"""Tests for incremental Kafka-driven 5D graph ingestion (graph_5d_stream)."""

import tempfile
from datetime import UTC, datetime
from pathlib import Path

from bus.events import ArtifactType, EventEnvelope
from coordinator.store import RunStore, set_run_store
from graph_5d import connect_graph_db, get_5d_graph
from graph_5d_stream import apply_envelope


def _env(run_id, artifact_type, payload, ts):
    return EventEnvelope(
        run_id=run_id,
        correlation_id="corr-1",
        agent_id="agent",
        tier="orchestrator",
        artifact_type=artifact_type,
        payload=payload,
        timestamp=ts,
    )


def test_stream_ingestion_builds_graph_with_real_event_times():
    tmpdir = Path(tempfile.mkdtemp())
    store = RunStore(db_path=tmpdir / "runs.db")
    graph_db = tmpdir / "graph_5d.db"
    set_run_store(store)
    try:
        run_id = "run-stream-1"
        # Run is created (with evidence) before RUN_STARTED is consumed.
        store.create_run(
            run_id=run_id,
            correlation_id="corr-1",
            task_description="incident",
            evidence_records=[
                {
                    "source_type": "siem",
                    "source_name": "sentinel",
                    "observed_at": "2026-05-12T12:00:00Z",
                    "asset_id": "host-001",
                    "user_id": "admin",
                    "event_type": "Failed Login",
                    "cve_id": "CVE-2026-0001",
                    "confidence": 0.95,
                    "extracted_fields": {"ip": "10.0.1.45"},
                }
            ],
        )

        t0 = datetime(2026, 6, 1, 19, 0, 0, tzinfo=UTC)
        t1 = datetime(2026, 6, 1, 19, 0, 5, tzinfo=UTC)
        t2 = datetime(2026, 6, 1, 19, 0, 10, tzinfo=UTC)
        t3 = datetime(2026, 6, 1, 19, 0, 15, tzinfo=UTC)

        conn = connect_graph_db(graph_db)
        try:
            with conn:
                # Stream the envelopes in the order they'd arrive on the bus.
                assert apply_envelope(
                    conn, _env(run_id, ArtifactType.RUN_STARTED, {}, t0)
                )
                assert apply_envelope(
                    conn,
                    _env(
                        run_id,
                        ArtifactType.AGENT_CONFIG,
                        {"persona": "Identity", "focus_objective": "users"},
                        t1,
                    ),
                )
                assert apply_envelope(
                    conn,
                    _env(
                        run_id,
                        ArtifactType.CHILD_CONFIG,
                        {"persona": "AD Solver", "parent_persona": "Identity"},
                        t2,
                    ),
                )
                assert apply_envelope(
                    conn,
                    _env(
                        run_id,
                        ArtifactType.CAUSAL_PAYLOAD,
                        {
                            "graph": {
                                "nodes": [
                                    {
                                        "id": "asset_criticality",
                                        "label": "Asset Criticality",
                                    }
                                ],
                                "edges": [],
                            }
                        },
                        t3,
                    ),
                )
                # Telemetry phase events are not modelled in the graph.
                assert not apply_envelope(
                    conn,
                    _env(
                        run_id,
                        ArtifactType.EXECUTION_PHASE,
                        {"phase": "X", "message": "m", "status": "done"},
                        t3,
                    ),
                )
        finally:
            conn.close()

        graph = get_5d_graph(connect_graph_db(graph_db), run_id)
        nodes = {n["id"]: n for n in graph["nodes"]}

        # Swarm + telemetry + causal layers all present from the stream.
        assert "agent.orchestrator" in nodes
        assert "agent.parent.identity" in nodes
        assert "agent.child.ad_solver" in nodes
        assert "asset.host-001" in nodes
        assert "user.admin" in nodes
        assert "threat.cve-2026-0001" in nodes
        assert "causal.asset_criticality" in nodes

        # The key fix: nodes carry the *real* event time, not reconstruction now.
        assert nodes["agent.orchestrator"]["created_at"] == t0.isoformat()
        assert nodes["agent.parent.identity"]["created_at"] == t1.isoformat()
        assert nodes["agent.child.ad_solver"]["created_at"] == t2.isoformat()
        # Evidence node keeps its own telemetry timestamp.
        assert nodes["asset.host-001"]["created_at"] == "2026-05-12T12:00:00Z"

        rels = {e["relationship"] for e in graph["edges"]}
        assert {"spawns", "accessed", "vulnerable_to", "triggered"} <= rels
    finally:
        set_run_store(None)


def test_stream_is_idempotent_on_replay():
    tmpdir = Path(tempfile.mkdtemp())
    store = RunStore(db_path=tmpdir / "runs.db")
    graph_db = tmpdir / "graph_5d.db"
    set_run_store(store)
    try:
        run_id = "run-stream-2"
        store.create_run(
            run_id=run_id,
            correlation_id="corr-2",
            task_description="incident",
            evidence_records=[],
        )
        t1 = datetime(2026, 6, 1, 19, 0, 5, tzinfo=UTC)
        env = _env(
            run_id,
            ArtifactType.AGENT_CONFIG,
            {"persona": "Identity", "focus_objective": "users"},
            t1,
        )

        conn = connect_graph_db(graph_db)
        try:
            with conn:
                apply_envelope(conn, env)
                apply_envelope(conn, env)  # replay same offset
                apply_envelope(conn, env)
        finally:
            conn.close()

        graph = get_5d_graph(connect_graph_db(graph_db), run_id)
        # One parent node, one spawn edge — replays must not duplicate.
        parents = [n for n in graph["nodes"] if n["id"] == "agent.parent.identity"]
        spawn_edges = [
            e
            for e in graph["edges"]
            if e["relationship"] == "spawns" and e["target"] == "agent.parent.identity"
        ]
        assert len(parents) == 1
        assert len(spawn_edges) == 1
    finally:
        set_run_store(None)
