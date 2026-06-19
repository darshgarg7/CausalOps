"""Tests for spawn work command dispatch (Kafka-off inline path)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from bus.events import ArtifactType
from coordinator.spawn import build_child_command, build_parent_command
from coordinator.store import RunStore, set_run_store
from schema import AgentConfig, ChildConfig, DecisionMemo
from worker.dispatch import dispatch_spawn_envelope


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    run_store = RunStore(db_path=tmp_path / "runs.db")
    set_run_store(run_store)
    yield run_store
    set_run_store(None)


def test_spawn_command_topics() -> None:
    from bus.topics import TOPIC_SPAWN, topic_for_artifact

    assert topic_for_artifact(ArtifactType.RUN_PARENT) == TOPIC_SPAWN
    assert topic_for_artifact(ArtifactType.RUN_CHILD) == TOPIC_SPAWN
    assert topic_for_artifact(ArtifactType.TASK_COMPLETED) != TOPIC_SPAWN


def test_dispatch_parent_and_child_commands(store: RunStore, monkeypatch) -> None:
    record = store.create_run(
        run_id="run-worker-1",
        correlation_id="run-worker-1",
        task_description="Investigate lateral movement in finance segment",
    )
    record.parent_configs = [AgentConfig(persona="Network", focus_objective="Trace C2")]
    record.expected_parent_count = 1
    store.save(record)

    child = ChildConfig(
        parent_persona="Network",
        persona="DNS",
        focus_objective="Inspect DNS",
    )
    memo = DecisionMemo(
        perspective="Containment",
        strategy="Isolate hosts",
        risks=["Downtime"],
    )

    def fake_parent(_state: dict[str, Any]) -> dict[str, Any]:
        return {"child_configs": [child]}

    def fake_child(_state: dict[str, Any]) -> dict[str, Any]:
        return {"memos": [memo]}

    agents = ModuleType("agents")
    agents.parent_agent_node = fake_parent
    agents.child_agent_node = fake_child
    sys.modules["agents"] = agents

    monkeypatch.setattr("worker.dispatch.publish_artifact", lambda **_: None)

    parent_envelope = build_parent_command(
        record, record.parent_configs[0], task_id="p1"
    )
    asyncio.run(dispatch_spawn_envelope(parent_envelope, store=store))

    updated = store.get_run("run-worker-1")
    assert len(updated.child_configs) == 1
    assert updated.completed_parent_count == 1
    assert updated.idempotency_seen(f"{updated.run_id}:run_parent:p1")

    updated.expected_child_count = 1
    store.save(updated)

    child_envelope = build_child_command(updated, child, task_id="c1")
    asyncio.run(dispatch_spawn_envelope(child_envelope, store=store))

    finished = store.get_run("run-worker-1")
    assert len(finished.memos) == 1
    assert finished.completed_child_count == 1
    assert finished.idempotency_seen(f"{finished.run_id}:run_parent:p1")
    assert finished.idempotency_seen(f"{finished.run_id}:run_child:c1")


def test_duplicate_parent_command_is_skipped(store: RunStore, monkeypatch) -> None:
    record = store.create_run(
        run_id="run-worker-dup",
        correlation_id="run-worker-dup",
        task_description="Investigate lateral movement in finance segment",
    )
    record.parent_configs = [AgentConfig(persona="Network", focus_objective="Trace C2")]
    record.expected_parent_count = 1
    store.save(record)

    child = ChildConfig(
        parent_persona="Network",
        persona="DNS",
        focus_objective="Inspect DNS",
    )

    def fake_parent(_state: dict[str, Any]) -> dict[str, Any]:
        return {"child_configs": [child]}

    agents = ModuleType("agents")
    agents.parent_agent_node = fake_parent
    agents.child_agent_node = lambda _state: {"memos": []}
    sys.modules["agents"] = agents
    monkeypatch.setattr("worker.dispatch.publish_artifact", lambda **_: None)

    parent_envelope = build_parent_command(
        record, record.parent_configs[0], task_id="p1"
    )
    asyncio.run(dispatch_spawn_envelope(parent_envelope, store=store))
    asyncio.run(dispatch_spawn_envelope(parent_envelope, store=store))

    updated = store.get_run("run-worker-dup")
    assert updated.completed_parent_count == 1
    assert len(updated.child_configs) == 1


def test_try_claim_idempotency_is_atomic(store: RunStore) -> None:
    key = "run-worker-claim:run_parent:t1"
    assert store.try_claim_idempotency("run-worker-claim", key) is True
    assert store.try_claim_idempotency("run-worker-claim", key) is False
    store.release_idempotency_claim("run-worker-claim", key)
    assert store.try_claim_idempotency("run-worker-claim", key) is True
