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

export interface CausalEdge {
  source: string;
  target: string;
  relationship: string;
  required_evidence?: string[];
  falsification_tests?: string[];
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

export interface RunResponse {
  run_id: string;
  execution_mode?: ExecutionMode;
  strategies: Strategy[];
  ranked_strategies?: unknown[];
  final_recommendation?: string | null;
  evaluator_error?: string | null;
  causal_graph: CausalGraph;
  impact: Impact;
  causal_estimate_report?: unknown;
  causal_dataset_profile?: unknown;
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
