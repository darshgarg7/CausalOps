"""Standalone MCP server exposing the CausalOps memory layer.

Runs as its own process — ``python -m memory.mcp_server`` — on stdio
(Claude Desktop/Code) or SSE (docker, HTTP clients) depending on
``MCP_TRANSPORT``. Never mounted inside the FastAPI app in api.py.
"""

from __future__ import annotations

import os
from typing import Any

from fastmcp import FastMCP

from memory.store import SupabaseMemoryStore

mcp = FastMCP(
    "causalops-memory",
    instructions=(
        "CausalOps persistent memory server. Use search_similar_incidents to "
        "retrieve context before starting a run. Use write_run_to_memory "
        "after DoWhy completes."
    ),
)


@mcp.tool()
def search_similar_incidents(description: str, k: int = 5) -> list[dict[str, Any]]:
    """Search past CausalOps runs similar to the given incident description.

    Returns ranked results with similarity score, temporal weight, and a
    summary of the causal graph and estimate report from each past run.
    """

    return SupabaseMemoryStore().search_similar_runs(description, k=k)


@mcp.tool()
def get_entity_relationships(
    entity_value: str, entity_type: str
) -> list[dict[str, Any]]:
    """Get all known relationships for an entity.

    ``entity_type`` is one of: asset, technique, cve, graph_node. Returns
    edges with source, relationship type, target, and source run ID.
    """

    return SupabaseMemoryStore().get_entity_relationships(entity_value, entity_type)


@mcp.tool()
def get_asset_timeline(asset_id: str, since_days: int = 90) -> list[dict[str, Any]]:
    """Get the chronological event timeline for an asset over the past N days."""

    return SupabaseMemoryStore().get_asset_timeline(asset_id, since_days=since_days)


@mcp.tool()
def write_run_to_memory(run_artifact: dict[str, Any]) -> dict[str, Any]:
    """Store a completed CausalOps run in the memory layer.

    Embeds the task description, indexes entities, and builds knowledge
    graph edges. Returns ``{"run_id": str, "entities_indexed": int}``.
    """

    return SupabaseMemoryStore().write_run(run_artifact)


if __name__ == "__main__":
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run(transport=transport)  # type: ignore[arg-type]
    else:
        mcp.run(
            transport=transport,  # type: ignore[arg-type]
            host=os.getenv("MCP_HOST", "0.0.0.0"),
            port=int(os.getenv("MCP_PORT", "8001")),
        )
