"""Coordinator runner tests with mocked agent nodes."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from coordinator.runner import execute_run
from coordinator.store import RunStore, set_run_store
from schema import AgentConfig, ChildConfig, DecisionMemo


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    run_store = RunStore(db_path=tmp_path / "runs.db")
    set_run_store(run_store)
    yield run_store
    set_run_store(None)


def _install_fake_nodes(
    *,
    fake_orchestrator,
    fake_parent,
    fake_child,
    fake_evaluator,
    fake_causal,
    fake_estimator,
) -> None:
    agents = ModuleType("agents")
    agents.grand_orchestrator_node = fake_orchestrator
    agents.parent_agent_node = fake_parent
    agents.child_agent_node = fake_child

    evaluator = ModuleType("evaluator")
    evaluator.evaluate_memos_node = fake_evaluator

    causal = ModuleType("causal")
    causal.causal_synthesis_node = fake_causal
    causal.dowhy_engine_node = fake_estimator

    sys.modules["agents"] = agents
    sys.modules["evaluator"] = evaluator
    sys.modules["causal"] = causal


def test_execute_run_with_mocked_nodes(store: RunStore, monkeypatch) -> None:
    parent_a = AgentConfig(persona="Network", focus_objective="Trace C2")
    child_a = ChildConfig(
        parent_persona="Network",
        persona="DNS",
        focus_objective="Inspect DNS",
    )
    child_b = ChildConfig(
        parent_persona="Network",
        persona="Firewall",
        focus_objective="Inspect egress",
    )
    memo_a = DecisionMemo(
        perspective="Containment",
        strategy="Isolate hosts",
        risks=["Downtime"],
    )
    memo_b = DecisionMemo(
        perspective="Detection",
        strategy="Deploy detections",
        risks=["Noise"],
    )

    def fake_orchestrator(_state: dict[str, Any]) -> dict[str, Any]:
        return {"parent_configs": [parent_a]}

    def fake_parent(_state: dict[str, Any]) -> dict[str, Any]:
        return {"child_configs": [child_a, child_b]}

    def fake_child(_state: dict[str, Any]) -> dict[str, Any]:
        persona = _state["persona"]
        memo = memo_a if persona == "DNS" else memo_b
        return {"memos": [memo]}

    def fake_evaluator(_state: dict[str, Any]) -> dict[str, Any]:
        return {
            "ranked_strategies": [{"ranked_perspectives": ["Containment"]}],
            "final_recommendation": "Isolate hosts",
            "evaluator_error": None,
        }

    def fake_causal(_state: dict[str, Any]) -> dict[str, Any]:
        return {
            "causal_payload": {
                "graph": {
                    "nodes": [],
                    "edges": [],
                    "treatment_variable": "treatment",
                    "outcome_variable": "outcome",
                    "candidate_confounders": [],
                }
            },
            "causal_refutation_passed": False,
        }

    def fake_estimator(_state: dict[str, Any]) -> dict[str, Any]:
        return {
            "dowhy_results": {"ate_estimate": None, "method": "withheld:demo"},
            "causal_estimate_report": {"method": "withheld:demo", "ate": None},
            "causal_dataset_profile": {},
            "causal_refutation_passed": False,
            "causal_refutation_attempts": 1,
        }

    _install_fake_nodes(
        fake_orchestrator=fake_orchestrator,
        fake_parent=fake_parent,
        fake_child=fake_child,
        fake_evaluator=fake_evaluator,
        fake_causal=fake_causal,
        fake_estimator=fake_estimator,
    )
    monkeypatch.setattr("coordinator.runner.publish_telemetry", lambda **_: None)
    monkeypatch.setattr("coordinator.runner.bind_from_state", lambda _: None)

    final_state = asyncio.run(
        execute_run(
            task_description="Investigate lateral movement in finance segment",
            run_id="run-coord-1",
            correlation_id="run-coord-1",
            store=store,
        )
    )

    assert len(final_state["memos"]) == 2
    assert final_state["final_recommendation"] == "Isolate hosts"
    assert final_state["causal_estimate_report"]["method"] == "withheld:demo"

    persisted = store.get_run("run-coord-1")
    assert persisted.status == "completed"
    assert persisted.phase == "reasoning"
    assert persisted.children_barrier_met() is True
