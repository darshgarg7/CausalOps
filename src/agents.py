"""LangGraph agent nodes for hierarchical cyber investigation.

The agent layer is intentionally limited to decomposition, memo writing, and
evidence-need discovery. It does not create estimator rows. Downstream causal
code can therefore treat agent output as hypothesis context rather than data.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from openai import ContentFilterFinishReasonError
from pydantic import BaseModel

from bus.events import ArtifactType
from bus.helpers import bind_from_state
from bus.publish import publish_artifact, publish_spawn, publish_telemetry
from llm import get_llm
from schema import (
    AgentConfig,
    ChildConfig,
    ChildState,
    DecisionMemo,
    GraphState,
    ParentState,
)

logger = logging.getLogger(__name__)


llm = get_llm(temperature=0.4)
low_temp_llm = get_llm(temperature=0.0)


class ParentConfigsOutput(BaseModel):
    """Structured output from the grand orchestrator."""

    parent_configs: list[AgentConfig]


grand_orchestrator_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are the Grand Orchestrator for CausalOps SOC operations. "
            "Analyze the incident and decompose it into 2-3 distinct "
            "investigatory vectors, such as geopolitical context, network "
            "forensics, identity risk, supply-chain exposure, or insider "
            "threat. Assign an AgentConfig for each vector.",
        ),
        ("user", "{memory_context_text}INCIDENT:\n{task_description}"),
    ]
)
grand_orchestrator_chain = grand_orchestrator_prompt | llm.with_structured_output(
    ParentConfigsOutput
)


def _format_memory_context(memory_context: list[dict[str, Any]] | None) -> str:
    """Render retrieved past runs into the orchestrator's user-message prefix.

    Returns an empty string when there's no context, so the prompt template
    doesn't need a conditional block.
    """

    if not memory_context:
        return ""

    lines = ["RELEVANT PAST INCIDENTS (ranked by recency-weighted similarity):"]
    for index, run in enumerate(memory_context, start=1):
        similarity = run.get("similarity")
        weight = run.get("weighted_score")
        ate = run.get("ate")
        method = run.get("method")
        n_rows = run.get("n_rows")
        impact = (
            f"ATE={ate}, method={method}, n_rows={n_rows}"
            if ate is not None
            else f"ATE=null (withheld: {method or 'insufficient_data'})"
        )
        lines.append(
            f"{index}. [run_id: {run.get('run_id')}] "
            f"similarity={similarity}, weight={weight}\n"
            f'   "{run.get("task_description", "")}"\n'
            f"   {impact}"
        )
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def grand_orchestrator_node(state: GraphState) -> dict[str, list[AgentConfig]]:
    """Decompose the incident into parent-agent investigation tracks."""

    bind_from_state(state)
    publish_telemetry(
        agent_id="orchestrator",
        tier="orchestrator",
        phase="ORCHESTRATOR",
        message="Decomposing incident into parent tracks",
        status="running",
    )

    logger.info("Grand orchestrator analyzing incident")
    result = grand_orchestrator_chain.invoke(
        {
            "task_description": state["task_description"],
            "memory_context_text": _format_memory_context(state.get("memory_context")),
        }
    )
    if result is None:
        raise RuntimeError("Grand orchestrator returned no structured parent configs")
    if isinstance(result, dict):
        result = ParentConfigsOutput(**result)
    logger.info("Spawned %s parent agents", len(result.parent_configs))

    for config in result.parent_configs:
        publish_spawn(
            agent_id="orchestrator",
            tier="orchestrator",
            artifact_type=ArtifactType.AGENT_CONFIG,
            payload=config.model_dump(),
        )

    publish_telemetry(
        agent_id="orchestrator",
        tier="orchestrator",
        phase="ORCHESTRATOR",
        message=f"Spawned {len(result.parent_configs)} parent agents",
        status="done",
    )
    return {"parent_configs": result.parent_configs}


class ChildConfigsOutput(BaseModel):
    """Structured output from a parent agent."""

    child_configs: list[ChildConfig]


parent_agent_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are a {persona} Parent Agent investigating a major SOC "
            "incident. Your objective is: {focus_objective}. Analyze the "
            "incident metacognitively, name blind spots, and spawn 2 "
            "specialized Child Agents for granular technical details that "
            "you cannot cover alone.\n\n"
            "EVOLVED POLICY PRIOR:\n{policy_context}",
        ),
        ("user", "INCIDENT:\n{task_description}"),
    ]
)
parent_agent_chain = parent_agent_prompt | llm.with_structured_output(
    ChildConfigsOutput
)


def parent_agent_node(state: ParentState) -> dict[str, list[ChildConfig]]:
    """Spawn child-agent tasks for a single parent investigation track."""

    bind_from_state(state)
    agent_id = f"parent:{state['persona']}"
    publish_telemetry(
        agent_id=agent_id,
        tier="parent",
        phase="PARENT_SPAWN",
        message=f"Parent [{state['persona']}] spawning specialists",
        status="running",
    )

    logger.info("Parent agent [%s] spawning specialists", state["persona"])
    result = parent_agent_chain.invoke(
        {
            "persona": state["persona"],
            "focus_objective": state["focus_objective"],
            "task_description": state["task_description"],
            "policy_context": _policy_context(state.get("policy")),
        }
    )
    if result is None:
        raise RuntimeError(
            f"Parent agent [{state['persona']}] returned no child configs"
        )
    if isinstance(result, dict):
        result = ChildConfigsOutput(**result)

    for child in result.child_configs:
        child.parent_persona = state["persona"]

    logger.info(
        "Parent agent [%s] spawned %s children",
        state["persona"],
        len(result.child_configs),
    )

    for child in result.child_configs:
        publish_spawn(
            agent_id=agent_id,
            tier="parent",
            artifact_type=ArtifactType.CHILD_CONFIG,
            payload=child.model_dump(),
        )

    publish_telemetry(
        agent_id=agent_id,
        tier="parent",
        phase="PARENT_SPAWN",
        message=f"Spawned {len(result.child_configs)} children",
        status="done",
    )
    return {"child_configs": result.child_configs}


child_agent_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are a {persona} Child Agent responding to a "
            "{parent_persona}. Your objective: {focus_objective}. Perform a "
            "granular incident investigation and output a structured "
            "DecisionMemo. Include explicit assumptions, risks, "
            "second_order_effects, evidence_needs, and a confidence label. "
            "Evidence needs must name concrete telemetry, logs, CVE feeds, "
            "incident-report facts, or analyst observations that would "
            "confirm or falsify your strategy.\n\n"
            "RUNTIME PROFILE:\n{runtime_guidance}\n\n"
            "EVOLVED POLICY PRIOR:\n{policy_context}",
        ),
        ("user", "INCIDENT:\n{task_description}"),
    ]
)
child_agent_chain = child_agent_prompt | low_temp_llm.with_structured_output(
    DecisionMemo
)

def _fallback_memo(state: ChildState, reason: str) -> DecisionMemo:
    """Return a minimal memo when the LLM call fails."""
    return DecisionMemo(
        perspective=state["persona"],
        strategy=f"[UNAVAILABLE - {reason}]",
        assumptions=[],
        risks=["Memo could not be generated; review manually."],
        second_order_effects=[],
        evidence_needs=["Manual analyst review required."],
        confidence="Low",
    )

def child_agent_node(state: ChildState) -> dict[str, list[DecisionMemo]]:
    """Produce one evidence-aware decision memo from a child agent."""

    bind_from_state(state)
    agent_id = f"child:{state['persona']}"
    publish_telemetry(
        agent_id=agent_id,
        tier="child",
        phase="CHILD_MEMO",
        message=f"Child [{state['persona']}] synthesizing memo",
        status="running",
    )

    logger.info("Child agent [%s] synthesizing memo", state["persona"])
    try: 
        memo = child_agent_chain.invoke(
            {
                "persona": state["persona"],
                "parent_persona": state["parent_persona"],
                "focus_objective": state["focus_objective"],
                "task_description": state["task_description"],
                "runtime_guidance": _runtime_guidance(
                    state.get("execution_mode", "standard")
                ),
                "policy_context": _policy_context(state.get("policy")),
            }
        )
        if memo is None:
            raise ValueError("structured memo output was empty")
        logger.info("Child agent [%s] completed memo", state["persona"])
    except ContentFilterFinishReasonError:
        logger.warning(
            "Child agent [%s] blocked by content filter - using fallback",
            state["persona"],
        )
        publish_telemetry(
            agent_id=agent_id,
            tier="child",
            phase="ERROR",
            message=f"Child [{state['persona']}] blocked by content filter",
            status="error"
        )
        memo = _fallback_memo(state, "blocked by azure content filter")
    except Exception as exc:
        logger.error(
            "Child agent [%s] failed unexpectedly: %s", state["persona"], exc
        )
        memo = _fallback_memo(state, f"Unexpected error: {exc}")

    if isinstance(memo, dict):
        memo = DecisionMemo(**memo)

    publish_artifact(
        agent_id=agent_id,
        tier="child",
        artifact_type=ArtifactType.DECISION_MEMO,
        payload=memo.model_dump(),
    )

    publish_telemetry(
        agent_id=agent_id,
        tier="child",
        phase="CHILD_MEMO",
        message=f"Memo complete: {memo.perspective}",
        status="done",
    )
    return {"memos": [memo]}


def memo_to_text(memo: Any) -> str:
    """Return a compact text representation for logs or debugging."""

    if hasattr(memo, "model_dump_json"):
        return memo.model_dump_json()
    return str(memo)


def _policy_context(policy: Any) -> str:
    """Render an evolved policy prior into compact prompt guidance."""

    if not policy:
        return "No evolved policy prior; use the stated objective."
    if hasattr(policy, "model_dump"):
        policy = policy.model_dump()
    traits = dict(policy.get("traits", {}) if isinstance(policy, dict) else {})
    top_traits = sorted(traits.items(), key=lambda item: item[1], reverse=True)[:4]
    top_text = ", ".join(f"{name}={value:.2f}" for name, value in top_traits)
    objective_hint = policy.get("objective_hint") if isinstance(policy, dict) else None
    policy_id = (
        policy.get("policy_id", "unknown") if isinstance(policy, dict) else "unknown"
    )
    priority = objective_hint or top_text or "balanced search"
    return (
        f"policy_id={policy_id}; prioritize {priority}; "
        f"top_traits={top_text or 'none'}."
    )


def _runtime_guidance(execution_mode: str) -> str:
    if execution_mode == "deep":
        return (
            "Deep mode: provide richer reasoning and broader evidence needs; "
            "include nuanced trade-offs."
        )
    return (
        "Standard mode: be concise and decision-ready. Use short field values, "
        "2-3 risks, 2-3 assumptions, and 2-3 concrete evidence needs."
    )
