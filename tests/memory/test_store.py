"""Integration tests for SupabaseMemoryStore against the real project.

Skipped automatically unless SUPABASE_SERVICE_ROLE_KEY is a real (non-
placeholder) value in .env. Run with:

    pytest tests/memory/test_store.py -v
"""

from __future__ import annotations

import os
import uuid

import pytest

from memory.store import SupabaseMemoryStore

pytestmark = pytest.mark.integration

_SKIP_REASON = "Real Supabase credentials not configured in .env"


def _has_credentials() -> bool:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    return bool(os.getenv("SUPABASE_URL")) and bool(key) and "your-" not in key


requires_credentials = pytest.mark.skipif(not _has_credentials(), reason=_SKIP_REASON)


@pytest.fixture
def run_artifact():
    run_id = f"test-{uuid.uuid4().hex[:12]}"
    yield {
        "run_id": run_id,
        "task_description": "Integration test: suspected lateral movement via RDP",
        "memos": [],
        "causal_graph": {
            "nodes": [{"id": "Patch_Applied"}, {"id": "Lateral_Movement"}],
            "edges": [
                {
                    "source": "Patch_Applied",
                    "target": "Lateral_Movement",
                    "relationship": "reduces likelihood of",
                }
            ],
        },
        "causal_estimate_report": {
            "ate": -0.3,
            "method": "backdoor.linear_regression",
            "n_rows": 40,
        },
        "evidence_records": [
            {"asset_id": "test-host-01", "technique_id": "T1021.001", "cve_id": None}
        ],
    }
    _cleanup(run_id)


def _cleanup(run_id: str) -> None:
    store = SupabaseMemoryStore()
    store._client.table("memory_entity_edges").delete().eq(
        "source_run_id", run_id
    ).execute()
    store._client.table("memory_runs").delete().eq("run_id", run_id).execute()


@requires_credentials
def test_write_run_inserts_row_and_indexes_entities(run_artifact) -> None:
    store = SupabaseMemoryStore()
    result = store.write_run(run_artifact)

    assert result["run_id"] == run_artifact["run_id"]
    assert result["entities_indexed"] > 0


@requires_credentials
def test_search_similar_runs_returns_expected_shape(run_artifact) -> None:
    store = SupabaseMemoryStore()
    store.write_run(run_artifact)

    results = store.search_similar_runs(run_artifact["task_description"], k=3)

    assert isinstance(results, list)
    assert results
    top = results[0]
    expected_keys = (
        "run_id",
        "task_description",
        "similarity",
        "weighted_score",
        "created_at",
    )
    for key in expected_keys:
        assert key in top


@requires_credentials
def test_get_entity_relationships_returns_edges(run_artifact) -> None:
    store = SupabaseMemoryStore()
    store.write_run(run_artifact)

    edges = store.get_entity_relationships("Patch_Applied", "graph_node")

    assert isinstance(edges, list)
    assert any(edge.get("target_value") == "Lateral_Movement" for edge in edges)


@requires_credentials
def test_get_asset_timeline_returns_chronological_list(run_artifact) -> None:
    store = SupabaseMemoryStore()
    store.write_run(run_artifact)

    timeline = store.get_asset_timeline("test-host-01", since_days=1)

    assert isinstance(timeline, list)
