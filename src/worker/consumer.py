"""Kafka consumer loop for executable hivemind.spawn commands."""

from __future__ import annotations

import asyncio
import logging
import os

from aiokafka import AIOKafkaConsumer

from bus.dlq import publish_dlq
from bus.events import ArtifactType
from bus.producer import kafka_enabled
from bus.serde import bytes_to_envelope
from bus.topics import TOPIC_SPAWN
from worker.dispatch import dispatch_spawn_envelope, idempotency_key_from_envelope

logger = logging.getLogger(__name__)

_SPAWN_COMMANDS = frozenset({ArtifactType.RUN_PARENT, ArtifactType.RUN_CHILD})


def _spawn_max_retries() -> int:
    return max(1, int(os.getenv("HIVEMIND_SPAWN_MAX_RETRIES", "2")))


def _spawn_retry_backoff_seconds() -> float:
    return max(0.0, int(os.getenv("HIVEMIND_SPAWN_RETRY_BACKOFF_MS", "1000")) / 1000.0)


async def _process_spawn_message(consumer: AIOKafkaConsumer, message) -> None:
    """Dispatch one spawn message with retries, DLQ handoff, and manual commit."""

    max_retries = _spawn_max_retries()
    backoff_s = _spawn_retry_backoff_seconds()
    attempt = 0
    envelope = None

    while attempt < max_retries:
        attempt += 1
        try:
            envelope = bytes_to_envelope(message.value)
        except Exception as exc:
            logger.exception("Failed to decode spawn message")
            publish_dlq(
                original_topic=TOPIC_SPAWN,
                original_value=message.value,
                error=str(exc),
                attempt=attempt,
                original_key=message.key,
            )
            await consumer.commit()
            return

        if envelope.artifact_type not in _SPAWN_COMMANDS:
            await consumer.commit()
            return

        try:
            await dispatch_spawn_envelope(envelope)
            await consumer.commit()
            return
        except Exception as exc:
            idempotency_key = idempotency_key_from_envelope(envelope)
            if idempotency_key:
                from coordinator.store import get_run_store

                get_run_store().release_idempotency_claim(
                    envelope.run_id, idempotency_key
                )
            logger.exception(
                "Spawn dispatch failed for run %s command %s (attempt %s/%s)",
                envelope.run_id,
                envelope.artifact_type,
                attempt,
                max_retries,
            )
            if attempt >= max_retries:
                publish_dlq(
                    original_topic=TOPIC_SPAWN,
                    original_value=message.value,
                    error=str(exc),
                    attempt=attempt,
                    run_id=envelope.run_id,
                    artifact_type=envelope.artifact_type.value,
                    original_key=message.key,
                )
                await consumer.commit()
                return
            await asyncio.sleep(backoff_s)


async def run_spawn_consumer(*, stop_event: asyncio.Event | None = None) -> None:
    """Consume RUN_PARENT/RUN_CHILD commands until stop_event is set."""

    if not kafka_enabled():
        logger.info("Spawn consumer idle: KAFKA_BOOTSTRAP unset (inline dispatch used)")
        if stop_event:
            await stop_event.wait()
        return

    consumer = AIOKafkaConsumer(
        TOPIC_SPAWN,
        bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP", "").strip(),
        group_id="hivemind-workers",
        auto_offset_reset="earliest",
        enable_auto_commit=False,
    )
    await consumer.start()
    logger.info("Spawn consumer started on %s", TOPIC_SPAWN)
    try:
        while True:
            if stop_event and stop_event.is_set():
                break
            records = await consumer.getmany(timeout_ms=500, max_records=50)
            for batch in records.values():
                for message in batch:
                    await _process_spawn_message(consumer, message)
            if stop_event is None:
                await asyncio.sleep(0)
    finally:
        await consumer.stop()
        logger.info("Spawn consumer stopped")
