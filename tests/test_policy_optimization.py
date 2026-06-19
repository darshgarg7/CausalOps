"""Tests for agent evolution and KG-grounded policy learning."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from bus.events import ArtifactType, EventEnvelope
from evolution import evolve_child_configs
from graph_5d import get_5d_graph, init_5d_schema
from graph_5d_stream import apply_envelope
from policy_learning import build_policy_optimization_report
from schema import AgentPolicy, ChildConfig, DecisionMemo


def test_steady_state_island_evolution_attaches_policy_priors() -> None:
    children = [
        ChildConfig(
            parent_persona="Network",
            persona="DNS Forensics",
            focus_objective="Inspect DNS telemetry and evidence gaps",
        ),
        ChildConfig(
            parent_persona="Identity",
            persona="Session Risk",
            focus_objective="Trace identity risk and containment actions",
        ),
    ]
    evolved, report = evolve_child_configs(
        {
            "run_id": "run-evolve-1",
            "task_description": (
                "Investigate a dynamic Kafka-backed causal graph with uncertain "
                "telemetry, risk, and evidence gaps."
            ),
        },
        children,
    )

    assert len(evolved) == 2
    assert all(config.policy is not None for config in evolved)
    assert report["algorithm"] == "steady_state_island_evolution"
    assert report["tier"] == "child"
    assert len(report["selected_policies"]) == 2
    assert report["replacement_events"] > 0


def test_policy_learning_builds_q_values_and_child_shards() -> None:
    policy = AgentPolicy(
        policy_id="child.dns.seed",
        island_id="child-island-1",
        traits={
            "evidence_weight": 0.8,
            "causal_focus": 0.7,
            "temporal_awareness": 0.6,
            "exploration": 0.4,
            "exploitation": 0.7,
            "risk_aversion": 0.65,
            "coordination": 0.75,
            "resource_budget": 0.55,
        },
    )
    state = {
        "run_id": "run-policy-1",
        "child_configs": [
            ChildConfig(
                parent_persona="Network",
                persona="DNS",
                focus_objective="Inspect DNS",
                policy=policy,
            )
        ],
        "memos": [
            DecisionMemo(
                perspective="DNS",
                strategy="Correlate resolver logs with beacon timing",
                risks=["False positives"],
                confidence="high",
            )
        ],
        "ranked_strategies": [
            {
                "evaluations": [
                    {
                        "perspective": "DNS",
                        "score": {"overall_score": 0.84},
                    }
                ],
                "ranked_perspectives": ["DNS"],
            }
        ],
        "causal_estimate_report": {
            "method": "dowhy.backdoor.linear_regression+statsmodels.ols",
            "ate": -0.3,
            "p_value": 0.01,
            "n_rows": 80,
        },
        "reasoning_report": {
            "stats": {"anomaly_count": 1, "unexplained_anomaly_count": 0},
            "recommendations": [{"action": "apply_patch"}],
        },
    }
    kg = {
        "run_id": "run-policy-1",
        "nodes": [
            {"id": "agent.child.dns", "node_type": "agent"},
            {"id": "causal.patch", "node_type": "causal_variable"},
        ],
        "edges": [
            {
                "source": "agent.child.dns",
                "target": "causal.patch",
                "relationship": "supports",
                "confidence": 0.9,
            }
        ],
    }

    report = build_policy_optimization_report(state, kg)

    assert report["algorithm"] == "kg_model_based_rl_meta_learning"
    assert "kg.global" in report["mdp"]["q_values"]
    assert report["stackelberg"]["leader_agent_id"] == "agent.child.dns"
    assert len(report["meta_learning"]["child_shards"]) == 1
    assert report["kafka_feedback"]["kg_update_nodes"] >= 3


def test_policy_optimization_artifact_updates_5d_graph() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_5d_schema(conn)
    report = {
        "reward_model": {"global_reward": 0.7},
        "kg_base": {"node_count": 2, "edge_count": 1},
        "stackelberg": {
            "leader_agent_id": "agent.child.dns",
            "leader_action": "policy_action.dns",
            "leader_q_value": 1.2,
            "solution_concept": "test",
        },
        "meta_learning": {
            "updated_prior": {"coordination": 0.8},
            "child_shards": [
                {
                    "agent_id": "agent.child.dns",
                    "policy_id": "child.dns.seed",
                    "q_value": 1.2,
                    "inherited_prior": {"coordination": 0.7},
                    "local_delta": {"coordination": 0.1},
                    "specialized_policy": {"coordination": 0.82},
                }
            ],
        },
        "kafka_feedback": {"loop": "test"},
    }
    env = EventEnvelope(
        run_id="run-policy-kg",
        correlation_id="run-policy-kg",
        agent_id="optimizer:rl",
        tier="optimizer",
        artifact_type=ArtifactType.POLICY_OPTIMIZATION_REPORT,
        payload=report,
        timestamp=datetime(2026, 6, 1, 12, 0, tzinfo=UTC),
    )

    assert apply_envelope(conn, env)

    graph = get_5d_graph(conn, "run-policy-kg")
    node_ids = {node["id"] for node in graph["nodes"]}
    relationships = {edge["relationship"] for edge in graph["edges"]}

    assert "policy.meta_prior" in node_ids
    assert "policy.shard.agent.child.dns" in node_ids
    assert "updates_knowledge_graph" in relationships
    assert "selects_stackelberg_leader" in relationships
