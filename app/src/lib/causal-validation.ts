/**
 * Pure, backend-data-only helpers for rendering causal validation state.
 *
 * Every function here is a pure function of fields the FastAPI backend
 * actually returns (`causal_graph.edges[].status/p_value/strength` from
 * `causal_discovery.py`'s `apply_discovery`, and `causal_estimate_report`
 * from `estimators.py`). Nothing in this module invents a confidence
 * percentage, a refutation score, or an evidence type — when the backend
 * hasn't provided a signal, callers get an explicit "unknown"/"unavailable"
 * state instead of a synthesized number.
 */
import type { CausalEdge, CausalEstimateReport, CausalGraph } from "./causalops-types";

// ---------------------------------------------------------------------------
// Edge validation status (causal_discovery.py: EdgeVerdict.status)
// ---------------------------------------------------------------------------

export type EdgeValidationStatus =
  | "confirmed"
  | "compatible"
  | "reversed"
  | "refuted"
  | "discovered"
  | "hypothesized";

const KNOWN_EDGE_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "compatible",
  "reversed",
  "refuted",
  "discovered",
  "hypothesized",
]);

/** Normalize a possibly-missing/unrecognized backend status to a display status. */
export function edgeValidationStatus(edge: Pick<CausalEdge, "status">): EdgeValidationStatus {
  const status = edge.status;
  return status && KNOWN_EDGE_STATUSES.has(status)
    ? (status as EdgeValidationStatus)
    : "hypothesized";
}

export interface EdgeVisualStyle {
  status: EdgeValidationStatus;
  label: string;
  shortLabel: string;
  /** Canvas/CSS-safe color for the edge. */
  color: string;
  /** react-force-graph `linkLineDash` value; null renders a solid line. */
  dash: number[] | null;
}

const EDGE_STYLE_BY_STATUS: Record<EdgeValidationStatus, Omit<EdgeVisualStyle, "status">> = {
  confirmed: {
    label: "Confirmed by independence testing",
    shortLabel: "Confirmed",
    color: "rgba(80, 220, 170, 0.9)",
    dash: null,
  },
  compatible: {
    label: "Dependence supported; hypothesis direction adopted",
    shortLabel: "Compatible",
    color: "rgba(120, 220, 255, 0.8)",
    dash: null,
  },
  discovered: {
    label: "Discovered from evidence, not originally hypothesized",
    shortLabel: "Discovered",
    color: "rgba(190, 150, 255, 0.85)",
    dash: [1, 3],
  },
  reversed: {
    label: "Direction reversed by data versus the hypothesis",
    shortLabel: "Reversed",
    color: "rgba(245, 158, 11, 0.9)",
    dash: [6, 3],
  },
  refuted: {
    label: "Refuted — variables appear independent",
    shortLabel: "Refuted",
    color: "rgba(244, 63, 94, 0.6)",
    dash: [2, 4],
  },
  hypothesized: {
    label: "Hypothesized, not yet validated",
    shortLabel: "Hypothesized",
    color: "rgba(148, 163, 184, 0.55)",
    dash: [8, 4],
  },
};

/** Visual style for one edge, derived only from the edge's own backend fields. */
export function edgeVisualStyle(edge: Pick<CausalEdge, "status">): EdgeVisualStyle {
  const status = edgeValidationStatus(edge);
  return { status, ...EDGE_STYLE_BY_STATUS[status] };
}

/**
 * Stroke width from real backend `strength` (Cramér's V, 0..1) only.
 * Returns a fixed neutral width when the backend provides no strength —
 * never synthesizes one from a hash or random source.
 */
export function edgeStrokeWidth(edge: Pick<CausalEdge, "strength">, active = false): number {
  const strength = edge.strength;
  const base =
    typeof strength === "number" && Number.isFinite(strength)
      ? 1 + Math.max(0, Math.min(1, strength)) * 2.2
      : 1.2;
  return active ? base + 1 : base;
}

/** True when at least one edge in the graph carries backend discovery output. */
export function graphDiscoveryAvailable(graph: Pick<CausalGraph, "edges">): boolean {
  return (graph.edges ?? []).some((edge) => edge.status != null);
}

/** Count real edges per validation status — no fabricated proportions. */
export function edgeStatusCounts(
  graph: Pick<CausalGraph, "edges">,
): Record<EdgeValidationStatus, number> {
  const counts: Record<EdgeValidationStatus, number> = {
    confirmed: 0,
    compatible: 0,
    discovered: 0,
    reversed: 0,
    refuted: 0,
    hypothesized: 0,
  };
  for (const edge of graph.edges ?? []) {
    counts[edgeValidationStatus(edge)] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Estimate / refutation state (estimators.py: CausalEstimateReport)
// ---------------------------------------------------------------------------

export type EstimateState =
  | "unavailable"
  | "insufficient_evidence"
  | "withheld"
  | "estimated_unrefuted"
  | "estimated_refuted_pass"
  | "estimated_refuted_fail";

export interface EstimateSummary {
  state: EstimateState;
  label: string;
  detail: string;
  /** Real refuter tally, e.g. "2/3 refuters passed" — never a synthesized percentage. */
  refuterTally: string | null;
}

/**
 * Summarize a `CausalEstimateReport` into a display state. Pure function of
 * the report's own fields (`data_mode`, `method`, `ate`, `refutation_passed`,
 * `refuters`) — never derives a numeric "refutation score".
 */
export function summarizeEstimate(
  report: CausalEstimateReport | null | undefined,
): EstimateSummary {
  if (!report) {
    return {
      state: "unavailable",
      label: "Not evaluated",
      detail: "No causal estimate report was returned for this run.",
      refuterTally: null,
    };
  }

  const method = report.method ?? "";
  const refuters = report.refuters ?? [];
  const refuterTally = refuters.length
    ? `${refuters.filter((r) => r.passed).length}/${refuters.length} refuters passed`
    : null;

  if (report.ate == null) {
    if (method.startsWith("withheld:data_quality_gates") || report.data_mode !== "empirical") {
      return {
        state: "insufficient_evidence",
        label: "Insufficient evidence",
        detail:
          report.data_mode === "synthetic_simulation"
            ? "Only synthetic evidence rows were supplied; no production estimate is produced."
            : "Evidence did not pass the data-quality gates (minimum rows, treatment/outcome variation, balance).",
        refuterTally: null,
      };
    }
    return {
      state: "withheld",
      label: "Estimate withheld",
      detail: method ? `Backend withheld estimation: ${method}` : "Estimation was withheld.",
      refuterTally: null,
    };
  }

  if (!refuters.length) {
    return {
      state: "estimated_unrefuted",
      label: "Estimated · refutation unavailable",
      detail: "An effect was estimated, but no refutation tests were recorded for it.",
      refuterTally: null,
    };
  }

  if (report.refutation_passed) {
    return {
      state: "estimated_refuted_pass",
      label: "Estimated · refutation passed",
      detail: "The estimate survived all recorded refutation tests.",
      refuterTally,
    };
  }

  return {
    state: "estimated_refuted_fail",
    label: "Estimated · refutation failed",
    detail: "At least one refutation test failed to reproduce the estimated effect.",
    refuterTally,
  };
}
