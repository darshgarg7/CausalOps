"""Barrier waits for coordinator phase advancement."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from coordinator.store import RunRecord, RunStore

logger = logging.getLogger(__name__)

DEFAULT_BARRIER_TIMEOUT_S = 600.0


async def wait_for_barrier(
    store: RunStore,
    run_id: str,
    predicate: Callable[[RunRecord], bool],
    *,
    timeout_s: float = DEFAULT_BARRIER_TIMEOUT_S,
    poll_interval_s: float = 0.05,
) -> RunRecord:
    """Poll run store until predicate is true or timeout."""

    elapsed = 0.0
    while elapsed < timeout_s:
        record = store.get_run(run_id)
        if predicate(record):
            return record
        await asyncio.sleep(poll_interval_s)
        elapsed += poll_interval_s

    record = store.get_run(run_id)
    raise TimeoutError(
        f"Barrier timeout for run {run_id} in phase {record.phase} "
        f"(parents {record.completed_parent_count}/{record.expected_parent_count}, "
        f"children {record.completed_child_count}/{record.expected_child_count})"
    )
