import sqlite3

from graph_5d import (
    _derive_location,
    get_5d_graph,
    init_5d_schema,
    log_st_edge,
    log_st_node,
    reconstruct_5d_graph,
)


def test_derive_location_segments_hosts_into_zones():
    # A real IP in the telemetry wins and yields its /24.
    assert _derive_location({"IPAddress": "192.168.4.22"}, "host-005") == (
        "192.168.4.0/24",
        "192.168.4.22",
    )
    # host-NNN ids map to deterministic /24 segments (16 hosts each).
    assert _derive_location({}, "host-000") == ("10.0.1.0/24", "10.0.1.10")
    assert _derive_location({}, "host-016") == ("10.0.2.0/24", "10.0.2.10")
    assert _derive_location({}, "host-079") == ("10.0.5.0/24", "10.0.5.25")
    # Unknown asset with no IP stays in the broad space.
    assert _derive_location({}, "service-xyz") == ("10.0.0.0/8", "")
    # The 80-host demo dataset separates into 5 zones, not one.
    segments = {_derive_location({}, f"host-{i:03d}")[0] for i in range(80)}
    assert len(segments) == 5


class MockRecord:
    def __init__(self):
        self.parent_configs = []
        self.child_configs = []
        self.memos = []
        self.evidence_records = []
        self.causal_payload = {}


def test_5d_schema_and_logging():
    # Set up in-memory sqlite db
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row

    init_5d_schema(conn)

    # Log node
    log_st_node(
        conn,
        run_id="run-123",
        node_id="agent.orchestrator",
        node_type="agent",
        label="Orchestrator",
        description="Core Agent",
        location={"tier": "orchestrator"},
    )

    # Log edge
    log_st_edge(
        conn,
        run_id="run-123",
        subject_id="agent.orchestrator",
        predicate="spawns",
        object_id="agent.parent.identity",
        observed_at="2026-06-03T12:00:00Z",
        location={"tier": "orchestrator"},
        confidence=1.0,
        edge_metadata={"reason": "test"},
    )

    graph = get_5d_graph(conn, "run-123")

    assert len(graph["nodes"]) == 1
    assert graph["nodes"][0]["id"] == "agent.orchestrator"
    assert graph["nodes"][0]["node_type"] == "agent"

    assert len(graph["edges"]) == 1
    assert graph["edges"][0]["source"] == "agent.orchestrator"
    assert graph["edges"][0]["target"] == "agent.parent.identity"
    assert graph["edges"][0]["relationship"] == "spawns"
    assert graph["edges"][0]["observed_at"] == "2026-06-03T12:00:00Z"

    conn.close()


def test_reconstruction():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_5d_schema(conn)

    record = MockRecord()

    # Add dummy parent
    class DummyParent:
        persona = "Identity"
        focus_objective = "Investigate users"

    record.parent_configs.append(DummyParent())

    # Add dummy child
    class DummyChild:
        persona = "Active Directory Solver"
        parent_persona = "Identity"
        focus_objective = "Map tokens"

    record.child_configs.append(DummyChild())

    # Add dummy memo
    class DummyMemo:
        perspective = "Active Directory Solver Memo"
        strategy = "Rotate credentials"
        risks = ["user lockout"]
        confidence = "high"

    record.memos.append(DummyMemo())

    # Add evidence
    record.evidence_records.append(
        {
            "source_type": "siem",
            "source_name": "sentinel",
            "observed_at": "2026-06-03T12:00:05Z",
            "asset_id": "host-001",
            "user_id": "admin",
            "event_type": "Failed Login",
            "cve_id": "CVE-2026-0001",
            "confidence": 0.95,
            "extracted_fields": {"ip": "10.0.1.45"},
        }
    )

    reconstruct_5d_graph(conn, "run-abc", record)

    graph = get_5d_graph(conn, "run-abc")

    # Verify nodes
    node_ids = {n["id"] for n in graph["nodes"]}
    assert "agent.orchestrator" in node_ids
    assert "agent.parent.identity" in node_ids
    assert "agent.child.active_directory_solver" in node_ids
    assert "asset.host-001" in node_ids
    assert "user.admin" in node_ids
    assert "threat.cve-2026-0001" in node_ids

    # Verify edges
    edge_types = {e["relationship"] for e in graph["edges"]}
    assert "spawns" in edge_types
    assert "submits" in edge_types
    assert "accessed" in edge_types
    assert "vulnerable_to" in edge_types

    conn.close()
