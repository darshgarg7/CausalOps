"""Contract tests for HiveMind's public FastAPI surface."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
os.environ.setdefault("AZURE_OPENAI_API_KEY", "test-key")
os.environ.setdefault("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
os.environ.setdefault("AZURE_OPENAI_API_VERSION", "2024-08-01-preview")

from api import app  # noqa: E402

client = TestClient(app)


def test_health_check_contract():
    """The API should expose a minimal readiness endpoint."""

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_sentinel_normalizer_contract():
    """The Sentinel normalizer should return estimator-ready evidence rows."""

    response = client.post(
        "/normalize/sentinel",
        json={
            "source_name": "sentinel-prod-kql",
            "records": [
                {
                    "SystemAlertId": "alert-001",
                    "Computer": "host-001",
                    "AlertName": "Lateral movement detected",
                    "Severity": "High",
                    "Patch Applied": 1,
                    "Lateral_Movement": 0,
                }
            ],
        },
    )

    payload = response.json()
    record = payload["evidence_records"][0]

    assert response.status_code == 200
    assert record["source_type"] == "siem"
    assert record["source_name"] == "sentinel-prod-kql"
    assert record["asset_id"] == "host-001"
    assert record["severity"] == 8.0
    assert record["extracted_fields"]["Patch_Applied"] == 1


def test_estimate_contract_withholds_synthetic_ate(patch_graph, synthetic_evidence):
    """The API must refuse production ATE output for synthetic-only records."""

    response = client.post(
        "/estimate",
        json={"graph": patch_graph, "evidence_records": synthetic_evidence},
    )

    payload = response.json()
    report = payload["causal_estimate_report"]
    profile = payload["causal_dataset_profile"]

    assert response.status_code == 200
    assert profile["data_mode"] == "synthetic_simulation"
    assert report["method"] == "withheld:data_quality_gates"
    assert report["data_mode"] == "synthetic_simulation"
    assert report["ate"] is None
    assert report["p_value"] is None
    assert payload["provenance"] == []


def test_estimate_contract_accepts_empirical_evidence(patch_graph, patch_evidence):
    """The direct estimator endpoint should expose empirical causal statistics."""

    response = client.post(
        "/estimate",
        json={"graph": patch_graph, "evidence_records": patch_evidence},
    )

    payload = response.json()
    report = payload["causal_estimate_report"]
    profile = payload["causal_dataset_profile"]

    assert response.status_code == 200
    assert profile["data_mode"] == "empirical"
    assert profile["n_rows"] == 80
    assert profile["treated_count"] == 40
    assert profile["control_count"] == 40
    assert report["ate"] == pytest.approx(-0.3, abs=1e-9)
    assert report["p_value"] is not None
    assert report["ci_low"] is not None
    assert report["ci_high"] is not None
    assert len(report["refuters"]) == 3


def test_demo_estimate_contract_returns_real_statistics():
    """The deterministic demo endpoint should expose non-hard-coded statistics."""

    response = client.get("/demo/estimate")

    payload = response.json()
    report = payload["causal_estimate_report"]
    profile = payload["causal_dataset_profile"]

    assert response.status_code == 200
    assert payload["scenario"] == "patching reduces observed lateral movement"
    assert profile["data_mode"] == "empirical"
    assert profile["n_rows"] == 80
    assert profile["treated_count"] == 40
    assert profile["control_count"] == 40
    assert report["method"] == "dowhy.backdoor.linear_regression+statsmodels.ols"
    assert report["ate"] == pytest.approx(-0.3, abs=1e-9)
    assert report["p_value"] is not None
    assert report["ci_low"] is not None
    assert report["ci_high"] is not None
    assert len(report["refuters"]) == 3
    assert len(payload["provenance_sample"]) == 5
