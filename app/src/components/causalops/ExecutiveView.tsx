import { AlertTriangle, ArrowRight, ShieldCheck, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { buildKillChain, type ScenarioState } from "@/lib/scenario-builder";
import type { RunResponse } from "@/lib/causalops-types";
import { isImpactWithheld, type DerivedMetrics } from "@/lib/derived-metrics";
import type { ObservabilityTrace } from "@/lib/agent-runtime";
import { ExecutiveCausalCompact } from "./ExecutiveCausalCompact";
import { cn } from "@/lib/utils";

interface Props {
  fields: ScenarioState;
  ttps: string[];
  result: RunResponse | null;
  derived: DerivedMetrics | null;
  observability?: ObservabilityTrace | null;
}

/** Executive Mode: condensed narrative + risk heatmap + recommended action. */
export function ExecutiveView({ fields, ttps, result, derived, observability }: Props) {
  const chain = useMemo(() => buildKillChain(fields, ttps), [fields, ttps]);

  // Risk heuristic (5x5 likelihood × impact)
  const likelihood = useMemo(() => {
    let score = 2;
    if (chain.blindSpots >= 2) score += 2;
    else if (chain.blindSpots >= 1) score += 1;
    if (/0[- ]?day|zero[- ]?day|unauth/i.test(fields.vector)) score += 1;
    if (/insider|departing|privileged/i.test(fields.actor)) score += 1;
    return Math.min(5, Math.max(1, score));
  }, [chain.blindSpots, fields.vector, fields.actor]);

  const impact = useMemo(() => {
    let score = 2;
    if (/ransomware|encrypt|destroy/i.test(fields.objective)) score += 2;
    if (/pii|customer data|regulatory|gdpr|sec/i.test(fields.impact + fields.asset)) score += 1;
    if (/board|disclosure|outage/i.test(fields.impact)) score += 1;
    return Math.min(5, Math.max(1, score));
  }, [fields.objective, fields.impact, fields.asset]);

  const riskScore = likelihood * impact;
  const riskLabel =
    riskScore >= 18 ? "CRITICAL" : riskScore >= 12 ? "HIGH" : riskScore >= 6 ? "MEDIUM" : "LOW";
  const riskTone =
    riskScore >= 18
      ? "border-rose-400/50 bg-rose-500/15 text-rose-200"
      : riskScore >= 12
        ? "border-amber-400/50 bg-amber-500/15 text-amber-200"
        : riskScore >= 6
          ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
          : "border-emerald-400/50 bg-emerald-500/15 text-emerald-200";

  const dwellLabel =
    chain.totalDwellHours >= 24
      ? `${(chain.totalDwellHours / 24).toFixed(1)} days`
      : `${chain.totalDwellHours.toFixed(1)} hours`;

  // Top 3 mitigations from chain
  const topMitigations = chain.steps.slice(0, 3).map((s) => ({
    label: s.technique.mitigation.split(",")[0].trim(),
    forStep: `${s.technique.id} ${s.technique.name}`,
  }));

  // Recommended action: prefer engine top strategy if available
  const topStrategy = derived?.ranked?.[0]?.strategy;
  const recommendedAction =
    topStrategy?.summary ??
    topStrategy?.title ??
    "Activate containment playbook against highest-EU strategy";

  return (
    <div className="space-y-5">
      {/* Threat narrative */}
      <section className="panel-cinematic hm-corner rounded-2xl p-6">
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          <ShieldCheck className="h-3 w-3 text-[color:var(--neon-cyan)]" />
          Executive Threat Narrative
        </div>
        <p className="text-base leading-relaxed text-foreground/95 sm:text-lg">
          {buildNarrative(fields, ttps.length, chain.totalDwellHours)}
        </p>
      </section>

      {/* Risk + Dwell + Top strategy */}
      <section className="grid gap-3 md:grid-cols-3">
        <div className={cn("rounded-2xl border p-5", riskTone)}>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-80">
            Composite Risk
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-4xl font-semibold tabular-nums">{riskScore}</span>
            <span className="font-mono text-xs uppercase tracking-wider opacity-80">/ 25</span>
          </div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em]">{riskLabel}</div>
          <div className="mt-2 text-[10px] opacity-80">
            Likelihood {likelihood} · Impact {impact}
          </div>
        </div>

        <div className="panel-frame rounded-2xl p-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Time-to-Impact (est.)
          </div>
          <div className="mt-1 font-mono text-3xl tabular-nums text-[color:var(--neon-cyan)]">
            {dwellLabel}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {chain.steps.length} chain steps · {chain.detectionPoints} detection point
            {chain.detectionPoints === 1 ? "" : "s"} · {chain.blindSpots} blind
          </div>
        </div>

        <div className="panel-frame rounded-2xl p-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Engine top strategy
          </div>
          {derived && result ? (
            <>
              <div className="mt-1 font-mono text-2xl tabular-nums text-foreground">
                {isImpactWithheld(result.impact)
                  ? "ATE withheld"
                  : `ATE ${result.impact.ate?.toFixed(2) ?? "—"}`}
              </div>
              <div className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
                {derived.ranked[0].strategy.title}
              </div>
            </>
          ) : (
            <p className="mt-1 text-[12px] text-muted-foreground">
              Run the engine to see ranked strategies.
            </p>
          )}
        </div>
      </section>

      {/* Risk heatmap */}
      <section className="panel-frame rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-[color:var(--neon-cyan)]" />
          <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground/90">
            Likelihood × Impact heatmap
          </h3>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            5×5 — your scenario marked
          </span>
        </div>
        <Heatmap likelihood={likelihood} impact={impact} />
      </section>

      {/* Top mitigations + Recommended action */}
      <section className="grid gap-3 md:grid-cols-[1fr_320px]">
        <div className="panel-frame rounded-2xl p-5">
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-foreground/90">
            Top defensive moves
          </h3>
          {topMitigations.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              Map MITRE techniques to see recommended mitigations.
            </p>
          ) : (
            <ol className="space-y-2">
              {topMitigations.map((m, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 font-mono text-[10px] tabular-nums text-[color:var(--neon-cyan)]">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-sm text-foreground/95">{m.label}</p>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      addresses {m.forStep}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="panel-cinematic glow-primary rounded-2xl p-5">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--neon-cyan)]">
            Recommended Action
          </div>
          <div className="mb-3 space-y-2">
            {recommendedAction
              .split(". ")
              .filter((s) => s.trim().length > 0)
              .map((sentence, idx) => {
                const text = sentence.trim().endsWith(".") ? sentence : sentence + ".";
                return (
                  <div
                    key={idx}
                    className="flex items-start gap-2 text-sm leading-relaxed text-foreground"
                  >
                    <span className="text-[color:var(--neon-cyan)] select-none mt-0.5">•</span>
                    <span>{text}</span>
                  </div>
                );
              })}
          </div>
          {result && (
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Run {result.run_id}</span>
              <ArrowRight className="h-2.5 w-2.5" />
              <span>{result.strategies?.length ?? 0} ranked options</span>
            </div>
          )}
        </div>
      </section>

      {result && (
        <ExecutiveCausalCompact
          graph={result.causal_graph ?? { nodes: [], edges: [] }}
          trace={observability ?? null}
        />
      )}

      {chain.blindSpots > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="leading-snug">
            Defensive posture has <strong>{chain.blindSpots}</strong> uncovered chain step
            {chain.blindSpots > 1 ? "s" : ""}. Recommend addressing detection gaps before next
            exercise.
          </span>
        </div>
      )}
    </div>
  );
}

function buildNarrative(s: ScenarioState, ttpCount: number, dwell: number): string {
  const actor = s.actor.trim() || "An external attacker";
  const asset = s.asset.trim() || "in-scope production assets";
  const vector = s.vector.trim() || "an unspecified entry vector";
  const objective = s.objective.trim() || "compromise of the target";
  const dwellLabel = dwell >= 24 ? `${(dwell / 24).toFixed(1)} days` : `~${dwell.toFixed(0)} hours`;
  return `${actor} targets ${asset} via ${vector}. The intended outcome is ${objective.toLowerCase()}. Modeled chain spans ${ttpCount} ATT&CK techniques over an estimated ${dwellLabel} of dwell before impact.`;
}

function Heatmap({ likelihood, impact }: { likelihood: number; impact: number }) {
  const cells: { l: number; i: number; tone: string }[] = [];
  for (let i = 5; i >= 1; i--) {
    for (let l = 1; l <= 5; l++) {
      const score = l * i;
      const tone =
        score >= 18
          ? "bg-rose-500/35"
          : score >= 12
            ? "bg-amber-500/30"
            : score >= 6
              ? "bg-cyan-500/25"
              : "bg-emerald-500/20";
      cells.push({ l, i, tone });
    }
  }
  return (
    <div className="flex gap-3">
      {/* Y axis */}
      <div className="flex flex-col-reverse justify-between py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        <span>Impact 1</span>
        <span>2</span>
        <span>3</span>
        <span>4</span>
        <span>5</span>
      </div>
      <div className="flex-1">
        <div className="grid grid-cols-5 gap-1">
          {cells.map(({ l, i, tone }) => {
            const active = l === likelihood && i === impact;
            return (
              <div
                key={`${l}-${i}`}
                className={cn(
                  "relative flex aspect-[2/1] items-center justify-center rounded border border-white/5 font-mono text-[10px] tabular-nums",
                  tone,
                  active &&
                    "ring-2 ring-[color:var(--neon-cyan)] ring-offset-2 ring-offset-transparent",
                )}
              >
                <span className={active ? "text-foreground" : "text-foreground/50"}>{l * i}</span>
                {active && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-[color:var(--neon-cyan)] shadow-[0_0_8px_var(--neon-cyan)]" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-1 grid grid-cols-5 gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className="text-center">
              {n === 1 ? "Likelihood 1" : n}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
