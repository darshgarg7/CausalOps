"""Shared schemas for HiveMind's agentic causal evidence pipeline.

The project deliberately separates three layers:

* agent outputs, which are LLM-authored hypotheses and memos;
* evidence records, which are normalized observations from logs/feeds/reports;
* causal estimate reports, which are produced by deterministic compiler and
  estimator code.

Keeping these contracts explicit prevents the causal estimator from silently
falling back to LLM-generated rows.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Causal graph schemas
# ---------------------------------------------------------------------------


class CausalNode(BaseModel):
    """A measurable variable in the causal graph."""

    id: str = Field(description="Unique variable name without spaces")
    label: str = Field(description="Human readable label")
    description: str = Field(
        description="Explanation of what this node represents in the scenario"
    )


class CausalEdge(BaseModel):
    """A directed causal claim plus its evidence and falsification criteria."""

    source: str = Field(description="Source node ID")
    target: str = Field(description="Target node ID")
    relationship: str = Field(description="Description of the causal mechanism")
    required_evidence: list[str] = Field(
        default_factory=list,
        description="Observable records that would support this causal edge",
    )
    falsification_tests: list[str] = Field(
        default_factory=list,
        description=(
            "Observable records or temporal contradictions that would weaken "
            "this edge"
        ),
    )


class CausalGraphDef(BaseModel):
    """A directed acyclic graph suitable for evidence-backed estimation."""

    nodes: list[CausalNode] = Field(description="Nodes constituting the causal DAG")
    edges: list[CausalEdge] = Field(description="Edges mapping the flow of causality")
    treatment_variable: str = Field(
        description="Node ID representing the action/intervention"
    )
    outcome_variable: str = Field(
        description="Node ID representing the final outcome"
    )
    candidate_confounders: list[str] = Field(
        default_factory=list,
        description=(
            "Measured variables that should be adjusted for when estimating "
            "the treatment effect"
        ),
    )


class VariableMeasurementPlan(BaseModel):
    """Instructions for compiling raw evidence into one graph variable."""

    variable: str = Field(description="Causal node ID to measure")
    description: str = Field(description="Plain-English measurement definition")
    evidence_fields: list[str] = Field(
        description="Expected fields from telemetry, CVE feeds, reports, or uploads"
    )
    aggregation: str = Field(
        description="How raw evidence should be aggregated into an observation row"
    )
    expected_type: Literal["binary", "continuous", "count"] = Field(
        description="Expected numeric variable type"
    )


class EdgeEvidenceRequirement(BaseModel):
    """Confirming and falsifying evidence requirements for one edge."""

    edge: str = Field(description="Edge key formatted as source->target")
    confirming_evidence: list[str] = Field(
        description="Evidence that would support the edge"
    )
    falsifying_evidence: list[str] = Field(
        description="Evidence that would weaken or reject the edge"
    )


class CausalPayload(BaseModel):
    """LLM-authored causal hypothesis without estimator data rows."""

    graph: CausalGraphDef
    measurement_plan: list[VariableMeasurementPlan] = Field(
        description="Plan for compiling empirical evidence into model variables"
    )
    edge_evidence_requirements: list[EdgeEvidenceRequirement] = Field(
        default_factory=list,
        description="Confirming/falsifying evidence plan for each causal edge",
    )


# ---------------------------------------------------------------------------
# Evidence and estimation schemas
# ---------------------------------------------------------------------------


class EvidenceRecord(BaseModel):
    """One normalized row of evidence from logs, feeds, reports, or analysts."""

    source_type: Literal[
        "siem",
        "edr",
        "cve",
        "incident_report",
        "asset_inventory",
        "manual",
        "synthetic",
    ] = Field(description="Origin class for this evidence record")
    source_name: str = Field(
        default="manual",
        description="Concrete source name, index, feed, or upload name",
    )
    observed_at: str | None = Field(
        default=None,
        description="ISO timestamp or date associated with the record",
    )
    asset_id: str | None = Field(
        default=None,
        description="Host, workload, identity, service, or business asset",
    )
    user_id: str | None = Field(
        default=None,
        description="User or principal associated with the record",
    )
    event_type: str | None = Field(
        default=None,
        description="Normalized event or detection type",
    )
    technique_id: str | None = Field(
        default=None,
        description="MITRE ATT&CK technique ID when known",
    )
    cve_id: str | None = Field(default=None, description="CVE ID when known")
    severity: float | None = Field(
        default=None,
        description="Numeric severity or confidence if available",
    )
    raw_text: str | None = Field(
        default=None,
        description="Raw log line, report excerpt, or finding text",
    )
    raw_ref: str | None = Field(
        default=None,
        description="Pointer back to the original record",
    )
    extracted_fields: dict[str, Any] = Field(
        default_factory=dict,
        description="Additional already-normalized field values",
    )
    confidence: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        description="Record extraction confidence",
    )


class CausalDatasetProfile(BaseModel):
    """Quality profile for the dataframe passed to the estimator."""

    data_mode: Literal["empirical", "insufficient_data", "synthetic_simulation"] = Field(
        description=(
            "Whether estimate rows came from evidence, are insufficient, or "
            "are simulation-only"
        )
    )
    n_rows: int = Field(description="Number of compiled observation rows")
    columns: list[str] = Field(
        default_factory=list,
        description="Compiled dataframe columns",
    )
    treatment: str = Field(description="Treatment column")
    outcome: str = Field(description="Outcome column")
    adjustment_set: list[str] = Field(
        default_factory=list,
        description="Covariates used for adjustment",
    )
    treated_count: int = Field(default=0, description="Rows with treatment > 0")
    control_count: int = Field(default=0, description="Rows with treatment == 0")
    missingness: dict[str, float] = Field(
        default_factory=dict,
        description="Missing ratio by column",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Data quality and identifiability warnings",
    )


class RefuterReport(BaseModel):
    """Result from one DoWhy refutation check."""

    name: str
    passed: bool
    details: str


class CausalEstimateReport(BaseModel):
    """Complete statistical report for a treatment-effect estimate."""

    data_mode: Literal["empirical", "insufficient_data", "synthetic_simulation"]
    method: str
    treatment: str
    outcome: str
    adjustment_set: list[str] = Field(default_factory=list)
    n_rows: int = 0
    ate: float | None = None
    standard_error: float | None = None
    p_value: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    refutation_passed: bool = False
    refuters: list[RefuterReport] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    dataset_profile: CausalDatasetProfile | None = None


# ---------------------------------------------------------------------------
# Agent schemas
# ---------------------------------------------------------------------------


class AgentConfig(BaseModel):
    """Parent agent configuration."""

    persona: str = Field(description="High-level persona")
    focus_objective: str = Field(description="Objective for this parent agent")


class ChildConfig(BaseModel):
    """Child agent configuration spawned dynamically by a parent."""

    parent_persona: str
    persona: str = Field(description="Granular child persona")
    focus_objective: str = Field(description="Specific sub-problem to solve")


class DecisionMemo(BaseModel):
    """Structured artifact emitted by a child agent."""

    perspective: str
    strategy: str
    risks: list[str]
    assumptions: list[str] = Field(default_factory=list)
    second_order_effects: list[str] = Field(default_factory=list)
    evidence_needs: list[str] = Field(default_factory=list)
    confidence: str | None = Field(default="N/A")


# ---------------------------------------------------------------------------
# State schemas
# ---------------------------------------------------------------------------


class GraphState(TypedDict):
    """Master LangGraph state shared across all workflow nodes."""

    task_description: str
    run_id: str
    correlation_id: str

    parent_configs: list[AgentConfig]
    child_configs: Annotated[list[ChildConfig], operator.add]

    memos: Annotated[list[DecisionMemo], operator.add]
    ranked_strategies: list[dict[str, Any]]
    final_recommendation: str | None
    evaluator_error: str | None

    causal_payload: dict[str, Any] | None
    causal_refutation_passed: bool
    causal_refutation_attempts: int
    dowhy_results: dict[str, Any] | None
    evidence_records: list[dict[str, Any]]
    causal_dataset_profile: dict[str, Any] | None
    causal_estimate_report: dict[str, Any] | None


class ParentState(TypedDict):
    """State for Parent Agent node execution."""

    task_description: str
    run_id: str
    correlation_id: str
    persona: str
    focus_objective: str


class ChildState(TypedDict):
    """State for Child Agent node execution."""

    task_description: str
    run_id: str
    correlation_id: str
    parent_persona: str
    persona: str
    focus_objective: str
