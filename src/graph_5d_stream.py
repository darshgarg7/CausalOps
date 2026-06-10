"""Incremental Kafka-driven ingestion for the 5D Spatiotemporal KG.

Maps individual bus ``EventEnvelope``s to spatiotemporal node/edge mutations so
the graph evolves continuously as a run streams, instead of only being
reconstructed in one batch at the end. Every write goes through the same
idempotent upsert helpers as the batch reconstruction (``graph_5d``), so the
streaming path and any later backfill converge on identical graph state.

The envelope's own ``timestamp`` is used as the observed time, which makes the
agent/swarm tier appear on the timeline at the moment it actually happened
during the run rather than at synthetic offsets.
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from bus.events import ArtifactType, EventEnvelope
from graph_5d import (
    ingest_causal,
    ingest_child,
    ingest_evidence_record,
    ingest_findings,
    ingest_memo,
    ingest_orchestrator,
    ingest_parent,
)

logger = logging.getLogger(__name__)


def apply_envelope(conn: sqlite3.Connection, envelope: EventEnvelope) -> bool:
    """Apply a single bus envelope to the 5D graph.

    Returns ``True`` when the envelope mapped to a graph mutation, ``False`` for
    envelope types the graph does not model (telemetry phases, etc.).
    """

    artifact_type = envelope.artifact_type
    run_id = envelope.run_id
    observed_at = envelope.timestamp.isoformat()
    payload = envelope.payload or {}

    if artifact_type == ArtifactType.RUN_STARTED:
        ingest_orchestrator(conn, run_id, observed_at=observed_at)
        # Stream in the telemetry/evidence layer the run was created with so the
        # asset/user/threat/event nodes also appear at their real observed time.
        _ingest_run_evidence(conn, run_id, default_time=observed_at)
        return True

    if artifact_type == ArtifactType.AGENT_CONFIG:
        ingest_parent(conn, run_id, payload, observed_at=observed_at)
        return True

    if artifact_type == ArtifactType.CHILD_CONFIG:
        ingest_child(conn, run_id, payload, observed_at=observed_at)
        return True

    if artifact_type == ArtifactType.DECISION_MEMO:
        child_configs = _load_child_configs(run_id)
        ingest_memo(conn, run_id, payload, child_configs, observed_at=observed_at)
        return True

    if artifact_type == ArtifactType.CAUSAL_PAYLOAD:
        graph = payload.get("graph", {}) or {}
        ingest_causal(conn, run_id, graph, observed_at=observed_at)
        # Causal variables now exist, so (re)link any asset measurements to them.
        causal_nodes = graph.get("nodes", []) or []
        if causal_nodes:
            _ingest_run_evidence(
                conn, run_id, default_time=observed_at, causal_nodes=causal_nodes
            )
        return True

    if artifact_type == ArtifactType.REASONING_REPORT:
        ingest_findings(conn, run_id, payload, observed_at=observed_at)
        return True

    return False


def _load_record(run_id: str) -> Any | None:
    """Load the current RunRecord from the shared store, if present."""

    try:
        from coordinator.store import get_run_store

        return get_run_store().get_run(run_id)
    except Exception:
        # Record may not be persisted yet, or store unavailable — skip gracefully.
        return None


def _load_child_configs(run_id: str) -> list[Any]:
    record = _load_record(run_id)
    if record is None:
        return []
    return list(getattr(record, "child_configs", []) or [])


def _ingest_run_evidence(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    default_time: str,
    causal_nodes: list[dict[str, Any]] | None = None,
) -> None:
    record = _load_record(run_id)
    if record is None:
        return
    evidence = getattr(record, "evidence_records", []) or []
    for r in evidence:
        ingest_evidence_record(
            conn, run_id, r, causal_nodes, default_time=default_time
        )
