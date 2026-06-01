"""LangGraph agent nodes for hierarchical cyber investigation.

The agent layer is intentionally limited to decomposition, memo writing, and
evidence-need discovery. It does not create estimator rows. Downstream causal
code can therefore treat agent output as hypothesis context rather than data.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import AzureChatOpenAI
from pydantic import BaseModel
from openai import ContentFilterFinishReasonError


from schema import (
    AgentConfig,
    ChildConfig,
    ChildState,
    DecisionMemo,
    GraphState,
    ParentState,
)

logger = logging.getLogger(__name__)


def _azure_chat(temperature: float) -> AzureChatOpenAI:
    """Create an Azure OpenAI chat client from environment configuration."""

    return AzureChatOpenAI(
        azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
        api_key=os.getenv("AZURE_OPENAI_API_KEY"),
        azure_deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
        api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview"),
        temperature=temperature,
    )


llm = _azure_chat(temperature=0.4)
low_temp_llm = _azure_chat(temperature=0.0)


class ParentConfigsOutput(BaseModel):
    """Structured output from the grand orchestrator."""

    parent_configs: list[AgentConfig]


grand_orchestrator_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are the Grand Orchestrator for HiveMind SOC operations. "
            "Analyze the incident and decompose it into 2-3 distinct "
            "investigatory vectors, such as geopolitical context, network "
            "forensics, identity risk, supply-chain exposure, or insider "
            "threat. Assign an AgentConfig for each vector.",
        ),
        ("user", "INCIDENT:\n{task_description}"),
    ]
)
grand_orchestrator_chain = grand_orchestrator_prompt | llm.with_structured_output(
    ParentConfigsOutput
)


def grand_orchestrator_node(state: GraphState) -> dict[str, list[AgentConfig]]:
    """Decompose the incident into parent-agent investigation tracks."""

    logger.info("Grand orchestrator analyzing incident")
    result = grand_orchestrator_chain.invoke(
        {"task_description": state["task_description"]}
    )
    logger.info("Spawned %s parent agents", len(result.parent_configs))
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
            "you cannot cover alone.",
        ),
        ("user", "INCIDENT:\n{task_description}"),
    ]
)
parent_agent_chain = parent_agent_prompt | llm.with_structured_output(
    ChildConfigsOutput
)


def parent_agent_node(state: ParentState) -> dict[str, list[ChildConfig]]:
    """Spawn child-agent tasks for a single parent investigation track."""

    logger.info("Parent agent [%s] spawning specialists", state["persona"])
    result = parent_agent_chain.invoke(
        {
            "persona": state["persona"],
            "focus_objective": state["focus_objective"],
            "task_description": state["task_description"],
        }
    )

    for child in result.child_configs:
        child.parent_persona = state["persona"]

    logger.info(
        "Parent agent [%s] spawned %s children",
        state["persona"],
        len(result.child_configs),
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
            "confirm or falsify your strategy.",
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

    logger.info("Child agent [%s] synthesizing memo", state["persona"])
    try:
        memo = child_agent_chain.invoke(
            {
                "persona": state["persona"],
                "parent_persona": state["parent_persona"],
                "focus_objective": state["focus_objective"],
                "task_description": state["task_description"],
            }
        )
        logger.info("Child agent [%s] completed memo", state["persona"])
    except ContentFilterFinishReasonError:
        logger.warning(
            "Child agent [%s] blocked by content filter - using fallback memo",
            state["persona"]
        )
        memo = _fallback_memo(state, "blocked by azure content filter")
    except Exception as exc:
        logger.error(
            "Child agent [%s] failed unexpectedly: %s", state["persona"], exc
        )
        memo = _fallback_memo(state, f"unexpected error: {exc}")

    return {"memos": [memo]}


def memo_to_text(memo: Any) -> str:
    """Return a compact text representation for logs or debugging."""

    if hasattr(memo, "model_dump_json"):
        return memo.model_dump_json()
    return str(memo)
