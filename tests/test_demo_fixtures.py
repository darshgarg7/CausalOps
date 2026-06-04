"""Tests for bundled demo evidence and causal fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from dataset_compiler import compile_evidence_dataset  # noqa: E402
from demo_fixtures import (  # noqa: E402
    demo_causal_payload,
    is_demo_evidence,
    patch_lateral_movement_evidence,
    patch_lateral_movement_graph,
    resolve_run_evidence,
)
from estimators import estimate_causal_effect  # noqa: E402


def test_resolve_run_evidence_uses_demo_when_missing() -> None:
    records, used_demo = resolve_run_evidence(None)
    assert used_demo is True
    assert len(records) == 80
    assert is_demo_evidence(records)


def test_resolve_run_evidence_preserves_caller_records() -> None:
    caller = [{"source_type": "manual", "source_name": "upload", "raw_ref": "row-1"}]
    records, used_demo = resolve_run_evidence(caller)
    assert used_demo is False
    assert records == caller


def test_demo_fixture_passes_estimation_gates() -> None:
    graph = patch_lateral_movement_graph()
    evidence = patch_lateral_movement_evidence()
    compilation = compile_evidence_dataset(graph, evidence)
    report = estimate_causal_effect(
        graph,
        compilation.dataframe,
        compilation.profile,
    )

    assert report.ate is not None
    assert report.method.startswith("dowhy.")
    assert report.n_rows >= 50


def test_demo_causal_payload_matches_graph() -> None:
    payload = demo_causal_payload()
    graph = payload["graph"]
    assert graph["treatment_variable"] == "Patch_Applied"
    assert graph["outcome_variable"] == "Lateral_Movement"
    assert "Asset_Criticality" in graph["candidate_confounders"]
