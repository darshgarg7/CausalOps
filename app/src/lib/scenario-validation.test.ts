import { describe, expect, it } from "vitest";

import { EMPTY_SCENARIO, type ScenarioState } from "./scenario-builder";
import { techniqueLabel, validateScenario } from "./scenario-validation";

function scenario(overrides: Partial<ScenarioState> = {}): ScenarioState {
  return {
    ...EMPTY_SCENARIO,
    asset: "Production identity tenant and finance workstations",
    actor: "Financially motivated ransomware affiliate",
    objective: "Contain intrusion and prevent ransomware deployment",
    vector: "Spear-phishing followed by credential theft",
    environment: "Entra ID, Defender XDR, segmented server tiers",
    impact: "Customer-facing outage and disclosure risk",
    detection_gaps: "EDR missing on a subset of jump hosts",
    ...overrides,
  };
}

describe("validateScenario", () => {
  it("blocks empty scenarios with required-field and TTP errors", () => {
    const result = validateScenario(EMPTY_SCENARIO, []);

    expect(result.canRun).toBe(false);
    expect(result.errors).toBe(4);
    expect(result.issues.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([
        "missing-asset",
        "missing-objective",
        "missing-vector",
        "ttps-missing",
      ]),
    );
  });

  it("flags ransomware objectives that lack an impact technique", () => {
    const result = validateScenario(scenario(), ["T1566.001", "T1003.001"]);

    expect(result.canRun).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "conflict-ransom-no-impact",
          addTtpIds: ["T1486", "T1490"],
        }),
      ]),
    );
  });

  it("allows a complete scenario with a coherent kill chain", () => {
    const result = validateScenario(scenario(), ["T1566.001", "T1003.001", "T1486"]);

    expect(result.canRun).toBe(true);
    expect(result.errors).toBe(0);
    expect(techniqueLabel("T1486")).toContain("Data Encrypted for Impact");
  });
});
