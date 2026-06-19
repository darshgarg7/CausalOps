"""Shared helpers for binding publish context inside graph nodes."""

from __future__ import annotations

from typing import Any, Mapping

from bus.context import bind_run_context


def bind_from_state(state: Mapping[str, Any]) -> None:
    """Bind Kafka publish context from LangGraph state (sync or fan-out nodes)."""

    run_id = state.get("run_id")
    if not run_id:
        return
    bind_run_context(run_id, state.get("correlation_id"))
