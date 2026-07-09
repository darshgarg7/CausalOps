"""LangGraph assembly for CausalOps's investigation and causal workflow.

Deprecated for execution in Phase 2b+: the coordinator + spawn workers drive
parent/child fan-out. This module remains for reference and refutation routing
used during migration tests.

NOTE: the memory_retrieve/memory_write topology below is reference-only.
Production execution wires those nodes into coordinator/runner.py::execute_run()
as coordinator phases (_run_memory_retrieve, _run_memory_write), since this
module's build_graph() is never invoked by the real coordinator path.
"""

from __future__ import annotations

import logging
from typing import Literal

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from agents import child_agent_node, grand_orchestrator_node, parent_agent_node
from bus.helpers import bind_from_state
from bus.publish import publish_telemetry
from causal import causal_synthesis_node, dowhy_engine_node
from evaluator import evaluate_memos_node
from memory.nodes import memory_retrieve_node, memory_write_node
from schema import GraphState

logger = logging.getLogger(__name__)


def route_to_parents(state: GraphState) -> list[Send]:
    """Route execution to parent agents selected by the orchestrator."""

    return [
        Send(
            "parent_agent",
            {
                "task_description": state["task_description"],
                "run_id": state["run_id"],
                "correlation_id": state["correlation_id"],
                "persona": config.persona,
                "focus_objective": config.focus_objective,
                "policy": config.policy.model_dump() if config.policy else None,
            },
        )
        for config in state.get("parent_configs", [])
    ]


def gather_children_node(state: GraphState) -> dict:
    """Barrier node that lets dynamically produced child configs converge."""

    bind_from_state(state)
    child_count = len(state.get("child_configs", []))
    logger.info("Gathered %s child tasks", child_count)
    publish_telemetry(
        agent_id="control",
        tier="control",
        phase="CHILDREN_GATHER",
        message=f"Gathered {child_count} child tasks",
        status="done",
    )
    return {}


def route_to_children(state: GraphState) -> list[Send]:
    """Route execution to each specialized child agent."""

    return [
        Send(
            "child_agent",
            {
                "task_description": state["task_description"],
                "run_id": state["run_id"],
                "correlation_id": state["correlation_id"],
                "parent_persona": config.parent_persona,
                "persona": config.persona,
                "focus_objective": config.focus_objective,
                "policy": config.policy.model_dump() if config.policy else None,
            },
        )
        for config in state.get("child_configs", [])
    ]


def conditional_refutation_check(
    state: GraphState,
) -> Literal["end", "causal_synthesis"]:
    """Stop when refuters pass or when estimation is explicitly withheld."""

    from coordinator.refutation import refutation_next_step

    return refutation_next_step(state)


def build_graph():
    """Build and compile the executable LangGraph workflow."""

    builder = StateGraph(GraphState)

    builder.add_node("memory_retrieve", memory_retrieve_node)
    builder.add_node("orchestrator", grand_orchestrator_node)
    builder.add_node("parent_agent", parent_agent_node)
    builder.add_node("gather_children", gather_children_node)
    builder.add_node("child_agent", child_agent_node)
    builder.add_node("evaluate_memos", evaluate_memos_node)
    builder.add_node("causal_synthesis", causal_synthesis_node)
    builder.add_node("dowhy_engine", dowhy_engine_node)
    builder.add_node("memory_write", memory_write_node)

    builder.add_edge(START, "memory_retrieve")
    builder.add_edge("memory_retrieve", "orchestrator")
    builder.add_conditional_edges("orchestrator", route_to_parents, ["parent_agent"])
    builder.add_edge("parent_agent", "gather_children")
    builder.add_conditional_edges("gather_children", route_to_children, ["child_agent"])
    builder.add_edge("child_agent", "evaluate_memos")
    builder.add_edge("evaluate_memos", "causal_synthesis")
    builder.add_edge("causal_synthesis", "dowhy_engine")
    builder.add_conditional_edges(
        "dowhy_engine",
        conditional_refutation_check,
        {
            "end": "memory_write",
            "causal_synthesis": "causal_synthesis",
        },
    )
    builder.add_edge("memory_write", END)

    return builder.compile()
