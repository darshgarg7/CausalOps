"""HTTP interface for HiveMind's causal evidence compiler.

The API exposes two paths:

* `/run` executes the full agentic workflow and optional evidence-backed
  estimation.
* `/estimate` executes the deterministic compiler/estimator path directly from
  a caller-supplied graph and evidence records. This is the fastest way to demo
  the statistical core without spending LLM tokens.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from bus.consumer import stream_telemetry
from bus.producer import set_event_loop, start_producer, stop_producer
from coordinator.store import get_run_store
from dataset_compiler import compile_evidence_dataset
from demo_fixtures import (
    patch_lateral_movement_evidence,
    patch_lateral_movement_graph,
)
from engine import load_run_artifact, new_run_id, run_hivemind
from estimators import estimate_causal_effect
from evidence_adapters import (
    normalize_cve_records,
    normalize_incident_reports,
    normalize_sentinel_records,
)
from worker.consumer import run_spawn_consumer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("dowhy").setLevel(logging.WARNING)


def _spawn_worker_enabled() -> bool:
    return os.getenv("HIVEMIND_ENABLE_SPAWN_WORKER", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start Kafka producer and optionally the in-process spawn worker."""

    set_event_loop(asyncio.get_running_loop())
    await start_producer()
    stop_event = asyncio.Event()
    worker_task = None
    if _spawn_worker_enabled():
        worker_task = asyncio.create_task(run_spawn_consumer(stop_event=stop_event))
        logger.info("In-process spawn worker enabled")
    else:
        logger.info(
            "In-process spawn worker disabled; expect a separate worker service"
        )
    try:
        yield
    finally:
        stop_event.set()
        if worker_task is not None:
            await worker_task
        await stop_producer()


app = FastAPI(
    title="HiveMind API",
    version="0.2.0",
    description="Evidence-backed causal inference API for cyber decision support.",
    lifespan=lifespan,
)


def _allowed_origins() -> list[str]:
    """Return CORS origins from env, with a local-demo-safe default."""

    configured = os.getenv("HIVEMIND_ALLOWED_ORIGINS", "")
    if configured.strip():
        return [origin.strip() for origin in configured.split(",") if origin.strip()]
    return [
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    """Request body for the full agentic workflow."""

    task_description: str = Field(
        min_length=20,
        description="Natural-language incident or decision scenario.",
    )
    run_id: str | None = Field(
        default=None,
        description="Optional client-supplied run id for SSE telemetry alignment.",
    )
    evidence_records: list[dict[str, Any]] | None = Field(
        default=None,
        description="Optional normalized evidence records for causal estimation.",
    )


class EstimateRequest(BaseModel):
    """Request body for deterministic evidence-backed estimation."""

    graph: dict[str, Any] = Field(
        description="Causal graph containing treatment, outcome, and confounders.",
    )
    evidence_records: list[dict[str, Any]] = Field(
        description="Normalized evidence records to compile into observations.",
    )


class NormalizeRequest(BaseModel):
    """Request body for export-to-evidence normalization endpoints."""

    records: list[dict[str, Any]] = Field(
        description="Raw exported records from the upstream system.",
    )
    source_name: str | None = Field(
        default=None,
        description="Optional concrete feed/index/export name for provenance.",
    )


@app.get("/")
def read_root():
    """Return human-readable API orientation links."""

    return {
        "message": "Welcome to the HiveMind API",
        "docs_url": "/docs",
        "health_check": "/health",
        "run_status": "/run/{run_id}",
        "run_events_sse": "/run/{run_id}/events",
        "demo_estimate": "/demo/estimate",
        "normalizers": [
            "/normalize/sentinel",
            "/normalize/cve",
            "/normalize/incidents",
        ],
    }


@app.get("/health")
def health_check():
    """Return a minimal readiness signal for Docker and load balancers."""

    return {"status": "ok"}


@app.get("/run/{run_id}/events")
async def stream_run_events(run_id: str):
    """Stream execution telemetry for a run as Server-Sent Events."""

    async def event_generator():
        stop_event = asyncio.Event()
        try:
            async for envelope in stream_telemetry(run_id, stop_event=stop_event):
                payload = envelope.payload
                phase = str(payload.get("phase", ""))
                event = {
                    "id": f"{run_id}-{envelope.agent_id}-{envelope.sequence}",
                    "phase": phase,
                    "message": str(payload.get("message", "")),
                    "status": payload.get("status", "running"),
                    "ts": int(envelope.timestamp.timestamp() * 1000),
                }
                yield f"data: {json.dumps(event)}\n\n"
                if phase in ("COMPLETE", "ERROR"):
                    stop_event.set()
                    break
        except asyncio.CancelledError:
            stop_event.set()
            raise

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _execute_run_background(
    *,
    run_id: str,
    task_description: str,
    evidence_records: list[dict[str, Any]] | None,
) -> None:
    """Run HiveMind in the background for async POST /run."""

    try:
        await run_hivemind(
            task_description,
            evidence_records=evidence_records,
            run_id=run_id,
        )
    except Exception:
        logger.exception("Background run failed for run_id=%s", run_id)


@app.get("/run/{run_id}")
async def get_run_status(run_id: str):
    """Return run lifecycle status and artifact when complete."""

    store = get_run_store()
    try:
        record = store.get_run(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc

    artifact = None
    if record.status == "completed":
        artifact = load_run_artifact(run_id)

    # Coordinator may mark the run completed before the artifact file is written.
    effective_status = record.status
    if record.status == "completed" and artifact is None:
        effective_status = "running"

    payload: dict[str, Any] = {
        "run_id": run_id,
        "status": effective_status,
    }
    if record.error_detail:
        payload["error"] = record.error_detail
    if artifact is not None:
        payload["artifact"] = artifact
    return payload


class STEdgeIngest(BaseModel):
    subject: str = Field(description="Subject node ID")
    predicate: str = Field(description="Action link or relationship")
    object: str = Field(description="Object node ID")
    observed_at: str | None = Field(default=None, description="ISO timestamp")
    location: dict[str, Any] | None = Field(
        default=None, description="Spatial coordinates or zones"
    )
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    metadata: dict[str, Any] | None = Field(
        default=None, description="Additional metadata"
    )


class STNodeIngest(BaseModel):
    id: str = Field(description="Node ID")
    node_type: str = Field(
        description="agent | asset | threat | artifact | causal_variable"
    )
    label: str = Field(description="Display label")
    description: str | None = Field(default=None)
    location: dict[str, Any] | None = Field(default=None)


class Ingest5DRequest(BaseModel):
    nodes: list[STNodeIngest] = Field(default_factory=list)
    edges: list[STEdgeIngest] = Field(default_factory=list)


@app.get("/run/{run_id}/graph/5d")
async def get_run_5d_graph(run_id: str):
    """Retrieve the 5D Spatiotemporal Knowledge Graph for a run."""

    store = get_run_store()
    try:
        # Verify run exists
        store.get_run(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc

    return store.get_5d_graph(run_id)


@app.get("/run/{run_id}/reasoning")
async def get_run_reasoning(run_id: str):
    """Return the reasoning layer's anomalies and recommendations for a run."""

    store = get_run_store()
    try:
        record = store.get_run(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc

    if not record.reasoning_report:
        raise HTTPException(
            status_code=404, detail="Reasoning report not available for this run"
        )
    return record.reasoning_report


@app.post("/run/{run_id}/graph/5d/ingest", status_code=200)
async def ingest_run_5d_graph(run_id: str, request: Ingest5DRequest):
    """Manually ingest node and edge tuples into the 5D spatiotemporal graph."""

    store = get_run_store()
    try:
        store.get_run(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc

    try:
        conn = store._connect()
        try:
            with conn:
                from graph_5d import log_st_edge, log_st_node

                for node in request.nodes:
                    log_st_node(
                        conn,
                        run_id=run_id,
                        node_id=node.id,
                        node_type=node.node_type,
                        label=node.label,
                        description=node.description or "",
                        location=node.location,
                    )
                for edge in request.edges:
                    log_st_edge(
                        conn,
                        run_id=run_id,
                        subject_id=edge.subject,
                        predicate=edge.predicate,
                        object_id=edge.object,
                        observed_at=edge.observed_at,
                        location=edge.location,
                        confidence=edge.confidence,
                        edge_metadata=edge.metadata,
                    )
        finally:
            conn.close()
        return {
            "status": "ok",
            "nodes_ingested": len(request.nodes),
            "edges_ingested": len(request.edges),
        }
    except Exception as exc:
        logger.exception("Failed manual ingestion of 5D graph elements: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/run", status_code=202)
async def enqueue_run(request: RunRequest):
    """Enqueue the full agent graph and return immediately."""

    run_id = request.run_id or new_run_id()
    store = get_run_store()
    try:
        existing = store.get_run(run_id)
    except KeyError:
        existing = None

    if existing is not None and existing.status in ("queued", "running"):
        raise HTTPException(
            status_code=409,
            detail=f"Run {run_id} is already {existing.status}",
        )

    store.enqueue_run(
        run_id=run_id,
        correlation_id=run_id,
        task_description=request.task_description,
        evidence_records=request.evidence_records,
    )
    asyncio.create_task(
        _execute_run_background(
            run_id=run_id,
            task_description=request.task_description,
            evidence_records=request.evidence_records,
        )
    )
    logger.info("Enqueued HiveMind run_id=%s", run_id)
    return JSONResponse(
        status_code=202,
        content={"run_id": run_id, "status": "queued"},
    )


@app.post("/run/sync")
async def run_engine_sync(request: RunRequest):
    """Blocking run endpoint retained for scripts and integration tests."""

    logger.info("Received synchronous request to run HiveMind engine")
    try:
        result = await run_hivemind(
            request.task_description,
            evidence_records=request.evidence_records,
            run_id=request.run_id,
        )
        logger.info(
            "Successfully generated output for run_id: %s",
            result.get("run_id"),
        )
        return result
    except Exception as exc:
        logger.exception("Error executing run_hivemind")
        raise HTTPException(
            status_code=500,
            detail="HiveMind execution failed. See API logs for details.",
        ) from exc


@app.post("/estimate")
async def estimate_from_evidence(request: EstimateRequest):
    """Compile caller evidence and return a causal estimate report."""

    compilation = await asyncio.to_thread(
        compile_evidence_dataset,
        request.graph,
        request.evidence_records,
    )
    report = await asyncio.to_thread(
        estimate_causal_effect,
        request.graph,
        compilation.dataframe,
        compilation.profile,
    )
    return {
        "causal_estimate_report": report.model_dump(),
        "causal_dataset_profile": compilation.profile.model_dump(),
        "provenance": compilation.provenance,
    }


@app.post("/normalize/sentinel")
def normalize_sentinel_export(request: NormalizeRequest):
    """Normalize Microsoft Sentinel or SIEM-like export rows."""

    return {
        "evidence_records": list(
            normalize_sentinel_records(
                request.records,
                source_name=request.source_name or "microsoft-sentinel-export",
            )
        )
    }


@app.post("/normalize/cve")
def normalize_cve_export(request: NormalizeRequest):
    """Normalize NVD/CVE feed rows into evidence records."""

    return {
        "evidence_records": list(
            normalize_cve_records(
                request.records,
                source_name=request.source_name or "cve-feed-export",
            )
        )
    }


@app.post("/normalize/incidents")
def normalize_incident_export(request: NormalizeRequest):
    """Normalize incident-report export rows into evidence records."""

    return {
        "evidence_records": list(
            normalize_incident_reports(
                request.records,
                source_name=request.source_name or "incident-report-export",
            )
        )
    }


@app.get("/demo/estimate")
async def demo_estimate():
    """Run a deterministic SIEM-style evidence-backed causal estimate."""

    graph = patch_lateral_movement_graph()
    evidence = patch_lateral_movement_evidence()
    compilation = await asyncio.to_thread(compile_evidence_dataset, graph, evidence)
    report = await asyncio.to_thread(
        estimate_causal_effect, graph, compilation.dataframe, compilation.profile
    )
    return {
        "scenario": "patching reduces observed lateral movement",
        "graph": graph,
        "causal_estimate_report": report.model_dump(),
        "causal_dataset_profile": compilation.profile.model_dump(),
        "provenance_sample": compilation.provenance[:5],
    }
