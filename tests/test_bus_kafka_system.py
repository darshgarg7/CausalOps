"""Kafka bus routing and broker integration tests.

Unit tests run without a broker (default in CI). Integration tests are marked
``kafka`` and require a reachable ``KAFKA_BOOTSTRAP`` (e.g. Redpanda in compose).
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock, patch

import pytest
from aiokafka import AIOKafkaConsumer

from bus.events import ArtifactType, EventEnvelope
from bus.producer import (
    kafka_enabled,
    publish_envelope_sync,
    start_producer,
    stop_producer,
)
from bus.serde import bytes_to_envelope
from bus.topics import TOPIC_SPAWN, _ALL_TOPICS
from coordinator.spawn import build_parent_command
from coordinator.store import RunStore
from schema import AgentConfig
from worker.submit import submit_spawn_envelope


def test_all_hivemind_topics_are_registered() -> None:
    assert "hivemind.runs" in _ALL_TOPICS
    assert "hivemind.spawn" in _ALL_TOPICS
    assert "hivemind.artifacts" in _ALL_TOPICS
    assert "hivemind.telemetry" in _ALL_TOPICS
    assert "hivemind.dlq" in _ALL_TOPICS


def test_kafka_enabled_follows_bootstrap_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KAFKA_BOOTSTRAP", raising=False)
    assert kafka_enabled() is False

    monkeypatch.setenv("KAFKA_BOOTSTRAP", "localhost:19092")
    assert kafka_enabled() is True


def test_submit_spawn_envelope_dispatches_inline_without_kafka(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KAFKA_BOOTSTRAP", raising=False)

    envelope = EventEnvelope(
        run_id="run-inline-1",
        correlation_id="run-inline-1",
        agent_id="coordinator",
        tier="control",
        artifact_type=ArtifactType.RUN_PARENT,
        payload={"task_id": "p1"},
    )

    dispatch = AsyncMock()
    publish = Mock(return_value=True)

    async def run() -> None:
        with patch("worker.dispatch.dispatch_spawn_envelope", dispatch):
            with patch("worker.submit.publish_envelope_sync", publish):
                await submit_spawn_envelope(envelope)

        dispatch.assert_awaited_once_with(envelope)
        publish.assert_not_called()

    asyncio.run(run())


def test_submit_spawn_envelope_publishes_when_kafka_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KAFKA_BOOTSTRAP", "localhost:19092")

    envelope = EventEnvelope(
        run_id="run-kafka-route-1",
        correlation_id="run-kafka-route-1",
        agent_id="coordinator",
        tier="control",
        artifact_type=ArtifactType.RUN_PARENT,
        payload={"task_id": "p1"},
    )

    dispatch = AsyncMock()
    publish = Mock()

    async def run() -> None:
        with patch("worker.dispatch.dispatch_spawn_envelope", dispatch):
            with patch("worker.submit.publish_envelope_sync", publish):
                await submit_spawn_envelope(envelope)

        publish.assert_called_once_with(envelope)
        dispatch.assert_not_called()

    asyncio.run(run())


def test_submit_spawn_envelope_fails_fast_when_kafka_publish_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KAFKA_BOOTSTRAP", "localhost:19092")

    envelope = EventEnvelope(
        run_id="run-kafka-route-fail",
        correlation_id="run-kafka-route-fail",
        agent_id="coordinator",
        tier="control",
        artifact_type=ArtifactType.RUN_PARENT,
        payload={"task_id": "p1"},
    )

    dispatch = AsyncMock()
    publish = Mock(return_value=False)

    async def run() -> None:
        with patch("worker.dispatch.dispatch_spawn_envelope", dispatch):
            with patch("worker.submit.publish_envelope_sync", publish):
                with pytest.raises(RuntimeError, match="work was not enqueued"):
                    await submit_spawn_envelope(envelope)

        publish.assert_called_once_with(envelope)
        dispatch.assert_not_called()

    asyncio.run(run())


async def _broker_reachable(bootstrap: str) -> bool:
    consumer = AIOKafkaConsumer(
        bootstrap_servers=bootstrap,
        group_id=f"probe-{uuid.uuid4().hex[:8]}",
    )
    try:
        await consumer.start()
        return True
    except Exception:
        return False
    finally:
        await consumer.stop()


@pytest.fixture
def kafka_bootstrap(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    if request.node.get_closest_marker("kafka") is None:
        pytest.skip("kafka marker required")

    bootstrap = os.getenv("KAFKA_BOOTSTRAP", "localhost:19092").strip()
    if not bootstrap:
        pytest.skip("KAFKA_BOOTSTRAP not set")

    monkeypatch.setenv("KAFKA_BOOTSTRAP", bootstrap)

    if not asyncio.run(_broker_reachable(bootstrap)):
        pytest.skip(f"Kafka broker unreachable at {bootstrap}")

    return bootstrap


async def _wait_for_assignment(consumer: AIOKafkaConsumer, timeout: float = 10.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if consumer.assignment():
            return
        await asyncio.sleep(0.05)
    raise TimeoutError("Kafka consumer partition assignment timed out")


async def _consume_envelope_for_run(
    *,
    topic: str,
    run_id: str,
    bootstrap: str,
    timeout: float = 15.0,
) -> EventEnvelope:
    group_id = f"test-{uuid.uuid4().hex[:12]}"
    consumer = AIOKafkaConsumer(
        topic,
        bootstrap_servers=bootstrap,
        group_id=group_id,
        auto_offset_reset="latest",
        enable_auto_commit=False,
    )
    await consumer.start()
    try:
        await _wait_for_assignment(consumer)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            batches = await consumer.getmany(timeout_ms=500, max_records=20)
            for batch in batches.values():
                for message in batch:
                    envelope = bytes_to_envelope(message.value)
                    if envelope.run_id == run_id:
                        return envelope
    finally:
        await consumer.stop()
    raise TimeoutError(f"No envelope for run_id={run_id} on topic {topic}")


@pytest.mark.kafka
def test_kafka_spawn_envelope_round_trip(kafka_bootstrap: str, tmp_path) -> None:
    async def run() -> None:
        await start_producer()
        try:
            run_id = f"run-bus-spawn-{uuid.uuid4().hex[:8]}"
            store = RunStore(db_path=tmp_path / "runs.db")
            record = store.create_run(
                run_id=run_id,
                correlation_id=run_id,
                task_description="Kafka spawn round-trip test",
            )
            record.parent_configs = [
                AgentConfig(persona="Network", focus_objective="Trace C2"),
            ]
            store.save(record)

            envelope = build_parent_command(record, record.parent_configs[0], task_id="p1")

            consumer_task = asyncio.create_task(
                _consume_envelope_for_run(
                    topic=TOPIC_SPAWN,
                    run_id=run_id,
                    bootstrap=kafka_bootstrap,
                )
            )
            await asyncio.sleep(0.5)
            publish_envelope_sync(envelope)

            received = await asyncio.wait_for(consumer_task, timeout=20.0)
            assert received.artifact_type == ArtifactType.RUN_PARENT
            assert received.payload["task_id"] == "p1"
            assert received.payload["idempotency_key"] == f"{run_id}:run_parent:p1"
        finally:
            await stop_producer()

    asyncio.run(run())


@pytest.mark.kafka
def test_kafka_telemetry_stream_filters_by_run_id(kafka_bootstrap: str) -> None:
    async def run() -> None:
        from bus.consumer import stream_telemetry

        await start_producer()
        try:
            target_run = f"run-bus-telemetry-{uuid.uuid4().hex[:8]}"
            other_run = f"run-bus-other-{uuid.uuid4().hex[:8]}"

            stop_event = asyncio.Event()
            collected: list[EventEnvelope] = []

            async def collect() -> None:
                async for envelope in stream_telemetry(target_run, stop_event=stop_event):
                    collected.append(envelope)
                    if len(collected) >= 1:
                        stop_event.set()
                        break

            collector = asyncio.create_task(collect())
            await asyncio.sleep(0.5)

            for run_id, phase in ((other_run, "OTHER"), (target_run, "ORCHESTRATOR")):
                publish_envelope_sync(
                    EventEnvelope(
                        run_id=run_id,
                        correlation_id=run_id,
                        agent_id="orchestrator",
                        tier="orchestrator",
                        artifact_type=ArtifactType.EXECUTION_PHASE,
                        payload={
                            "phase": phase,
                            "message": "test",
                            "status": "running",
                        },
                        sequence=0,
                        timestamp=datetime.now(timezone.utc),
                    )
                )

            await asyncio.wait_for(collector, timeout=20.0)
            assert len(collected) == 1
            assert collected[0].run_id == target_run
            assert collected[0].payload["phase"] == "ORCHESTRATOR"
        finally:
            await stop_producer()

    asyncio.run(run())


@pytest.mark.kafka
def test_kafka_submit_spawn_envelope_reaches_spawn_topic(
    kafka_bootstrap: str,
    tmp_path,
) -> None:
    async def run() -> None:
        await start_producer()
        try:
            run_id = f"run-bus-submit-{uuid.uuid4().hex[:8]}"
            store = RunStore(db_path=tmp_path / "runs.db")
            record = store.create_run(
                run_id=run_id,
                correlation_id=run_id,
                task_description="Submit spawn via Kafka",
            )
            record.parent_configs = [
                AgentConfig(persona="Network", focus_objective="Trace C2"),
            ]
            store.save(record)

            envelope = build_parent_command(record, record.parent_configs[0], task_id="p1")

            consumer_task = asyncio.create_task(
                _consume_envelope_for_run(
                    topic=TOPIC_SPAWN,
                    run_id=run_id,
                    bootstrap=kafka_bootstrap,
                )
            )
            await asyncio.sleep(0.5)
            await submit_spawn_envelope(envelope)

            received = await asyncio.wait_for(consumer_task, timeout=20.0)
            assert received.artifact_type == ArtifactType.RUN_PARENT
            assert received.payload["idempotency_key"] == f"{run_id}:run_parent:p1"
        finally:
            await stop_producer()

    asyncio.run(run())
