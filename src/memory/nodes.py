"""Async memory nodes: retrieve past context, then persist a finished run.

These are written as ``GraphState -> dict`` node functions for structural
consistency with the rest of the pipeline. Production execution calls them
from ``coordinator/runner.py`` as coordinator phases (``graph.py``'s
LangGraph topology is not executed — see its module docstring).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from schema import GraphState

logger = logging.getLogger(__name__)

_RETRIEVE_K = 3


def _memory_configured() -> bool:
    return bool(os.getenv("SUPABASE_URL")) and bool(
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    )


async def memory_retrieve_node(state: GraphState) -> dict[str, Any]:
    """Retrieve the most similar past runs before the orchestrator runs."""

    if not _memory_configured():
        logger.info("Memory layer not configured; skipping retrieval")
        return {"memory_context": []}

    from memory.store import SupabaseMemoryStore

    store = SupabaseMemoryStore()
    results = await asyncio.to_thread(
        store.search_similar_runs, state["task_description"], _RETRIEVE_K
    )
    return {"memory_context": [_summarize_result(result) for result in results]}


async def memory_write_node(state: GraphState) -> dict[str, Any]:
    """Persist the completed run to memory after estimation finishes.

    Never called from within a try/except of its own — callers (the
    coordinator's memory_write phase) own the "never crash a run" guarantee.
    """

    if not _memory_configured():
        logger.info("Memory layer not configured; skipping write")
        return {}

    from memory.store import SupabaseMemoryStore

    run_artifact = {
        "run_id": state["run_id"],
        "task_description": state["task_description"],
        "memos": [_serialize(memo) for memo in state.get("memos", [])],
        "causal_graph": (state.get("causal_payload") or {}).get("graph"),
        "causal_estimate_report": state.get("causal_estimate_report"),
        "evidence_records": state.get("evidence_records", []),
    }

    store = SupabaseMemoryStore()
    result = await asyncio.to_thread(store.write_run, run_artifact)
    logger.info(
        "Wrote run %s to memory (%s entities indexed)",
        result.get("run_id"),
        result.get("entities_indexed"),
    )
    return {}


def _summarize_result(result: dict[str, Any]) -> dict[str, Any]:
    """Trim a search_similar_runs row to what's worth putting in a prompt."""

    estimate_report = result.get("estimate_report") or {}
    return {
        "run_id": result.get("run_id"),
        "task_description": result.get("task_description"),
        "similarity": result.get("similarity"),
        "weighted_score": result.get("weighted_score"),
        "created_at": result.get("created_at"),
        "ate": estimate_report.get("ate"),
        "method": estimate_report.get("method"),
        "n_rows": estimate_report.get("n_rows"),
    }


def _serialize(memo: Any) -> Any:
    if hasattr(memo, "model_dump"):
        return memo.model_dump()
    return memo
