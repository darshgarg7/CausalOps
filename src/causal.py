"""LangGraph nodes for causal hypothesis generation and estimation.

The LLM-facing node in this module only designs measurable hypotheses. The
estimation node compiles externally supplied evidence records and delegates to
deterministic statistical code. That separation is the core guardrail against
the old "LLM confirms its own synthetic story" failure mode.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import AzureChatOpenAI

from dataset_compiler import clean_variable, compile_evidence_dataset
from demo_fixtures import demo_causal_payload, is_demo_evidence
from estimators import estimate_causal_effect
from bus.events import ArtifactType
from bus.helpers import bind_from_state
from bus.publish import publish_artifact, publish_telemetry
from schema import CausalPayload, GraphState

logger = logging.getLogger(__name__)

llm = AzureChatOpenAI(
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    azure_deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview"),
    temperature=0.0,
)

synth_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are a Causal Hypothesis Architect for cyber operations. "
            "Review the DecisionMemos and evaluator ranking. Construct a "
            "causal DAG, define exactly ONE treatment_variable and ONE "
            "outcome_variable, list candidate_confounders, and produce a "
            "measurement_plan describing how real SIEM/EDR/CVE/incident-report "
            "evidence should be compiled into each variable. Do NOT generate "
            "dataset rows. For every important edge, include confirming "
            "evidence and falsifying evidence. Prefer temporally ordered, "
            "measurable cyber variables over abstract concepts.",
        ),
        ("user", "MEMOS:\n{memos_text}\n\nEVALUATOR:\n{evaluator_text}"),
    ]
)
synth_chain = synth_prompt | llm.with_structured_output(CausalPayload)


def causal_synthesis_node(state: GraphState):
    """Generate a measurable causal hypothesis and evidence plan."""

    bind_from_state(state)
    publish_telemetry(
        agent_id="causal_architect",
        tier="causal",
        phase="CAUSAL_SYNTH",
        message="Building causal hypothesis and measurement plan",
        status="running",
    )

    logger.info("Causal architect generating measurable hypothesis")
    memos = state.get("memos", [])
    ranked = state.get("ranked_strategies", [])
    evidence_records = state.get("evidence_records", []) or []

    if is_demo_evidence(evidence_records):
        payload_dict = demo_causal_payload()
        payload_dict["graph"] = _sanitize_graph(payload_dict.get("graph", {}))
        logger.info(
            "Using bundled demo causal fixture because no caller evidence was supplied"
        )
    else:
        memos_text = "\n\n".join([_format_memo(memo) for memo in memos])
        evaluator_text = str(ranked[-1] if ranked else {})

        payload = synth_chain.invoke({
            "memos_text": memos_text,
            "evaluator_text": evaluator_text,
        })
        payload_dict = payload.model_dump()
        payload_dict["graph"] = _sanitize_graph(payload_dict.get("graph", {}))

    publish_artifact(
        agent_id="causal_architect",
        tier="causal",
        artifact_type=ArtifactType.CAUSAL_PAYLOAD,
        payload=payload_dict,
    )
    publish_telemetry(
        agent_id="causal_architect",
        tier="causal",
        phase="CAUSAL_SYNTH",
        message="Causal payload ready",
        status="done",
    )

    return {
        "causal_payload": payload_dict,
        "causal_refutation_passed": False,
    }


def dowhy_engine_node(state: GraphState):
    """Compile evidence records and estimate causal effects when gates pass."""

    bind_from_state(state)
    publish_telemetry(
        agent_id="estimator",
        tier="estimator",
        phase="ESTIMATE",
        message="Compiling evidence and estimating causal effect",
        status="running",
    )

    logger.info("Causal estimator compiling evidence and estimating effects")
    payload = state.get("causal_payload") or {}
    graph_def = _sanitize_graph(payload.get("graph", {}))
    evidence_records = state.get("evidence_records", []) or []

    compilation = compile_evidence_dataset(graph_def, evidence_records)
    report = estimate_causal_effect(graph_def, compilation.dataframe, compilation.profile)
    report_dict = report.model_dump()
    if is_demo_evidence(evidence_records):
        report_dict.setdefault("warnings", []).insert(
            0,
            "DEMO_FIXTURE: No caller evidence was supplied. ATE is estimated from "
            "the bundled patch-vs-lateral-movement SIEM fixture, not from your "
            "scenario telemetry. Upload normalized evidence for a scenario-specific estimate.",
        )
    attempts = int(state.get("causal_refutation_attempts", 0)) + 1

    if report.ate is None:
        logger.info("Causal estimator withheld effect: %s", report.method)
    else:
        logger.info(
            "Causal estimator completed ATE=%s p=%s rows=%s",
            report.ate,
            report.p_value,
            report.n_rows,
        )

    legacy_results = {
        "ate_estimate": report.ate,
        "refutation_passed": report.refutation_passed,
        "refutation_details": "\n\n".join([r.details for r in report.refuters]),
        "p_value": report.p_value,
        "ci_low": report.ci_low,
        "ci_high": report.ci_high,
        "n_rows": report.n_rows,
        "method": report.method,
        "warnings": report.warnings,
    }

    publish_artifact(
        agent_id="estimator",
        tier="estimator",
        artifact_type=ArtifactType.CAUSAL_ESTIMATE_REPORT,
        payload=report_dict,
    )
    publish_telemetry(
        agent_id="estimator",
        tier="estimator",
        phase="ESTIMATE",
        message=f"Estimation complete ({report.method})",
        status="done",
    )

    return {
        "dowhy_results": legacy_results,
        "causal_estimate_report": report_dict,
        "causal_dataset_profile": compilation.profile.model_dump(),
        "causal_refutation_passed": report.refutation_passed,
        "causal_refutation_attempts": attempts,
    }


def _format_memo(memo: Any) -> str:
    """Serialize a memo into compact context for the causal architect prompt."""

    return "\n".join([
        f"Perspective: {_memo_value(memo, 'perspective', 'unknown')}",
        f"Strategy: {_memo_value(memo, 'strategy', '')}",
        f"Assumptions: {', '.join(_memo_value(memo, 'assumptions', []) or [])}",
        f"Risks: {', '.join(_memo_value(memo, 'risks', []) or [])}",
        "Second Order Effects: "
        f"{', '.join(_memo_value(memo, 'second_order_effects', []) or [])}",
        f"Evidence Needs: {', '.join(_memo_value(memo, 'evidence_needs', []) or [])}",
    ])


def _memo_value(memo: Any, field: str, default: Any) -> Any:
    """Read a memo value from a Pydantic model or a dictionary."""

    if isinstance(memo, dict):
        return memo.get(field, default)
    return getattr(memo, field, default)


def _sanitize_graph(graph_def: dict[str, Any]) -> dict[str, Any]:
    """Normalize graph identifiers and inject missing referenced nodes."""

    graph_def = dict(graph_def or {})
    graph_def["nodes"] = [dict(node) for node in graph_def.get("nodes", [])]
    graph_def["edges"] = [dict(edge) for edge in graph_def.get("edges", [])]
    graph_def["treatment_variable"] = clean_variable(
        graph_def.get("treatment_variable", "treatment")
    )
    graph_def["outcome_variable"] = clean_variable(
        graph_def.get("outcome_variable", "outcome")
    )
    graph_def["candidate_confounders"] = [
        clean_variable(confounder)
        for confounder in graph_def.get("candidate_confounders", [])
    ]

    for node in graph_def["nodes"]:
        node["id"] = clean_variable(node.get("id", node.get("label", "node")))
        node.setdefault("label", node["id"].replace("_", " "))
        node.setdefault("description", "")

    for edge in graph_def["edges"]:
        edge["source"] = clean_variable(edge.get("source", ""))
        edge["target"] = clean_variable(edge.get("target", ""))
        edge.setdefault("relationship", "")
        edge.setdefault("required_evidence", [])
        edge.setdefault("falsification_tests", [])

    _ensure_nodes(graph_def, [
        graph_def["treatment_variable"],
        graph_def["outcome_variable"],
        *graph_def["candidate_confounders"],
        *[edge["source"] for edge in graph_def["edges"] if edge.get("source")],
        *[edge["target"] for edge in graph_def["edges"] if edge.get("target")],
    ])
    return graph_def


def _ensure_nodes(graph_def: dict[str, Any], required: list[str]) -> None:
    """Add placeholder nodes for any referenced but missing variable IDs."""

    existing = {node["id"] for node in graph_def.get("nodes", []) if node.get("id")}
    for node_id in dict.fromkeys([clean_variable(node) for node in required if node]):
        if node_id not in existing:
            graph_def.setdefault("nodes", []).append(
                {
                    "id": node_id,
                    "label": node_id.replace("_", " "),
                    "description": "Auto-inferred measurable node",
                }
            )
            existing.add(node_id)
