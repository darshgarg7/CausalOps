"""Fallbacks for providers returning empty structured outputs."""

from __future__ import annotations

import importlib
import sys
from types import ModuleType

from langchain_core.runnables import RunnableLambda

from schema import DecisionMemo


class _FakeLLM:
    def with_structured_output(self, _schema):
        return RunnableLambda(lambda _input: None)


def _install_empty_llm(monkeypatch) -> None:
    fake_llm = ModuleType("llm")
    fake_llm.get_llm = lambda temperature=0.0: _FakeLLM()
    monkeypatch.setitem(sys.modules, "llm", fake_llm)


def test_child_agent_empty_structured_output_uses_fallback(monkeypatch) -> None:
    _install_empty_llm(monkeypatch)
    monkeypatch.delitem(sys.modules, "agents", raising=False)
    agents = importlib.import_module("agents")
    monkeypatch.setattr(agents, "publish_telemetry", lambda **_: None)
    monkeypatch.setattr(agents, "publish_artifact", lambda **_: None)

    update = agents.child_agent_node(
        {
            "task_description": "Investigate ransomware in cloud identity systems",
            "run_id": "run-empty-child",
            "correlation_id": "run-empty-child",
            "parent_persona": "Identity",
            "persona": "AWS Identity Forensics",
            "focus_objective": "Inspect privilege escalation paths",
            "policy": None,
        }
    )

    memo = update["memos"][0]
    assert isinstance(memo, DecisionMemo)
    assert memo.perspective == "AWS Identity Forensics"
    assert "structured memo output was empty" in memo.strategy


def test_evaluator_empty_structured_output_is_recoverable(monkeypatch) -> None:
    _install_empty_llm(monkeypatch)
    monkeypatch.delitem(sys.modules, "evaluator", raising=False)
    evaluator = importlib.import_module("evaluator")
    monkeypatch.setattr(evaluator, "publish_telemetry", lambda **_: None)
    monkeypatch.setattr(evaluator, "publish_artifact", lambda **_: None)

    update = evaluator.evaluate_memos_node(
        {
            "task_description": "Investigate ransomware in cloud identity systems",
            "run_id": "run-empty-evaluator",
            "correlation_id": "run-empty-evaluator",
            "memos": [
                DecisionMemo(
                    perspective="Identity",
                    strategy="Contain suspicious sessions",
                    risks=["Business disruption"],
                )
            ],
        }
    )

    assert update["ranked_strategies"] == []
    assert update["final_recommendation"] is None
    assert "structured evaluator output was empty" in update["evaluator_error"]


def test_causal_empty_structured_output_uses_richer_fallback(monkeypatch) -> None:
    _install_empty_llm(monkeypatch)
    monkeypatch.delitem(sys.modules, "causal", raising=False)
    causal = importlib.import_module("causal")
    monkeypatch.setattr(causal, "publish_telemetry", lambda **_: None)
    monkeypatch.setattr(causal, "publish_artifact", lambda **_: None)
    monkeypatch.setattr(causal, "bind_from_state", lambda _: None)

    update = causal.causal_synthesis_node(
        {
            "task_description": "Investigate ransomware in cloud identity systems",
            "run_id": "run-empty-causal",
            "correlation_id": "run-empty-causal",
            "memos": [
                DecisionMemo(
                    perspective="Containment",
                    strategy="Disable suspect sessions and isolate exposed assets",
                    risks=["Temporary business disruption"],
                )
            ],
            "ranked_strategies": [],
            "evidence_records": [],
        }
    )

    graph = update["causal_payload"]["graph"]
    node_ids = {node["id"] for node in graph["nodes"]}
    assert len(graph["nodes"]) >= 5
    assert len(graph["edges"]) >= 5
    assert graph["treatment_variable"] == "containment_action"
    assert graph["outcome_variable"] == "adversary_impact"
    assert {"asset_exposure", "detection_coverage", "adversary_dwell_time"} <= node_ids
