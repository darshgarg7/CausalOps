import { z } from "zod";
import type { RunResponse } from "./hivemind-types";

export const StrategySchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  risk_score: z.number().min(0).max(1),
  cost_score: z.number().min(0).max(1),
  speed_score: z.number().min(0).max(1),
});

export const CausalNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
});

export const CausalEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relationship: z.string(),
});

export const CausalGraphSchema = z.object({
  nodes: z.array(CausalNodeSchema),
  edges: z.array(CausalEdgeSchema),
});

export const ImpactSchema = z.object({
  ate: z.number().finite().nullable(),
  confidence: z.string().min(1),
  p_value: z.number().finite().nullable().optional(),
  ci_low: z.number().finite().nullable().optional(),
  ci_high: z.number().finite().nullable().optional(),
  n_rows: z.number().int().nonnegative().optional(),
  method: z.string().optional(),
  demo_fixture: z.boolean().optional(),
});

export const RunResponseSchema = z.object({
  run_id: z.string().min(1),
  strategies: z.array(StrategySchema),
  ranked_strategies: z.array(z.unknown()).optional(),
  final_recommendation: z.string().nullable().optional(),
  evaluator_error: z.string().nullable().optional(),
  causal_graph: CausalGraphSchema,
  impact: ImpactSchema,
  causal_estimate_report: z.unknown().optional(),
  causal_dataset_profile: z.unknown().optional(),
  agent_tier_metrics: z.unknown().optional(),
});

export interface SchemaIssue {
  path: string;
  message: string;
  code: string;
}

export class SchemaValidationError extends Error {
  issues: SchemaIssue[];
  raw: unknown;

  constructor(issues: SchemaIssue[], raw: unknown) {
    super(`Backend response failed validation: ${issues.length} issue(s)`);
    this.name = "SchemaValidationError";
    this.issues = issues;
    this.raw = raw;
  }
}

export function parseRunResponse(raw: unknown): RunResponse {
  const artifact = extractRunArtifact(raw);
  const result = RunResponseSchema.safeParse(artifact);
  if (!result.success) {
    const issues: SchemaIssue[] = result.error.issues.map((i) => ({
      path: i.path.length ? i.path.map(String).join(".") : "(root)",
      message: i.message,
      code: i.code,
    }));
    throw new SchemaValidationError(issues, raw);
  }
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize async GET envelopes and reject enqueue-only payloads before Zod. */
export function extractRunArtifact(raw: unknown): unknown {
  if (!isRecord(raw)) {
    throw new SchemaValidationError(
      [{ path: "(root)", message: "Expected object", code: "invalid_type" }],
      raw,
    );
  }

  if ("strategies" in raw && "causal_graph" in raw && "impact" in raw) {
    return raw;
  }

  if ("artifact" in raw && isRecord(raw.artifact)) {
    return raw.artifact;
  }

  if (raw.status === "queued" || raw.status === "running") {
    throw new Error(
      "Received run status instead of a completed artifact. " +
        "Wait for the execution stream to finish, then fetch GET /run/{run_id}.",
    );
  }

  return raw;
}
