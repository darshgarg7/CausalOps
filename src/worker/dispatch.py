"""Execute spawn work commands consumed from hivemind.spawn."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from bus.context import bind_run_context
from bus.events import ArtifactType, EventEnvelope
from bus.publish import publish_artifact
from coordinator.store import RunStore, get_run_store
from schema import ChildState, ParentState

logger = logging.getLogger(__name__)


async def dispatch_spawn_envelope(
    envelope: EventEnvelope,
    *,
    store: RunStore | None = None,
) -> None:
    """Run one parent or child work command."""

    if envelope.artifact_type == ArtifactType.RUN_PARENT:
        await _dispatch_parent(envelope, store=store)
        return
    if envelope.artifact_type == ArtifactType.RUN_CHILD:
        await _dispatch_child(envelope, store=store)
        return

    logger.debug(
        "Ignoring non-executable spawn artifact %s for run %s",
        envelope.artifact_type,
        envelope.run_id,
    )


def idempotency_key_from_envelope(envelope: EventEnvelope) -> str:
    """Return the spawn command idempotency key, if any."""

    return str(envelope.payload.get("idempotency_key", "") or "")


async def _dispatch_parent(
    envelope: EventEnvelope,
    *,
    store: RunStore | None,
) -> None:
    from agents import parent_agent_node

    run_store = store or get_run_store()
    payload = envelope.payload
    idempotency_key = idempotency_key_from_envelope(envelope)
    record = run_store.get_run(envelope.run_id)
    if idempotency_key and not run_store.try_claim_idempotency(
        envelope.run_id, idempotency_key
    ):
        logger.info("Skipping duplicate RUN_PARENT %s", idempotency_key)
        return

    try:
        parent_state: ParentState = {
            "task_description": str(
                payload.get("task_description", record.task_description)
            ),
            "run_id": envelope.run_id,
            "correlation_id": envelope.correlation_id,
            "persona": str(payload["persona"]),
            "focus_objective": str(payload["focus_objective"]),
        }
        update = await asyncio.to_thread(parent_agent_node, parent_state)
        configs = list(update.get("child_configs", []))
        run_store.append_child_configs(record, configs)
        if idempotency_key:
            run_store.complete_idempotency_claim(
                envelope.run_id, idempotency_key, record
            )
        run_store.mark_parent_complete(record)
        _publish_task_completed(
            envelope, payload, {"child_config_count": len(configs)}
        )
    except Exception:
        if idempotency_key:
            run_store.release_idempotency_claim(envelope.run_id, idempotency_key)
        raise


async def _dispatch_child(
    envelope: EventEnvelope,
    *,
    store: RunStore | None,
) -> None:
    from agents import child_agent_node

    run_store = store or get_run_store()
    payload = envelope.payload
    idempotency_key = idempotency_key_from_envelope(envelope)
    record = run_store.get_run(envelope.run_id)
    if idempotency_key and not run_store.try_claim_idempotency(
        envelope.run_id, idempotency_key
    ):
        logger.info("Skipping duplicate RUN_CHILD %s", idempotency_key)
        return

    try:
        child_state: ChildState = {
            "task_description": str(
                payload.get("task_description", record.task_description)
            ),
            "run_id": envelope.run_id,
            "correlation_id": envelope.correlation_id,
            "parent_persona": str(payload["parent_persona"]),
            "persona": str(payload["persona"]),
            "focus_objective": str(payload["focus_objective"]),
        }
        update = await asyncio.to_thread(child_agent_node, child_state)
        memos = list(update.get("memos", []))
        for memo in memos:
            run_store.append_memo(record, memo)
        if idempotency_key:
            run_store.complete_idempotency_claim(
                envelope.run_id, idempotency_key, record
            )
        run_store.mark_child_complete(record)
        _publish_task_completed(envelope, payload, {"memo_count": len(memos)})
    except Exception:
        if idempotency_key:
            run_store.release_idempotency_claim(envelope.run_id, idempotency_key)
        raise


def _publish_task_completed(
    envelope: EventEnvelope,
    payload: dict[str, Any],
    result: dict[str, Any],
) -> None:
    bind_run_context(envelope.run_id, envelope.correlation_id)
    publish_artifact(
        agent_id=envelope.agent_id,
        tier="control",
        artifact_type=ArtifactType.TASK_COMPLETED,
        payload={
            "task_id": payload.get("task_id"),
            "idempotency_key": payload.get("idempotency_key"),
            "command": envelope.artifact_type.value,
            **result,
        },
    )
