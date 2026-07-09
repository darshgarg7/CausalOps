"""Live round-trip test through the actual MCP protocol layer.

`tests/memory/test_mcp_tools.py` mocks ``SupabaseMemoryStore`` and never opens
a real client session — it proves the tool wrappers delegate correctly, not
that the MCP bridge itself works end to end. This test opens a real
``fastmcp.Client`` session against the live ``mcp`` server object (in-memory
transport — no Docker, no network hop, but the same protocol layer prompt 1's
``curl http://localhost:8001/sse`` check exercises over SSE) and calls
``write_run_to_memory`` then ``search_similar_incidents`` exactly as an MCP
client (Claude Code, Claude Desktop) would, against the real Supabase
project. Skipped automatically unless real Supabase credentials are
configured — see ``tests/memory/test_store.py`` for the same pattern. Run
with:

    pytest tests/memory/test_mcp_bridge.py -v -m integration
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from fastmcp import Client

from memory import mcp_server
from memory.store import SupabaseMemoryStore

pytestmark = pytest.mark.integration

_SKIP_REASON = "Real Supabase credentials not configured in .env"


def _has_credentials() -> bool:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    return bool(os.getenv("SUPABASE_URL")) and bool(key) and "your-" not in key


requires_credentials = pytest.mark.skipif(not _has_credentials(), reason=_SKIP_REASON)


@pytest.fixture
def tagged_run():
    tag = f"mcp-bridge-{uuid.uuid4().hex[:8]}"
    run_id = f"{tag}-run-1"
    yield {"tag": tag, "run_id": run_id}
    store = SupabaseMemoryStore()
    store._client.table("memory_entity_edges").delete().eq(
        "source_run_id", run_id
    ).execute()
    store._client.table("memory_runs").delete().eq("run_id", run_id).execute()
    store._client.table("memory_entities").delete().like(
        "entity_value", f"{tag}%"
    ).execute()


@requires_credentials
def test_write_then_search_round_trips_through_real_mcp_client(tagged_run) -> None:
    tag = tagged_run["tag"]
    run_id = tagged_run["run_id"]
    task_description = f"Incident {tag}: MCP bridge protocol round trip"

    async def _round_trip() -> tuple[dict, list[dict]]:
        async with Client(mcp_server.mcp) as client:
            write_result = await client.call_tool(
                "write_run_to_memory",
                {
                    "run_artifact": {
                        "run_id": run_id,
                        "task_description": task_description,
                        "memos": [],
                        "causal_graph": {},
                        "causal_estimate_report": {},
                    }
                },
            )
            search_result = await client.call_tool(
                "search_similar_incidents",
                {"description": task_description, "k": 3},
            )
            return write_result.data, search_result.data

    write_data, search_data = asyncio.run(_round_trip())

    assert write_data["run_id"] == run_id
    assert any(row.get("run_id") == run_id for row in search_data)
