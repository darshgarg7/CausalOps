"""Coordinator state machine — replaces LangGraph graph.ainvoke in Phase 2a."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from bus.helpers import bind_from_state
from bus.publish import publish_telemetry
from coordinator.barriers import wait_for_barrier
from coordinator.refutation import refutation_next_step
from coordinator.spawn import enqueue_child_tasks, enqueue_parent_tasks
from coordinator.store import RunRecord, RunStore, get_run_store

logger = logging.getLogger(__name__)


async def execute_run(
    *,
    task_description: str,
    evidence_records: list[dict[str, Any]] | None = None,
    run_id: str,
    correlation_id: str,
    store: RunStore | None = None,
) -> dict[str, Any]:
    """Run the full HiveMind workflow via coordinator + run store."""

    run_store = store or get_run_store()
    try:
        record = run_store.get_run(run_id)
        record.status = "running"
        record.phase = "running"
        if evidence_records is not None:
            record.evidence_records = evidence_records
        run_store.save(record)
    except KeyError:
        record = run_store.create_run(
            run_id=run_id,
            correlation_id=correlation_id,
            task_description=task_description,
            evidence_records=evidence_records,
            status="running",
        )

    try:
        await _run_orchestrator(record, run_store)
        await _run_parent_evolution(record, run_store)
        await _dispatch_parents(record, run_store)
        await _gather_children(record, run_store)
        await _run_child_evolution(record, run_store)
        await _dispatch_children(record, run_store)
        await _run_evaluator(record, run_store)
        await _run_causal_loop(record, run_store)
        await _run_reasoner(record, run_store)

        # Build 5D Spatiotemporal KG Graph.
        #
        # When Kafka is enabled the graph is continuously streamed in by the
        # worker's graph consumer (graph_5d_stream) using real event times, so a
        # batch rebuild here would only duplicate edges at synthetic timestamps.
        # In inline/no-Kafka mode there is no stream, so reconstruct from the
        # final record state as a backfill.
        from bus.producer import kafka_enabled

        if not kafka_enabled():
            await asyncio.to_thread(_backfill_5d_graph, record)

        await _run_policy_learning(record, run_store)

        if not kafka_enabled():
            await asyncio.to_thread(_ingest_policy_optimization, record)

        record.status = "completed"
        run_store.save(record)
    except Exception:
        record.status = "failed"
        run_store.save(record)
        raise

    return record.to_graph_state()


async def _run_orchestrator(record: RunRecord, store: RunStore) -> None:
    from agents import grand_orchestrator_node

    store.set_phase(record, "orchestrator")
    state = record.to_graph_state()
    update = await asyncio.to_thread(grand_orchestrator_node, state)
    record.apply_node_update(update)
    store.save(record)


async def _run_parent_evolution(record: RunRecord, store: RunStore) -> None:
    from evolution import (
        evolve_parent_configs,
        merge_evolution_reports,
        publish_evolution_phase,
    )

    store.set_phase(record, "parent_evolution")
    state = record.to_graph_state()
    evolved, phase_report = await asyncio.to_thread(
        evolve_parent_configs,
        state,
        record.parent_configs,
    )
    record.parent_configs = evolved
    record.expected_parent_count = len(evolved)
    record.agent_evolution_report = merge_evolution_reports(
        record.agent_evolution_report,
        phase_report,
    )
    store.save(record)
    await asyncio.to_thread(publish_evolution_phase, state, phase_report)


async def _dispatch_parents(record: RunRecord, store: RunStore) -> None:
    store.set_phase(record, "parents")
    parent_configs = list(record.parent_configs)
    if not parent_configs:
        raise RuntimeError("Orchestrator produced no parent configs")

    record.expected_parent_count = len(parent_configs)
    record.completed_parent_count = 0
    store.save(record)
    await enqueue_parent_tasks(record)
    refreshed = await wait_for_barrier(
        store,
        record.run_id,
        lambda run: run.parents_barrier_met(),
    )
    record.child_configs = refreshed.child_configs
    record.completed_parent_count = refreshed.completed_parent_count


async def _gather_children(record: RunRecord, store: RunStore) -> None:
    """Barrier telemetry after all parents complete."""

    record.expected_child_count = len(record.child_configs)
    store.save(record)
    bind_from_state(record.to_graph_state())
    child_count = len(record.child_configs)
    logger.info("Gathered %s child tasks", child_count)
    publish_telemetry(
        agent_id="control",
        tier="control",
        phase="CHILDREN_GATHER",
        message=f"Gathered {child_count} child tasks",
        status="done",
    )


async def _run_child_evolution(record: RunRecord, store: RunStore) -> None:
    from evolution import (
        evolve_child_configs,
        merge_evolution_reports,
        publish_evolution_phase,
    )

    store.set_phase(record, "child_evolution")
    state = record.to_graph_state()
    evolved, phase_report = await asyncio.to_thread(
        evolve_child_configs,
        state,
        record.child_configs,
    )
    record.child_configs = evolved
    record.expected_child_count = len(evolved)
    record.agent_evolution_report = merge_evolution_reports(
        record.agent_evolution_report,
        phase_report,
    )
    store.save(record)
    await asyncio.to_thread(publish_evolution_phase, state, phase_report)


async def _dispatch_children(record: RunRecord, store: RunStore) -> None:
    store.set_phase(record, "children")
    child_configs = list(record.child_configs)
    if not child_configs:
        raise RuntimeError("No child configs produced by parent agents")

    record.expected_child_count = len(child_configs)
    record.completed_child_count = 0
    store.save(record)
    await enqueue_child_tasks(record)
    refreshed = await wait_for_barrier(
        store,
        record.run_id,
        lambda run: run.children_barrier_met(),
    )
    record.memos = refreshed.memos
    record.completed_child_count = refreshed.completed_child_count


async def _run_evaluator(record: RunRecord, store: RunStore) -> None:
    from evaluator import evaluate_memos_node

    store.set_phase(record, "evaluator")
    state = record.to_graph_state()
    update = await asyncio.to_thread(evaluate_memos_node, state)
    record.apply_node_update(update)
    store.save(record)


async def _run_causal_loop(record: RunRecord, store: RunStore) -> None:
    from causal import causal_synthesis_node, dowhy_engine_node

    while True:
        store.set_phase(record, "causal_synthesis")
        state = record.to_graph_state()
        update = await asyncio.to_thread(causal_synthesis_node, state)
        record.apply_node_update(update)
        store.save(record)

        store.set_phase(record, "estimator")
        state = record.to_graph_state()
        update = await asyncio.to_thread(dowhy_engine_node, state)
        record.apply_node_update(update)
        store.save(record)

        if refutation_next_step(record.to_graph_state()) == "end":
            break


async def _run_reasoner(record: RunRecord, store: RunStore) -> None:
    from reasoning import reasoning_node

    store.set_phase(record, "reasoning")
    state = record.to_graph_state()
    update = await asyncio.to_thread(reasoning_node, state)
    record.apply_node_update(update)
    store.save(record)


async def _run_policy_learning(record: RunRecord, store: RunStore) -> None:
    from policy_learning import policy_learning_node

    store.set_phase(record, "policy_learning")
    state = record.to_graph_state()
    kg_snapshot = await asyncio.to_thread(_load_kg_snapshot, record.run_id)
    update = await asyncio.to_thread(policy_learning_node, state, kg_snapshot)
    record.apply_node_update(update)
    store.save(record)


def _backfill_5d_graph(record: RunRecord) -> None:
    try:
        from graph_5d import connect_graph_db, reconstruct_5d_graph

        conn = connect_graph_db()
        try:
            with conn:
                reconstruct_5d_graph(conn, record.run_id, record)
        finally:
            conn.close()
    except Exception as exc:
        logger.exception("Failed to build 5D spatiotemporal graph: %s", exc)


def _ingest_policy_optimization(record: RunRecord) -> None:
    if not record.policy_optimization_report:
        return
    try:
        from graph_5d import connect_graph_db, ingest_policy_optimization

        conn = connect_graph_db()
        try:
            with conn:
                ingest_policy_optimization(
                    conn,
                    record.run_id,
                    record.policy_optimization_report,
                )
        finally:
            conn.close()
    except Exception as exc:
        logger.exception("Failed to ingest policy optimization graph update: %s", exc)


def _load_kg_snapshot(run_id: str) -> dict[str, Any]:
    try:
        from graph_5d import connect_graph_db, get_5d_graph

        conn = connect_graph_db()
        try:
            with conn:
                return get_5d_graph(conn, run_id)
        finally:
            conn.close()
    except Exception as exc:
        logger.exception("Failed to load KG snapshot for RL loop: %s", exc)
        return {"run_id": run_id, "nodes": [], "edges": []}
