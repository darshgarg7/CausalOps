"""Bus contract tests (no broker required)."""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from bus.events import ArtifactType, EventEnvelope  # noqa: E402
from bus.serde import bytes_to_envelope, envelope_to_bytes  # noqa: E402
from bus.topics import (  # noqa: E402
    TOPIC_ARTIFACTS,
    TOPIC_RUNS,
    TOPIC_SPAWN,
    TOPIC_TELEMETRY,
    topic_for_artifact,
)


def test_envelope_round_trip() -> None:
    original = EventEnvelope(
        run_id="run-test-1",
        correlation_id="run-test-1",
        agent_id="orchestrator",
        tier="orchestrator",
        artifact_type=ArtifactType.EXECUTION_PHASE,
        payload={"phase": "ORCHESTRATOR", "message": "ok", "status": "running"},
        sequence=0,
        timestamp=datetime(2026, 5, 28, 12, 0, 0, tzinfo=UTC),
    )
    restored = bytes_to_envelope(envelope_to_bytes(original))
    assert restored.run_id == original.run_id
    assert restored.artifact_type == original.artifact_type
    assert restored.payload == original.payload


@pytest.mark.parametrize(
    ("artifact_type", "expected_topic"),
    [
        (ArtifactType.RUN_STARTED, TOPIC_RUNS),
        (ArtifactType.AGENT_CONFIG, TOPIC_SPAWN),
        (ArtifactType.RUN_PARENT, TOPIC_SPAWN),
        (ArtifactType.RUN_CHILD, TOPIC_SPAWN),
        (ArtifactType.DECISION_MEMO, TOPIC_ARTIFACTS),
        (ArtifactType.EXECUTION_PHASE, TOPIC_TELEMETRY),
    ],
)
def test_topic_routing(artifact_type: ArtifactType, expected_topic: str) -> None:
    assert topic_for_artifact(artifact_type) == expected_topic
