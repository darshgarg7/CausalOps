"""Submit spawn work to Kafka or inline dispatch when the bus is disabled."""

from __future__ import annotations

import asyncio

from bus.events import EventEnvelope
from bus.producer import kafka_enabled, publish_envelope_sync


async def submit_spawn_envelope(envelope: EventEnvelope) -> None:
    """Publish a spawn command for workers, or dispatch inline without Kafka."""

    from worker.dispatch import dispatch_spawn_envelope

    if kafka_enabled():
        published = await asyncio.to_thread(publish_envelope_sync, envelope)
        if not published:
            raise RuntimeError(
                "Kafka spawn command publish failed; work was not enqueued."
            )
        return
    await dispatch_spawn_envelope(envelope)
