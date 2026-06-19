"""Async Kafka producer with optional no-op mode.

Publishing runs on a dedicated background thread/event loop so sync LangGraph
nodes never block waiting on the FastAPI uvicorn loop (which caused 30s publish
timeouts under load).
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading

from aiokafka import AIOKafkaProducer

from bus.events import EventEnvelope
from bus.serde import envelope_to_bytes
from bus.topics import topic_for_artifact

logger = logging.getLogger(__name__)

_producer: AIOKafkaProducer | None = None
_worker_loop: asyncio.AbstractEventLoop | None = None
_worker_thread: threading.Thread | None = None
_ready = threading.Event()
_shutdown = threading.Event()


def kafka_enabled() -> bool:
    """True when KAFKA_BOOTSTRAP is configured."""

    return bool(os.getenv("KAFKA_BOOTSTRAP", "").strip())


def set_event_loop(_loop: asyncio.AbstractEventLoop | None) -> None:
    """Legacy hook; publishing uses a dedicated worker loop."""


async def start_producer() -> None:
    """Start the Kafka producer on a background thread (no-op if disabled)."""

    global _worker_thread

    if not kafka_enabled():
        logger.info("KAFKA_BOOTSTRAP unset; Kafka producer disabled")
        return
    if _worker_thread is not None and _worker_thread.is_alive():
        return

    _ready.clear()
    _shutdown.clear()
    _worker_thread = threading.Thread(
        target=_worker_main,
        name="hivemind-kafka-producer",
        daemon=True,
    )
    _worker_thread.start()
    if not _ready.wait(timeout=30):
        raise RuntimeError("Kafka producer worker failed to start within 30s")


async def stop_producer() -> None:
    """Stop the background producer thread."""

    global _worker_thread, _worker_loop, _producer
    if _worker_thread is None or _worker_loop is None:
        return

    _shutdown.set()
    future = asyncio.run_coroutine_threadsafe(_shutdown_worker(), _worker_loop)
    try:
        future.result(timeout=15)
    except Exception:
        logger.exception("Kafka producer shutdown error")
    _worker_thread.join(timeout=5)
    _worker_thread = None
    _worker_loop = None
    _producer = None
    logger.info("Kafka producer stopped")


def _worker_main() -> None:
    global _worker_loop
    loop = asyncio.new_event_loop()
    _worker_loop = loop
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_worker_startup())
        loop.run_forever()
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


async def _worker_startup() -> None:
    global _producer
    bootstrap = os.getenv("KAFKA_BOOTSTRAP", "").strip()
    _producer = AIOKafkaProducer(
        bootstrap_servers=bootstrap,
        acks="all",
    )
    await _producer.start()
    logger.info("Kafka producer connected to %s", bootstrap)
    _ready.set()


async def _shutdown_worker() -> None:
    global _producer
    if _producer is not None:
        await _producer.stop()
        _producer = None
    loop = asyncio.get_running_loop()
    loop.call_soon(loop.stop)


async def publish_envelope(envelope: EventEnvelope) -> None:
    """Publish one envelope to the topic implied by artifact_type."""

    if not kafka_enabled():
        return
    if _producer is None:
        logger.warning("Kafka publish skipped: producer not started")
        return

    topic = topic_for_artifact(envelope.artifact_type)
    payload = envelope_to_bytes(envelope)
    await publish_bytes(topic, payload, key=envelope.run_id.encode("utf-8"))


async def publish_bytes(
    topic: str,
    value: bytes,
    *,
    key: bytes | None = None,
) -> None:
    """Publish raw bytes to a Kafka topic."""

    if not kafka_enabled():
        return
    if _producer is None:
        logger.warning("Kafka publish skipped: producer not started")
        return

    await _producer.send_and_wait(topic, value, key=key)


def publish_bytes_sync(
    topic: str,
    value: bytes,
    *,
    key: bytes | None = None,
) -> bool:
    """Publish raw bytes from sync code via the dedicated worker loop."""

    if not kafka_enabled():
        return True

    loop = _worker_loop
    if loop is None or not loop.is_running():
        logger.warning("Kafka publish skipped: worker loop not running")
        return False

    future = asyncio.run_coroutine_threadsafe(
        publish_bytes(topic, value, key=key),
        loop,
    )
    try:
        future.result(timeout=15)
        return True
    except Exception:
        logger.exception("Kafka publish failed for topic %s", topic)
        return False


def publish_envelope_sync(envelope: EventEnvelope) -> bool:
    """Publish from sync LangGraph nodes via the dedicated worker loop."""

    if not kafka_enabled():
        return True

    loop = _worker_loop
    if loop is None or not loop.is_running():
        logger.warning("Kafka publish skipped: worker loop not running")
        return False

    future = asyncio.run_coroutine_threadsafe(publish_envelope(envelope), loop)
    try:
        future.result(timeout=15)
        return True
    except Exception:
        logger.exception(
            "Kafka publish failed for %s/%s",
            envelope.artifact_type,
            envelope.run_id,
        )
        return False
