import { describe, expect, it } from "vitest";

import { computeDerivedMetrics, fmt, isImpactWithheld } from "./derived-metrics";
import type { RunResponse } from "./causalops-types";

function runFixture(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    run_id: "run-test-1",
    strategies: [
      {
        title: "Patch exposed hosts",
        summary: "Patch vulnerable edge systems first.",
        risk_score: 0.1,
        cost_score: 0.5,
        speed_score: 0.8,
      },
      {
        title: "Disable affected service",
        summary: "Take the risky service offline immediately.",
        risk_score: 0.2,
        cost_score: 0.1,
        speed_score: 0.9,
      },
      {
        title: "Wait for vendor guidance",
        summary: "Delay response until vendor guidance lands.",
        risk_score: 0.4,
        cost_score: 0.8,
        speed_score: 0.4,
      },
    ],
    causal_graph: {
      nodes: [
        { id: "Exposure", label: "Exposure" },
        { id: "Patch", label: "Patch" },
        { id: "Movement", label: "Movement" },
      ],
      edges: [
        { source: "Exposure", target: "Patch", relationship: "prioritizes" },
        { source: "Patch", target: "Movement", relationship: "reduces" },
      ],
    },
    impact: {
      ate: -0.3,
      confidence: "high",
      ci_low: -0.45,
      ci_high: -0.15,
      n_rows: 80,
      method: "dowhy.backdoor.linear_regression+statsmodels.ols",
    },
    ...overrides,
  };
}

describe("computeDerivedMetrics", () => {
  it("ranks strategies by expected utility and reports graph shape", () => {
    const metrics = computeDerivedMetrics(runFixture());

    expect(metrics.top?.strategy.title).toBe("Disable affected service");
    expect(metrics.ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(metrics.ranked.find((item) => item.index === 2)?.pareto).toBe(false);
    expect(metrics.graph).toMatchObject({
      nodes: 3,
      edges: 2,
      acyclic: true,
      maxDepth: 2,
    });
    expect(metrics.ci.low).toBe(-0.45);
    expect(metrics.ci.high).toBe(-0.15);
    expect(metrics.ci.halfWidth).toBeCloseTo(0.15);
    expect(metrics.deltaPct).toBe(-30);
  });

  it("keeps withheld impact numerics neutral for UI charts", () => {
    const run = runFixture({
      impact: {
        ate: null,
        confidence: "insufficient_data",
        method: "withheld:data_quality_gates",
      },
    });

    const metrics = computeDerivedMetrics(run);

    expect(isImpactWithheld(run.impact)).toBe(true);
    expect(metrics.ci).toEqual({ low: 0, high: 0, halfWidth: 0 });
    expect(metrics.deltaPct).toBe(0);
    expect(fmt.ate(run.impact.ate)).toBe("WITHHELD");
  });
});
