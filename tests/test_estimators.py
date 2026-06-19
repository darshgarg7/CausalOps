"""Tests for DoWhy/statsmodels causal estimation behavior."""

from __future__ import annotations

import pytest

from dataset_compiler import compile_evidence_dataset
from estimators import estimate_causal_effect


def test_demo_estimate_reports_real_statistics(patch_graph, patch_evidence):
    """The deterministic demo should produce a real p-value and confidence band."""

    compilation = compile_evidence_dataset(patch_graph, patch_evidence)
    report = estimate_causal_effect(
        patch_graph,
        compilation.dataframe,
        compilation.profile,
    )

    assert report.data_mode == "empirical"
    assert report.method == "dowhy.backdoor.linear_regression+statsmodels.ols"
    assert report.n_rows == 80
    assert report.ate == pytest.approx(-0.3, abs=1e-9)
    assert report.standard_error is not None
    assert report.p_value is not None
    assert report.p_value < 0.01
    assert report.ci_low is not None
    assert report.ci_high is not None
    assert report.ci_low < report.ate < report.ci_high
    assert len(report.refuters) == 3
    assert {refuter.name for refuter in report.refuters} == {
        "random_common_cause",
        "placebo_treatment_refuter",
        "data_subset_refuter",
    }


def test_estimator_withholds_when_compiler_rejects_data(
    patch_graph,
    synthetic_evidence,
):
    """Synthetic rows should reach the estimator as an explicit refusal."""

    compilation = compile_evidence_dataset(patch_graph, synthetic_evidence)
    report = estimate_causal_effect(
        patch_graph,
        compilation.dataframe,
        compilation.profile,
    )

    assert report.data_mode == "synthetic_simulation"
    assert report.method == "withheld:data_quality_gates"
    assert report.ate is None
    assert report.p_value is None
    assert report.ci_low is None
    assert report.ci_high is None
    assert report.refutation_passed is False
    assert any("Empirical data gate failed" in warning for warning in report.warnings)


def test_estimator_withholds_when_no_evidence_is_available(patch_graph):
    """No evidence should produce a withheld report with no diagnostics invented."""

    compilation = compile_evidence_dataset(patch_graph, [])
    report = estimate_causal_effect(
        patch_graph,
        compilation.dataframe,
        compilation.profile,
    )

    assert report.data_mode == "insufficient_data"
    assert report.method == "withheld:data_quality_gates"
    assert report.n_rows == 0
    assert report.ate is None
    assert report.standard_error is None
    assert report.p_value is None
    assert report.refuters == []
    assert any("Minimum row gate failed" in warning for warning in report.warnings)


def test_estimator_withholds_when_outcome_has_no_variation(
    patch_graph,
    patch_evidence,
):
    """A constant outcome should be blocked before DoWhy runs."""

    constant_outcome = []
    for record in patch_evidence:
        copy = dict(record)
        copy["extracted_fields"] = {
            **record["extracted_fields"],
            "Lateral_Movement": 0,
        }
        constant_outcome.append(copy)

    compilation = compile_evidence_dataset(patch_graph, constant_outcome)
    report = estimate_causal_effect(
        patch_graph,
        compilation.dataframe,
        compilation.profile,
    )

    assert report.data_mode == "empirical"
    assert report.method == "withheld:data_quality_gates"
    assert report.ate is None
    assert report.p_value is None
    assert any(
        "Outcome variation gate failed" in warning for warning in report.warnings
    )
