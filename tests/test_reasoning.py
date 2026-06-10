"""Tests for the deterministic reasoning layer (anomalies + recommendations).

The demo fixture's known structure makes the expected output exact: patched
hosts have a 5% lateral-movement rate, so host-000 and host-070 (patched,
critical, moved) are causal-surprise anomalies — both explained by the
confirmed Asset_Criticality -> Lateral_Movement edge. The negative ATE for
patching yields a treatment recommendation ranking critical unpatched hosts
first.
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from reasoning import build_reasoning_report


def demo_records(n_rows: int = 80) -> list[dict]:
    records = []
    for index in range(n_rows):
        treated = 1 if index % 2 == 0 else 0
        critical = 1 if index % 5 == 0 else 0
        outcome = int(
            (not treated and index % 3 == 0) or (critical and index % 7 == 0)
        )
        records.append(
            {
                "asset_id": f"host-{index:03d}",
                "extracted_fields": {
                    "Patch_Applied": treated,
                    "Lateral_Movement": outcome,
                    "Asset_Criticality": critical,
                },
            }
        )
    return records


VALIDATED_GRAPH = {
    "nodes": [
        {"id": "Patch_Applied"},
        {"id": "Lateral_Movement"},
        {"id": "Asset_Criticality"},
    ],
    "edges": [
        {"source": "Asset_Criticality", "target": "Patch_Applied",
         "status": "refuted", "p_value": 1.0},
        {"source": "Asset_Criticality", "target": "Lateral_Movement",
         "status": "confirmed", "p_value": 0.064},
        {"source": "Patch_Applied", "target": "Lateral_Movement",
         "status": "confirmed", "p_value": 0.0004},
    ],
    "treatment_variable": "Patch_Applied",
    "outcome_variable": "Lateral_Movement",
    "candidate_confounders": ["Asset_Criticality"],
}

ESTIMATE = {"ate": -0.30, "p_value": 0.001, "ci_low": -0.45, "ci_high": -0.15,
            "n_rows": 80, "method": "linear_regression"}


def test_anomalies_are_patched_hosts_with_movement():
    report = build_reasoning_report(demo_records(), VALIDATED_GRAPH, ESTIMATE)

    flagged = {a["asset_id"] for a in report["anomalies"]}
    # Patched group movement rate is 5% (2/40) — below the 15% threshold —
    # so exactly the two patched-but-moved hosts are flagged. The unpatched
    # group rate (35%) is unsurprising, so none of those hosts are flagged.
    assert flagged == {"host-000", "host-070"}
    for anomaly in report["anomalies"]:
        assert anomaly["explained"], anomaly
        assert anomaly["severity"] == "medium"
        causes = {c["variable"] for c in anomaly["explained_by"]}
        assert causes == {"Asset_Criticality"}
    assert report["stats"]["unexplained_anomaly_count"] == 0


def test_refuted_edges_do_not_explain_anomalies():
    graph = {**VALIDATED_GRAPH, "edges": [
        dict(e, status="refuted") for e in VALIDATED_GRAPH["edges"]
    ]}
    report = build_reasoning_report(demo_records(), graph, ESTIMATE)
    assert report["anomalies"], "anomalies should still be detected"
    # With every secondary cause refuted, anomalies become unexplained.
    assert all(not a["explained"] for a in report["anomalies"])
    assert all(a["severity"] == "high" for a in report["anomalies"])
    # Unexplained anomalies produce the top-priority recommendation.
    actions = {r["action"]: r for r in report["recommendations"]}
    assert "investigate_unexplained_anomalies" in actions
    assert actions["investigate_unexplained_anomalies"]["priority"] == 1


def test_treatment_recommendation_ranks_critical_hosts_first():
    report = build_reasoning_report(demo_records(), VALIDATED_GRAPH, ESTIMATE)
    actions = {r["action"]: r for r in report["recommendations"]}

    rec = actions["apply_patch_applied"]
    assert rec["target_count"] == 40  # all unpatched hosts
    # Critical unpatched hosts (host-005, host-015, ...) outrank the rest.
    assert rec["targets"][0] == "host-005"
    assert all(int(t.split("-")[1]) % 5 == 0 for t in rec["targets"][:8])
    assert rec["evidence"]["ate"] == -0.30

    # Explained anomalies yield a mitigation recommendation for the driver.
    mit = actions["mitigate_asset_criticality"]
    assert set(mit["targets"]) == {"host-000", "host-070"}
    assert mit["evidence"]["edge_status"] == "confirmed"


def test_zone_summary_localizes_anomalies():
    report = build_reasoning_report(demo_records(), VALIDATED_GRAPH, ESTIMATE)
    by_zone = {z["zone"]: z for z in report["zone_summary"]}
    # host-000 is in 10.0.1.0/24, host-070 in 10.0.5.0/24 (16 hosts per /24).
    assert by_zone["10.0.1.0/24"]["anomalies"] == 1
    assert by_zone["10.0.5.0/24"]["anomalies"] == 1
    assert sum(z["anomalies"] for z in report["zone_summary"]) == 2
    assert all(z["assets"] == 16 for z in report["zone_summary"])


def test_insufficient_inputs_warn_and_return_empty():
    report = build_reasoning_report([], VALIDATED_GRAPH, ESTIMATE)
    assert report["warnings"]
    assert not report["anomalies"] and not report["recommendations"]


def test_ingest_findings_places_anomalies_in_asset_zone():
    from graph_5d import get_5d_graph, ingest_findings, init_5d_schema, log_st_node

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_5d_schema(conn)
    run_id = "run-test"
    log_st_node(
        conn, run_id=run_id, node_id="asset.host-000", node_type="asset",
        label="Asset: host-000", description="",
        location={"subnet": "10.0.1.0/24", "ip": "10.0.1.10"},
        created_at="2026-05-12T00:00:00Z",
    )

    report = build_reasoning_report(demo_records(), VALIDATED_GRAPH, ESTIMATE)
    ingest_findings(conn, run_id, report, observed_at="2026-05-12T01:00:00Z")

    graph = get_5d_graph(conn, run_id)
    nodes = {n["id"]: n for n in graph["nodes"]}

    finding = nodes["finding.anomaly.host-000"]
    assert finding["node_type"] == "finding"
    # Anomaly inherits the asset's zone so spatial clustering is meaningful.
    assert finding["location"]["subnet"] == "10.0.1.0/24"
    assert finding["location"]["tier"] == "reasoning"

    decision_ids = [n for n in nodes if n.startswith("decision.")]
    assert "decision.apply_patch_applied" in decision_ids
    edge_predicates = {(e["source"], e["relationship"], e["target"])
                      for e in graph["edges"]}
    assert ("finding.anomaly.host-000", "flags", "asset.host-000") in edge_predicates
    assert (
        "finding.anomaly.host-000", "attributed_to", "causal.Asset_Criticality"
    ) in edge_predicates
