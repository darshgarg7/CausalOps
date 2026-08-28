"""Shared fixtures for CausalOps's backend test suite."""

from __future__ import annotations

import pytest
from dotenv import load_dotenv

from demo_fixtures import (
    patch_lateral_movement_evidence,
    patch_lateral_movement_graph,
)

# Auto-load repo-root .env so `pytest -m integration` picks up real Supabase/Azure
# credentials without requiring a manual `source .env` first. Docker already gets
# this via docker-compose's `env_file:`; nothing outside Docker wired it in before.
load_dotenv()


@pytest.fixture(autouse=True)
def kafka_off_for_unit_tests(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Force inline spawn dispatch in unit tests.

    Broker tests opt out via the ``kafka`` marker.
    """

    if request.node.get_closest_marker("kafka") is not None:
        return
    monkeypatch.delenv("KAFKA_BOOTSTRAP", raising=False)


@pytest.fixture(autouse=True)
def memory_creds_off_for_unit_tests(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Force the memory layer "unconfigured" for unit tests.

    ``load_dotenv()`` above makes real Supabase/Azure credentials visible at
    collection time so the ``integration`` marker's ``skipif`` gate resolves
    correctly. Without this fixture, every *other* test would also see those
    credentials at run time and silently turn offline unit tests (e.g.
    ``test_coordinator_runner.py``, which never sets a memory-related env var
    itself) into live network calls against production Supabase/Azure.
    Integration tests opt out via the ``integration`` marker, same pattern as
    ``kafka_off_for_unit_tests`` above.
    """

    if request.node.get_closest_marker("integration") is not None:
        return
    for var in (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
    ):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def patch_graph():
    """Return the deterministic patching/lateral-movement causal graph."""

    return patch_lateral_movement_graph()


@pytest.fixture
def patch_evidence():
    """Return the deterministic SIEM-style evidence panel."""

    return patch_lateral_movement_evidence()


@pytest.fixture
def synthetic_evidence():
    """Return LLM-like synthetic rows that must never produce production ATE."""

    return [
        {
            "source_type": "synthetic",
            "source_name": "llm-generated-table",
            "raw_ref": f"synthetic-{index:03d}",
            "extracted_fields": {
                "Patch_Applied": index % 2,
                "Lateral_Movement": (index + 1) % 2,
                "Asset_Criticality": index % 5 == 0,
            },
        }
        for index in range(80)
    ]
