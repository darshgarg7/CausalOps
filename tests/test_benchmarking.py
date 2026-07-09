"""Tests for standardized CausalOps tier scoring."""

from __future__ import annotations

from benchmarking import score_agent_tiers
from demo_fixtures import patch_lateral_movement_graph


def test_score_agent_tiers_reports_all_contracts():
    """Tier scoring should return stable per-layer quality metrics."""

    final_state = {
        "parent_configs": [
            {"persona": "Identity", "focus_objective": "Review auth signals"},
            {"persona": "Network", "focus_objective": "Review east-west traffic"},
        ],
        "child_configs": [
            {"persona": "Okta", "focus_objective": "Session analysis"},
            {"persona": "EDR", "focus_objective": "Endpoint lateral movement"},
            {"persona": "CVE", "focus_objective": "Vulnerability exposure"},
            {"persona": "SOC", "focus_objective": "Incident timeline"},
        ],
        "memos": [
            {
                "strategy": "Contain identity blast radius",
                "risks": ["Business disruption"],
                "assumptions": ["Logs are complete"],
                "second_order_effects": ["Helpdesk load"],
                "evidence_needs": ["SSO logs"],
            }
        ],
        "ranked_strategies": [
            {
                "evaluations": [{"perspective": "Identity"}],
                "ranked_perspectives": ["Identity"],
                "final_recommendation": "Revoke sessions for high-risk users.",
            }
        ],
        "evaluator_error": None,
        "causal_payload": {"graph": patch_lateral_movement_graph()},
        "causal_estimate_report": {
            "method": "dowhy.backdoor.linear_regression+statsmodels.ols",
            "n_rows": 80,
            "ate": -0.3,
            "p_value": 0.001,
            "ci_low": -0.4,
            "ci_high": -0.2,
            "refuters": [{"name": "placebo_treatment_refuter"}],
        },
    }

    metrics = score_agent_tiers(final_state)
    tiers = metrics["tiers"]

    assert 0.0 <= metrics["overall_score"] <= 1.0
    assert set(tiers) == {
        "orchestrator",
        "parent_agents",
        "child_agents",
        "evaluator",
        "causal_architect",
        "estimator",
    }
    assert tiers["orchestrator"]["score"] == 1.0
    assert tiers["estimator"]["observed"]["has_p_value"] is True
    assert tiers["estimator"]["observed"]["refuters"] == 1
