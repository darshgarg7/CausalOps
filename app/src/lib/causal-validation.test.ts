import { describe, expect, it } from "vitest";

import {
  edgeStatusCounts,
  edgeStrokeWidth,
  edgeValidationStatus,
  edgeVisualStyle,
  graphDiscoveryAvailable,
  summarizeEstimate,
  type EdgeValidationStatus,
} from "./causal-validation";
import type { CausalEstimateReport, CausalGraph } from "./causalops-types";

const ALL_STATUSES: EdgeValidationStatus[] = [
  "confirmed",
  "compatible",
  "reversed",
  "refuted",
  "discovered",
  "hypothesized",
];

describe("edgeValidationStatus / edgeVisualStyle", () => {
  it("maps every real backend status to a distinct visual style", () => {
    const styles = ALL_STATUSES.map((status) => edgeVisualStyle({ status }));
    // Every status must render distinctly (color or dash pattern differs) so an
    // analyst can visually tell confirmed/refuted/reversed/discovered apart.
    const signatures = styles.map((s) => `${s.color}|${JSON.stringify(s.dash)}`);
    expect(new Set(signatures).size).toBe(ALL_STATUSES.length);
  });

  it("falls back to hypothesized for a missing status (edge never reached discovery)", () => {
    expect(edgeValidationStatus({ status: undefined })).toBe("hypothesized");
    expect(edgeVisualStyle({}).status).toBe("hypothesized");
  });

  it("falls back to hypothesized for an unrecognized status instead of crashing", () => {
    // @ts-expect-error deliberately passing a value outside the real backend enum
    expect(edgeValidationStatus({ status: "made_up" })).toBe("hypothesized");
  });

  it("gives refuted edges a visually distinct (dashed) line, never solid like confirmed", () => {
    expect(edgeVisualStyle({ status: "confirmed" }).dash).toBeNull();
    expect(edgeVisualStyle({ status: "refuted" }).dash).not.toBeNull();
    expect(edgeVisualStyle({ status: "hypothesized" }).dash).not.toBeNull();
  });
});

describe("edgeStrokeWidth", () => {
  it("scales with real backend strength", () => {
    const weak = edgeStrokeWidth({ strength: 0.1 });
    const strong = edgeStrokeWidth({ strength: 0.9 });
    expect(strong).toBeGreaterThan(weak);
  });

  it("never fabricates a width from edge content — missing strength gets a fixed neutral value", () => {
    // Two edges with wildly different relationship text/status but no
    // `strength` field must render identically: the width is a pure
    // function of `strength`, not a hash or heuristic over other fields.
    const a = edgeStrokeWidth({ strength: undefined });
    const b = edgeStrokeWidth({ strength: null });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it("widens active edges by a fixed amount regardless of strength", () => {
    const inactive = edgeStrokeWidth({ strength: 0.5 }, false);
    const active = edgeStrokeWidth({ strength: 0.5 }, true);
    expect(active).toBeGreaterThan(inactive);
  });
});

describe("graphDiscoveryAvailable / edgeStatusCounts", () => {
  const withDiscovery: CausalGraph = {
    nodes: [],
    edges: [
      { source: "a", target: "b", relationship: "r", status: "confirmed" },
      { source: "b", target: "c", relationship: "r", status: "refuted" },
      { source: "c", target: "d", relationship: "r", status: "refuted" },
    ],
  };
  const withoutDiscovery: CausalGraph = {
    nodes: [],
    edges: [{ source: "a", target: "b", relationship: "r" }],
  };

  it("is true only when at least one edge carries a backend status", () => {
    expect(graphDiscoveryAvailable(withDiscovery)).toBe(true);
    expect(graphDiscoveryAvailable(withoutDiscovery)).toBe(false);
    expect(graphDiscoveryAvailable({ edges: [] })).toBe(false);
  });

  it("counts real statuses exactly, with no fabricated proportions", () => {
    const counts = edgeStatusCounts(withDiscovery);
    expect(counts.confirmed).toBe(1);
    expect(counts.refuted).toBe(2);
    expect(counts.compatible).toBe(0);
    expect(counts.discovered).toBe(0);
    expect(counts.reversed).toBe(0);
    expect(counts.hypothesized).toBe(0);
  });

  it("treats an edge with no status as hypothesized in the tally", () => {
    const counts = edgeStatusCounts(withoutDiscovery);
    expect(counts.hypothesized).toBe(1);
  });
});

describe("summarizeEstimate", () => {
  it("reports 'Not evaluated' when no report was returned at all", () => {
    expect(summarizeEstimate(null).state).toBe("unavailable");
    expect(summarizeEstimate(undefined).state).toBe("unavailable");
    expect(summarizeEstimate(null).label).toBe("Not evaluated");
  });

  it("reports insufficient evidence for data-quality-gate withholding", () => {
    const report: CausalEstimateReport = {
      data_mode: "insufficient_data",
      method: "withheld:data_quality_gates",
      ate: null,
      refuters: [],
    };
    const summary = summarizeEstimate(report);
    expect(summary.state).toBe("insufficient_evidence");
    expect(summary.refuterTally).toBeNull();
  });

  it("reports insufficient evidence for synthetic-only evidence", () => {
    const report: CausalEstimateReport = {
      data_mode: "synthetic_simulation",
      method: "withheld:data_quality_gates",
      ate: null,
    };
    expect(summarizeEstimate(report).state).toBe("insufficient_evidence");
  });

  it("reports a generic withheld state for non-gate withholding (e.g. DoWhy identification failure)", () => {
    const report: CausalEstimateReport = {
      data_mode: "empirical",
      method: "withheld:dowhy_identification_or_estimation_failed",
      ate: null,
    };
    expect(summarizeEstimate(report).state).toBe("withheld");
  });

  it("reports 'refutation unavailable' when an ATE exists but no refuters ran", () => {
    const report: CausalEstimateReport = {
      data_mode: "empirical",
      method: "dowhy.backdoor.linear_regression+statsmodels.ols",
      ate: -0.3,
      refuters: [],
    };
    const summary = summarizeEstimate(report);
    expect(summary.state).toBe("estimated_unrefuted");
    expect(summary.refuterTally).toBeNull();
  });

  it("reports refutation passed with a real N/M tally, never a synthesized percentage", () => {
    const report: CausalEstimateReport = {
      data_mode: "empirical",
      method: "dowhy.backdoor.linear_regression+statsmodels.ols",
      ate: -0.3,
      refutation_passed: true,
      refuters: [
        { name: "random_common_cause", passed: true, details: "" },
        { name: "placebo_treatment_refuter", passed: true, details: "" },
        { name: "data_subset_refuter", passed: true, details: "" },
      ],
    };
    const summary = summarizeEstimate(report);
    expect(summary.state).toBe("estimated_refuted_pass");
    expect(summary.refuterTally).toBe("3/3 refuters passed");
    // The tally must be an integer fraction of real booleans, never a "%".
    expect(summary.refuterTally).not.toContain("%");
  });

  it("reports refutation failed when at least one refuter disagrees, with the real tally", () => {
    const report: CausalEstimateReport = {
      data_mode: "empirical",
      method: "dowhy.backdoor.linear_regression+statsmodels.ols",
      ate: -0.3,
      refutation_passed: false,
      refuters: [
        { name: "random_common_cause", passed: true, details: "" },
        { name: "placebo_treatment_refuter", passed: false, details: "" },
      ],
    };
    const summary = summarizeEstimate(report);
    expect(summary.state).toBe("estimated_refuted_fail");
    expect(summary.refuterTally).toBe("1/2 refuters passed");
  });
});
