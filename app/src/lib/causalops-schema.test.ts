import { describe, expect, it } from "vitest";

import { parseRunResponse, SchemaValidationError } from "./causalops-schema";

const validRunResponse = {
  run_id: "run-123",
  strategies: [
    {
      title: "Prioritize emergency patching",
      summary: "Patch exploited assets before broad hardening.",
      risk_score: 0.15,
      cost_score: 0.35,
      speed_score: 0.82,
    },
  ],
  ranked_strategies: [],
  final_recommendation: "Patch internet-facing systems first.",
  causal_graph: {
    nodes: [
      { id: "Patch_Applied", label: "Patch applied" },
      { id: "Lateral_Movement", label: "Lateral movement" },
    ],
    edges: [
      {
        source: "Patch_Applied",
        target: "Lateral_Movement",
        relationship: "Reduces exploitable movement paths",
      },
    ],
  },
  impact: {
    ate: -0.3,
    confidence: "statistically_significant",
    p_value: 0.004,
    ci_low: -0.45,
    ci_high: -0.15,
    n_rows: 80,
    method: "dowhy.backdoor.linear_regression+statsmodels.ols",
  },
  causal_estimate_report: {
    method: "dowhy.backdoor.linear_regression+statsmodels.ols",
  },
  causal_dataset_profile: {
    data_mode: "empirical",
  },
  agent_tier_metrics: {
    orchestrator: { score: 1 },
  },
};

describe("parseRunResponse", () => {
  it("accepts a complete backend response with statistical diagnostics", () => {
    const parsed = parseRunResponse(validRunResponse);

    expect(parsed.run_id).toBe("run-123");
    expect(parsed.impact.ate).toBe(-0.3);
    expect(parsed.impact.p_value).toBe(0.004);
    expect(parsed.impact.ci_low).toBe(-0.45);
    expect(parsed.impact.ci_high).toBe(-0.15);
  });

  it("accepts nullable optional statistical fields for withheld estimates", () => {
    const parsed = parseRunResponse({
      ...validRunResponse,
      impact: {
        ...validRunResponse.impact,
        p_value: null,
        ci_low: null,
        ci_high: null,
      },
    });

    expect(parsed.impact.p_value).toBeNull();
    expect(parsed.impact.ci_low).toBeNull();
    expect(parsed.impact.ci_high).toBeNull();
  });

  it("throws structured issues when backend response shape drifts", () => {
    expect(() =>
      parseRunResponse({
        ...validRunResponse,
        impact: {
          ...validRunResponse.impact,
          ate: "not-a-number",
        },
      }),
    ).toThrow(SchemaValidationError);

    try {
      parseRunResponse({
        ...validRunResponse,
        strategies: [{ ...validRunResponse.strategies[0], risk_score: 9 }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "strategies.0.risk_score",
          }),
        ]),
      );
    }
  });
});

// Fixtures below mirror the real serialized shape observed from a live
// /demo/estimate run (patch-vs-lateral-movement fixture), traced through
// src/schema.py's CausalEstimateReport/RefuterReport and
// src/causal_discovery.py's apply_discovery edge annotations, not invented
// field names.
describe("parseRunResponse: causal discovery and estimate report", () => {
  it("accepts a complete causal_estimate_report with real refuters and discovery-validated edges", () => {
    const parsed = parseRunResponse({
      ...validRunResponse,
      causal_graph: {
        nodes: [
          { id: "Asset_Criticality", label: "Asset criticality" },
          { id: "Patch_Applied", label: "Patch applied" },
          { id: "Lateral_Movement", label: "Lateral movement" },
        ],
        edges: [
          {
            source: "Asset_Criticality",
            target: "Patch_Applied",
            relationship: "Critical assets are prioritized for patching.",
            status: "refuted",
            p_value: 1.0,
            strength: 0.0,
            validation_detail: "Marginally independent (p=1.0000, alpha=0.1).",
          },
          {
            source: "Asset_Criticality",
            target: "Lateral_Movement",
            relationship: "Critical assets attract more adversary movement.",
            status: "confirmed",
            p_value: 0.0644,
            strength: 0.2067,
            validation_detail: "Dependence and collider orientation both match the data.",
          },
          {
            source: "Patch_Applied",
            target: "Lateral_Movement",
            relationship: "Patching reduces exploitability and movement.",
            status: "compatible",
          },
        ],
        treatment_variable: "Patch_Applied",
        outcome_variable: "Lateral_Movement",
        candidate_confounders: ["Asset_Criticality"],
      },
      causal_estimate_report: {
        data_mode: "empirical",
        method: "dowhy.backdoor.linear_regression+statsmodels.ols",
        treatment: "Patch_Applied",
        outcome: "Lateral_Movement",
        adjustment_set: ["Asset_Criticality"],
        n_rows: 80,
        ate: -0.3,
        standard_error: 0.0821,
        p_value: 0.00047,
        ci_low: -0.4635,
        ci_high: -0.1365,
        refutation_passed: true,
        refuters: [
          { name: "random_common_cause", passed: true, details: "New effect:-0.3006" },
          { name: "placebo_treatment_refuter", passed: true, details: "New effect:0.0" },
          { name: "data_subset_refuter", passed: true, details: "New effect:-0.2991" },
        ],
        warnings: [],
        dataset_profile: {
          data_mode: "empirical",
          n_rows: 80,
          treatment: "Patch_Applied",
          outcome: "Lateral_Movement",
          treated_count: 40,
          control_count: 40,
        },
      },
    });

    expect(parsed.causal_estimate_report?.refuters).toHaveLength(3);
    expect(parsed.causal_estimate_report?.refuters?.every((r) => r.passed)).toBe(true);
    expect(parsed.causal_estimate_report?.refutation_passed).toBe(true);
    const statuses = parsed.causal_graph.edges.map((e) => e.status);
    expect(statuses).toEqual(["refuted", "confirmed", "compatible"]);
    expect(parsed.causal_graph.edges[1].p_value).toBeCloseTo(0.0644);
  });

  it("accepts a withheld estimate (insufficient evidence) with no ate and no refuters", () => {
    const parsed = parseRunResponse({
      ...validRunResponse,
      causal_estimate_report: {
        data_mode: "insufficient_data",
        method: "withheld:data_quality_gates",
        treatment: "Patch_Applied",
        outcome: "Lateral_Movement",
        n_rows: 1,
        ate: null,
        standard_error: null,
        p_value: null,
        ci_low: null,
        ci_high: null,
        refutation_passed: false,
        refuters: [],
        warnings: ["Minimum row gate failed: at least 50 complete observations are required."],
      },
    });

    expect(parsed.causal_estimate_report?.ate).toBeNull();
    expect(parsed.causal_estimate_report?.refuters).toEqual([]);
    expect(parsed.causal_estimate_report?.method).toBe("withheld:data_quality_gates");
  });

  it("accepts a run whose graph edges carry no discovery output (skipped or older artifact)", () => {
    const parsed = parseRunResponse(validRunResponse);

    // The base fixture's edges have no status/p_value/strength at all —
    // this must parse cleanly rather than requiring discovery fields.
    expect(parsed.causal_graph.edges[0].status).toBeUndefined();
    expect(parsed.causal_graph.edges[0].p_value).toBeUndefined();
    expect(parsed.causal_estimate_report).toEqual({
      method: "dowhy.backdoor.linear_regression+statsmodels.ols",
    });
  });

  it("rejects an edge status value the backend's EdgeVerdict cannot produce", () => {
    expect(() =>
      parseRunResponse({
        ...validRunResponse,
        causal_graph: {
          ...validRunResponse.causal_graph,
          edges: [
            {
              ...validRunResponse.causal_graph.edges[0],
              status: "definitely_true",
            },
          ],
        },
      }),
    ).toThrow(SchemaValidationError);
  });
});
