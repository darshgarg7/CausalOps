"""Dead-letter queue helpers for poison Kafka messages."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from bus.producer import kafka_enabled, publish_bytes_sync
from bus.topics import TOPIC_DLQ

logger = logging.getLogger(__name__)


def publish_dlq(
    *,
    original_topic: str,
    original_value: bytes,
    error: str,
    attempt: int,
    run_id: str | None = None,
    artifact_type: str | None = None,
    original_key: bytes | None = None,
) -> None:
    """Publish a failed message envelope to hivemind.dlq."""

    if not kafka_enabled():
        logger.warning(
            "DLQ publish skipped (Kafka disabled): topic=%s run_id=%s error=%s",
            original_topic,
            run_id,
            error,
        )
        return

    payload: dict[str, Any] = {
        "failed_at": datetime.now(timezone.utc).isoformat(),
        "original_topic": original_topic,
        "original_key": original_key.decode("utf-8") if original_key else None,
        "error": error,
        "attempt": attempt,
        "run_id": run_id,
        "artifact_type": artifact_type,
    }
    try:
        payload["original_value"] = json.loads(original_value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        import base64

        payload["original_value_b64"] = base64.b64encode(original_value).decode("ascii")

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    key = (run_id or "unknown").encode("utf-8")
    publish_bytes_sync(TOPIC_DLQ, body, key=key)
