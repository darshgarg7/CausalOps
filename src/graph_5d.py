"""5D Spatiotemporal Knowledge Graph schema and ingestion engine.

Captures tuples of (Subject, Predicate, Object, Time, Location) representing
both multi-agent orchestration states and physical network events.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, TypedDict

from paths import data_dir

logger = logging.getLogger(__name__)

# The 5D graph lives in its own SQLite file, separate from runs.db. Run-state is
# written by both the api and worker containers; the graph is written only by
# the worker's stream consumer (or, in no-Kafka mode, only by the api during the
# end-of-run backfill). Keeping them in separate files preserves the
# single-writer-per-file invariant SQLite needs to avoid lock contention across
# containers sharing a bind-mounted volume.
DEFAULT_GRAPH_DB_PATH = data_dir() / "graph_5d.db"


def graph_db_path() -> Path:
    """Resolve the 5D graph database path (overridable via env for tests)."""

    return Path(os.getenv("HIVEMIND_GRAPH_DB_PATH", str(DEFAULT_GRAPH_DB_PATH)))


def connect_graph_db(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open (and lazily initialise) a connection to the dedicated graph DB."""

    path = Path(db_path) if db_path is not None else graph_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        # Rollback-journal, not WAL — see RunStore._connect for rationale (WAL's
        # shared-memory mmap is unreliable on Docker bind mounts).
        conn.execute("PRAGMA journal_mode=DELETE;")
        conn.execute("PRAGMA busy_timeout=30000;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    except sqlite3.OperationalError:
        pass
    with conn:
        init_5d_schema(conn)
    return conn


class STNode(TypedDict):
    id: str
    node_type: str  # "agent" | "asset" | "threat" | "artifact" | "causal_variable"
    label: str
    description: str
    location: dict[str, Any]
    created_at: str


class STEdge(TypedDict):
    source: str
    target: str
    relationship: str
    observed_at: str
    location: dict[str, Any]
    confidence: float
    metadata: dict[str, Any]


def init_5d_schema(conn: sqlite3.Connection) -> None:
    """Create the spatiotemporal node and edge tables in runs.db."""

    logger.info("Initializing 5D Spatiotemporal KG database schema")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS spatiotemporal_nodes (
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            node_type TEXT NOT NULL,
            label TEXT NOT NULL,
            description TEXT,
            location_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, node_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS spatiotemporal_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object_id TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            location_json TEXT NOT NULL DEFAULT '{}',
            confidence REAL NOT NULL DEFAULT 1.0,
            edge_metadata_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    # Add indexes for performance on queries
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_st_edges_run ON spatiotemporal_edges (run_id)"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_st_edges_time
        ON spatiotemporal_edges (run_id, observed_at)
        """
    )


def log_st_node(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    node_id: str,
    node_type: str,
    label: str,
    description: str = "",
    location: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> None:
    """Insert or update a spatiotemporal node.

    ``created_at`` should reflect when the node's event actually occurred so the
    node shares a timeline with its edges. When a node is seen more than once we
    keep the earliest timestamp so timeline replay reveals it at first sighting.
    """

    t = created_at or datetime.now(UTC).isoformat()
    location_json = json.dumps(location or {})
    conn.execute(
        """
        INSERT INTO spatiotemporal_nodes (
            run_id, node_id, node_type, label, description, location_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_id) DO UPDATE SET
            node_type = excluded.node_type,
            label = excluded.label,
            description = excluded.description,
            location_json = excluded.location_json,
            created_at = MIN(spatiotemporal_nodes.created_at, excluded.created_at)
        """,
        (run_id, node_id, node_type, label, description, location_json, t),
    )


def log_st_edge(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    subject_id: str,
    predicate: str,
    object_id: str,
    observed_at: str | None = None,
    location: dict[str, Any] | None = None,
    confidence: float = 1.0,
    edge_metadata: dict[str, Any] | None = None,
) -> None:
    """Append a spatiotemporal edge unless an exact duplicate exists."""

    t = observed_at or datetime.now(UTC).isoformat()
    location_json = json.dumps(location or {})
    meta_json = json.dumps(edge_metadata or {})

    # Check if edge already exists to prevent duplicate rows
    existing = conn.execute(
        """
        SELECT 1 FROM spatiotemporal_edges
        WHERE run_id = ?
          AND subject_id = ?
          AND predicate = ?
          AND object_id = ?
          AND observed_at = ?
        """,
        (run_id, subject_id, predicate, object_id, t),
    ).fetchone()

    if not existing:
        conn.execute(
            """
            INSERT INTO spatiotemporal_edges (
                run_id,
                subject_id,
                predicate,
                object_id,
                observed_at,
                location_json,
                confidence,
                edge_metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                subject_id,
                predicate,
                object_id,
                t,
                location_json,
                confidence,
                meta_json,
            ),
        )


def get_5d_graph(conn: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    """Fetch the compiled 5D spatiotemporal graph nodes and edges."""

    # Fetch nodes
    nodes_rows = conn.execute(
        """
        SELECT node_id, node_type, label, description, location_json, created_at
        FROM spatiotemporal_nodes
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchall()

    nodes = []
    for r in nodes_rows:
        try:
            loc = json.loads(r["location_json"])
        except Exception:
            loc = {}
        nodes.append(
            {
                "id": r["node_id"],
                "node_type": r["node_type"],
                "label": r["label"],
                "description": r["description"] or "",
                "location": loc,
                "created_at": r["created_at"],
            }
        )

    # Fetch edges
    edges_rows = conn.execute(
        """
        SELECT
            subject_id,
            predicate,
            object_id,
            observed_at,
            location_json,
            confidence,
            edge_metadata_json
        FROM spatiotemporal_edges
        WHERE run_id = ?
        ORDER BY observed_at ASC
        """,
        (run_id,),
    ).fetchall()

    edges = []
    for r in edges_rows:
        try:
            loc = json.loads(r["location_json"])
        except Exception:
            loc = {}
        try:
            meta = json.loads(r["edge_metadata_json"])
        except Exception:
            meta = {}
        edges.append(
            {
                "source": r["subject_id"],
                "target": r["object_id"],
                "relationship": r["predicate"],
                "observed_at": r["observed_at"],
                "location": loc,
                "confidence": float(r["confidence"]),
                "metadata": meta,
            }
        )

    return {
        "run_id": run_id,
        "nodes": nodes,
        "edges": edges,
    }


def seed_spatiotemporal_base(conn: sqlite3.Connection, run_id: str) -> None:
    """Pre-populate default nodes for the agent tiers so we have them available."""

    log_st_node(
        conn,
        run_id=run_id,
        node_id="agent.orchestrator",
        node_type="agent",
        label="Grand Orchestrator",
        description="Core coordinator decomposing incidents",
        location={"tier": "orchestrator", "zone": "swarm"},
    )


ORCHESTRATOR_ID = "agent.orchestrator"


def _field(obj: Any, key: str, default: Any = "") -> Any:
    """Read ``key`` from either a dict payload or a pydantic/dataclass object."""

    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _slug(value: str) -> str:
    return value.replace(" ", "_").lower()


# --- Per-section ingest helpers -------------------------------------------------
# Each helper applies one slice of the graph from a single payload (dict or
# object) at a given observed time. They are shared by the batch reconstruction
# and the incremental Kafka stream so both converge on identical, idempotent
# node/edge state regardless of ingestion path.


def ingest_orchestrator(
    conn: sqlite3.Connection, run_id: str, *, observed_at: str
) -> None:
    """Upsert the grand orchestrator root node."""

    log_st_node(
        conn,
        run_id=run_id,
        node_id=ORCHESTRATOR_ID,
        node_type="agent",
        label="Grand Orchestrator",
        description="Core coordinator decomposing incidents",
        location={"tier": "orchestrator", "zone": "swarm"},
        created_at=observed_at,
    )


def ingest_parent(
    conn: sqlite3.Connection, run_id: str, parent: Any, *, observed_at: str
) -> None:
    """Upsert one parent agent node and its spawn edge from the orchestrator."""

    persona = _field(parent, "persona")
    if not persona:
        return
    p_id = f"agent.parent.{_slug(persona)}"
    log_st_node(
        conn,
        run_id=run_id,
        node_id=p_id,
        node_type="agent",
        label=f"{persona} Parent",
        description=_field(parent, "focus_objective"),
        location={"tier": "parent", "domain": persona, "zone": "swarm"},
        created_at=observed_at,
    )
    log_st_edge(
        conn,
        run_id=run_id,
        subject_id=ORCHESTRATOR_ID,
        predicate="spawns",
        object_id=p_id,
        observed_at=observed_at,
        location={"tier": "orchestrator", "zone": "swarm"},
    )


def ingest_child(
    conn: sqlite3.Connection, run_id: str, child: Any, *, observed_at: str
) -> None:
    """Upsert one child agent node and its spawn edge from its parent."""

    persona = _field(child, "persona")
    parent_persona = _field(child, "parent_persona")
    if not persona:
        return
    c_id = f"agent.child.{_slug(persona)}"
    p_id = (
        f"agent.parent.{_slug(parent_persona)}" if parent_persona else ORCHESTRATOR_ID
    )
    log_st_node(
        conn,
        run_id=run_id,
        node_id=c_id,
        node_type="agent",
        label=f"{persona} Child",
        description=_field(child, "focus_objective"),
        location={
            "tier": "child",
            "domain": persona,
            "parent_domain": parent_persona,
            "zone": "swarm",
        },
        created_at=observed_at,
    )
    log_st_edge(
        conn,
        run_id=run_id,
        subject_id=p_id,
        predicate="spawns",
        object_id=c_id,
        observed_at=observed_at,
        location={"tier": "parent", "zone": "swarm"},
    )


def ingest_memo(
    conn: sqlite3.Connection,
    run_id: str,
    memo: Any,
    child_configs: Any,
    *,
    observed_at: str,
) -> None:
    """Upsert one decision memo node and its submit/evaluation edges."""

    perspective = _field(memo, "perspective")
    strategy = _field(memo, "strategy")
    risks = _field(memo, "risks", []) or []
    confidence = _field(memo, "confidence", "N/A")
    if not perspective:
        return

    memo_hash = hashlib.sha256(f"{perspective}-{strategy}".encode()).hexdigest()[:8]
    m_id = f"artifact.memo.{memo_hash}"
    log_st_node(
        conn,
        run_id=run_id,
        node_id=m_id,
        node_type="artifact",
        label=f"Memo: {perspective[:30]}...",
        description=strategy,
        location={"tier": "evaluator", "zone": "swarm"},
        created_at=observed_at,
    )

    # Map the memo back to the child persona that authored it.
    matching_child_id = ORCHESTRATOR_ID
    for child in child_configs or []:
        child_persona = _field(child, "persona")
        if not child_persona:
            continue
        if (
            child_persona.lower() in perspective.lower()
            or perspective.lower() in child_persona.lower()
        ):
            matching_child_id = f"agent.child.{_slug(child_persona)}"
            break

    log_st_edge(
        conn,
        run_id=run_id,
        subject_id=matching_child_id,
        predicate="submits",
        object_id=m_id,
        observed_at=observed_at,
        location={"tier": "child", "zone": "swarm"},
    )
    log_st_edge(
        conn,
        run_id=run_id,
        subject_id=m_id,
        predicate="evaluated_by",
        object_id=ORCHESTRATOR_ID,
        observed_at=observed_at,
        location={"tier": "evaluator", "zone": "swarm"},
        confidence=1.0,
        edge_metadata={"confidence_tier": confidence, "risks_count": len(risks)},
    )


def ingest_causal(
    conn: sqlite3.Connection,
    run_id: str,
    causal_graph: dict[str, Any],
    *,
    observed_at: str,
) -> None:
    """Upsert causal variable nodes and the causal DAG edges between them."""

    causal_nodes = (causal_graph or {}).get("nodes", []) or []
    causal_edges = (causal_graph or {}).get("edges", []) or []

    for c_node in causal_nodes:
        n_id = f"causal.{c_node.get('id')}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=n_id,
            node_type="causal_variable",
            label=c_node.get("label", c_node.get("id")),
            description=c_node.get("description", ""),
            location={"tier": "causal", "zone": "analysis"},
            created_at=observed_at,
        )

    for c_edge in causal_edges:
        src = f"causal.{c_edge.get('source')}"
        tgt = f"causal.{c_edge.get('target')}"
        status = c_edge.get("status", "hypothesized")
        metadata = {"status": status}
        if c_edge.get("p_value") is not None:
            metadata["p_value"] = c_edge["p_value"]
        if c_edge.get("validation_detail"):
            metadata["detail"] = c_edge["validation_detail"]
        # Confidence reflects how the data judged the edge, not blind trust in
        # the hypothesis: validated edges carry their association strength,
        # unvalidated hypotheses sit at 0.5, refuted edges are floored.
        if status in ("confirmed", "compatible", "reversed", "discovered"):
            confidence = float(c_edge.get("strength") or 0.75)
        elif status == "refuted":
            confidence = 0.05
        else:
            confidence = 0.5

        # A data-reversed edge replaces the hypothesized opposite direction.
        if status == "reversed":
            conn.execute(
                """
                DELETE FROM spatiotemporal_edges
                WHERE run_id = ? AND subject_id = ? AND object_id = ?
                """,
                (run_id, tgt, src),
            )

        # The causal DAG is a single evolving structure: a later validation
        # pass updates the edge in place rather than appending a duplicate
        # observation between the same variables.
        updated = conn.execute(
            """
            UPDATE spatiotemporal_edges
            SET predicate = ?, confidence = ?, edge_metadata_json = ?
            WHERE run_id = ? AND subject_id = ? AND object_id = ?
            """,
            (
                c_edge.get("relationship", "influences"),
                confidence,
                json.dumps(metadata),
                run_id,
                src,
                tgt,
            ),
        )
        if updated.rowcount == 0:
            log_st_edge(
                conn,
                run_id=run_id,
                subject_id=src,
                predicate=c_edge.get("relationship", "influences"),
                object_id=tgt,
                observed_at=observed_at,
                location={"tier": "causal", "zone": "analysis"},
                confidence=confidence,
                edge_metadata=metadata,
            )


def ingest_findings(
    conn: sqlite3.Connection,
    run_id: str,
    report: dict[str, Any],
    *,
    observed_at: str,
) -> None:
    """Upsert reasoning-layer findings (anomalies) and decisions into the graph.

    Anomaly nodes are placed in the flagged asset's own zone so spatial
    clustering shows where anomalies concentrate; decision nodes live in the
    analysis zone alongside the causal variables they cite.
    """

    # Asset locations let anomaly findings inherit the host's zone.
    asset_locations: dict[str, dict[str, Any]] = {}
    for row in conn.execute(
        "SELECT node_id, location_json FROM spatiotemporal_nodes"
        " WHERE run_id = ? AND node_type = 'asset'",
        (run_id,),
    ).fetchall():
        try:
            asset_locations[row["node_id"]] = json.loads(row["location_json"])
        except Exception:
            asset_locations[row["node_id"]] = {}

    for anomaly in report.get("anomalies", []) or []:
        asset_id = str(anomaly.get("asset_id", ""))
        ast_node = f"asset.{asset_id.lower()}"
        find_id = f"finding.anomaly.{asset_id.lower()}"
        location = dict(
            asset_locations.get(ast_node) or {"subnet": anomaly.get("zone", "")}
        )
        location["tier"] = "reasoning"
        severity = anomaly.get("severity", "medium")
        log_st_node(
            conn,
            run_id=run_id,
            node_id=find_id,
            node_type="finding",
            label=f"Anomaly: {asset_id}"
            + (" (unexplained)" if severity == "high" else ""),
            description=anomaly.get("detail", ""),
            location=location,
            created_at=observed_at,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=find_id,
            predicate="flags",
            object_id=ast_node,
            observed_at=observed_at,
            location=location,
            confidence=1.0 - float(anomaly.get("baseline_rate") or 0.0),
            edge_metadata={"severity": severity},
        )
        for cause in anomaly.get("explained_by", []) or []:
            log_st_edge(
                conn,
                run_id=run_id,
                subject_id=find_id,
                predicate="attributed_to",
                object_id=f"causal.{cause.get('variable')}",
                observed_at=observed_at,
                location=location,
                confidence=0.8,
                edge_metadata={
                    "edge_status": cause.get("edge_status"),
                    "p_value": cause.get("p_value"),
                },
            )

    analysis_loc = {"tier": "reasoning", "zone": "analysis"}
    for rec in report.get("recommendations", []) or []:
        action = str(rec.get("action", "decision"))
        dec_id = f"decision.{action.lower()}"
        targets = rec.get("targets", []) or []
        log_st_node(
            conn,
            run_id=run_id,
            node_id=dec_id,
            node_type="decision",
            label=f"P{rec.get('priority', '?')}: {action.replace('_', ' ')}",
            description=(
                f"{rec.get('rationale', '')} "
                f"[targets: {rec.get('target_count', len(targets))}, "
                f"evidence: {json.dumps(rec.get('evidence', {}))}]"
            ),
            location=analysis_loc,
            created_at=observed_at,
        )
        for target in targets:
            log_st_edge(
                conn,
                run_id=run_id,
                subject_id=dec_id,
                predicate="recommends_for",
                object_id=f"asset.{str(target).lower()}",
                observed_at=observed_at,
                location=analysis_loc,
                confidence=1.0,
                edge_metadata={"priority": rec.get("priority")},
            )


def ingest_evolution_report(
    conn: sqlite3.Connection,
    run_id: str,
    report: dict[str, Any],
    *,
    observed_at: str | None = None,
) -> None:
    """Upsert island-evolution policy priors into the 5D graph."""

    t = observed_at or datetime.now(UTC).isoformat()
    phases = report.get("phases") if isinstance(report, dict) else None
    phase_reports = phases or [report]
    for phase in phase_reports:
        if not isinstance(phase, dict):
            continue
        tier = str(phase.get("tier", "agent"))
        evo_id = f"optimizer.evolution.{tier}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=evo_id,
            node_type="optimizer",
            label=f"{tier.title()} Island Evolution",
            description=(
                "Steady-state island algorithm selecting agent policy priors "
                f"over {phase.get('generations', 0)} generations."
            ),
            location={"tier": "optimizer", "zone": "policy"},
            created_at=t,
        )
        for island in phase.get("islands", []) or []:
            island_id = str(island.get("island_id", "island"))
            island_node = f"optimizer.evolution.{_slug(island_id)}"
            log_st_node(
                conn,
                run_id=run_id,
                node_id=island_node,
                node_type="optimizer",
                label=island_id,
                description=(
                    f"Population {island.get('population_size', 0)}; "
                    f"best fitness {island.get('best_fitness', 0)}."
                ),
                location={"tier": "optimizer", "zone": "policy", "island": island_id},
                created_at=t,
            )
            log_st_edge(
                conn,
                run_id=run_id,
                subject_id=evo_id,
                predicate="maintains_island",
                object_id=island_node,
                observed_at=t,
                location={"tier": "optimizer", "zone": "policy"},
                confidence=float(island.get("best_fitness", 0.5) or 0.5),
                edge_metadata={
                    "mean_fitness": island.get("mean_fitness"),
                    "population_size": island.get("population_size"),
                },
            )

        for selected in phase.get("selected_policies", []) or []:
            policy = selected.get("policy", {}) or {}
            policy_id = str(policy.get("policy_id", "policy.unknown"))
            policy_node = f"policy.evolved.{_slug(policy_id)}"
            agent_id = str(selected.get("agent", "agent.unknown"))
            log_st_node(
                conn,
                run_id=run_id,
                node_id=policy_node,
                node_type="policy",
                label=f"Policy: {selected.get('persona', policy_id)}",
                description=(
                    f"Fitness {policy.get('fitness', 0)}; "
                    f"traits {json.dumps(policy.get('traits', {}), sort_keys=True)}"
                ),
                location={
                    "tier": "optimizer",
                    "zone": "policy",
                    "island": policy.get("island_id"),
                },
                created_at=t,
            )
            log_st_edge(
                conn,
                run_id=run_id,
                subject_id=evo_id,
                predicate="selects_policy",
                object_id=policy_node,
                observed_at=t,
                location={"tier": "optimizer", "zone": "policy"},
                confidence=float(policy.get("fitness", 0.5) or 0.5),
                edge_metadata={"generation": policy.get("generation")},
            )
            log_st_edge(
                conn,
                run_id=run_id,
                subject_id=policy_node,
                predicate="prior_for",
                object_id=agent_id,
                observed_at=t,
                location={"tier": "optimizer", "zone": "swarm"},
                confidence=float(policy.get("fitness", 0.5) or 0.5),
                edge_metadata={"traits": policy.get("traits", {})},
            )


def ingest_policy_optimization(
    conn: sqlite3.Connection,
    run_id: str,
    report: dict[str, Any],
    *,
    observed_at: str | None = None,
) -> None:
    """Upsert the KG-grounded RL/meta-learning policy update."""

    t = observed_at or datetime.now(UTC).isoformat()
    meta = (report or {}).get("meta_learning", {}) or {}
    stackelberg = (report or {}).get("stackelberg", {}) or {}
    kg_base = (report or {}).get("kg_base", {}) or {}
    meta_node = "policy.meta_prior"
    kg_node = f"kg.run.{_slug(run_id)}"

    log_st_node(
        conn,
        run_id=run_id,
        node_id=kg_node,
        node_type="knowledge_graph",
        label="Run Knowledge Graph",
        description=(
            f"{kg_base.get('node_count', 0)} nodes, "
            f"{kg_base.get('edge_count', 0)} edges before RL update."
        ),
        location={"tier": "knowledge_graph", "zone": "substrate"},
        created_at=t,
    )
    log_st_node(
        conn,
        run_id=run_id,
        node_id=meta_node,
        node_type="policy",
        label="Meta-Learned Policy Prior",
        description=json.dumps(meta.get("updated_prior", {}), sort_keys=True),
        location={"tier": "optimizer", "zone": "policy"},
        created_at=t,
    )
    log_st_edge(
        conn,
        run_id=run_id,
        subject_id=kg_node,
        predicate="grounds_rl_state",
        object_id=meta_node,
        observed_at=t,
        location={"tier": "optimizer", "zone": "policy"},
        confidence=1.0,
        edge_metadata=report.get("reward_model", {}),
    )

    for shard in meta.get("child_shards", []) or []:
        agent_id = str(shard.get("agent_id", "agent.child.unknown"))
        shard_id = f"policy.shard.{_slug(agent_id)}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=shard_id,
            node_type="policy",
            label=f"Policy Shard: {agent_id.split('.')[-1]}",
            description=json.dumps(shard.get("specialized_policy", {}), sort_keys=True),
            location={"tier": "optimizer", "zone": "policy", "agent": agent_id},
            created_at=t,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=meta_node,
            predicate="shards_prior_to",
            object_id=shard_id,
            observed_at=t,
            location={"tier": "optimizer", "zone": "policy"},
            confidence=float(shard.get("q_value", 0.5) or 0.5),
            edge_metadata={"inherited_prior": shard.get("inherited_prior", {})},
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=shard_id,
            predicate="specializes",
            object_id=agent_id,
            observed_at=t,
            location={"tier": "optimizer", "zone": "swarm"},
            confidence=float(shard.get("q_value", 0.5) or 0.5),
            edge_metadata={"local_delta": shard.get("local_delta", {})},
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=shard_id,
            predicate="updates_meta_prior",
            object_id=meta_node,
            observed_at=t,
            location={"tier": "optimizer", "zone": "policy"},
            confidence=float(shard.get("q_value", 0.5) or 0.5),
            edge_metadata={"policy_id": shard.get("policy_id")},
        )

    leader = stackelberg.get("leader_agent_id")
    if leader:
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=meta_node,
            predicate="selects_stackelberg_leader",
            object_id=str(leader),
            observed_at=t,
            location={"tier": "optimizer", "zone": "policy"},
            confidence=float(stackelberg.get("leader_q_value", 0.5) or 0.5),
            edge_metadata={
                "leader_action": stackelberg.get("leader_action"),
                "solution_concept": stackelberg.get("solution_concept"),
            },
        )

    log_st_edge(
        conn,
        run_id=run_id,
        subject_id=meta_node,
        predicate="updates_knowledge_graph",
        object_id=kg_node,
        observed_at=t,
        location={"tier": "optimizer", "zone": "substrate"},
        confidence=1.0,
        edge_metadata={"kafka_feedback": report.get("kafka_feedback", {})},
    )


def ingest_evidence_record(
    conn: sqlite3.Connection,
    run_id: str,
    r: dict[str, Any],
    causal_nodes: list[dict[str, Any]] | None = None,
    *,
    default_time: str,
) -> None:
    """Upsert the asset/user/threat/event nodes for one evidence record.

    ``causal_nodes`` is used to link measured asset fields to causal variables;
    pass the currently-known causal nodes (may be empty if causal synthesis has
    not run yet — measurement edges are added later when it has).
    """

    causal_nodes = causal_nodes or []
    src_type = r.get("source_type", "siem")
    src_name = r.get("source_name", "manual")
    observed_at = r.get("observed_at") or default_time
    asset_id = r.get("asset_id")
    user_id = r.get("user_id")
    cve_id = r.get("cve_id")
    event_type = r.get("event_type")
    fields = r.get("extracted_fields") or {}
    confidence = float(r.get("confidence", 1.0))

    # Derive the spatial dimension (subnet + ip) from telemetry or asset id.
    subnet, ip = _derive_location(fields, asset_id)

    location_data = {
        "subnet": subnet,
        "ip": ip,
        "source": src_name,
        "source_type": src_type,
    }

    if not asset_id:
        return

    ast_id = f"asset.{asset_id.lower()}"
    log_st_node(
        conn,
        run_id=run_id,
        node_id=ast_id,
        node_type="asset",
        label=f"Asset: {asset_id}",
        description=f"Type: {src_type} | Source: {src_name}",
        location=location_data,
        created_at=observed_at,
    )

    # Map user access
    if user_id:
        usr_id = f"user.{user_id.lower()}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=usr_id,
            node_type="user",
            label=f"User: {user_id}",
            description="User identity triggering telemetry",
            location=location_data,
            created_at=observed_at,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=usr_id,
            predicate="accessed",
            object_id=ast_id,
            observed_at=observed_at,
            location=location_data,
            confidence=confidence,
        )

    # Map CVE vulnerability threat
    if cve_id:
        thr_id = f"threat.{cve_id.lower()}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=thr_id,
            node_type="threat",
            label=cve_id,
            description="Identified CVE Vulnerability",
            location={"zone": "external_intel"},
            created_at=observed_at,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=ast_id,
            predicate="vulnerable_to",
            object_id=thr_id,
            observed_at=observed_at,
            location=location_data,
            confidence=confidence,
        )

    # Map telemetry alerts. Key the event node on (asset, type, time) so
    # repeated identical observations collapse onto one node instead of
    # producing a new dot per evidence row.
    if event_type:
        evt_key = hashlib.sha256(
            f"{ast_id}-{event_type}-{observed_at}".encode()
        ).hexdigest()[:8]
        evt_id = f"event.{event_type.replace(' ', '_').lower()}.{evt_key}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=evt_id,
            node_type="artifact",
            label=event_type,
            description=r.get("raw_text", "Telemetry event details"),
            location=location_data,
            created_at=observed_at,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=ast_id,
            predicate="triggered",
            object_id=evt_id,
            observed_at=observed_at,
            location=location_data,
            confidence=confidence,
        )

    # Map fields to causal variables if matching
    for field_name, field_val in fields.items():
        for c_node in causal_nodes:
            c_id = c_node.get("id")
            if str(c_id).lower() == str(field_name).lower() and field_val:
                log_st_edge(
                    conn,
                    run_id=run_id,
                    subject_id=ast_id,
                    predicate=f"measured_as_{c_id}",
                    object_id=f"causal.{c_id}",
                    observed_at=observed_at,
                    location=location_data,
                    confidence=confidence,
                    edge_metadata={"measured_value": field_val},
                )


_IP_FIELD_KEYS = (
    "ip",
    "IPAddress",
    "IpAddress",
    "SourceIP",
    "src_ip",
    "DeviceIP",
    "DestinationIP",
)
_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
_HOST_RE = re.compile(r"host[-_]?(\d+)", re.IGNORECASE)

# Number of hosts grouped into each /24 segment when deriving zones from host ids.
_HOSTS_PER_SEGMENT = 16


def _derive_location(fields: dict[str, Any], asset_id: Any) -> tuple[str, str]:
    """Resolve (subnet, ip) for an evidence record — the graph's spatial axis.

    Priority:
      1. A real IP present in the telemetry fields -> its /24 and the IP itself.
      2. A ``host-NNN`` asset id -> a deterministic /24 segment (and a stable
         synthetic host IP within it) so hosts actually separate into zones
         instead of collapsing into one /8.
      3. Otherwise the broad 10.0.0.0/8 space with no IP.
    """

    for key in _IP_FIELD_KEYS:
        val = fields.get(key)
        if val and _IP_RE.match(str(val).strip()):
            ip = str(val).strip()
            a, b, c, _ = ip.split(".")
            return f"{a}.{b}.{c}.0/24", ip

    match = _HOST_RE.search(str(asset_id or ""))
    if match:
        n = int(match.group(1))
        segment = (n // _HOSTS_PER_SEGMENT) + 1
        host_octet = (n % _HOSTS_PER_SEGMENT) + 10
        return f"10.0.{segment}.0/24", f"10.0.{segment}.{host_octet}"

    return "10.0.0.0/8", ""


def reconstruct_5d_graph(conn: sqlite3.Connection, run_id: str, record: Any) -> None:
    """Rebuild the full 5D graph from a RunRecord (batch backfill / no-Kafka mode).

    Uses staged synthetic timestamps for the agent tier so a snapshot-only
    rebuild still produces an ordered timeline. The incremental stream
    (``graph_5d_stream``) instead stamps these with real event times.
    """

    logger.info("Reconstructing 5D Spatiotemporal KG for run %s", run_id)

    base_time = datetime.now(UTC)
    t_orchestrator = base_time.isoformat()
    t_parents = (base_time + timedelta(seconds=2)).isoformat()
    t_children = (base_time + timedelta(seconds=4)).isoformat()
    t_causal = (base_time + timedelta(seconds=8)).isoformat()
    t_estimate = (base_time + timedelta(seconds=10)).isoformat()

    ingest_orchestrator(conn, run_id, observed_at=t_orchestrator)

    for parent in getattr(record, "parent_configs", []) or []:
        ingest_parent(conn, run_id, parent, observed_at=t_orchestrator)

    child_configs = getattr(record, "child_configs", []) or []
    for child in child_configs:
        ingest_child(conn, run_id, child, observed_at=t_parents)

    evolution_report = getattr(record, "agent_evolution_report", None)
    if evolution_report:
        t_evolution = (base_time + timedelta(seconds=5)).isoformat()
        ingest_evolution_report(conn, run_id, evolution_report, observed_at=t_evolution)

    for memo in getattr(record, "memos", []) or []:
        ingest_memo(conn, run_id, memo, child_configs, observed_at=t_children)

    causal_payload = getattr(record, "causal_payload", None) or {}
    causal_graph = causal_payload.get("graph", {}) or {}
    ingest_causal(conn, run_id, causal_graph, observed_at=t_causal)
    causal_nodes = causal_graph.get("nodes", []) or []

    for r in getattr(record, "evidence_records", []) or []:
        ingest_evidence_record(conn, run_id, r, causal_nodes, default_time=t_estimate)

    reasoning_report = getattr(record, "reasoning_report", None)
    if reasoning_report:
        t_reasoning = (base_time + timedelta(seconds=12)).isoformat()
        ingest_findings(conn, run_id, reasoning_report, observed_at=t_reasoning)

    policy_report = getattr(record, "policy_optimization_report", None)
    if policy_report:
        t_policy = (base_time + timedelta(seconds=14)).isoformat()
        ingest_policy_optimization(conn, run_id, policy_report, observed_at=t_policy)
