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
