"""Per-run publish context (run id, correlation id, sequence counters)."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass, field

from bus.summary import RunBusSummary


@dataclass
class RunPublishContext:
    """Tracks sequencing for one HiveMind run."""

    run_id: str
    correlation_id: str
    _sequences: dict[str, int] = field(default_factory=dict)
    summary: RunBusSummary = field(default_factory=RunBusSummary)

    def next_sequence(self, agent_id: str) -> int:
        current = self._sequences.get(agent_id, 0)
        self._sequences[agent_id] = current + 1
        return current


_run_context: ContextVar[RunPublishContext | None] = ContextVar(
    "hivemind_run_context",
    default=None,
)


def bind_run_context(run_id: str, correlation_id: str | None = None) -> RunPublishContext:
    """Bind publish context for the current async task / thread."""

    ctx = RunPublishContext(
        run_id=run_id,
        correlation_id=correlation_id or run_id,
    )
    _run_context.set(ctx)
    return ctx


def get_run_context() -> RunPublishContext | None:
    """Return the active run context, if any."""

    return _run_context.get()


def get_run_summary() -> dict[str, int | bool]:
    """Return bus artifact counters for the active run, or empty defaults."""

    ctx = get_run_context()
    if ctx is None:
        return RunBusSummary().to_dict()
    return ctx.summary.to_dict()


def clear_run_context() -> None:
    """Clear run context after a workflow finishes."""

    _run_context.set(None)
