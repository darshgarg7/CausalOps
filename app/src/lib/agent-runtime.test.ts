import { describe, expect, it } from "vitest";

import { buildObservabilityTrace } from "./agent-runtime";
import { EMPTY_SCENARIO, type ScenarioState } from "./scenario-builder";
import type { RunResponse } from "./causalops-types";

const scenario: ScenarioState = {
  ...EMPTY_SCENARIO,
  asset: "domain-controller-01",
  actor: "FIN7",
  objective: "exfiltrate customer PII",
  vector: "phishing email with malicious attachment",
  environment: "SIEM and EDR telemetry available",
  impact: "regulatory disclosure",
};

const result: RunResponse = {
  run_id: "run-test-001",
  strategies: [],
  causal_graph: {
    nodes: [
      { id: "Patch_Applied", label: "Patch applied" },
      { id: "Lateral_Movement", label: "Lateral movement" },
      { id: "Asset_Criticality", label: "Asset criticality" },
    ],
    edges: [
      {
        source: "Patch_Applied",
        target: "Lateral_Movement",
        relationship: "Patching reduces movement.",
        status: "confirmed",
        p_value: 0.001,
        strength: 0.6,
      },
      {
        source: "Asset_Criticality",
        target: "Patch_Applied",
        relationship: "Critical assets are prioritized for patching.",
        status: "refuted",
      },
    ],
    treatment_variable: "Patch_Applied",
    outcome_variable: "Lateral_Movement",
  },
  impact: { ate: -0.3, confidence: "high" },
};

describe("buildObservabilityTrace: no fabricated causal-validation data", () => {
  const trace = buildObservabilityTrace(scenario, ["T1566"], result);

  it("does not attach a run-level validation/refutation block", () => {
    // Regression guard: this trace used to carry a `validation` object with
    // a hash-derived `refutationScore`, `placeboPassed`, and `placeboTotal`
    // presented as if it were DoWhy output. It must never come back here —
    // real refutation results live in CausalEstimateReport instead.
    expect(trace).not.toHaveProperty("validation");
  });

  it("edge attribution carries no confidence, evidence type, or validated flag", () => {
    expect(trace.edges.length).toBeGreaterThan(0);
    for (const edge of trace.edges) {
      expect(edge).not.toHaveProperty("confidence");
      expect(edge).not.toHaveProperty("evidenceType");
      expect(edge).not.toHaveProperty("evidenceSummary");
      expect(edge).not.toHaveProperty("validated");
      // Structural attribution only.
      expect(Object.keys(edge).sort()).toEqual(
        ["attributedAgentId", "key", "relationship", "source", "target"].sort(),
      );
    }
  });

  it("the decision log never claims a DoWhy-style refutation pass", () => {
    const text = trace.log.map((entry) => entry.message).join(" ");
    expect(text).not.toMatch(/refutation score/i);
    expect(text).not.toMatch(/placebo test/i);
    expect(text).not.toMatch(/DoWhy/i);
  });

  it("still produces the illustrative agent hierarchy (orchestrator + attribution)", () => {
    // The simplification must not remove the legitimate illustrative
    // content — only the fabricated statistical claims layered onto it.
    expect(trace.agents.some((a) => a.level === "orchestrator")).toBe(true);
    expect(trace.edges.map((e) => e.key)).toEqual(
      expect.arrayContaining([
        "Patch_Applied->Lateral_Movement",
        "Asset_Criticality->Patch_Applied",
      ]),
    );
  });
});
