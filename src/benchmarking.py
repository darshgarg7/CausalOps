"""Deterministic quality metrics for each HiveMind agent tier.

These metrics are not a replacement for human review, but they give the demo a
standardized scoreboard: every tier has an expected contract, an observed
signal, and a normalized score. That directly answers whether the orchestrator,
agents, evaluator, causal architect, and estimator are being tested consistently.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def score_agent_tiers(
    final_state: dict[str, Any],
    summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Score all workflow tiers from the final LangGraph state."""

    summary = summary or {}
    parent_configs = final_state.get("parent_configs", []) or []
    child_configs = final_state.get("child_configs", []) or []
    memos = final_state.get("memos", []) or []
    ranked = final_state.get("ranked_strategies", []) or []
    evaluator_error = final_state.get("evaluator_error")
    causal_payload = final_state.get("causal_payload") or {}
    estimate_report = final_state.get("causal_estimate_report") or {}

    parent_count = summary.get("parent_config_count")
    if parent_count is None:
        parent_count = len(parent_configs)
    child_count = summary.get("child_config_count")
    if child_count is None:
        child_count = len(child_configs)
    memo_count = summary.get("memo_count")
    if memo_count is None:
        memo_count = len(memos)

    metrics = {
        "orchestrator": _score_orchestrator_count(int(parent_count)),
        "parent_agents": _score_parent_agents_count(int(child_count), child_configs),
        "child_agents": _score_child_agents_count(int(memo_count), memos),
        "evaluator": _score_evaluator(
            ranked,
            evaluator_error,
            has_ranked=bool(summary.get("has_ranked_strategies")),
        ),
        "causal_architect": _score_causal_architect(causal_payload.get("graph", {})),
        "estimator": _score_estimator(estimate_report),
    }
    overall = sum(item["score"] for item in metrics.values()) / max(len(metrics), 1)
    return {
        "overall_score": round(overall, 3),
        "tiers": metrics,
    }


def _score_orchestrator_count(parent_count: int) -> dict[str, Any]:
    """Score orchestrator branch count from bus summary or state."""

    score = 1.0 if 2 <= parent_count <= 3 else 0.55 if parent_count > 0 else 0.0
    return {
        "score": score,
        "observed": parent_count,
        "target": "2-3 parent investigatory vectors",
    }


def _score_orchestrator(parent_configs: Iterable[Any]) -> dict[str, Any]:
    """Score whether the orchestrator produced the expected branch count."""

    return _score_orchestrator_count(len(list(parent_configs)))


def _score_parent_agents_count(
    child_count: int,
    child_configs: Iterable[Any],
) -> dict[str, Any]:
    """Score parent spawn output using bus count with optional completeness sample."""

    children = list(child_configs)
    if children:
        complete = sum(
            1
            for child in children
            if _field(child, "persona") and _field(child, "focus_objective")
        )
        completeness = complete / max(len(children), 1)
    elif child_count > 0:
        completeness = 1.0
    else:
        completeness = 0.0

    observed = child_count if child_count else len(children)
    score = completeness if observed else 0.0
    if observed >= 4:
        score = min(1.0, score + 0.1)
    return {
        "score": round(score, 3),
        "observed": observed,
        "target": "specialized children with persona and focus objective",
    }


def _score_parent_agents(child_configs: Iterable[Any]) -> dict[str, Any]:
    """Score whether parent agents produced complete child tasks."""

    return _score_parent_agents_count(len(list(child_configs)), child_configs)


def _score_child_agents_count(
    memo_count: int,
    memos: Iterable[Any],
) -> dict[str, Any]:
    """Score child memo output using bus count and a single memo sample."""

    memo_list = list(memos)
    observed = memo_count if memo_count else len(memo_list)
    if not observed:
        return {
            "score": 0.0,
            "observed": 0,
            "target": "memos with strategy, risks, assumptions, evidence needs",
        }

    sample = memo_list[:1]
    if sample:
        memo = sample[0]
        fields_present = [
            bool(_field(memo, "strategy")),
            bool(_field(memo, "risks")),
            bool(_field(memo, "assumptions")),
            bool(_field(memo, "second_order_effects")),
            bool(_field(memo, "evidence_needs")),
        ]
        sample_score = sum(fields_present) / len(fields_present)
    else:
        sample_score = 1.0

    count_score = min(1.0, observed / max(observed, 1))
    score = round(min(1.0, count_score * 0.4 + sample_score * 0.6), 3)
    return {
        "score": score,
        "observed": observed,
        "target": "complete DecisionMemo fields",
    }


def _score_child_agents(memos: Iterable[Any]) -> dict[str, Any]:
    """Score child-agent memo completeness."""

    return _score_child_agents_count(len(list(memos)), memos)


def _score_evaluator(
    ranked: list[dict[str, Any]],
    evaluator_error: str | None,
    *,
    has_ranked: bool = False,
) -> dict[str, Any]:
    """Score evaluator output shape and failure handling."""

    if evaluator_error:
        return {
            "score": 0.0,
            "observed": "error",
            "target": "ranked strategies with final recommendation",
        }

    latest = ranked[-1] if ranked else {}
    has_evals = bool(latest.get("evaluations"))
    has_rank = bool(latest.get("ranked_perspectives")) or has_ranked
    has_recommendation = bool(latest.get("final_recommendation"))
    score = sum([has_evals, has_rank, has_recommendation]) / 3
    return {
        "score": round(score, 3),
        "observed": len(ranked),
        "target": "evaluations, rank order, final recommendation",
    }


def _score_causal_architect(graph: dict[str, Any]) -> dict[str, Any]:
    """Score graph validity, treatment/outcome clarity, and evidence tests."""

    nodes = graph.get("nodes", []) or []
    edges = graph.get("edges", []) or []
    treatment = graph.get("treatment_variable")
    outcome = graph.get("outcome_variable")
    has_path = _has_path(edges, treatment, outcome) if treatment and outcome else False
    acyclic = _is_acyclic(nodes, edges)
    edge_evidence = sum(
        1
        for edge in edges
        if edge.get("required_evidence") or edge.get("falsification_tests")
    )
    evidence_ratio = edge_evidence / max(len(edges), 1) if edges else 0.0
    score = (
        sum(
            [
                bool(nodes),
                bool(edges),
                bool(treatment),
                bool(outcome),
                has_path,
                acyclic,
            ]
        )
        / 6
    )
    score = min(1.0, score * 0.8 + evidence_ratio * 0.2)
    return {
        "score": round(score, 3),
        "observed": {
            "nodes": len(nodes),
            "edges": len(edges),
            "acyclic": acyclic,
            "treatment_to_outcome_path": has_path,
        },
        "target": (
            "valid measurable DAG with treatment/outcome path and evidence requirements"
        ),
    }


def _score_estimator(report: dict[str, Any]) -> dict[str, Any]:
    """Score estimator readiness and statistical reporting completeness."""

    if not report:
        return {
            "score": 0.0,
            "observed": "missing",
            "target": "estimate report or explicit data-quality refusal",
        }

    if report.get("ate") is None:
        score = 0.55 if str(report.get("method", "")).startswith("withheld:") else 0.25
    else:
        score = 0.65
        if report.get("p_value") is not None:
            score += 0.15
        if report.get("ci_low") is not None and report.get("ci_high") is not None:
            score += 0.1
        if report.get("refuters"):
            score += 0.1

    return {
        "score": round(min(1.0, score), 3),
        "observed": {
            "method": report.get("method"),
            "n_rows": report.get("n_rows"),
            "has_p_value": report.get("p_value") is not None,
            "refuters": len(report.get("refuters", []) or []),
        },
        "target": "gated estimate with p-value, CI, and refuters when data permits",
    }


def _has_path(edges: list[dict[str, Any]], source: str, target: str) -> bool:
    """Return whether the graph contains a path from source to target."""

    adjacency: dict[str, list[str]] = {}
    for edge in edges:
        adjacency.setdefault(edge.get("source"), []).append(edge.get("target"))

    stack = [source]
    seen = set()
    while stack:
        node = stack.pop()
        if node == target:
            return True
        if node in seen:
            continue
        seen.add(node)
        stack.extend(adjacency.get(node, []))
    return False


def _is_acyclic(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> bool:
    """Return whether directed graph edges are acyclic."""

    node_ids = {node.get("id") for node in nodes}
    indegree = {node_id: 0 for node_id in node_ids if node_id}
    adjacency = {node_id: [] for node_id in node_ids if node_id}
    for edge in edges:
        source = edge.get("source")
        target = edge.get("target")
        if source in adjacency and target in indegree:
            adjacency[source].append(target)
            indegree[target] += 1

    queue = [node for node, degree in indegree.items() if degree == 0]
    visited = 0
    while queue:
        node = queue.pop()
        visited += 1
        for child in adjacency.get(node, []):
            indegree[child] -= 1
            if indegree[child] == 0:
                queue.append(child)
    return visited == len(indegree)


def _field(obj: Any, name: str) -> Any:
    """Read fields from Pydantic objects or dictionaries consistently."""

    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)
