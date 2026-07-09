"""Deterministic reasoning layer over the 5D spatiotemporal graph.

Consumes what the run produced — evidence records, the data-validated causal
DAG, and the effect estimate — and emits operational conclusions:

1. **Anomalies (causal surprise).** An asset whose adverse outcome was
   improbable given its treatment group is flagged. Each anomaly is then
   *explained* by walking the validated DAG: active secondary causes of the
   outcome (non-refuted edges) account for the surprise. Anomalies with no
   explaining cause are marked unexplained — the highest-severity signal,
   because the validated model cannot account for them.
2. **Zone summary.** Anomaly and outcome concentration per network zone, so
   the spatial axis carries operational meaning.
3. **Recommendations.** Ranked, evidence-cited actions: investigate
   unexplained anomalies, apply a treatment whose estimated effect is
   significant (targets ranked by active secondary risk drivers), and
   mitigate confirmed secondary causes.

Like the discovery layer, this module is pure statistics over recorded
evidence — no LLM authorship — so its conclusions always cite the data and
verdicts they were derived from.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

ANOMALY_THRESHOLD = float(os.getenv("CAUSALOPS_ANOMALY_THRESHOLD", "0.15"))
MAX_LISTED_TARGETS = int(os.getenv("CAUSALOPS_REASONING_MAX_TARGETS", "10"))


def build_reasoning_report(
    evidence_records: list[dict[str, Any]],
    causal_graph: dict[str, Any],
    estimate_report: dict[str, Any] | None = None,
    *,
    anomaly_threshold: float | None = None,
) -> dict[str, Any]:
    """Derive anomalies, zone pressure, and recommendations for one run."""

    threshold = ANOMALY_THRESHOLD if anomaly_threshold is None else anomaly_threshold
    estimate_report = estimate_report or {}
    treatment = causal_graph.get("treatment_variable", "")
    outcome = causal_graph.get("outcome_variable", "")
    edges = causal_graph.get("edges", []) or []

    report: dict[str, Any] = {
        "anomalies": [],
        "zone_summary": [],
        "recommendations": [],
        "stats": {},
        "warnings": [],
    }

    assets = _asset_table(evidence_records, causal_graph)
    if not assets or not treatment or not outcome:
        report["warnings"].append(
            "Reasoning skipped: no measurable assets or treatment/outcome undefined."
        )
        return report

    measured = [
        a
        for a in assets.values()
        if treatment in a["values"] and outcome in a["values"]
    ]
    if not measured:
        report["warnings"].append(
            "Reasoning skipped: no asset measures both treatment and outcome."
        )
        return report

    # Secondary drivers: validated (non-refuted) causes of the outcome other
    # than the treatment itself.
    secondary_causes = {
        str(e["source"]): e
        for e in edges
        if str(e.get("target")) == outcome
        and str(e.get("source")) != treatment
        and e.get("status") != "refuted"
    }

    # --- Anomalies: adverse outcome that was improbable in its treatment group
    by_treatment: dict[int, list[dict[str, Any]]] = {}
    for asset in measured:
        by_treatment.setdefault(asset["values"][treatment], []).append(asset)

    group_rates = {
        t_val: sum(a["values"][outcome] for a in group) / len(group)
        for t_val, group in by_treatment.items()
    }

    anomalies: list[dict[str, Any]] = []
    for asset in measured:
        if not asset["values"][outcome]:
            continue
        baseline = group_rates[asset["values"][treatment]]
        if baseline > threshold:
            continue
        explained_by = [
            {
                "variable": var,
                "edge_status": edge.get("status", "hypothesized"),
                "p_value": edge.get("p_value"),
            }
            for var, edge in secondary_causes.items()
            if asset["values"].get(var)
        ]
        anomalies.append(
            {
                "asset_id": asset["asset_id"],
                "zone": asset["zone"],
                "treatment_value": asset["values"][treatment],
                "outcome_value": asset["values"][outcome],
                "baseline_rate": round(baseline, 4),
                "severity": "high" if not explained_by else "medium",
                "explained": bool(explained_by),
                "explained_by": explained_by,
                "detail": (
                    f"{outcome} occurred although only "
                    f"{baseline:.0%} of assets with {treatment}="
                    f"{asset['values'][treatment]} show it"
                    + (
                        "; consistent with active causes: "
                        + ", ".join(e["variable"] for e in explained_by)
                        if explained_by
                        else "; no validated cause accounts for it"
                    )
                    + "."
                ),
            }
        )
    report["anomalies"] = anomalies

    # --- Zone summary -------------------------------------------------------
    zones: dict[str, dict[str, Any]] = {}
    anomalous_assets = {a["asset_id"] for a in anomalies}
    for asset in measured:
        zone = zones.setdefault(
            asset["zone"],
            {"zone": asset["zone"], "assets": 0, "outcomes": 0, "anomalies": 0},
        )
        zone["assets"] += 1
        zone["outcomes"] += asset["values"][outcome]
        if asset["asset_id"] in anomalous_assets:
            zone["anomalies"] += 1
    report["zone_summary"] = sorted(
        zones.values(), key=lambda z: (-z["anomalies"], -z["outcomes"], z["zone"])
    )

    # --- Recommendations ----------------------------------------------------
    recommendations: list[dict[str, Any]] = []

    unexplained = [a for a in anomalies if not a["explained"]]
    if unexplained:
        recommendations.append(
            {
                "priority": 1,
                "action": "investigate_unexplained_anomalies",
                "targets": [a["asset_id"] for a in unexplained][:MAX_LISTED_TARGETS],
                "target_count": len(unexplained),
                "rationale": (
                    "These assets show the adverse outcome with no validated "
                    "causal explanation; the model cannot account for them."
                ),
                "evidence": {"anomaly_threshold": threshold},
            }
        )

    ate = estimate_report.get("ate")
    p_value = estimate_report.get("p_value")
    if ate is not None and ate < 0 and (p_value is None or p_value < 0.05):
        untreated = [a for a in measured if not a["values"][treatment]]
        # Rank by how many validated secondary outcome drivers are active.
        untreated.sort(
            key=lambda a: (
                -sum(1 for var in secondary_causes if a["values"].get(var)),
                a["asset_id"],
            )
        )
        if untreated:
            recommendations.append(
                {
                    "priority": 2,
                    "action": f"apply_{treatment}".lower(),
                    "targets": [a["asset_id"] for a in untreated][:MAX_LISTED_TARGETS],
                    "target_count": len(untreated),
                    "rationale": (
                        f"{treatment} reduces {outcome} by an estimated "
                        f"{abs(ate):.2f} per asset; untreated assets with "
                        "active secondary risk drivers are listed first."
                    ),
                    "evidence": {
                        "ate": ate,
                        "p_value": p_value,
                        "ci_low": estimate_report.get("ci_low"),
                        "ci_high": estimate_report.get("ci_high"),
                        "n_rows": estimate_report.get("n_rows"),
                        "method": estimate_report.get("method"),
                    },
                }
            )

    explained = [a for a in anomalies if a["explained"]]
    if explained:
        driver_assets: dict[str, list[str]] = {}
        driver_edges: dict[str, dict[str, Any]] = {}
        for anomaly in explained:
            for cause in anomaly["explained_by"]:
                driver_assets.setdefault(cause["variable"], []).append(
                    anomaly["asset_id"]
                )
                driver_edges[cause["variable"]] = cause
        for var, asset_ids in sorted(driver_assets.items()):
            cause = driver_edges[var]
            recommendations.append(
                {
                    "priority": 3,
                    "action": f"mitigate_{var}".lower(),
                    "targets": asset_ids[:MAX_LISTED_TARGETS],
                    "target_count": len(asset_ids),
                    "rationale": (
                        f"{var} is a validated cause of {outcome} "
                        f"({cause['edge_status']}) and drove the outcome on "
                        "these assets despite treatment; add compensating "
                        "controls for this driver."
                    ),
                    "evidence": {
                        "edge_status": cause["edge_status"],
                        "p_value": cause["p_value"],
                    },
                }
            )

    report["recommendations"] = recommendations
    report["stats"] = {
        "assets_measured": len(measured),
        "outcome_rate_by_treatment": {
            str(k): round(v, 4) for k, v in group_rates.items()
        },
        "anomaly_count": len(anomalies),
        "unexplained_anomaly_count": len(unexplained),
        "anomaly_threshold": threshold,
    }
    return report


def reasoning_node(state: dict[str, Any]) -> dict[str, Any]:
    """Coordinator node: reason over the run's validated causal model."""

    from bus.events import ArtifactType
    from bus.helpers import bind_from_state
    from bus.publish import publish_artifact, publish_telemetry

    bind_from_state(state)
    publish_telemetry(
        agent_id="reasoner",
        tier="reasoning",
        phase="REASONING",
        message=(
            "Deriving anomalies and recommendations from the validated causal model"
        ),
        status="running",
    )

    payload = state.get("causal_payload") or {}
    report = build_reasoning_report(
        state.get("evidence_records", []) or [],
        payload.get("graph", {}) or {},
        state.get("causal_estimate_report") or {},
    )
    logger.info(
        "Reasoner found %d anomalies (%d unexplained), %d recommendations",
        report["stats"].get("anomaly_count", 0),
        report["stats"].get("unexplained_anomaly_count", 0),
        len(report["recommendations"]),
    )

    publish_artifact(
        agent_id="reasoner",
        tier="reasoning",
        artifact_type=ArtifactType.REASONING_REPORT,
        payload=report,
    )
    publish_telemetry(
        agent_id="reasoner",
        tier="reasoning",
        phase="REASONING",
        message=(
            f"Reasoning complete: {report['stats'].get('anomaly_count', 0)} anomalies, "
            f"{len(report['recommendations'])} recommendations"
        ),
        status="done",
    )
    return {"reasoning_report": report}


def _asset_table(
    evidence_records: list[dict[str, Any]], causal_graph: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Collapse evidence records into one row of variable values per asset."""

    from graph_5d import _derive_location

    variables = {
        str(node.get("id")): str(node.get("id"))
        for node in causal_graph.get("nodes", []) or []
        if node.get("id")
    }
    lower_to_var = {v.lower(): v for v in variables}

    assets: dict[str, dict[str, Any]] = {}
    for record in evidence_records:
        asset_id = record.get("asset_id")
        if not asset_id:
            continue
        fields = record.get("extracted_fields") or {}
        subnet, _ = _derive_location(fields, asset_id)
        entry = assets.setdefault(
            str(asset_id), {"asset_id": str(asset_id), "zone": subnet, "values": {}}
        )
        for field_name, field_val in fields.items():
            var = lower_to_var.get(str(field_name).lower())
            if var is None:
                continue
            try:
                entry["values"][var] = int(bool(int(float(field_val))))
            except (TypeError, ValueError):
                continue
    return assets
