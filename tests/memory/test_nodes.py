"""Integration tests for the async memory coordinator nodes.

The missing-credentials test needs no network access. The rest require a
real Supabase project (see .env) and are skipped otherwise. Run with:

    pytest tests/memory/test_nodes.py -v
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

from memory.nodes import memory_retrieve_node, memory_write_node

pytestmark = pytest.mark.integration

_SKIP_REASON = "Real Supabase credentials not configured in .env"


def _has_credentials() -> bool:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    return bool(os.getenv("SUPABASE_URL")) and bool(key) and "your-" not in key


requires_credentials = pytest.mark.skipif(not _has_credentials(), reason=_SKIP_REASON)


def test_memory_retrieve_node_without_credentials_degrades_gracefully(
    monkeypatch,
) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    state = {"task_description": "unused", "run_id": "run-x"}
    result = asyncio.run(memory_retrieve_node(state))

    assert result == {"memory_context": []}


@requires_credentials
def test_memory_retrieve_node_returns_memory_context() -> None:
    state = {"task_description": "generic incident about privilege escalation"}
    result = asyncio.run(memory_retrieve_node(state))

    assert "memory_context" in result
    assert isinstance(result["memory_context"], list)


@requires_credentials
def test_memory_write_node_persists_a_run() -> None:
    run_id = f"test-{uuid.uuid4().hex[:12]}"
    state = {
        "run_id": run_id,
        "task_description": "Integration test via memory_write_node",
        "memos": [],
        "causal_payload": {"graph": {"nodes": [], "edges": []}},
        "causal_estimate_report": {
            "ate": None,
            "method": "withheld:data_quality_gates",
        },
        "evidence_records": [],
    }

    result = asyncio.run(memory_write_node(state))
    assert result == {}

    from memory.store import SupabaseMemoryStore

    store = SupabaseMemoryStore()
    try:
        found = store.search_similar_runs(state["task_description"], k=5)
        assert any(row.get("run_id") == run_id for row in found)
    finally:
        store._client.table("memory_runs").delete().eq("run_id", run_id).execute()
