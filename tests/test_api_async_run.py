"""API tests for async POST /run and GET /run/{run_id}."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from coordinator.store import RunStore, set_run_store  # noqa: E402
from engine import DATA_DIR  # noqa: E402


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    run_store = RunStore(db_path=tmp_path / "runs.db")
    set_run_store(run_store)
    yield run_store
    set_run_store(None)


@pytest.fixture
def client(store: RunStore):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from api import app

    with TestClient(app) as test_client:
        yield test_client


def test_post_run_returns_202(client) -> None:
    with patch("api._execute_run_background"):
        response = client.post(
            "/run",
            json={
                "task_description": "Investigate lateral movement in finance segment",
                "run_id": "run-api-202",
            },
        )

    assert response.status_code == 202
    body = response.json()
    assert body["run_id"] == "run-api-202"
    assert body["status"] == "queued"


def test_get_run_returns_completed_artifact(client, store: RunStore) -> None:
    artifact = {
        "run_id": "run-api-get",
        "strategies": [],
        "causal_graph": {"nodes": [], "edges": []},
        "impact": {"ate": None, "confidence": "insufficient_data"},
    }
    record = store.enqueue_run(
        run_id="run-api-get",
        correlation_id="run-api-get",
        task_description="Investigate lateral movement in finance segment",
    )
    store.set_status(record, "completed")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    artifact_path = DATA_DIR / "run-api-get.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    response = client.get("/run/run-api-get")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["artifact"]["run_id"] == "run-api-get"


def test_get_run_completed_without_artifact_reports_running(
    client, store: RunStore
) -> None:
    record = store.enqueue_run(
        run_id="run-api-pending-artifact",
        correlation_id="run-api-pending-artifact",
        task_description="Investigate lateral movement in finance segment",
    )
    store.set_status(record, "completed")

    response = client.get("/run/run-api-pending-artifact")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "running"
    assert "artifact" not in body


def test_get_run_not_found(client) -> None:
    response = client.get("/run/run-missing")
    assert response.status_code == 404


def test_post_run_conflict_when_in_progress(client, store: RunStore) -> None:
    store.enqueue_run(
        run_id="run-api-busy",
        correlation_id="run-api-busy",
        task_description="Investigate lateral movement in finance segment",
    )

    with patch("api._execute_run_background"):
        response = client.post(
            "/run",
            json={
                "task_description": "Investigate lateral movement in finance segment",
                "run_id": "run-api-busy",
            },
        )

    assert response.status_code == 409
