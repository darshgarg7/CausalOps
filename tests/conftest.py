"""Shared fixtures for HiveMind's backend test suite."""

from __future__ import annotations

import pytest

from demo_fixtures import (
    patch_lateral_movement_evidence,
    patch_lateral_movement_graph,
)


@pytest.fixture(autouse=True)
def kafka_off_for_unit_tests(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Force inline spawn dispatch in unit tests (broker tests opt out via ``kafka`` marker)."""

    if request.node.get_closest_marker("kafka") is not None:
        return
    monkeypatch.delenv("KAFKA_BOOTSTRAP", raising=False)


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
