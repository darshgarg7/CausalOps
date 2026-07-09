"""Unit tests for the standalone MCP server's tool wrappers.

The store is fully mocked — no Supabase or Azure calls happen here.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

from fastmcp import Client

from memory import mcp_server


def test_search_similar_incidents_delegates_to_store() -> None:
    mock_store = MagicMock()
    mock_store.search_similar_runs.return_value = [{"run_id": "run-1"}]

    with patch.object(mcp_server, "SupabaseMemoryStore", return_value=mock_store):
        result = mcp_server.search_similar_incidents("lateral movement", k=2)

    mock_store.search_similar_runs.assert_called_once_with("lateral movement", k=2)
    assert result == [{"run_id": "run-1"}]


def test_get_entity_relationships_delegates_to_store() -> None:
    mock_store = MagicMock()
    mock_store.get_entity_relationships.return_value = [{"relationship": "causes"}]

    with patch.object(mcp_server, "SupabaseMemoryStore", return_value=mock_store):
        result = mcp_server.get_entity_relationships("host-01", "asset")

    mock_store.get_entity_relationships.assert_called_once_with("host-01", "asset")
    assert result == [{"relationship": "causes"}]


def test_get_asset_timeline_delegates_to_store() -> None:
    mock_store = MagicMock()
    mock_store.get_asset_timeline.return_value = [{"created_at": "2026-01-01"}]

    with patch.object(mcp_server, "SupabaseMemoryStore", return_value=mock_store):
        result = mcp_server.get_asset_timeline("host-01", since_days=30)

    mock_store.get_asset_timeline.assert_called_once_with("host-01", since_days=30)
    assert result == [{"created_at": "2026-01-01"}]


def test_write_run_to_memory_delegates_to_store() -> None:
    mock_store = MagicMock()
    mock_store.write_run.return_value = {"run_id": "run-1", "entities_indexed": 3}
    artifact = {"run_id": "run-1", "task_description": "test"}

    with patch.object(mcp_server, "SupabaseMemoryStore", return_value=mock_store):
        result = mcp_server.write_run_to_memory(artifact)

    mock_store.write_run.assert_called_once_with(artifact)
    assert result == {"run_id": "run-1", "entities_indexed": 3}


def test_list_tools_exposes_all_four_tools() -> None:
    async def _list() -> list[str]:
        async with Client(mcp_server.mcp) as client:
            tools = await client.list_tools()
            return [tool.name for tool in tools]

    names = asyncio.run(_list())
    assert set(names) == {
        "search_similar_incidents",
        "get_entity_relationships",
        "get_asset_timeline",
        "write_run_to_memory",
    }


def test_search_similar_incidents_round_trips_through_mcp_protocol() -> None:
    mock_store = MagicMock()
    mock_store.search_similar_runs.return_value = [
        {"run_id": "run-1", "similarity": 0.9}
    ]

    async def _call() -> list[dict]:
        with patch.object(mcp_server, "SupabaseMemoryStore", return_value=mock_store):
            async with Client(mcp_server.mcp) as client:
                result = await client.call_tool(
                    "search_similar_incidents",
                    {"description": "lateral movement", "k": 2},
                )
                return result.data

    data = asyncio.run(_call())
    mock_store.search_similar_runs.assert_called_once_with("lateral movement", k=2)
    assert data == [{"run_id": "run-1", "similarity": 0.9}]
