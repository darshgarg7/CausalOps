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
            execution_mode="deep",
            store=store,
        )
    )

    assert len(final_state["memos"]) == 2
    assert final_state["final_recommendation"] == "Isolate hosts"
    assert final_state["causal_estimate_report"]["method"] == "withheld:demo"

    persisted = store.get_run("run-coord-1")
    assert persisted.status == "completed"
    assert persisted.phase == "memory_write"
    assert persisted.children_barrier_met() is True
    assert persisted.agent_evolution_report is not None
    assert persisted.policy_optimization_report is not None


def test_standard_mode_skips_expensive_planning_nodes(
    store: RunStore,
    monkeypatch,
) -> None:
    memo_a = DecisionMemo(
        perspective="Containment",
        strategy="Disable suspect sessions and isolate exposed assets",
        risks=["Temporary business disruption"],
        assumptions=["Incident is active"],
        evidence_needs=["identity logs", "endpoint telemetry"],
        confidence="high",
    )
    memo_b = DecisionMemo(
        perspective="Evidence",
        strategy="Collect causal evidence before broad remediation",
        risks=["Delayed containment"],
        assumptions=["Telemetry is available"],
        evidence_needs=["SIEM alerts", "cloud audit logs", "network egress"],
        confidence="medium",
    )

    calls = {
        "orchestrator": 0,
        "parent": 0,
        "child": 0,
        "evaluator": 0,
        "causal_synthesis": 0,
    }

    def fake_orchestrator(_state: dict[str, Any]) -> dict[str, Any]:
        calls["orchestrator"] += 1
        return {"parent_configs": []}

    def fake_parent(_state: dict[str, Any]) -> dict[str, Any]:
        calls["parent"] += 1
        return {"child_configs": []}

    def fake_child(_state: dict[str, Any]) -> dict[str, Any]:
        calls["child"] += 1
        memo = memo_a if "Containment" in _state["persona"] else memo_b
        return {"memos": [memo]}

    def fake_evaluator(_state: dict[str, Any]) -> dict[str, Any]:
        calls["evaluator"] += 1
        return {"ranked_strategies": [], "final_recommendation": None}

    def fake_causal(_state: dict[str, Any]) -> dict[str, Any]:
        calls["causal_synthesis"] += 1
        return {"causal_payload": {}, "causal_refutation_passed": False}

    def fake_estimator(_state: dict[str, Any]) -> dict[str, Any]:
        return {
            "dowhy_results": {"ate_estimate": None, "method": "withheld:standard"},
            "causal_estimate_report": {"method": "withheld:standard", "ate": None},
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

    causal = sys.modules["causal"]
    causal._fallback_causal_payload = lambda _memos: {
        "graph": {
            "nodes": [],
            "edges": [],
            "treatment_variable": "treatment",
            "outcome_variable": "outcome",
            "candidate_confounders": [],
        },
        "measurement_plan": [],
        "edge_evidence_requirements": [],
    }
    causal._sanitize_graph = lambda graph: graph

    def fake_reasoning(_state: dict[str, Any]) -> dict[str, Any]:
        return {"reasoning_report": {"stats": {}, "recommendations": []}}

    reasoning = ModuleType("reasoning")
    reasoning.reasoning_node = fake_reasoning
    sys.modules["reasoning"] = reasoning

    monkeypatch.setattr("coordinator.runner.publish_telemetry", lambda **_: None)
    monkeypatch.setattr("coordinator.runner.publish_artifact", lambda **_: None)
    monkeypatch.setattr("coordinator.runner.bind_from_state", lambda _: None)

    final_state = asyncio.run(
        execute_run(
            task_description="Investigate ransomware blast radius in cloud identity",
            run_id="run-coord-standard",
            correlation_id="run-coord-standard",
            execution_mode="standard",
            store=store,
        )
    )

    assert calls == {
        "orchestrator": 0,
        "parent": 0,
        "child": 2,
        "evaluator": 0,
        "causal_synthesis": 0,
    }
    assert final_state["execution_mode"] == "standard"
    assert len(final_state["parent_configs"]) == 1
    assert len(final_state["child_configs"]) == 2
    assert len(final_state["memos"]) == 2
    assert final_state["ranked_strategies"][0]["ranked_perspectives"][0] == "Evidence"
