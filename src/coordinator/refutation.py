"""Refutation loop termination rules shared by coordinator and legacy graph."""

from __future__ import annotations

import logging
from typing import Any, Literal

logger = logging.getLogger(__name__)


def refutation_next_step(state: dict[str, Any]) -> Literal["end", "causal_synthesis"]:
    """Stop when refuters pass or when estimation is explicitly withheld."""

    estimate_report = state.get("causal_estimate_report") or {}
    method = str(estimate_report.get("method", ""))
    attempts = int(state.get("causal_refutation_attempts", 0))
    if state.get("causal_refutation_passed", False) or method.startswith("withheld:"):
        return "end"
    if attempts >= 2:
        logger.info("Refutation failed after %s attempt(s); ending run", attempts)
        return "end"

    logger.info("Refutation failed; retrying causal synthesis")
    return "causal_synthesis"
