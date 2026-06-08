"""5D Spatiotemporal Knowledge Graph schema and ingestion engine.

Captures tuples of (Subject, Predicate, Object, Time, Location) representing
both multi-agent orchestration states and physical network events.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Any, TypedDict

logger = logging.getLogger(__name__)


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
        "CREATE INDEX IF NOT EXISTS idx_st_edges_time ON spatiotemporal_edges (run_id, observed_at)"
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

    t = created_at or datetime.now(timezone.utc).isoformat()
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
    """Append a spatiotemporal edge if not already existing to prevent exact duplicates."""

    t = observed_at or datetime.now(timezone.utc).isoformat()
    location_json = json.dumps(location or {})
    meta_json = json.dumps(edge_metadata or {})
    
    # Check if edge already exists to prevent duplicate rows
    existing = conn.execute(
        """
        SELECT 1 FROM spatiotemporal_edges
        WHERE run_id = ? AND subject_id = ? AND predicate = ? AND object_id = ? AND observed_at = ?
        """,
        (run_id, subject_id, predicate, object_id, t),
    ).fetchone()
    
    if not existing:
        conn.execute(
            """
            INSERT INTO spatiotemporal_edges (
                run_id, subject_id, predicate, object_id, observed_at, location_json, confidence, edge_metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, subject_id, predicate, object_id, t, location_json, confidence, meta_json),
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
        nodes.append({
            "id": r["node_id"],
            "node_type": r["node_type"],
            "label": r["label"],
            "description": r["description"] or "",
            "location": loc,
            "created_at": r["created_at"],
        })

    # Fetch edges
    edges_rows = conn.execute(
        """
        SELECT subject_id, predicate, object_id, observed_at, location_json, confidence, edge_metadata_json
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
        edges.append({
            "source": r["subject_id"],
            "target": r["object_id"],
            "relationship": r["predicate"],
            "observed_at": r["observed_at"],
            "location": loc,
            "confidence": float(r["confidence"]),
            "metadata": meta,
        })

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


def reconstruct_5d_graph(conn: sqlite3.Connection, run_id: str, record: Any) -> None:
    """Reconcile and rebuild the 5D spatiotemporal graph from a RunRecord's contents."""

    logger.info("Reconstructing 5D Spatiotemporal KG for run %s", run_id)
    
    # Establish a timeline starting at run creation (or current time if missing)
    base_time = datetime.now(timezone.utc)
    t_orchestrator = base_time.isoformat()
    t_parents = (base_time + timedelta(seconds=2)).isoformat()
    t_children = (base_time + timedelta(seconds=4)).isoformat()
    t_memos = (base_time + timedelta(seconds=6)).isoformat()
    t_causal = (base_time + timedelta(seconds=8)).isoformat()
    t_estimate = (base_time + timedelta(seconds=10)).isoformat()

    # 1. Base Orchestrator Node
    log_st_node(
        conn,
        run_id=run_id,
        node_id="agent.orchestrator",
        node_type="agent",
        label="Grand Orchestrator",
        description="Core coordinator decomposing incidents",
        location={"tier": "orchestrator", "zone": "swarm"},
        created_at=t_orchestrator,
    )

    # 2. Parent configurations and spawns
    parent_configs = getattr(record, "parent_configs", []) or []
    for parent in parent_configs:
        persona = getattr(parent, "persona", "")
        if not persona:
            continue
        p_id = f"agent.parent.{persona.replace(' ', '_').lower()}"
        log_st_node(
            conn,
            run_id=run_id,
            node_id=p_id,
            node_type="agent",
            label=f"{persona} Parent",
            description=getattr(parent, "focus_objective", ""),
            location={"tier": "parent", "domain": persona, "zone": "swarm"},
            created_at=t_orchestrator,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id="agent.orchestrator",
            predicate="spawns",
            object_id=p_id,
            observed_at=t_orchestrator,
            location={"tier": "orchestrator", "zone": "swarm"},
        )

    # 3. Child configurations and spawns
    child_configs = getattr(record, "child_configs", []) or []
    for child in child_configs:
        persona = getattr(child, "persona", "")
        parent_persona = getattr(child, "parent_persona", "")
        if not persona:
            continue
        c_id = f"agent.child.{persona.replace(' ', '_').lower()}"
        p_id = f"agent.parent.{parent_persona.replace(' ', '_').lower()}"
        
        log_st_node(
            conn,
            run_id=run_id,
            node_id=c_id,
            node_type="agent",
            label=f"{persona} Child",
            description=getattr(child, "focus_objective", ""),
            location={"tier": "child", "domain": persona, "parent_domain": parent_persona, "zone": "swarm"},
            created_at=t_parents,
        )
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=p_id if parent_persona else "agent.orchestrator",
            predicate="spawns",
            object_id=c_id,
            observed_at=t_parents,
            location={"tier": "parent", "zone": "swarm"},
        )

    # 4. Decision Memos and submissions
    memos = getattr(record, "memos", []) or []
    for memo in memos:
        # Retrieve values checking dict and class attributes
        if isinstance(memo, dict):
            perspective = memo.get("perspective", "")
            strategy = memo.get("strategy", "")
            risks = memo.get("risks", [])
            confidence = memo.get("confidence", "N/A")
        else:
            perspective = getattr(memo, "perspective", "")
            strategy = getattr(memo, "strategy", "")
            risks = getattr(memo, "risks", [])
            confidence = getattr(memo, "confidence", "N/A")

        if not perspective:
            continue

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
            created_at=t_children,
        )

        # Draw edge from the child agent that submitted this memo
        # Attempt to map perspective back to child persona
        matching_child_id = "agent.orchestrator"
        for child in child_configs:
            child_persona = getattr(child, "persona", "")
            if child_persona.lower() in perspective.lower() or perspective.lower() in child_persona.lower():
                matching_child_id = f"agent.child.{child_persona.replace(' ', '_').lower()}"
                break

        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=matching_child_id,
            predicate="submits",
            object_id=m_id,
            observed_at=t_children,
            location={"tier": "child", "zone": "swarm"},
        )
        
        # Link to orchestrator evaluation
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=m_id,
            predicate="evaluated_by",
            object_id="agent.orchestrator",
            observed_at=t_memos,
            location={"tier": "evaluator", "zone": "swarm"},
            confidence=1.0,
            edge_metadata={"confidence_tier": confidence, "risks_count": len(risks)},
        )

    # 5. Causal variables and Causal graph edges
    causal_payload = getattr(record, "causal_payload", None) or {}
    causal_graph = causal_payload.get("graph", {})
    causal_nodes = causal_graph.get("nodes", [])
    causal_edges = causal_graph.get("edges", [])

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
            created_at=t_causal,
        )

    for c_edge in causal_edges:
        src = f"causal.{c_edge.get('source')}"
        tgt = f"causal.{c_edge.get('target')}"
        log_st_edge(
            conn,
            run_id=run_id,
            subject_id=src,
            predicate=c_edge.get("relationship", "influences"),
            object_id=tgt,
            observed_at=t_causal,
            location={"tier": "causal", "zone": "analysis"},
            confidence=1.0,
        )

    # 6. Physical assets, users, and evidence records mapping
    evidence_records = getattr(record, "evidence_records", []) or []
    for r in evidence_records:
        src_type = r.get("source_type", "siem")
        src_name = r.get("source_name", "manual")
        observed_at = r.get("observed_at") or t_estimate
        asset_id = r.get("asset_id")
        user_id = r.get("user_id")
        cve_id = r.get("cve_id")
        event_type = r.get("event_type")
        fields = r.get("extracted_fields") or {}
        confidence = float(r.get("confidence", 1.0))

        # Logical IP subnet parsing from asset id / fields
        ip = fields.get("ip") or fields.get("IPAddress") or fields.get("Computer") or ""
        subnet = "10.0.0.0/8"
        if "10.0.1" in ip or "host-001" in str(asset_id):
            subnet = "10.0.1.0/24"
        elif "10.0.2" in ip or "host-002" in str(asset_id):
            subnet = "10.0.2.0/24"
        elif "10.0.3" in ip:
            subnet = "10.0.3.0/24"

        location_data = {"subnet": subnet, "ip": ip, "source": src_name, "source_type": src_type}

        # Handle Asset Node
        if asset_id:
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
                # If fields match any causal variables, connect asset to causal node
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
