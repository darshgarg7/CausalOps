"""Kafka consumer that incrementally builds the 5D Spatiotemporal KG.

Subscribes to the run-lifecycle, spawn, and artifact topics and applies each
envelope to the spatiotemporal graph as it arrives, so the graph is continuously
updated from the event stream rather than reconstructed once at run end. Writes
go to the same ``runs.db`` (WAL mode) the API reads from.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time

from aiokafka import AIOKafkaConsumer

from bus.producer import kafka_enabled
from bus.serde import bytes_to_envelope
from bus.topics import TOPIC_ARTIFACTS, TOPIC_RUNS, TOPIC_SPAWN

logger = logging.getLogger(__name__)

_GRAPH_TOPICS = (TOPIC_RUNS, TOPIC_SPAWN, TOPIC_ARTIFACTS)
_MAX_WRITE_ATTEMPTS = 4


def _apply_sync(value: bytes) -> None:
    """Decode and apply one message on a single thread (owns its connection).

    Writes go to the dedicated graph DB (single writer), so they never contend
    with run-state writes in runs.db. A short retry absorbs transient SQLite
    lock errors from the concurrent API reader.
    """

    from graph_5d import connect_graph_db
    from graph_5d_stream import apply_envelope

    try:
        envelope = bytes_to_envelope(value)
    except Exception:
        logger.exception("5D graph consumer: failed to decode message")
        return

    for attempt in range(1, _MAX_WRITE_ATTEMPTS + 1):
        conn = connect_graph_db()
        try:
            with conn:
                apply_envelope(conn, envelope)
            return
        except sqlite3.OperationalError as exc:
            if attempt >= _MAX_WRITE_ATTEMPTS:
                logger.exception(
                    "5D graph consumer: giving up on %s for run %s after %s attempts",
                    getattr(envelope, "artifact_type", "?"),
                    getattr(envelope, "run_id", "?"),
                    attempt,
                )
                return
            time.sleep(0.25 * attempt)
        except Exception:
            logger.exception(
                "5D graph consumer: failed to apply %s for run %s",
                getattr(envelope, "artifact_type", "?"),
                getattr(envelope, "run_id", "?"),
            )
            return
        finally:
            conn.close()


async def run_graph_consumer(*, stop_event: asyncio.Event | None = None) -> None:
    """Consume run/spawn/artifact events into the 5D graph until stopped."""

    if not kafka_enabled():
        logger.info(
            "5D graph consumer idle: KAFKA_BOOTSTRAP unset (batch reconstruct used)"
        )
        if stop_event:
            await stop_event.wait()
        return

    consumer = AIOKafkaConsumer(
        *_GRAPH_TOPICS,
        bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP", "").strip(),
        group_id="hivemind-graph-5d",
        auto_offset_reset="earliest",
        enable_auto_commit=True,
    )
    await consumer.start()
    logger.info("5D graph consumer started on %s", ", ".join(_GRAPH_TOPICS))
    try:
        while True:
            if stop_event and stop_event.is_set():
                break
            records = await consumer.getmany(timeout_ms=500, max_records=50)
            for batch in records.values():
                for message in batch:
                    # SQLite work is sync; run it off the event loop thread.
                    await asyncio.to_thread(_apply_sync, message.value)
            if stop_event is None:
                await asyncio.sleep(0)
    finally:
        await consumer.stop()
        logger.info("5D graph consumer stopped")
