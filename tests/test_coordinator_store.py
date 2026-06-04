"""Unit tests for coordinator run store."""

from __future__ import annotations

from pathlib import Path

import pytest

from coordinator.store import RunRecord, RunStore
from schema import AgentConfig, ChildConfig, DecisionMemo


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    return RunStore(db_path=tmp_path / "runs.db")


def test_create_and_load_run(store: RunStore) -> None:
    record = store.create_run(
        run_id="run-test-1",
        correlation_id="run-test-1",
        task_description="Investigate lateral movement in finance segment",
        evidence_records=[{"source_type": "manual", "source_name": "demo"}],
    )
    assert record.phase == "created"
    assert record.status == "running"

    loaded = store.get_run("run-test-1")
    assert loaded.task_description == record.task_description
    assert loaded.evidence_records == record.evidence_records


def test_append_child_configs_and_barrier(store: RunStore) -> None:
    record = store.create_run(
        run_id="run-test-2",
        correlation_id="run-test-2",
        task_description="Investigate lateral movement in finance segment",
    )
    record.parent_configs = [
        AgentConfig(persona="Network", focus_objective="Trace C2"),
        AgentConfig(persona="Identity", focus_objective="Review creds"),
    ]
    record.expected_parent_count = 2
    record.completed_parent_count = 2
    store.append_child_configs(
        record,
        [
            ChildConfig(
                parent_persona="Network",
                persona="DNS",
                focus_objective="Inspect DNS",
            )
        ],
    )
    store.append_child_configs(
        record,
        [
            ChildConfig(
                parent_persona="Identity",
                persona="MFA",
                focus_objective="Review MFA gaps",
            ),
            ChildConfig(
                parent_persona="Identity",
                persona="Sessions",
                focus_objective="Review sessions",
            ),
        ],
    )
    assert len(record.child_configs) == 3
    assert record.parents_barrier_met() is True

    record.expected_child_count = 3
    record.completed_child_count = 3
    assert record.children_barrier_met() is True


def test_apply_node_update_and_graph_state(store: RunStore) -> None:
    record = store.create_run(
        run_id="run-test-3",
        correlation_id="run-test-3",
        task_description="Investigate lateral movement in finance segment",
    )
    memo = DecisionMemo(
        perspective="Containment",
        strategy="Isolate affected hosts",
        risks=["Business disruption"],
    )
    record.apply_node_update(
        {
            "parent_configs": [
                AgentConfig(persona="Network", focus_objective="Trace C2"),
            ],
            "memos": [memo],
            "causal_refutation_attempts": 1,
        }
    )
    state = record.to_graph_state()
    assert len(state["parent_configs"]) == 1
    assert len(state["memos"]) == 1
    assert state["causal_refutation_attempts"] == 1
