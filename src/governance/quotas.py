"""Per-run child-spawn quotas (skeleton).

Governs how many child agents a single run may spawn. Controlled by
``HIVEMIND_MAX_CHILDREN_PER_RUN`` (default ``0`` = unlimited => no-op), matching
the repo's ``HIVEMIND_*`` convention. ``HIVEMIND_GOVERNANCE_ENABLED=0`` also
disables enforcement globally.

STATUS: STUB. :func:`check_spawn_allowed` currently returns ``True`` whenever
governance is disabled or the limit is unlimited. The per-run child counter and
the actual enforcement hook are intentionally NOT implemented yet: the worker
spawn consumer (``src/worker/consumer.py``) will call this function — and record
spawns against a run — in a follow-up PR. This module is deliberately left
un-wired so it introduces no behavior change on its own.
"""

from __future__ import annotations

import os

GOVERNANCE_ENABLED = os.getenv("HIVEMIND_GOVERNANCE_ENABLED", "1") == "1"


def _max_children_per_run() -> int:
    """Return the configured per-run child cap (0 or negative => unlimited)."""

    try:
        return int(os.getenv("HIVEMIND_MAX_CHILDREN_PER_RUN", "0"))
    except ValueError:
        return 0


def check_spawn_allowed(run_id: str, tier: str) -> bool:
    """Return whether ``run_id`` may spawn another child agent at ``tier``.

    STUB: returns ``True`` unless governance is disabled-checked and a positive
    cap is configured; the actual per-run counting is deferred (see module
    docstring). With the default config (``HIVEMIND_MAX_CHILDREN_PER_RUN=0``)
    this is always ``True`` — a strict no-op.

    The follow-up consumer wiring will (a) increment a per-run counter as
    children are dispatched and (b) return ``False`` here once the cap is
    reached.
    """

    if not GOVERNANCE_ENABLED:
        return True

    max_children = _max_children_per_run()
    if max_children <= 0:
        return True  # unlimited => no-op

    # TODO(follow-up): consult the per-run child counter populated by the spawn
    # consumer and return False once ``max_children`` is reached. Until that
    # wiring lands we do not have a count to enforce against, so allow.
    return True
