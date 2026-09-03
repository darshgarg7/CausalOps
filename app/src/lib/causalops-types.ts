export interface Strategy {
  title: string;
  summary: string;
  risk_score: number;
  cost_score: number;
  speed_score: number;
}

export interface CausalNode {
  id: string;
  label: string;
  description?: string;
}

/**
 * `status`/`p_value`/`strength`/`validation_detail` are populated by
 * `causal_discovery.py`'s `apply_discovery` (src/causal.py's
 * `dowhy_engine_node`) after conditional-independence testing runs. They are
 * absent on graphs that never reached the estimator (e.g. discovery skipped
 * for low row counts, or an older stored run artifact).
 */
export interface CausalEdge {
  source: string;
  target: string;
  relationship: string;
  required_evidence?: string[];
  falsification_tests?: string[];
  status?: "confirmed" | "compatible" | "reversed" | "refuted" | "discovered" | "hypothesized";
  p_value?: number | null;
  strength?: number | null;
  validation_detail?: string;
}

export interface CausalGraph {
  nodes: CausalNode[];
  edges: CausalEdge[];
  treatment_variable?: string;
  outcome_variable?: string;
  candidate_confounders?: string[];
}

export interface Impact {
  ate: number | null;
  confidence: string;
  p_value?: number | null;
  ci_low?: number | null;
  ci_high?: number | null;
  n_rows?: number;
  method?: string;
  demo_fixture?: boolean;
}

/** schema.py: RefuterReport — one DoWhy refutation check result. */
export interface RefuterReport {
  name: string;
  passed: boolean;
  details: string;
}

/** schema.py: CausalDatasetProfile — quality profile of the compiled dataframe. */
export interface CausalDatasetProfile {
  data_mode?: "empirical" | "insufficient_data" | "synthetic_simulation";
  n_rows?: number;
  columns?: string[];
  treatment?: string;
  outcome?: string;
  adjustment_set?: string[];
  treated_count?: number;
  control_count?: number;
  missingness?: Record<string, number>;
  warnings?: string[];
}

/** schema.py: CausalEstimateReport — the full statistical report from estimators.py. */
export interface CausalEstimateReport {
  data_mode?: "empirical" | "insufficient_data" | "synthetic_simulation";
  method?: string;
  treatment?: string;
  outcome?: string;
  adjustment_set?: string[];
  n_rows?: number;
  ate?: number | null;
  standard_error?: number | null;
  p_value?: number | null;
  ci_low?: number | null;
  ci_high?: number | null;
  refutation_passed?: boolean;
  refuters?: RefuterReport[];
  warnings?: string[];
  dataset_profile?: CausalDatasetProfile | null;
}

export interface RunResponse {
  run_id: string;
  execution_mode?: ExecutionMode;
  strategies: Strategy[];
  ranked_strategies?: unknown[];
  final_recommendation?: string | null;
  evaluator_error?: string | null;
  causal_graph: CausalGraph;
  impact: Impact;
  causal_estimate_report?: CausalEstimateReport;
  causal_dataset_profile?: CausalDatasetProfile;
  agent_tier_metrics?: unknown;
  agent_evolution_report?: unknown;
  policy_optimization_report?: unknown;
}

export type ExecutionMode = "standard" | "deep";

export interface RunEnqueueResponse {
  run_id: string;
  status: "queued" | "running" | "completed" | "failed";
}

export interface RunStatusResponse {
  run_id: string;
  status: "queued" | "running" | "completed" | "failed";
  error?: string;
  artifact?: RunResponse;
}

export type EnqueueResult =
  | { mode: "async"; run_id: string; status: "queued" }
  | { mode: "sync"; run_id: string; artifact: RunResponse };

export interface HistoryEntry {
  id: string;
  runId: string;
  timestamp: number;
  taskExcerpt: string;
  taskFull: string;
  ate: number | null;
  confidence: string;
  strategyCount: number;
  payload: RunResponse;
}

export type ExecutionPhaseStatus = "queued" | "running" | "done" | "error";

export interface ExecutionEvent {
  id: string;
  phase: string;
  message: string;
  status: ExecutionPhaseStatus;
  ts: number;
  durationMs?: number;
}
