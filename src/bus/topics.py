"""Kafka topic names and artifact routing."""

from __future__ import annotations

from bus.events import ArtifactType

TOPIC_RUNS = "causalops.runs"
TOPIC_SPAWN = "causalops.spawn"
TOPIC_ARTIFACTS = "causalops.artifacts"
TOPIC_TELEMETRY = "causalops.telemetry"
TOPIC_EVIDENCE = "causalops.evidence"
TOPIC_DLQ = "causalops.dlq"

_ALL_TOPICS = (
    TOPIC_RUNS,
    TOPIC_SPAWN,
    TOPIC_ARTIFACTS,
    TOPIC_TELEMETRY,
    TOPIC_EVIDENCE,
    TOPIC_DLQ,
)


def topic_for_artifact(artifact_type: ArtifactType) -> str:
    """Return the Kafka topic for an artifact type."""

    if artifact_type in (
        ArtifactType.RUN_STARTED,
        ArtifactType.RUN_COMPLETED,
        ArtifactType.RUN_FAILED,
    ):
        return TOPIC_RUNS
    if artifact_type in (
        ArtifactType.AGENT_CONFIG,
        ArtifactType.CHILD_CONFIG,
        ArtifactType.RUN_PARENT,
        ArtifactType.RUN_CHILD,
    ):
        return TOPIC_SPAWN
    if artifact_type == ArtifactType.EXECUTION_PHASE:
        return TOPIC_TELEMETRY
    return TOPIC_ARTIFACTS
