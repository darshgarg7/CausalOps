"""Legacy Streamlit entry point for the HiveMind backend.

The Docker Compose demo uses the React frontend in `app/`, but this Streamlit
surface remains useful for quick local inspection of graph artifacts and raw
estimator output.
"""

from __future__ import annotations

import asyncio

from dotenv import load_dotenv
import streamlit as st
from streamlit_agraph import Config, Edge, Node, agraph

from engine import run_hivemind

load_dotenv()


def main() -> None:
    """Render the Streamlit demo and execute HiveMind on demand."""

    st.set_page_config(
        page_title="HiveMind Causal Engine",
        page_icon="H",
        layout="wide",
    )
    st.title("HiveMind: Causal Digital Twin")
    st.markdown(
        "Deploy hierarchical agents to build a measurable causal DAG, compile "
        "evidence records, and estimate interventions only when data gates pass.",
        help="The orchestrator dynamically spins up nested parent/child agents.",
    )

    task_description = st.text_area(
        "Massive Event Space Description",
        value=_default_incident(),
        height=200,
    )

    if st.button("Initialize Causal Execution", type="primary", use_container_width=True):
        _run_and_render(task_description)


def _run_and_render(task_description: str) -> None:
    """Execute a run and render graph, impact, and raw artifact panels."""

    if not task_description.strip():
        st.warning("Please provide a task description before running.")
        return

    with st.status("Executing Hierarchical Agentic Loop...", expanded=True) as status:
        st.write("Executing causal graph workflow...")
        try:
            artifact = asyncio.run(run_hivemind(task_description))
            status.update(
                label="Analysis and causal inference complete",
                state="complete",
                expanded=False,
            )
        except Exception as exc:
            status.update(label="Execution failed", state="error", expanded=False)
            st.error(f"Error executing graph: {exc}")
            return

    artifact_path = f"data/{artifact['run_id']}.json"
    st.success(f"Execution trace saved locally to `{artifact_path}`")
    st.divider()

    col1, col2 = st.columns([1, 1])
    with col1:
        _render_graph(artifact.get("causal_graph", {}))
    with col2:
        _render_impact(artifact.get("impact", {}))

    st.divider()
    st.header("Raw Agent Artifacts")
    st.json(artifact)


def _render_graph(causal_graph: dict) -> None:
    """Render an interactive causal DAG when graph data exists."""

    st.subheader("Synthesized Causal DAG")
    if not causal_graph or "nodes" not in causal_graph:
        st.write("No DAG generated.")
        return

    nodes = [
        Node(
            id=node["id"],
            label=node.get("label", node["id"]),
            size=25,
            shape="dot",
            title=node.get("description", ""),
        )
        for node in causal_graph.get("nodes", [])
    ]
    edges = [
        Edge(
            source=edge["source"],
            target=edge["target"],
            label=edge.get("relationship", ""),
        )
        for edge in causal_graph.get("edges", [])
    ]
    config = Config(
        width=1000,
        height=600,
        directed=True,
        nodeHighlightBehavior=True,
        highlightColor="#F7A7A6",
    )
    agraph(nodes=nodes, edges=edges, config=config)


def _render_impact(impact: dict) -> None:
    """Render estimator output without pretending withheld effects are valid."""

    st.subheader("DoWhy Causal Estimation")
    if not impact:
        st.write("No estimator report returned.")
        return

    confidence = impact.get("confidence", "insufficient_data")
    method = impact.get("method", "unknown")
    if confidence == "insufficient_data":
        st.warning(f"ATE withheld by estimator gate: `{method}`")
        return

    st.metric("Average Treatment Effect (ATE)", f"{impact.get('ate', 0.0):.4f}")
    st.caption(
        "p-value: "
        f"{impact.get('p_value')} | CI: "
        f"[{impact.get('ci_low')}, {impact.get('ci_high')}]"
    )
    if confidence == "high":
        st.success("Refutation tests passed.")
    else:
        st.error("Estimate is fragile or weakly supported.")


def _default_incident() -> str:
    """Return the default incident prompt for local demos."""

    return (
        "WORLD SPACE INCIDENT:\n"
        "An Advanced Persistent Threat (APT) is simultaneously moving "
        "laterally across 5 globally dispersed geographic regions. Telemetry "
        "shows exploitation of a supply-chain vendor vulnerability in the "
        "CI/CD pipeline, concurrent with unusual insider-threat signatures "
        "inside financial compartments in London. Global disruption is "
        "imminent if root causality is not mapped."
    )


if __name__ == "__main__":
    main()
