"""JSON serialization for event envelopes."""

from __future__ import annotations

import json
from typing import Any

from bus.events import EventEnvelope


def envelope_to_bytes(envelope: EventEnvelope) -> bytes:
    """Serialize an envelope to UTF-8 JSON bytes."""

    data = envelope.model_dump(mode="json")
    return json.dumps(data, default=str).encode("utf-8")


def bytes_to_envelope(raw: bytes) -> EventEnvelope:
    """Deserialize UTF-8 JSON bytes into an envelope."""

    data: dict[str, Any] = json.loads(raw.decode("utf-8"))
    return EventEnvelope.model_validate(data)
