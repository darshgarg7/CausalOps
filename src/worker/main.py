"""Standalone spawn worker entrypoint for the worker compose service."""

from __future__ import annotations

import asyncio
import logging
import signal

from bus.producer import start_producer, stop_producer
from worker.consumer import run_spawn_consumer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    await start_producer()
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)
    try:
        await run_spawn_consumer(stop_event=stop_event)
    finally:
        await stop_producer()


def main() -> None:
    logger.info("Starting HiveMind spawn worker")
    asyncio.run(_run())


if __name__ == "__main__":
    main()
