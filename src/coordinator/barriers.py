"""Barrier waits for coordinator phase advancement."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from time import monotonic

from coordinator.store import RunRecord, RunStore

logger = logging.getLogger(__name__)

DEFAULT_BARRIER_TIMEOUT_S = 1800.0


def _barrier_timeout_s() -> float:
    try:
        return max(
            60.0,
            float(os.getenv("CAUSALOPS_BARRIER_TIMEOUT_S", DEFAULT_BARRIER_TIMEOUT_S)),
        )
    except ValueError:
        return DEFAULT_BARRIER_TIMEOUT_S


async def wait_for_barrier(
    store: RunStore,
    run_id: str,
    predicate: Callable[[RunRecord], bool],
    *,
    timeout_s: float | None = None,
    poll_interval_s: float = 0.05,
) -> RunRecord:
    """Poll run store until predicate is true or timeout."""

    started_at = monotonic()
    timeout = _barrier_timeout_s() if timeout_s is None else timeout_s
    deadline = started_at + timeout
    while monotonic() < deadline:
        record = store.get_run(run_id)
        if predicate(record):
            return record
        await asyncio.sleep(poll_interval_s)

    record = store.get_run(run_id)
    raise TimeoutError(
        f"Barrier timeout for run {run_id} in phase {record.phase} "
        f"(parents {record.completed_parent_count}/{record.expected_parent_count}, "
        f"children {record.completed_child_count}/{record.expected_child_count})"
    )
