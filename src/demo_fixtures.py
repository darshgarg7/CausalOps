"""Deterministic evidence fixtures for demos and smoke tests.

The fixture in this module is intentionally boring in the best possible way:
it provides a small, repeatable empirical panel where a patch intervention is
associated with reduced lateral movement while adjusting for asset criticality.
It exercises the same compiler, gatekeeper, DoWhy, statsmodels, and refuter
path that real evidence records use.
"""

from __future__ import annotations

from typing import Any


DEMO_SOURCE_NAME = "demo-sentinel-export"


def is_demo_evidence(evidence_records: list[dict[str, Any]] | None) -> bool:
    """True when a run is using the bundled SIEM demo fixture."""

    if not evidence_records:
        return False
    return all(
        record.get("source_name") == DEMO_SOURCE_NAME for record in evidence_records
    )


def resolve_run_evidence(
    evidence_records: list[dict[str, Any]] | None,
) -> tuple[list[dict[str, Any]], bool]:
    """Use demo evidence when the caller did not supply empirical records."""

    if evidence_records:
        return evidence_records, False
    return patch_lateral_movement_evidence(), True


def demo_causal_payload() -> dict[str, Any]:
    """Return the causal hypothesis bundled with the demo evidence fixture."""

    graph = patch_lateral_movement_graph()
    return {
        "graph": graph,
        "measurement_plan": [
            {
                "variable": "Patch_Applied",
                "description": "Whether the vulnerable asset was patched before the observation window.",
                "evidence_fields": ["patch_status", "Patch_Applied"],
                "aggregation": "binary max over pre-window observations",
                "expected_type": "binary",
            },
            {
                "variable": "Lateral_Movement",
                "description": "Whether downstream lateral movement was observed after exposure.",
                "evidence_fields": ["lateral_movement", "Lateral_Movement"],
                "aggregation": "binary max over post-exposure window",
                "expected_type": "binary",
            },
            {
                "variable": "Asset_Criticality",
                "description": "Whether the asset belongs to a high-value tier.",
                "evidence_fields": ["asset_tier", "Asset_Criticality"],
                "aggregation": "binary from inventory tier mapping",
                "expected_type": "binary",
            },
        ],
        "edge_evidence_requirements": [
            {
                "edge": "Asset_Criticality->Patch_Applied",
                "confirming_evidence": ["patch priority tier before movement window"],
                "falsifying_evidence": ["patch timing unrelated to priority"],
            },
            {
                "edge": "Patch_Applied->Lateral_Movement",
                "confirming_evidence": ["patch status before movement window"],
                "falsifying_evidence": ["movement started before patch opportunity"],
            },
        ],
    }


def patch_lateral_movement_graph() -> dict[str, Any]:
    """Return a measurable graph for the built-in evidence-backed demo."""

    return {
        "nodes": [
            {
                "id": "Patch_Applied",
                "label": "Patch Applied",
                "description": "Whether the vulnerable asset was patched.",
            },
            {
                "id": "Lateral_Movement",
                "label": "Lateral Movement",
                "description": "Whether downstream lateral movement was observed.",
            },
            {
                "id": "Asset_Criticality",
                "label": "Asset Criticality",
                "description": "Whether the asset belongs to a high-value tier.",
            },
        ],
        "edges": [
            {
                "source": "Asset_Criticality",
                "target": "Patch_Applied",
                "relationship": "Critical assets are prioritized for patching.",
                "required_evidence": ["asset inventory priority tier"],
                "falsification_tests": ["patch timing unrelated to priority"],
            },
            {
                "source": "Asset_Criticality",
                "target": "Lateral_Movement",
                "relationship": "Critical assets attract more adversary movement.",
                "required_evidence": ["EDR lateral movement alerts by tier"],
                "falsification_tests": ["equal movement rate across tiers"],
            },
            {
                "source": "Patch_Applied",
                "target": "Lateral_Movement",
                "relationship": "Patching reduces exploitability and movement.",
                "required_evidence": ["patch status before movement window"],
                "falsification_tests": ["movement started before patch opportunity"],
            },
        ],
        "treatment_variable": "Patch_Applied",
        "outcome_variable": "Lateral_Movement",
        "candidate_confounders": ["Asset_Criticality"],
    }


def patch_lateral_movement_evidence(n_rows: int = 80) -> list[dict[str, Any]]:
    """Return deterministic SIEM-style evidence records for demo estimation."""

    records: list[dict[str, Any]] = []
    for index in range(n_rows):
        treated = 1 if index % 2 == 0 else 0
        critical = 1 if index % 5 == 0 else 0
        outcome = int(
            (not treated and index % 3 == 0)
            or (critical and index % 7 == 0)
        )
        records.append(
            {
                "source_type": "siem",
                "source_name": DEMO_SOURCE_NAME,
                "observed_at": f"2026-05-12T{index % 24:02d}:00:00Z",
                "asset_id": f"host-{index:03d}",
                "event_type": "compiled_observation",
                "raw_ref": f"demo-row-{index:03d}",
                "extracted_fields": {
                    "Patch_Applied": treated,
                    "Lateral_Movement": outcome,
                    "Asset_Criticality": critical,
                },
                "confidence": 1.0,
            }
        )
    return records
