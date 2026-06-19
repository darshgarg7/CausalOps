"""Kafka optional-mode tests (no broker required)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from bus.consumer import stream_telemetry  # noqa: E402
from bus.producer import kafka_enabled  # noqa: E402


def test_kafka_disabled_without_bootstrap(monkeypatch) -> None:
    monkeypatch.delenv("KAFKA_BOOTSTRAP", raising=False)
    assert kafka_enabled() is False


async def _collect_telemetry(run_id: str) -> list:
    items = []
    async for envelope in stream_telemetry(run_id):
        items.append(envelope)
    return items


def test_sse_stream_noop_without_bootstrap(monkeypatch) -> None:
    import asyncio

    monkeypatch.delenv("KAFKA_BOOTSTRAP", raising=False)
    items = asyncio.run(_collect_telemetry("run-off-test"))
    assert items == []
