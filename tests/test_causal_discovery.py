"""Tests for data-driven causal DAG discovery and validation (item b).

The demo fixture encodes a textbook collider: Patch_Applied and
Asset_Criticality are independent by construction, and both drive
Lateral_Movement. Discovery must therefore recover both true edge directions
from the data alone (collider orientation) and refute the fixture's false
"criticality drives patching" edge.
"""

import os
import sqlite3
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from causal_discovery import (
    apply_discovery,
    discover_and_validate,
    estimation_edges,
)


HYPOTHESIZED_EDGES = [
    {"source": "Asset_Criticality", "target": "Patch_Applied",
     "relationship": "Critical assets are prioritized for patching."},
    {"source": "Asset_Criticality", "target": "Lateral_Movement",
     "relationship": "Critical assets attract more adversary movement."},
    {"source": "Patch_Applied", "target": "Lateral_Movement",
     "relationship": "Patching reduces exploitability and movement."},
]


def demo_dataframe(n_rows: int = 80) -> pd.DataFrame:
    """Mirror demo_fixtures.patch_lateral_movement_evidence as a dataframe."""

    rows = []
    for index in range(n_rows):
        treated = 1 if index % 2 == 0 else 0
        critical = 1 if index % 5 == 0 else 0
        outcome = int(
            (not treated and index % 3 == 0) or (critical and index % 7 == 0)
        )
        rows.append(
            {
                "Patch_Applied": treated,
                "Lateral_Movement": outcome,
                "Asset_Criticality": critical,
            }
        )
    return pd.DataFrame(rows)


def test_collider_emerges_from_demo_data():
    report = discover_and_validate(demo_dataframe(), HYPOTHESIZED_EDGES)

    assert report.performed
    # Skeleton: PA—LM and AC—LM, but not PA—AC (independent by construction).
    assert ("Lateral_Movement", "Patch_Applied") in report.skeleton
    assert ("Asset_Criticality", "Lateral_Movement") in report.skeleton
    assert ("Asset_Criticality", "Patch_Applied") not in report.skeleton
    # Collider orientation recovers both true directions from data alone.
    assert ("Patch_Applied", "Lateral_Movement") in report.oriented
    assert ("Asset_Criticality", "Lateral_Movement") in report.oriented

    by_pair = {frozenset((v.source, v.target)): v.status for v in report.verdicts}
    assert by_pair[frozenset(("Asset_Criticality", "Patch_Applied"))] == "refuted"
    assert by_pair[frozenset(("Patch_Applied", "Lateral_Movement"))] == "confirmed"
    assert by_pair[frozenset(("Asset_Criticality", "Lateral_Movement"))] == "confirmed"


def test_apply_discovery_marks_statuses_and_filters_estimation():
    graph_def = {
        "nodes": [],
        "edges": HYPOTHESIZED_EDGES,
        "treatment_variable": "Patch_Applied",
        "outcome_variable": "Lateral_Movement",
        "candidate_confounders": ["Asset_Criticality"],
    }
    report = discover_and_validate(demo_dataframe(), HYPOTHESIZED_EDGES)
    validated = apply_discovery(graph_def, report)

    statuses = {
        (e["source"], e["target"]): e["status"] for e in validated["edges"]
    }
    # Refuted edge is kept (for graph/UI downgrade) but marked.
    assert statuses[("Asset_Criticality", "Patch_Applied")] == "refuted"
    assert statuses[("Patch_Applied", "Lateral_Movement")] == "confirmed"
    # Estimation excludes refuted edges.
    est = {(e["source"], e["target"]) for e in estimation_edges(validated)}
    assert ("Asset_Criticality", "Patch_Applied") not in est
    assert ("Patch_Applied", "Lateral_Movement") in est
    # Validated edges carry their evidence.
    confirmed = next(
        e for e in validated["edges"]
        if (e["source"], e["target"]) == ("Patch_Applied", "Lateral_Movement")
    )
    assert confirmed["p_value"] is not None and confirmed["p_value"] < 0.05
    assert confirmed["strength"] is not None and confirmed["strength"] > 0


def test_insufficient_rows_falls_back_to_hypothesis():
    report = discover_and_validate(demo_dataframe(10), HYPOTHESIZED_EDGES)
    assert not report.performed
    assert report.warnings

    graph_def = {"edges": HYPOTHESIZED_EDGES, "nodes": []}
    validated = apply_discovery(graph_def, report)
    assert len(validated["edges"]) == len(HYPOTHESIZED_EDGES)
    assert all(e["status"] == "hypothesized" for e in validated["edges"])
    # Nothing is dropped from estimation when discovery did not run.
    assert len(estimation_edges(validated)) == len(HYPOTHESIZED_EDGES)


def test_ingest_causal_updates_edge_status_in_place():
    from graph_5d import get_5d_graph, ingest_causal, init_5d_schema

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_5d_schema(conn)
    run_id = "run-test"

    hypothesized = {
        "nodes": [{"id": "A", "label": "A"}, {"id": "B", "label": "B"}],
        "edges": [{"source": "A", "target": "B", "relationship": "drives"}],
    }
    ingest_causal(conn, run_id, hypothesized, observed_at="2026-05-12T00:00:00Z")

    validated = {
        "nodes": hypothesized["nodes"],
        "edges": [
            {
                "source": "A",
                "target": "B",
                "relationship": "drives",
                "status": "refuted",
                "p_value": 0.8,
                "validation_detail": "Marginally independent.",
            }
        ],
    }
    ingest_causal(conn, run_id, validated, observed_at="2026-05-12T00:05:00Z")

    graph = get_5d_graph(conn, run_id)
    causal_edges = [
        e for e in graph["edges"] if e["source"] == "causal.A"
    ]
    # Updated in place: one edge, downgraded, status recorded.
    assert len(causal_edges) == 1
    assert causal_edges[0]["confidence"] == 0.05
    assert causal_edges[0]["metadata"]["status"] == "refuted"
