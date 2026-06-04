"""Unit tests for refutation loop termination."""

from __future__ import annotations

from coordinator.refutation import refutation_next_step


def test_refutation_passed_ends() -> None:
    state = {
        "causal_refutation_passed": True,
        "causal_refutation_attempts": 1,
        "causal_estimate_report": {"method": "backdoor.linear_regression"},
    }
    assert refutation_next_step(state) == "end"


def test_withheld_method_ends() -> None:
    state = {
        "causal_refutation_passed": False,
        "causal_refutation_attempts": 1,
        "causal_estimate_report": {"method": "withheld:insufficient_data"},
    }
    assert refutation_next_step(state) == "end"


def test_max_attempts_ends() -> None:
    state = {
        "causal_refutation_passed": False,
        "causal_refutation_attempts": 2,
        "causal_estimate_report": {"method": "backdoor.linear_regression"},
    }
    assert refutation_next_step(state) == "end"


def test_failed_refutation_retries() -> None:
    state = {
        "causal_refutation_passed": False,
        "causal_refutation_attempts": 1,
        "causal_estimate_report": {"method": "backdoor.linear_regression"},
    }
    assert refutation_next_step(state) == "causal_synthesis"
