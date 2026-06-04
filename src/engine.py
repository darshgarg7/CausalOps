"""Execution engine for HiveMind runs.

This module is the backend boundary used by the HTTP API and the legacy
Streamlit demo. It runs the Phase 2 coordinator workflow, composes a
frontend-friendly artifact, emits deterministic tier metrics, and persists
the full run record.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from benchmarking import score_agent_tiers
from bus.context import bind_run_context, clear_run_context, get_run_summary
from bus.helpers import bind_from_state
from bus.producer import set_event_loop
from bus.publish import publish_run_event, publish_telemetry
from coordinator.runner import execute_run
from coordinator.store import RunRecord, get_run_store
from demo_fixtures import is_demo_evidence, resolve_run_evidence

DATA_DIR = Path("../data")


def serialize_pydantic(obj: Any) -> Any:
    """Serialize Pydantic objects while leaving plain values untouched."""

    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    return obj


def new_run_id() -> str:
    """Generate a unique run identifier."""

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"run-{stamp}-{uuid.uuid4().hex[:8]}"


async def run_hivemind(
    task_description: str,
    evidence_records: list[dict[str, Any]] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Run the full HiveMind workflow and return a persisted artifact."""

    resolved_run_id = run_id or new_run_id()
    correlation_id = resolved_run_id
    resolved_evidence, used_demo_fixture = resolve_run_evidence(evidence_records)
    bind_run_context(resolved_run_id, correlation_id)
    set_event_loop(asyncio.get_running_loop())

    initial_state = {
        "task_description": task_description,
        "run_id": resolved_run_id,
        "correlation_id": correlation_id,
        "evidence_records": resolved_evidence,
    }

    publish_run_event("started")
    publish_telemetry(
        agent_id="control",
        tier="control",
        phase="ORCHESTRATOR",
        message="Run started",
        status="running",
    )

    bus_summary: dict[str, Any] = {}
    try:
        final_state = await execute_run(
            task_description=task_description,
            evidence_records=resolved_evidence,
            run_id=resolved_run_id,
            correlation_id=correlation_id,
        )
        try:
            record = get_run_store().get_run(resolved_run_id)
            bus_summary = _bus_summary_from_record(record)
        except KeyError:
            bus_summary = get_run_summary()
    except Exception as exc:
        bind_from_state(initial_state)
        publish_run_event("failed", detail=str(exc))
        publish_telemetry(
            agent_id="control",
            tier="control",
            phase="ERROR",
            message=str(exc),
            status="error",
        )
        try:
            record = get_run_store().get_run(resolved_run_id)
            get_run_store().set_status(record, "failed", error_detail=str(exc))
        except KeyError:
            pass
        raise
    finally:
        clear_run_context()

    run_id = final_state.get("run_id", resolved_run_id)
    DATA_DIR.mkdir(exist_ok=True)

    memos_raw = [serialize_pydantic(memo) for memo in final_state.get("memos", [])]
    strategies = [_strategy_card(i, memo) for i, memo in enumerate(memos_raw)]

    causal_payload = final_state.get("causal_payload") or {}
    causal_graph = causal_payload.get("graph", {})
    dowhy_results = final_state.get("dowhy_results") or {}
    causal_estimate_report = final_state.get("causal_estimate_report") or {}
    causal_dataset_profile = final_state.get("causal_dataset_profile") or {}
    agent_tier_metrics = score_agent_tiers(final_state, summary=bus_summary)
    ate_estimate = _impact_ate(causal_estimate_report, dowhy_results)
    confidence = _impact_confidence(causal_estimate_report)

    artifact = {
        "run_id": run_id,
        "strategies": strategies,
        "ranked_strategies": final_state.get("ranked_strategies", []),
        "final_recommendation": final_state.get("final_recommendation"),
        "evaluator_error": final_state.get("evaluator_error"),
        "causal_graph": causal_graph,
        "impact": {
            "ate": ate_estimate,
            "confidence": confidence,
            "p_value": causal_estimate_report.get("p_value"),
            "ci_low": causal_estimate_report.get("ci_low"),
            "ci_high": causal_estimate_report.get("ci_high"),
            "n_rows": causal_estimate_report.get("n_rows", 0),
            "method": causal_estimate_report.get("method", "unknown"),
            "demo_fixture": used_demo_fixture
            or is_demo_evidence(resolved_evidence),
        },
        "causal_estimate_report": causal_estimate_report,
        "causal_dataset_profile": causal_dataset_profile,
        "agent_tier_metrics": agent_tier_metrics,
        "bus_summary": bus_summary,
    }

    artifact_path = DATA_DIR / f"{run_id}.json"
    with artifact_path.open("w", encoding="utf-8") as handle:
        json.dump(artifact, handle, indent=2)

    try:
        record = get_run_store().get_run(run_id)
        get_run_store().set_status(record, "completed")
    except KeyError:
        pass

    bind_run_context(run_id, correlation_id)
    try:
        publish_telemetry(
            agent_id="control",
            tier="control",
            phase="COMPLETE",
            message="Causal loop complete",
            status="done",
        )
        publish_run_event("completed")
    finally:
        clear_run_context()

    return artifact


def load_run_artifact(run_id: str) -> dict[str, Any] | None:
    """Load a persisted run artifact from disk."""

    artifact_path = DATA_DIR / f"{run_id}.json"
    if not artifact_path.is_file():
        return None
    with artifact_path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _bus_summary_from_record(record: RunRecord) -> dict[str, Any]:
    """Derive bus_summary counters from durable run store state."""

    return {
        "parent_config_count": len(record.parent_configs),
        "child_config_count": len(record.child_configs),
        "memo_count": len(record.memos),
        "has_ranked_strategies": bool(record.ranked_strategies),
        "has_causal_payload": record.causal_payload is not None,
        "has_estimate_report": record.causal_estimate_report is not None,
    }


def _strategy_card(index: int, memo: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw decision memo into a compact UI strategy card."""

    perspective = str(memo.get("perspective", "") or "").strip()
    strategy = str(memo.get("strategy", "") or "").strip()
    fallback_title = f"Strategy {index + 1}"
    if perspective:
        title = perspective[:80] + ("..." if len(perspective) > 80 else "")
    else:
        title = fallback_title
    summary = strategy or perspective or fallback_title
    score_key = f"{perspective}\n{strategy}"
    return {
        "title": title,
        "summary": summary,
        "risk_score": _risk_score(memo),
        "cost_score": _stable_score(score_key, "cost", 0.25, 0.75),
        "speed_score": _stable_score(score_key, "speed", 0.25, 0.85),
    }


def _impact_ate(
    causal_estimate_report: dict[str, Any],
    dowhy_results: dict[str, Any],
) -> float | None:
    """Return ATE for the UI, or None when estimation was withheld."""

    method = str(causal_estimate_report.get("method", ""))
    if method.startswith("withheld:") or causal_estimate_report.get("ate") is None:
        return None
    value = causal_estimate_report.get("ate", dowhy_results.get("ate_estimate"))
    if value is None:
        return None
    return _safe_float(value, default=None)


def _memo_text(memo: dict[str, Any]) -> str:
    """Return the most useful text view of a serialized memo."""

    if "content" in memo:
        return str(memo["content"])
    return json.dumps(memo, ensure_ascii=False)


def _risk_score(memo: dict[str, Any]) -> float:
    """Derive a deterministic display risk score from memo risk metadata."""

    risks = memo.get("risks", [])
    confidence = str(memo.get("confidence", "") or "").lower()
    base = min(0.85, 0.18 + 0.11 * len(risks or []))
    if confidence == "high":
        base -= 0.08
    elif confidence == "low":
        base += 0.08
    return round(max(0.05, min(0.95, base)), 2)


def _stable_score(text: str, salt: str, low: float, high: float) -> float:
    """Create a stable pseudo-score for UI dimensions without randomness."""

    digest = hashlib.sha256(f"{salt}:{text}".encode("utf-8")).hexdigest()
    value = int(digest[:8], 16) / 0xFFFFFFFF
    return round(low + (high - low) * value, 2)


def _impact_confidence(report: dict[str, Any]) -> str:
    """Map estimator diagnostics into a simple frontend confidence label."""

    if not report or report.get("ate") is None:
        return "insufficient_data"
    p_value = report.get("p_value")
    refuted = report.get("refutation_passed", False)
    if refuted and p_value is not None and p_value <= 0.05:
        return "high"
    if p_value is not None and p_value <= 0.1:
        return "medium"
    return "low"


def _safe_float(value: Any, default: float | None = 0.0) -> float | None:
    """Convert estimator values to JSON-safe floats for the UI."""

    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default
