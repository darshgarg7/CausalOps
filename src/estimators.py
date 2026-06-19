"""Estimate causal effects from compiled evidence datasets.

DoWhy is used for causal identification and effect estimation. Statsmodels is
used for the explicit coefficient report that executives and reviewers ask for:
standard error, p-value, and confidence interval. This split keeps the causal
API clear while preserving familiar statistical diagnostics.
"""

from __future__ import annotations

import warnings
from typing import Any

import dowhy
import pandas as pd

from dataset_compiler import clean_variable, passes_estimation_gates
from schema import CausalDatasetProfile, CausalEstimateReport, RefuterReport


def estimate_causal_effect(
    graph_def: dict[str, Any],
    df: pd.DataFrame,
    profile: CausalDatasetProfile,
) -> CausalEstimateReport:
    """Run quality gates, DoWhy estimation, stats reporting, and refuters."""

    gates_passed, gate_warnings = passes_estimation_gates(profile, df)
    treatment = profile.treatment
    outcome = profile.outcome
    adjustment_set = [
        c
        for c in profile.adjustment_set
        if c in df.columns and c not in {treatment, outcome}
    ]

    if not gates_passed:
        return CausalEstimateReport(
            data_mode=profile.data_mode,
            method="withheld:data_quality_gates",
            treatment=treatment,
            outcome=outcome,
            adjustment_set=adjustment_set,
            n_rows=profile.n_rows,
            warnings=gate_warnings,
            dataset_profile=profile,
        )

    gml_string = _build_gml(graph_def, df.columns)

    try:
        model = dowhy.CausalModel(
            data=df,
            treatment=treatment,
            outcome=outcome,
            graph=gml_string,
        )
        identified_estimand = model.identify_effect(proceed_when_unidentifiable=False)
        estimate = model.estimate_effect(
            identified_estimand,
            method_name="backdoor.linear_regression",
        )
    except Exception as exc:
        return CausalEstimateReport(
            data_mode="empirical",
            method="withheld:dowhy_identification_or_estimation_failed",
            treatment=treatment,
            outcome=outcome,
            adjustment_set=adjustment_set,
            n_rows=profile.n_rows,
            warnings=[*gate_warnings, str(exc)],
            dataset_profile=profile,
        )

    ate = _safe_float(getattr(estimate, "value", None))
    stats = _linear_regression_stats(df, treatment, outcome, adjustment_set)
    refuters = _run_refuters(model, identified_estimand, estimate, ate)
    refutation_passed = bool(refuters) and all(r.passed for r in refuters)

    return CausalEstimateReport(
        data_mode="empirical",
        method="dowhy.backdoor.linear_regression+statsmodels.ols",
        treatment=treatment,
        outcome=outcome,
        adjustment_set=adjustment_set,
        n_rows=profile.n_rows,
        ate=ate,
        standard_error=stats.get("standard_error"),
        p_value=stats.get("p_value"),
        ci_low=stats.get("ci_low"),
        ci_high=stats.get("ci_high"),
        refutation_passed=refutation_passed,
        refuters=refuters,
        warnings=[*gate_warnings, *stats.get("warnings", [])],
        dataset_profile=profile,
    )


def _build_gml(graph_def: dict[str, Any], data_columns) -> str:
    """Build a GML DAG string compatible with NetworkX and DoWhy."""

    data_column_set = {clean_variable(c) for c in data_columns}
    nodes = graph_def.get("nodes", [])
    edges = graph_def.get("edges", [])
    treatment = clean_variable(graph_def.get("treatment_variable", "treatment"))
    outcome = clean_variable(graph_def.get("outcome_variable", "outcome"))
    confounders = {
        clean_variable(c) for c in graph_def.get("candidate_confounders", [])
    }

    required_nodes = {treatment, outcome, *confounders, *data_column_set}
    for node in nodes:
        required_nodes.add(clean_variable(node.get("id", node.get("label", ""))))
    for edge in edges:
        required_nodes.add(clean_variable(edge.get("source", "")))
        required_nodes.add(clean_variable(edge.get("target", "")))

    gml_nodes = "".join(
        f'  node [\n    id "{node_id}"\n    label "{node_id}"\n  ]\n'
        for node_id in sorted(required_nodes)
        if node_id
    )
    gml_edges = "".join(
        "  edge [\n"
        f'    source "{clean_variable(edge.get("source", ""))}"\n'
        f'    target "{clean_variable(edge.get("target", ""))}"\n'
        "  ]\n"
        for edge in edges
        if edge.get("source") and edge.get("target")
    )
    return f"graph [\n  directed 1\n{gml_nodes}{gml_edges}]\n"


def _linear_regression_stats(
    df: pd.DataFrame,
    treatment: str,
    outcome: str,
    adjustment_set: list[str],
) -> dict[str, Any]:
    """Compute OLS diagnostics for the treatment coefficient."""

    try:
        import statsmodels.api as sm
    except Exception as exc:
        return {
            "warnings": [f"statsmodels unavailable; p-value/CI not computed: {exc}"]
        }

    columns = [treatment, *adjustment_set]
    model_df = df[[outcome, *columns]].dropna()
    if model_df.empty or treatment not in model_df:
        return {"warnings": ["No complete rows available for statsmodels reporting."]}

    try:
        x = sm.add_constant(model_df[columns], has_constant="add")
        y = model_df[outcome]
        fit = sm.OLS(y, x).fit()
        ci = fit.conf_int().loc[treatment]
        return {
            "standard_error": _safe_float(fit.bse.get(treatment)),
            "p_value": _safe_float(fit.pvalues.get(treatment)),
            "ci_low": _safe_float(ci.iloc[0]),
            "ci_high": _safe_float(ci.iloc[1]),
            "warnings": [],
        }
    except Exception as exc:
        return {"warnings": [f"statsmodels reporting failed: {exc}"]}


def _run_refuters(
    model,
    identified_estimand,
    estimate,
    ate: float | None,
) -> list[RefuterReport]:
    """Run a compact battery of DoWhy refutation checks."""

    refuters: list[RefuterReport] = []
    for method_name in [
        "random_common_cause",
        "placebo_treatment_refuter",
        "data_subset_refuter",
    ]:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                result = model.refute_estimate(
                    identified_estimand,
                    estimate,
                    method_name=method_name,
                )
            new_effect = _safe_float(getattr(result, "new_effect", None))
            passed = _refuter_passed(method_name, ate, new_effect)
            refuters.append(
                RefuterReport(
                    name=method_name,
                    passed=passed,
                    details=str(result),
                )
            )
        except Exception as exc:
            refuters.append(
                RefuterReport(
                    name=method_name,
                    passed=False,
                    details=str(exc),
                )
            )
    return refuters


def _refuter_passed(
    method_name: str,
    ate: float | None,
    new_effect: float | None,
) -> bool:
    """Apply conservative pass/fail heuristics to refuter effect values."""

    if new_effect is None:
        return False
    if ate is None:
        return False
    tolerance = max(0.05, abs(ate) * 0.35)
    if method_name == "placebo_treatment_refuter":
        return abs(new_effect) <= tolerance
    return abs(new_effect - ate) <= tolerance


def _safe_float(value: Any) -> float | None:
    """Convert third-party numeric return values to plain floats."""

    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None
