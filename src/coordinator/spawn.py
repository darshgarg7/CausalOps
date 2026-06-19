"""Publish executable spawn work commands for Phase 2b workers."""

from __future__ import annotations

import uuid
from typing import Any

from bus.context import bind_run_context
from bus.events import ArtifactType, EventEnvelope
from coordinator.store import RunRecord
from schema import AgentConfig, ChildConfig


def _parent_idempotency_key(run_id: str, task_id: str) -> str:
    return f"{run_id}:run_parent:{task_id}"


def _child_idempotency_key(run_id: str, task_id: str) -> str:
    return f"{run_id}:run_child:{task_id}"


def build_parent_command(
    record: RunRecord,
    config: AgentConfig,
    *,
    task_id: str | None = None,
) -> EventEnvelope:
    """Build a RUN_PARENT spawn envelope."""

    resolved_task_id = task_id or uuid.uuid4().hex[:8]
    payload: dict[str, Any] = {
        "task_id": resolved_task_id,
        "idempotency_key": _parent_idempotency_key(record.run_id, resolved_task_id),
        "persona": config.persona,
        "focus_objective": config.focus_objective,
        "task_description": record.task_description,
    }
    if config.policy is not None:
        payload["policy"] = config.policy.model_dump()
    return EventEnvelope(
        run_id=record.run_id,
        correlation_id=record.correlation_id,
        agent_id="coordinator",
        tier="control",
        artifact_type=ArtifactType.RUN_PARENT,
        payload=payload,
    )


def build_child_command(
    record: RunRecord,
    config: ChildConfig,
    *,
    task_id: str | None = None,
) -> EventEnvelope:
    """Build a RUN_CHILD spawn envelope."""

    resolved_task_id = task_id or uuid.uuid4().hex[:8]
    payload: dict[str, Any] = {
        "task_id": resolved_task_id,
        "idempotency_key": _child_idempotency_key(record.run_id, resolved_task_id),
        "parent_persona": config.parent_persona,
        "persona": config.persona,
        "focus_objective": config.focus_objective,
        "task_description": record.task_description,
    }
    if config.policy is not None:
        payload["policy"] = config.policy.model_dump()
    return EventEnvelope(
        run_id=record.run_id,
        correlation_id=record.correlation_id,
        agent_id="coordinator",
        tier="control",
        artifact_type=ArtifactType.RUN_CHILD,
        payload=payload,
    )


async def enqueue_parent_tasks(record: RunRecord) -> None:
    """Publish RUN_PARENT commands for each orchestrator parent config."""

    from worker.submit import submit_spawn_envelope

    bind_run_context(record.run_id, record.correlation_id)
    for config in record.parent_configs:
        envelope = build_parent_command(record, config)
        await submit_spawn_envelope(envelope)


async def enqueue_child_tasks(record: RunRecord) -> None:
    """Publish RUN_CHILD commands for each accumulated child config."""

    from worker.submit import submit_spawn_envelope

    bind_run_context(record.run_id, record.correlation_id)
    for config in record.child_configs:
        envelope = build_child_command(record, config)
        await submit_spawn_envelope(envelope)
