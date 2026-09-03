import { z } from "zod";
import type { RunResponse } from "./causalops-types";

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
  description: z.string().optional(),
});

// causal_discovery.py: EdgeVerdict.status — the six verdicts apply_discovery
// can write onto a graph edge. Present only after discovery runs (see
// graphDiscoveryAvailable() in causal-validation.ts for the absent case).
export const EdgeValidationStatusSchema = z.enum([
  "confirmed",
  "compatible",
  "reversed",
  "refuted",
  "discovered",
  "hypothesized",
]);

export const CausalEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relationship: z.string(),
  required_evidence: z.array(z.string()).optional(),
  falsification_tests: z.array(z.string()).optional(),
  status: EdgeValidationStatusSchema.optional(),
  p_value: z.number().finite().nullable().optional(),
  strength: z.number().finite().nullable().optional(),
  validation_detail: z.string().optional(),
});

export const CausalGraphSchema = z.object({
  nodes: z.array(CausalNodeSchema),
  edges: z.array(CausalEdgeSchema),
  treatment_variable: z.string().optional(),
  outcome_variable: z.string().optional(),
  candidate_confounders: z.array(z.string()).optional(),
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

// schema.py: RefuterReport — one DoWhy refutation check (estimators.py's
// _run_refuters). `passed` is a real boolean; there is no numeric score.
export const RefuterReportSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  details: z.string(),
});

const DataModeSchema = z.enum(["empirical", "insufficient_data", "synthetic_simulation"]);

// schema.py: CausalDatasetProfile — quality profile of the compiled
// dataframe (dataset_compiler.py's compile_evidence_dataset).
export const CausalDatasetProfileSchema = z.object({
  data_mode: DataModeSchema.optional(),
  n_rows: z.number().int().nonnegative().optional(),
  columns: z.array(z.string()).optional(),
  treatment: z.string().optional(),
  outcome: z.string().optional(),
  adjustment_set: z.array(z.string()).optional(),
  treated_count: z.number().int().nonnegative().optional(),
  control_count: z.number().int().nonnegative().optional(),
  missingness: z.record(z.string(), z.number()).optional(),
  warnings: z.array(z.string()).optional(),
});

// schema.py: CausalEstimateReport — the full statistical report returned by
// estimators.py's estimate_causal_effect. All fields are optional here (not
// just where schema.py marks them optional) so older stored run artifacts
// and partial fixtures keep parsing instead of failing closed on drift that
// only affects fields this UI doesn't render yet.
export const CausalEstimateReportSchema = z.object({
  data_mode: DataModeSchema.optional(),
  method: z.string().optional(),
  treatment: z.string().optional(),
  outcome: z.string().optional(),
  adjustment_set: z.array(z.string()).optional(),
  n_rows: z.number().int().nonnegative().optional(),
  ate: z.number().finite().nullable().optional(),
  standard_error: z.number().finite().nullable().optional(),
  p_value: z.number().finite().nullable().optional(),
  ci_low: z.number().finite().nullable().optional(),
  ci_high: z.number().finite().nullable().optional(),
  refutation_passed: z.boolean().optional(),
  refuters: z.array(RefuterReportSchema).optional(),
  warnings: z.array(z.string()).optional(),
  dataset_profile: CausalDatasetProfileSchema.nullable().optional(),
});

export const RunResponseSchema = z.object({
  run_id: z.string().min(1),
  execution_mode: z.enum(["standard", "deep"]).optional(),
  strategies: z.array(StrategySchema),
  ranked_strategies: z.array(z.unknown()).optional(),
  final_recommendation: z.string().nullable().optional(),
  evaluator_error: z.string().nullable().optional(),
  causal_graph: CausalGraphSchema,
  impact: ImpactSchema,
  causal_estimate_report: CausalEstimateReportSchema.optional(),
  causal_dataset_profile: CausalDatasetProfileSchema.optional(),
  agent_tier_metrics: z.unknown().optional(),
  agent_evolution_report: z.unknown().optional(),
  policy_optimization_report: z.unknown().optional(),
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
