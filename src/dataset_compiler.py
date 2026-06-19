"""Compile normalized cyber evidence into estimator-ready causal datasets.

This module is the critical boundary between LLM-authored hypotheses and
statistical estimation. The compiler accepts a graph definition plus normalized
evidence records, then produces a numeric dataframe, row-level provenance, and
quality gates. If evidence is missing or structurally weak, the estimator is
expected to withhold ATE output rather than inventing rows.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

import pandas as pd
import polars as pl
from pydantic import ValidationError

from schema import CausalDatasetProfile, EvidenceRecord

MIN_COMPLETE_ROWS = 50
RECOMMENDED_COMPLETE_ROWS = 200
MIN_TREATMENT_GROUP_ROWS = 10


def clean_variable(value: str) -> str:
    """Normalize causal variable names for pandas, GML, and DoWhy."""

    return value.strip().replace(" ", "_").replace("-", "_")


@dataclass
class DatasetCompilation:
    """Compiled evidence dataframe and metadata returned by the compiler."""

    dataframe: pd.DataFrame
    profile: CausalDatasetProfile
    provenance: list[dict[str, Any]]


def _coerce_float(value: Any) -> float | None:
    """Convert common evidence encodings into numeric model values."""

    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        text = str(value).strip().lower()
        if text in {"true", "yes", "present", "detected", "treated"}:
            return 1.0
        if text in {"false", "no", "absent", "clean", "control"}:
            return 0.0
    return None


def _normalize_records(records: Iterable[dict[str, Any]]) -> Iterator[EvidenceRecord]:
    """Validate evidence records without dropping malformed inputs silently."""

    for i, record in enumerate(records or []):
        try:
            yield EvidenceRecord(**record)
        except ValidationError as exc:
            yield EvidenceRecord(
                source_type="manual",
                source_name="invalid-record-wrapper",
                raw_ref=f"record-{i}",
                raw_text=str(record),
                extracted_fields={"_parse_error": str(exc)},
            )


def _variable_lookup(record: EvidenceRecord, variable: str) -> float | None:
    """Find a numeric value for one graph variable inside one evidence record."""

    fields = record.extracted_fields or {}
    candidates = {
        variable,
        clean_variable(variable),
        variable.replace("_", " "),
        variable.lower(),
        clean_variable(variable).lower(),
    }

    lowered_fields = {k.lower(): v for k, v in fields.items()}
    for key in candidates:
        if key in fields:
            return _coerce_float(fields[key])
        if key.lower() in lowered_fields:
            return _coerce_float(lowered_fields[key.lower()])

    event_type = (record.event_type or "").lower().replace(" ", "_")
    if event_type and event_type == clean_variable(variable).lower():
        return 1.0

    return None


def compile_evidence_dataset(
    graph_def: dict[str, Any],
    evidence_records: Iterable[dict[str, Any]],
) -> DatasetCompilation:
    """Compile evidence records into a dataframe for treatment-effect estimation."""

    treatment = clean_variable(graph_def.get("treatment_variable", "treatment"))
    outcome = clean_variable(graph_def.get("outcome_variable", "outcome"))
    confounders = [
        clean_variable(c) for c in graph_def.get("candidate_confounders", [])
    ]
    columns = list(dict.fromkeys([treatment, outcome, *confounders]))

    records = list(_normalize_records(evidence_records))
    provenance: list[dict[str, Any]] = []
    skipped_synthetic = 0

    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".ndjson") as tmp:
        tmp_path = tmp.name
        idx = 0
        for record in records:
            if record.source_type == "synthetic":
                skipped_synthetic += 1
                continue

            row: dict[str, Any] = {}
            for col in columns:
                row[col] = _variable_lookup(record, col)

            if any(value is not None for value in row.values()):
                row["_asset_id"] = record.asset_id or "unknown_asset"
                row["_observed_at"] = record.observed_at
                row["_source_type"] = record.source_type
                row["_source_name"] = record.source_name
                row["_raw_ref"] = record.raw_ref or f"evidence-{idx}"

                tmp.write(json.dumps(row) + "\n")
                provenance.append(
                    {
                        "row_index": len(provenance),
                        "source_type": record.source_type,
                        "source_name": record.source_name,
                        "raw_ref": record.raw_ref or f"evidence-{idx}",
                        "asset_id": record.asset_id,
                        "observed_at": record.observed_at,
                    }
                )
            idx += 1

    try:
        if len(provenance) > 0:
            lf = pl.scan_ndjson(tmp_path)
            existing_cols = lf.collect_schema().names()
            missing_cols = [c for c in columns if c not in existing_cols]

            exprs = [
                pl.col(c).cast(pl.Float64, strict=False)
                for c in existing_cols
                if c in columns
            ]
            exprs.extend([pl.lit(None).cast(pl.Float64).alias(c) for c in missing_cols])

            if exprs:
                lf = lf.with_columns(exprs)

            has_required = treatment in existing_cols and outcome in existing_cols
            if has_required:
                lf_model = lf.drop_nulls(subset=[treatment, outcome])
            else:
                lf_model = pl.DataFrame(schema={c: pl.Float64 for c in columns}).lazy()
        else:
            lf_model = pl.DataFrame(schema={c: pl.Float64 for c in columns}).lazy()

        model_df = lf_model.select(columns).collect().to_pandas()

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    has_required_columns = {treatment, outcome}.issubset(model_df.columns)
    if not has_required_columns:
        model_df = pd.DataFrame(columns=columns)
    treated_count = int((model_df[treatment] > 0).sum()) if treatment in model_df else 0
    control_count = (
        int((model_df[treatment] <= 0).sum()) if treatment in model_df else 0
    )
    missingness = {
        col: (
            float(model_df[col].isna().mean())
            if col in model_df and len(model_df)
            else 1.0
        )
        for col in columns
    }
    warnings = _profile_warnings(
        model_df,
        treatment,
        outcome,
        confounders,
        treated_count,
        control_count,
    )
    if skipped_synthetic:
        warnings.append(
            f"Skipped {skipped_synthetic} synthetic record(s); synthetic rows "
            "are never eligible for production ATE estimation."
        )

    source_types = {record.source_type for record in records}
    if source_types == {"synthetic"}:
        data_mode = "synthetic_simulation"
    elif not records or model_df.empty:
        data_mode = "insufficient_data"
    else:
        data_mode = "empirical"

    profile = CausalDatasetProfile(
        data_mode=data_mode,
        n_rows=len(model_df),
        columns=columns,
        treatment=treatment,
        outcome=outcome,
        adjustment_set=[c for c in confounders if c in model_df.columns],
        treated_count=treated_count,
        control_count=control_count,
        missingness=missingness,
        warnings=warnings,
    )
    return DatasetCompilation(
        dataframe=model_df, profile=profile, provenance=provenance
    )


def passes_estimation_gates(
    profile: CausalDatasetProfile,
    df: pd.DataFrame,
) -> tuple[bool, list[str]]:
    """Return whether the dataset is eligible for causal estimation."""

    warnings = list(profile.warnings)
    treatment = profile.treatment
    outcome = profile.outcome

    if profile.data_mode != "empirical":
        warnings.append(
            "Empirical data gate failed: synthetic or missing records cannot "
            "produce a production ATE."
        )
    if profile.n_rows < MIN_COMPLETE_ROWS:
        warnings.append(
            "Minimum row gate failed: at least "
            f"{MIN_COMPLETE_ROWS} complete treatment/outcome observations "
            "are required."
        )
    if profile.n_rows < RECOMMENDED_COMPLETE_ROWS:
        warnings.append(
            "Exploratory sample size: "
            f"{RECOMMENDED_COMPLETE_ROWS}+ rows are recommended for a stable "
            "causal estimate; the lower gate is only a demo/smoke threshold."
        )
    if (
        profile.treated_count < MIN_TREATMENT_GROUP_ROWS
        or profile.control_count < MIN_TREATMENT_GROUP_ROWS
    ):
        warnings.append(
            "Treatment balance gate failed: at least "
            f"{MIN_TREATMENT_GROUP_ROWS} treated and "
            f"{MIN_TREATMENT_GROUP_ROWS} control rows are required."
        )
    if treatment not in df.columns or df[treatment].nunique(dropna=True) < 2:
        warnings.append("Treatment variation gate failed.")
    if outcome not in df.columns or df[outcome].nunique(dropna=True) < 2:
        warnings.append("Outcome variation gate failed.")

    for col, ratio in profile.missingness.items():
        if col in profile.adjustment_set and ratio > 0.35:
            warnings.append(
                f"High missingness gate failed for adjustment variable {col}: "
                f"{ratio:.0%}."
            )

    fatal_prefixes = (
        "Empirical data gate failed",
        "Minimum row gate failed",
        "Treatment balance gate failed",
        "Treatment variation gate failed",
        "Outcome variation gate failed",
    )
    passed = not any(w.startswith(fatal_prefixes) for w in warnings)
    return passed, warnings


def _profile_warnings(
    df: pd.DataFrame,
    treatment: str,
    outcome: str,
    confounders: list[str],
    treated_count: int,
    control_count: int,
) -> list[str]:
    """Produce non-fatal quality warnings before hard gates are applied."""

    warnings: list[str] = []
    if df.empty:
        warnings.append(
            "No complete empirical rows were compiled for treatment/outcome."
        )
        return warnings
    if treatment in df and df[treatment].nunique(dropna=True) < 2:
        warnings.append("Treatment has no observed variation.")
    if outcome in df and df[outcome].nunique(dropna=True) < 2:
        warnings.append("Outcome has no observed variation.")
    if treated_count == 0 or control_count == 0:
        warnings.append("Evidence contains only treated or only control observations.")
    missing_confounders = [c for c in confounders if c not in df.columns]
    if missing_confounders:
        warnings.append(
            "Candidate confounders missing from compiled data: "
            f"{', '.join(missing_confounders)}."
        )
    return warnings
