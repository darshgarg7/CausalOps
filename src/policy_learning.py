"""Model-based RL and bidirectional meta-learning over agent policies."""

from __future__ import annotations

import math
import re
from typing import Any

from bus.events import ArtifactType
from bus.helpers import bind_from_state
from bus.publish import publish_artifact, publish_telemetry
from evolution import TRAIT_NAMES

DISCOUNT = 0.82
VALUE_ITERATIONS = 12
_SLUG_RE = re.compile(r"[^a-z0-9_]+")


def policy_learning_node(
    state: dict[str, Any],
    kg_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the KG-grounded RL/meta-learning loop and publish its report."""

    bind_from_state(state)
    publish_telemetry(
        agent_id="optimizer:rl",
        tier="optimizer",
        phase="RL_POLICY_LOOP",
        message="Running KG-grounded value iteration over child policy shards",
        status="running",
    )
    report = build_policy_optimization_report(state, kg_snapshot or {})
    publish_artifact(
        agent_id="optimizer:rl",
        tier="optimizer",
        artifact_type=ArtifactType.POLICY_OPTIMIZATION_REPORT,
        payload=report,
    )
    publish_telemetry(
        agent_id="optimizer:rl",
        tier="optimizer",
        phase="RL_POLICY_LOOP",
        message=(
            "RL policy loop complete: "
            f"{len(report['meta_learning']['child_shards'])} child shards updated"
        ),
        status="done",
    )
    return {"policy_optimization_report": report}


def build_policy_optimization_report(
    state: dict[str, Any],
    kg_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a model-based RL report from the current KG and run artifacts."""

    kg = kg_snapshot or {}
    children = list(state.get("child_configs") or [])
    memos = list(state.get("memos") or [])
    if not children:
        children = []

    reward_inputs = _reward_inputs(state, kg)
    actions = _actions(children, memos, reward_inputs)
    states = _states(kg, actions)
    transitions = _transition_model(states, actions, kg)
    value_result = _value_iteration(states, actions, transitions)
    stackelberg = _stackelberg_response(actions, value_result["q_values"])
    meta_learning = _bidirectional_meta_learning(
        actions,
        value_result["q_values"].get("kg.global", {}),
        reward_inputs["global_reward"],
    )

    kg_nodes = kg.get("nodes") or []
    kg_edges = kg.get("edges") or []
    return {
        "algorithm": "kg_model_based_rl_meta_learning",
        "kg_base": {
            "run_id": kg.get("run_id") or state.get("run_id"),
            "node_count": len(kg_nodes),
            "edge_count": len(kg_edges),
            "snapshot_source": "spatiotemporal_kg",
        },
        "reward_model": reward_inputs,
        "mdp": {
            "states": states,
            "actions": [action["action_id"] for action in actions],
            "discount": DISCOUNT,
            "iterations": VALUE_ITERATIONS,
            "transition_source": "5d_kg_edge_confidence",
            "q_values": value_result["q_values"],
            "state_values": value_result["state_values"],
            "greedy_policy": value_result["greedy_policy"],
        },
        "stackelberg": stackelberg,
        "meta_learning": meta_learning,
        "kafka_feedback": {
            "artifact_type": ArtifactType.POLICY_OPTIMIZATION_REPORT.value,
            "kg_update_nodes": 2 + len(meta_learning["child_shards"]),
            "kg_update_edges": 2 * len(meta_learning["child_shards"]) + 1,
            "loop": "publish_policy_update_then_graph_consumer_ingests",
        },
    }


def _reward_inputs(state: dict[str, Any], kg: dict[str, Any]) -> dict[str, Any]:
    evaluator_scores = _evaluation_scores(state.get("ranked_strategies") or [])
    causal = _causal_reward(state.get("causal_estimate_report") or {})
    reasoning = _reasoning_reward(state.get("reasoning_report") or {})
    kg_reward = _kg_reward(kg)
    if evaluator_scores:
        evaluator_global = sum(evaluator_scores.values()) / len(evaluator_scores)
    else:
        evaluator_global = 0.5
    global_reward = _round(
        0.42 * evaluator_global
        + 0.22 * causal["score"]
        + 0.18 * reasoning["score"]
        + 0.18 * kg_reward["score"]
    )
    return {
        "global_reward": global_reward,
        "components": {
            "evaluator": _round(evaluator_global),
            "causal": causal,
            "reasoning": reasoning,
            "knowledge_graph": kg_reward,
        },
        "evaluator_scores_by_perspective": evaluator_scores,
    }


def _actions(
    child_configs: list[Any],
    memos: list[Any],
    reward_inputs: dict[str, Any],
) -> list[dict[str, Any]]:
    evaluator_scores = reward_inputs.get("evaluator_scores_by_perspective", {})
    actions: list[dict[str, Any]] = []
    for index, config in enumerate(child_configs):
        persona = _field(config, "persona", f"child-{index + 1}")
        memo = _matching_memo(persona, index, memos)
        perspective = str(_field(memo, "perspective", persona) if memo else persona)
        eval_score = _match_eval_score(perspective, evaluator_scores)
        confidence_bonus = _confidence_score(_field(memo, "confidence", "N/A"))
        risk_penalty = min(0.18, 0.035 * len(_field(memo, "risks", []) or []))
        base_reward = _clamp(
            0.58 * eval_score
            + 0.18 * confidence_bonus
            + 0.24 * reward_inputs["global_reward"]
            - risk_penalty
        )
        agent_id = f"agent.child.{_slug(persona)}"
        traits = _policy_traits(_field(config, "policy", None))
        actions.append(
            {
                "action_id": f"policy_action.{_slug(persona)}",
                "agent_id": agent_id,
                "persona": persona,
                "perspective": perspective,
                "base_reward": _round(base_reward),
                "traits": traits,
                "policy_id": _policy_id(_field(config, "policy", None), agent_id),
            }
        )

    if actions:
        return actions

    return [
        {
            "action_id": "policy_action.orchestrator",
            "agent_id": "agent.orchestrator",
            "persona": "orchestrator",
            "perspective": "orchestrator",
            "base_reward": reward_inputs["global_reward"],
            "traits": {name: 0.5 for name in TRAIT_NAMES},
            "policy_id": "policy.orchestrator.default",
        }
    ]


def _states(kg: dict[str, Any], actions: list[dict[str, Any]]) -> list[str]:
    state_ids = ["kg.global"]
    for action in actions:
        state_ids.append(action["agent_id"])
    for node in kg.get("nodes") or []:
        node_id = str(node.get("id", ""))
        if node_id.startswith("causal.") and node_id not in state_ids:
            state_ids.append(node_id)
        if len(state_ids) >= 16:
            break
    return state_ids


def _normalize_transitions(
    transitions: list[tuple[str, float]],
    states: list[str],
) -> list[tuple[str, float]]:
    """Map to valid states and normalize transition probabilities."""

    valid_transitions: dict[str, float] = {}
    for target, prob in transitions:
        valid_target = target if target in states else "kg.global"
        if valid_target not in states and states:
            valid_target = states[0]
        valid_transitions[valid_target] = (
            valid_transitions.get(valid_target, 0.0) + prob
        )

    total = sum(valid_transitions.values())
    if total <= 0.0:
        if states:
            return [(states[0], 1.0)]
        return []

    return [(state, prob / total) for state, prob in valid_transitions.items()]


def _transition_model(
    states: list[str],
    actions: list[dict[str, Any]],
    kg: dict[str, Any],
) -> dict[str, dict[str, list[tuple[str, float]]]]:
    adjacency: dict[str, list[tuple[str, float]]] = {}
    for edge in kg.get("edges") or []:
        source = str(edge.get("source", ""))
        target = str(edge.get("target", ""))
        if source and target:
            adjacency.setdefault(source, []).append(
                (target, _clamp(float(edge.get("confidence", 0.5))))
            )

    model: dict[str, dict[str, list[tuple[str, float]]]] = {}
    for state_id in states:
        model[state_id] = {}
        for action in actions:
            action_state = action["agent_id"]
            neighbors = [
                item for item in adjacency.get(action_state, []) if item[0] in states
            ]
            if not neighbors:
                raw_transitions = [
                    (action_state, 0.72),
                    ("kg.global", 0.28),
                ]
            else:
                total = sum(weight for _, weight in neighbors) or 1.0
                normalized = [
                    (target, 0.42 * (weight / total)) for target, weight in neighbors
                ]
                raw_transitions = [
                    (action_state, 0.48),
                    ("kg.global", 0.10),
                    *normalized,
                ]
            model[state_id][action["action_id"]] = _normalize_transitions(
                raw_transitions,
                states,
            )
    return model


def _value_iteration(
    states: list[str],
    actions: list[dict[str, Any]],
    transitions: dict[str, dict[str, list[tuple[str, float]]]],
) -> dict[str, Any]:
    values = {state_id: 0.0 for state_id in states}
    q_values: dict[str, dict[str, float]] = {}
    for _ in range(VALUE_ITERATIONS):
        next_values: dict[str, float] = {}
        q_values = {}
        for state_id in states:
            q_values[state_id] = {}
            for action in actions:
                action_id = action["action_id"]
                immediate = _state_action_reward(state_id, action)
                continuation = sum(
                    probability * values.get(next_state, 0.0)
                    for next_state, probability in transitions[state_id][action_id]
                )
                q_values[state_id][action_id] = immediate + DISCOUNT * continuation
            next_values[state_id] = max(q_values[state_id].values())
        values = next_values

    rounded_q = {
        state_id: {action_id: _round(value) for action_id, value in actions_q.items()}
        for state_id, actions_q in q_values.items()
    }
    greedy_policy = {
        state_id: max(actions_q, key=actions_q.get)
        for state_id, actions_q in rounded_q.items()
    }
    return {
        "q_values": rounded_q,
        "state_values": {state_id: _round(value) for state_id, value in values.items()},
        "greedy_policy": greedy_policy,
    }


def _state_action_reward(state_id: str, action: dict[str, Any]) -> float:
    reward = float(action["base_reward"])
    if state_id == action["agent_id"]:
        reward += 0.08
    if state_id.startswith("causal."):
        reward += 0.04 * action["traits"].get("causal_focus", 0.5)
    if state_id == "kg.global":
        reward += 0.03 * action["traits"].get("coordination", 0.5)
    return _clamp(reward)


def _stackelberg_response(
    actions: list[dict[str, Any]],
    q_values: dict[str, dict[str, float]],
) -> dict[str, Any]:
    global_q = q_values.get("kg.global", {})
    if not global_q:
        return {"leader_action": None, "followers": []}
    leader_action_id = max(global_q, key=global_q.get)
    leader = next(a for a in actions if a["action_id"] == leader_action_id)
    followers = []
    for action in actions:
        gap = _trait_gap(leader["traits"], action["traits"])
        response_value = _round(global_q[action["action_id"]] - 0.12 * gap)
        followers.append(
            {
                "agent_id": action["agent_id"],
                "action_id": action["action_id"],
                "response_value": response_value,
                "alignment_gap": _round(gap),
                "best_response": action["action_id"] == leader_action_id,
            }
        )
    return {
        "leader_action": leader_action_id,
        "leader_agent_id": leader["agent_id"],
        "leader_q_value": global_q[leader_action_id],
        "solution_concept": "single-leader_child-follower_stackelberg_response",
        "followers": followers,
    }


def _bidirectional_meta_learning(
    actions: list[dict[str, Any]],
    global_q: dict[str, float],
    global_reward: float,
) -> dict[str, Any]:
    weights = {
        action["action_id"]: max(0.05, global_q.get(action["action_id"], 0.0))
        for action in actions
    }
    prior = _weighted_traits(actions, weights, key="traits")
    mean_q = sum(weights.values()) / max(1, len(weights))
    child_shards: list[dict[str, Any]] = []

    upward_traits: list[dict[str, float]] = []
    upward_weights: dict[str, float] = {}
    for action in actions:
        action_id = action["action_id"]
        traits = action["traits"]
        q_delta = global_q.get(action_id, mean_q) - mean_q
        inherited = dict(prior)
        local_delta = {
            name: _round(0.45 * (traits[name] - prior[name]) + 0.04 * q_delta)
            for name in TRAIT_NAMES
        }
        specialized = {
            name: _clamp(
                0.58 * traits[name]
                + 0.30 * inherited[name]
                + 0.12 * (inherited[name] + local_delta[name])
            )
            for name in TRAIT_NAMES
        }
        specialized["exploitation"] = _clamp(
            specialized["exploitation"] + 0.05 * global_reward
        )
        specialized["coordination"] = _clamp(
            specialized["coordination"] + 0.04 * global_reward
        )
        upward_traits.append(specialized)
        upward_weights[action_id] = weights[action_id]
        child_shards.append(
            {
                "agent_id": action["agent_id"],
                "policy_id": action["policy_id"],
                "action_id": action_id,
                "q_value": global_q.get(action_id, 0.0),
                "inherited_prior": {k: _round(v) for k, v in inherited.items()},
                "local_delta": local_delta,
                "specialized_policy": {k: _round(v) for k, v in specialized.items()},
            }
        )

    updated_prior = _weighted_plain_traits(upward_traits, list(upward_weights.values()))
    for shard in child_shards:
        shard["specialized_policy"] = {
            name: _round(
                0.62 * shard["specialized_policy"][name] + 0.38 * updated_prior[name]
            )
            for name in TRAIT_NAMES
        }

    return {
        "method": "bidirectional_meta_learning",
        "passes": ["downward_prior_inheritance", "upward_local_delta_aggregation"],
        "prior": {name: _round(value) for name, value in prior.items()},
        "updated_prior": {name: _round(value) for name, value in updated_prior.items()},
        "child_shards": child_shards,
    }


def _evaluation_scores(ranked_strategies: list[Any]) -> dict[str, float]:
    if not ranked_strategies:
        return {}
    payload = ranked_strategies[0]
    if hasattr(payload, "model_dump"):
        payload = payload.model_dump()
    if not isinstance(payload, dict):
        return {}
    scores: dict[str, float] = {}
    for evaluation in payload.get("evaluations", []) or []:
        if hasattr(evaluation, "model_dump"):
            evaluation = evaluation.model_dump()
        if not isinstance(evaluation, dict):
            continue
        perspective = str(evaluation.get("perspective", ""))
        score = evaluation.get("score", {}) or {}
        if hasattr(score, "model_dump"):
            score = score.model_dump()
        overall = score.get("overall_score", 0.5) if isinstance(score, dict) else 0.5
        if perspective:
            scores[perspective] = _clamp(float(overall))
    ranked = payload.get("ranked_perspectives", []) or []
    for index, perspective in enumerate(ranked):
        if perspective not in scores:
            scores[str(perspective)] = _clamp(0.72 - 0.05 * index)
    return scores


def _causal_reward(report: dict[str, Any]) -> dict[str, Any]:
    method = str(report.get("method", "unknown"))
    ate = report.get("ate")
    p_value = report.get("p_value")
    n_rows = int(report.get("n_rows", 0) or 0)
    if method.startswith("withheld"):
        score = 0.34
    elif ate is None:
        score = 0.45
    else:
        significance = 1.0 if p_value is not None and p_value < 0.05 else 0.65
        sample = min(1.0, n_rows / 200.0)
        score = 0.55 + 0.25 * significance + 0.20 * sample
    return {
        "score": _round(score),
        "method": method,
        "ate": ate,
        "p_value": p_value,
        "n_rows": n_rows,
    }


def _reasoning_reward(report: dict[str, Any]) -> dict[str, Any]:
    stats = report.get("stats", {}) if isinstance(report, dict) else {}
    recommendations = (
        report.get("recommendations", []) if isinstance(report, dict) else []
    )
    anomaly_count = int(stats.get("anomaly_count", 0) or 0)
    unexplained = int(stats.get("unexplained_anomaly_count", 0) or 0)
    score = (
        0.55 + min(0.18, 0.03 * len(recommendations)) - min(0.18, 0.04 * unexplained)
    )
    if anomaly_count and not recommendations:
        score -= 0.08
    return {
        "score": _round(_clamp(score)),
        "anomaly_count": anomaly_count,
        "unexplained_anomaly_count": unexplained,
        "recommendation_count": len(recommendations),
    }


def _kg_reward(kg: dict[str, Any]) -> dict[str, Any]:
    nodes = kg.get("nodes") or []
    edges = kg.get("edges") or []
    if not nodes and not edges:
        return {"score": 0.42, "node_count": 0, "edge_count": 0, "mean_confidence": 0.0}
    confidences = [float(edge.get("confidence", 0.5)) for edge in edges]
    mean_confidence = sum(confidences) / max(1, len(confidences))
    density = min(1.0, len(edges) / max(1, len(nodes) * 2))
    return {
        "score": _round(0.42 + 0.34 * mean_confidence + 0.24 * density),
        "node_count": len(nodes),
        "edge_count": len(edges),
        "mean_confidence": _round(mean_confidence),
    }


def _matching_memo(persona: str, index: int, memos: list[Any]) -> Any | None:
    persona_l = persona.lower()
    for memo in memos:
        perspective = str(_field(memo, "perspective", "")).lower()
        if persona_l in perspective or perspective in persona_l:
            return memo
    if index < len(memos):
        return memos[index]
    return None


def _match_eval_score(perspective: str, scores: dict[str, float]) -> float:
    if perspective in scores:
        return scores[perspective]
    perspective_l = perspective.lower()
    for known, score in scores.items():
        known_l = known.lower()
        if known_l in perspective_l or perspective_l in known_l:
            return score
    return 0.5


def _confidence_score(confidence: Any) -> float:
    value = str(confidence or "").lower()
    if value == "high":
        return 0.82
    if value == "medium":
        return 0.62
    if value == "low":
        return 0.38
    return 0.5


def _policy_traits(policy: Any) -> dict[str, float]:
    if hasattr(policy, "model_dump"):
        policy = policy.model_dump()
    traits = policy.get("traits", {}) if isinstance(policy, dict) else {}
    return {name: _clamp(float(traits.get(name, 0.5))) for name in TRAIT_NAMES}


def _policy_id(policy: Any, fallback: str) -> str:
    if hasattr(policy, "model_dump"):
        policy = policy.model_dump()
    if isinstance(policy, dict) and policy.get("policy_id"):
        return str(policy["policy_id"])
    return f"policy.{fallback}"


def _weighted_traits(
    actions: list[dict[str, Any]],
    weights: dict[str, float],
    *,
    key: str,
) -> dict[str, float]:
    total = sum(weights.values()) or 1.0
    result = {name: 0.0 for name in TRAIT_NAMES}
    for action in actions:
        weight = weights[action["action_id"]]
        traits = action[key]
        for name in TRAIT_NAMES:
            result[name] += weight * traits[name]
    return {name: _clamp(value / total) for name, value in result.items()}


def _weighted_plain_traits(
    trait_sets: list[dict[str, float]],
    weights: list[float],
) -> dict[str, float]:
    total = sum(weights) or 1.0
    result = {name: 0.0 for name in TRAIT_NAMES}
    for traits, weight in zip(trait_sets, weights, strict=False):
        for name in TRAIT_NAMES:
            result[name] += weight * traits[name]
    return {name: _clamp(value / total) for name, value in result.items()}


def _trait_gap(a: dict[str, float], b: dict[str, float]) -> float:
    return math.sqrt(sum((a[name] - b[name]) ** 2 for name in TRAIT_NAMES)) / math.sqrt(
        len(TRAIT_NAMES)
    )


def _field(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _slug(value: str) -> str:
    slug = value.replace(" ", "_").lower()
    return _SLUG_RE.sub("", slug)


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _round(value: float) -> float:
    return round(float(value), 4)
