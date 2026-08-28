"""Telemetry consumer for SSE streaming."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import AsyncIterator

from aiokafka import AIOKafkaConsumer

from bus.events import ArtifactType, EventEnvelope
from bus.serde import bytes_to_envelope
from bus.topics import TOPIC_TELEMETRY

logger = logging.getLogger(__name__)


async def stream_telemetry(
    run_id: str,
    *,
    stop_event: asyncio.Event | None = None,
) -> AsyncIterator[EventEnvelope]:
    """Yield telemetry envelopes for a single run_id.

    Uses a unique consumer group per SSE connection and reads from latest offset
    so clients should connect before POST /run starts publishing.
    """

    if not os.getenv("KAFKA_BOOTSTRAP", "").strip():
        logger.warning("SSE telemetry stream requested but KAFKA_BOOTSTRAP unset")
        return

    group_id = f"causalops-sse-{uuid.uuid4().hex[:12]}"
    consumer = AIOKafkaConsumer(
        TOPIC_TELEMETRY,
        bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP", "").strip(),
        group_id=group_id,
        auto_offset_reset="latest",
        enable_auto_commit=True,
    )
    await consumer.start()
    try:
        while True:
            if stop_event and stop_event.is_set():
                break
            records = await consumer.getmany(timeout_ms=500, max_records=50)
            for batch in records.values():
                for message in batch:
                    try:
                        envelope = bytes_to_envelope(message.value)
                    except Exception:
                        logger.exception("Failed to decode telemetry message")
                        continue
                    if envelope.run_id != run_id:
                        continue
                    if envelope.artifact_type != ArtifactType.EXECUTION_PHASE:
                        continue
                    yield envelope
            if stop_event is None:
                await asyncio.sleep(0)
    finally:
        await consumer.stop()
