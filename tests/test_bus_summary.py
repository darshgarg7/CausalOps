"""Bus summary accumulator tests (no broker required)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from bus.context import (  # noqa: E402
    bind_run_context,
    clear_run_context,
    get_run_summary,
)
from bus.events import ArtifactType  # noqa: E402
from bus.publish import publish_artifact, publish_spawn  # noqa: E402
from bus.summary import RunBusSummary  # noqa: E402


def test_run_bus_summary_record() -> None:
    summary = RunBusSummary()
    summary.record(ArtifactType.AGENT_CONFIG)
    summary.record(ArtifactType.CHILD_CONFIG)
    summary.record(ArtifactType.CHILD_CONFIG)
    summary.record(ArtifactType.DECISION_MEMO)
    summary.record(ArtifactType.RANKED_STRATEGIES)
    summary.record(ArtifactType.CAUSAL_PAYLOAD)
    summary.record(ArtifactType.CAUSAL_ESTIMATE_REPORT)

    data = summary.to_dict()
    assert data["parent_config_count"] == 1
    assert data["child_config_count"] == 2
    assert data["memo_count"] == 1
    assert data["has_ranked_strategies"] is True
    assert data["has_causal_payload"] is True
    assert data["has_estimate_report"] is True


def test_publish_updates_run_summary(monkeypatch) -> None:
    monkeypatch.setattr(
        "bus.producer.publish_envelope_sync",
        lambda envelope: None,
    )
    bind_run_context("run-summary-test")
    try:
        publish_spawn(
            agent_id="orchestrator",
            tier="orchestrator",
            artifact_type=ArtifactType.AGENT_CONFIG,
            payload={"persona": "p", "focus_objective": "f"},
        )
        publish_artifact(
            agent_id="child:test",
            tier="child",
            artifact_type=ArtifactType.DECISION_MEMO,
            payload={"perspective": "x", "strategy": "y", "risks": []},
        )
        summary = get_run_summary()
        assert summary["parent_config_count"] == 1
        assert summary["memo_count"] == 1
    finally:
        clear_run_context()


def test_benchmarking_uses_summary_counts() -> None:
    from benchmarking import score_agent_tiers

    final_state = {
        "parent_configs": [],
        "child_configs": [],
        "memos": [],
        "ranked_strategies": [],
        "evaluator_error": None,
        "causal_payload": {"graph": {}},
        "causal_estimate_report": {
            "method": "withheld:data_quality_gates",
            "ate": None,
        },
    }
    summary = {
        "parent_config_count": 3,
        "child_config_count": 6,
        "memo_count": 6,
        "has_ranked_strategies": True,
    }
    metrics = score_agent_tiers(final_state, summary=summary)
    assert metrics["tiers"]["orchestrator"]["score"] == 1.0
    assert metrics["tiers"]["orchestrator"]["observed"] == 3
    assert metrics["tiers"]["child_agents"]["observed"] == 6
