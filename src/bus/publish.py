"""High-level publish helpers for graph nodes and engine."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from bus.context import get_run_context
from bus.events import ArtifactType, EventEnvelope, Tier
from bus.producer import publish_envelope_sync

ExecutionPhaseStatus = Literal["queued", "running", "done", "error"]


def _require_context() -> tuple[str, str, Any]:
    ctx = get_run_context()
    if ctx is None:
        raise RuntimeError("Run publish context not bound; call bind_run_context first")
    return ctx.run_id, ctx.correlation_id, ctx


def _emit(
    *,
    agent_id: str,
    tier: Tier,
    artifact_type: ArtifactType,
    payload: dict[str, Any],
) -> None:
    run_id, correlation_id, ctx = _require_context()
    sequence = ctx.next_sequence(agent_id)
    ctx.summary.record(artifact_type)
    envelope = EventEnvelope(
        run_id=run_id,
        correlation_id=correlation_id,
        agent_id=agent_id,
        tier=tier,
        artifact_type=artifact_type,
        payload=payload,
        sequence=sequence,
        timestamp=datetime.now(UTC),
    )
    publish_envelope_sync(envelope)


def publish_spawn(
    *,
    agent_id: str,
    tier: Tier,
    artifact_type: ArtifactType,
    payload: dict[str, Any],
) -> None:
    """Publish AgentConfig or ChildConfig to hivemind.spawn."""

    if artifact_type not in (ArtifactType.AGENT_CONFIG, ArtifactType.CHILD_CONFIG):
        raise ValueError(f"publish_spawn expected spawn artifact, got {artifact_type}")
    _emit(
        agent_id=agent_id,
        tier=tier,
        artifact_type=artifact_type,
        payload=payload,
    )


def publish_work_command(
    *,
    agent_id: str,
    tier: Tier,
    artifact_type: ArtifactType,
    payload: dict[str, Any],
) -> None:
    """Publish an executable parent/child work command to hivemind.spawn."""

    if artifact_type not in (ArtifactType.RUN_PARENT, ArtifactType.RUN_CHILD):
        raise ValueError(
            "publish_work_command expected run_parent or run_child, "
            f"got {artifact_type}"
        )
    _emit(
        agent_id=agent_id,
        tier=tier,
        artifact_type=artifact_type,
        payload=payload,
    )


def publish_artifact(
    *,
    agent_id: str,
    tier: Tier,
    artifact_type: ArtifactType,
    payload: dict[str, Any],
) -> None:
    """Publish a semantic artifact to hivemind.artifacts."""

    _emit(
        agent_id=agent_id,
        tier=tier,
        artifact_type=artifact_type,
        payload=payload,
    )


def publish_telemetry(
    *,
    agent_id: str,
    tier: Tier,
    phase: str,
    message: str,
    status: ExecutionPhaseStatus,
) -> None:
    """Publish a UI-compatible execution phase event."""

    _emit(
        agent_id=agent_id,
        tier=tier,
        artifact_type=ArtifactType.EXECUTION_PHASE,
        payload={
            "phase": phase,
            "message": message,
            "status": status,
        },
    )


def publish_run_event(
    event: Literal["started", "completed", "failed"],
    *,
    detail: str | None = None,
) -> None:
    """Publish run lifecycle control events to hivemind.runs."""

    artifact_map = {
        "started": ArtifactType.RUN_STARTED,
        "completed": ArtifactType.RUN_COMPLETED,
        "failed": ArtifactType.RUN_FAILED,
    }
    payload: dict[str, Any] = {}
    if detail:
        payload["detail"] = detail
    _emit(
        agent_id="control",
        tier="control",
        artifact_type=artifact_map[event],
        payload=payload,
    )
