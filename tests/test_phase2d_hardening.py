"""Tests for Phase 2d DLQ and spawn consumer retry behavior."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from bus.events import ArtifactType, EventEnvelope
from bus.serde import envelope_to_bytes
from bus.topics import TOPIC_DLQ, TOPIC_SPAWN
from coordinator.spawn import build_parent_command
from coordinator.store import RunStore, set_run_store
from schema import AgentConfig
from worker import consumer as spawn_consumer


@pytest.fixture
def store(tmp_path):
    run_store = RunStore(db_path=tmp_path / "runs.db")
    set_run_store(run_store)
    yield run_store
    set_run_store(None)


def test_spawn_dispatch_failure_publishes_dlq(
    store: RunStore,
    monkeypatch,
) -> None:
    record = store.create_run(
        run_id="run-dlq-1",
        correlation_id="run-dlq-1",
        task_description="Investigate lateral movement in finance segment",
    )
    record.parent_configs = [AgentConfig(persona="Network", focus_objective="Trace C2")]
    store.save(record)

    envelope = build_parent_command(record, record.parent_configs[0], task_id="p1")
    message = SimpleNamespace(
        value=json.dumps(
            {
                "run_id": envelope.run_id,
                "correlation_id": envelope.correlation_id,
                "agent_id": envelope.agent_id,
                "tier": envelope.tier,
                "artifact_type": envelope.artifact_type.value,
                "payload": envelope.payload,
                "sequence": envelope.sequence,
                "timestamp": envelope.timestamp.isoformat(),
            }
        ).encode("utf-8"),
        key=envelope.run_id.encode("utf-8"),
    )

    dlq_calls: list[dict] = []

    def capture_dlq(**kwargs):
        dlq_calls.append(kwargs)

    async def failing_dispatch(_envelope, *, store=None):
        raise RuntimeError("simulated worker failure")

    mock_consumer = AsyncMock()
    monkeypatch.setenv("CAUSALOPS_SPAWN_MAX_RETRIES", "1")
    monkeypatch.setattr(spawn_consumer, "dispatch_spawn_envelope", failing_dispatch)
    monkeypatch.setattr(spawn_consumer, "publish_dlq", capture_dlq)

    async def run() -> None:
        await spawn_consumer._process_spawn_message(mock_consumer, message)

    asyncio.run(run())

    assert len(dlq_calls) == 1
    assert dlq_calls[0]["original_topic"] == TOPIC_SPAWN
    assert dlq_calls[0]["run_id"] == "run-dlq-1"
    mock_consumer.commit.assert_awaited_once()


def test_dlq_topic_constant() -> None:
    assert TOPIC_DLQ == "causalops.dlq"


def test_spawn_batch_uses_configured_concurrency(monkeypatch) -> None:
    active = 0
    max_active = 0

    async def fake_dispatch(_envelope):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1

    messages = [
        SimpleNamespace(
            value=envelope_to_bytes(
                EventEnvelope(
                    run_id="run-batch",
                    correlation_id="run-batch",
                    agent_id="coordinator",
                    tier="control",
                    artifact_type=ArtifactType.RUN_CHILD,
                    payload={"task_id": f"c{index}"},
                )
            ),
            key=b"run-batch",
        )
        for index in range(4)
    ]

    mock_consumer = AsyncMock()
    monkeypatch.setenv("CAUSALOPS_SPAWN_CONCURRENCY", "2")
    monkeypatch.setattr(spawn_consumer, "dispatch_spawn_envelope", fake_dispatch)

    async def run() -> None:
        await spawn_consumer._process_spawn_batch(mock_consumer, messages)

    asyncio.run(run())

    assert max_active == 2
    mock_consumer.commit.assert_awaited_once()


def test_spawn_consumer_reads_existing_unclaimed_work(monkeypatch) -> None:
    """Fresh worker groups should not skip commands published before assignment."""

    created: dict[str, object] = {}

    class FakeConsumer:
        def __init__(self, *topics, **kwargs):
            created["topics"] = topics
            created["kwargs"] = kwargs

        async def start(self):
            created["started"] = True

        async def stop(self):
            created["stopped"] = True

        async def getmany(self, **_kwargs):
            return {}

    monkeypatch.setenv("KAFKA_BOOTSTRAP", "redpanda:9092")
    monkeypatch.setattr(spawn_consumer, "AIOKafkaConsumer", FakeConsumer)

    async def run() -> None:
        stop_event = asyncio.Event()
        stop_event.set()
        await spawn_consumer.run_spawn_consumer(stop_event=stop_event)

    asyncio.run(run())

    assert created["topics"] == (TOPIC_SPAWN,)
    assert created["kwargs"]["group_id"] == "causalops-workers"
    assert created["kwargs"]["auto_offset_reset"] == "earliest"
    assert created["kwargs"]["enable_auto_commit"] is False
    assert created["started"] is True
    assert created["stopped"] is True
