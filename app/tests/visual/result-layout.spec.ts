import { expect, test } from "@playwright/test";

const runId = "visual-layout-run";
const now = Date.parse("2026-07-06T17:32:47Z");

const payload = {
  run_id: runId,
  execution_mode: "standard",
  strategies: [
    {
      title: "Revoke exposed cross-account paths",
      summary: "Disable stale trust edges and rotate affected workload credentials.",
      risk_score: 0.31,
      cost_score: 0.42,
      speed_score: 0.74,
    },
  ],
  final_recommendation: "Treat identity trust drift as the primary exposure path.",
  causal_graph: {
    treatment_variable: "Identity_Hardening",
    outcome_variable: "Lateral_Movement",
    candidate_confounders: ["Asset_Criticality"],
    nodes: [
      {
        id: "Credential_Exposure",
        label: "Credential Exposure",
        description: "Leaked keys and stale sessions increase attacker reach.",
      },
      {
        id: "Identity_Hardening",
        label: "Identity Hardening",
        description: "Session revocation, MFA enforcement, and trust cleanup.",
      },
      {
        id: "Asset_Criticality",
        label: "Asset Criticality",
        description: "High-value workloads receive more admin and attacker attention.",
      },
      {
        id: "Lateral_Movement",
        label: "Lateral Movement",
        description: "Movement across cloud accounts and data stores.",
      },
      {
        id: "Backup_Resilience",
        label: "Backup Resilience",
        description: "Immutable recovery paths reduce blast radius.",
      },
    ],
    edges: [
      {
        source: "Credential_Exposure",
        target: "Lateral_Movement",
        relationship: "expands session reach",
        required_evidence: ["iam-session-log", "cloudtrail"],
      },
      {
        source: "Asset_Criticality",
        target: "Credential_Exposure",
        relationship: "raises exposure pressure",
        required_evidence: ["asset-inventory"],
      },
      {
        source: "Identity_Hardening",
        target: "Credential_Exposure",
        relationship: "reduces usable credentials",
        required_evidence: ["iam-change-log"],
      },
      {
        source: "Backup_Resilience",
        target: "Lateral_Movement",
        relationship: "limits operational impact",
        required_evidence: ["backup-policy"],
      },
    ],
  },
  impact: {
    ate: -0.23,
    confidence: "medium",
    p_value: 0.041,
    ci_low: -0.39,
    ci_high: -0.08,
    n_rows: 240,
    method: "visual-test-fixture",
  },
};

const historyEntry = {
  id: "history-visual-layout",
  runId,
  timestamp: now,
  taskExcerpt: "Visual graph layout fixture",
  taskFull: "Visual graph layout fixture",
  ate: -0.23,
  confidence: "medium",
  strategyCount: 1,
  payload,
};

const kgFixture = {
  nodes: [
    {
      id: "agent.parent",
      node_type: "agent",
      label: "Parent investigator",
      description: "Coordinates identity and recovery analysis.",
      location: { zone: "control-plane" },
      created_at: "2026-07-06T17:32:47Z",
    },
    {
      id: "asset.aws-prod",
      node_type: "asset",
      label: "AWS prod account",
      description: "Production cloud account with cross-account trust.",
      location: { zone: "aws", tier: "prod" },
      created_at: "2026-07-06T17:33:53Z",
    },
    {
      id: "threat.credential-exposure",
      node_type: "threat",
      label: "Credential exposure",
      description: "Leaked access paths create lateral movement pressure.",
      location: { zone: "identity" },
      created_at: "2026-07-06T17:36:21Z",
    },
    {
      id: "finding.trust-drift",
      node_type: "finding",
      label: "Trust drift",
      description: "Observed stale trust and role assumption paths.",
      location: { zone: "identity" },
      created_at: "2026-07-06T17:38:07Z",
    },
    {
      id: "decision.revoke-trust",
      node_type: "decision",
      label: "Revoke trust",
      description: "Prioritized trust cleanup and session revocation.",
      location: { zone: "control-plane" },
      created_at: "2026-07-06T17:39:11Z",
    },
  ],
  edges: [
    {
      source: "agent.parent",
      target: "asset.aws-prod",
      relationship: "investigates",
      observed_at: "2026-07-06T17:33:53Z",
      location: { zone: "aws" },
      confidence: 0.86,
      metadata: {},
    },
    {
      source: "asset.aws-prod",
      target: "threat.credential-exposure",
      relationship: "exposed_to",
      observed_at: "2026-07-06T17:36:21Z",
      location: { zone: "identity" },
      confidence: 0.78,
      metadata: {},
    },
    {
      source: "threat.credential-exposure",
      target: "finding.trust-drift",
      relationship: "supported_by",
      observed_at: "2026-07-06T17:38:07Z",
      location: { zone: "identity" },
      confidence: 0.81,
      metadata: {},
    },
    {
      source: "finding.trust-drift",
      target: "decision.revoke-trust",
      relationship: "drives",
      observed_at: "2026-07-06T17:39:11Z",
      location: { zone: "control-plane" },
      confidence: 0.88,
      metadata: {},
    },
  ],
};

test("result layout keeps the 5D KG primary with DAG context visible", async ({ page }) => {
  await page.route(`**/run/${runId}/graph/5d`, async (route) => {
    await route.fulfill({ json: kgFixture });
  });
  await page.addInitScript((entry) => {
    window.__HIVEMIND_VISUAL_RESULT__ = {
      historyId: entry.id,
      taskFull: entry.taskFull,
      payload: entry.payload,
    };
    window.localStorage.setItem("hivemind:history:v1", JSON.stringify([entry]));
  }, historyEntry);

  await page.goto("/");

  const workspace = page.getByTestId("result-graph-workspace");
  await expect(workspace).toBeVisible();
  await expect(page.getByTestId("primary-5d-kg")).toBeVisible();
  await expect(page.getByTestId("causal-dag-context")).toBeVisible();
  await expect(workspace).toContainText("5D Spatiotemporal KG");
  await expect(workspace).toContainText("Evidence DAG Context");

  await expect(workspace).toHaveScreenshot("result-graph-workspace.png", {
    animations: "disabled",
  });
});
