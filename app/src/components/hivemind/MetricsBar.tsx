import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  GitBranch,
  Hash,
  Minus,
  Network,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Impact } from "@/lib/hivemind-types";
import { fmt, isImpactWithheld, type DerivedMetrics } from "@/lib/derived-metrics";

interface MetricsBarProps {
  impact: Impact;
  runId: string;
  derived: DerivedMetrics;
}

function confidenceStyle(c: string) {
  const lc = c?.toLowerCase();
  if (lc === "high") {
    return {
      label: "HIGH",
      ring: "border-emerald-400/40",
      bg: "from-emerald-500/15 to-transparent",
      text: "text-emerald-300",
      stroke: "stroke-emerald-400",
      Icon: ShieldCheck,
    };
  }
  if (lc === "low") {
    return {
      label: "LOW",
      ring: "border-rose-400/40",
      bg: "from-rose-500/15 to-transparent",
      text: "text-rose-300",
      stroke: "stroke-rose-400",
      Icon: ShieldAlert,
    };
  }
  if (lc === "insufficient_data") {
    return {
      label: "NO ESTIMATE",
      ring: "border-slate-400/30",
      bg: "from-slate-500/10 to-transparent",
      text: "text-slate-300",
      stroke: "stroke-slate-400",
      Icon: ShieldAlert,
    };
  }
  return {
    label: c?.toUpperCase() || "MED",
    ring: "border-amber-400/40",
    bg: "from-amber-500/12 to-transparent",
    text: "text-amber-200",
    stroke: "stroke-amber-400",
    Icon: ShieldAlert,
  };
}

export function MetricsBar({ impact, runId, derived }: MetricsBarProps) {
  const withheld = isImpactWithheld(impact);
  const ate = impact.ate ?? 0;
  const positive = !withheld && ate > 0;
  const negative = !withheld && ate < 0;
  const TrendIcon = withheld ? Minus : positive ? ArrowUpRight : negative ? ArrowDownRight : Minus;
  const trendColor = withheld
    ? "text-muted-foreground"
    : positive
      ? "text-emerald-300"
      : negative
        ? "text-rose-300"
        : "text-muted-foreground";

  const conf = confidenceStyle(impact.confidence);
  const ConfIcon = conf.Icon;
  const reportedPValue =
    typeof impact.p_value === "number" ? `p=${impact.p_value.toPrecision(2)}` : "p unavailable";
  const methodLabel = withheld
    ? (impact.method?.replace(/^withheld:/, "withheld · ") ?? "estimate withheld")
    : impact.demo_fixture
      ? "demo SIEM fixture · patch vs lateral movement"
      : impact.method || "estimator unavailable";
  const rowCount = typeof impact.n_rows === "number" ? impact.n_rows : derived.trajectories;

  // Position of ATE on a -1..+1 scale (clamped). Used to render the marker.
  const atePos = Math.max(-1, Math.min(1, ate));
  const ateMarkerPct = ((atePos + 1) / 2) * 100;
  const ciLowPct = ((Math.max(-1, derived.ci.low) + 1) / 2) * 100;
  const ciHighPct = ((Math.min(1, derived.ci.high) + 1) / 2) * 100;

  // Confidence ring (SVG arc)
  const confRingDash = 100;
  const confRingOffset = confRingDash * (1 - derived.confidenceScore);

  return (
    <section className="grid gap-3 lg:grid-cols-12">
      {/* === ATE: hero card spanning 5 columns === */}
      <article className="panel-cinematic hm-corner relative overflow-hidden rounded-2xl p-6 lg:col-span-5">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--neon-cyan)]/70 to-transparent" />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.3em] text-[color:var(--neon-cyan)]/70">
            <Activity className="h-3 w-3" aria-hidden />
            Average Treatment Effect
          </div>
          <span className={cn("flex items-center gap-1 text-xs font-medium", trendColor)}>
            <TrendIcon className="h-3.5 w-3.5" aria-hidden />
            {withheld
              ? "no empirical estimate"
              : positive
                ? "above baseline"
                : negative
                  ? "below baseline"
                  : "neutral"}
          </span>
        </div>

        <div className="mt-5 flex items-end gap-3">
          <span
            className={cn(
              "font-mono leading-none tabular-nums text-cinematic-glow",
              withheld
                ? "text-[40px] font-medium text-muted-foreground"
                : "text-[64px] font-thin text-[color:var(--neon-cyan)]",
            )}
            aria-label={withheld ? "ATE withheld" : `ATE ${fmt.ate(ate)}`}
          >
            {fmt.ate(withheld ? null : ate)}
          </span>
          {!withheld && (
            <span className={cn("mb-2 font-mono text-sm font-medium tabular-nums", trendColor)}>
              Δ {ate >= 0 ? "+" : ""}
              {derived.deltaPct.toFixed(0)}%
            </span>
          )}
        </div>

        {/* CI band visualization */}
        <div className="mt-5">
          <div className="flex justify-between font-mono text-[9px] tracking-widest text-muted-foreground/60">
            <span>−1.0</span>
            <span>0</span>
            <span>+1.0</span>
          </div>
          <div className="relative mt-1 h-9 overflow-hidden rounded-md bg-white/[0.03] ring-1 ring-inset ring-white/5">
            {/* center axis */}
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/15" />
            {/* CI band */}
            <div
              className="absolute inset-y-2 rounded bg-gradient-to-r from-[color:var(--neon-cyan)]/20 via-[color:var(--neon-cyan)]/45 to-[color:var(--neon-cyan)]/20"
              style={{
                left: `${Math.min(ciLowPct, ciHighPct)}%`,
                width: `${Math.max(0.5, Math.abs(ciHighPct - ciLowPct))}%`,
              }}
            />
            {/* point marker */}
            <div
              className="absolute inset-y-0 w-px bg-[color:var(--neon-cyan)] shadow-[0_0_12px_oklch(0.82_0.18_200)]"
              style={{ left: `${ateMarkerPct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground/70">
            <span>
              95% CI{" "}
              <span className="text-foreground/80">
                [{derived.ci.low.toFixed(2)}, {derived.ci.high.toFixed(2)}]
              </span>
            </span>
            <span>
              {methodLabel} · n=
              <span className="text-foreground/80 tabular-nums">{rowCount}</span>
            </span>
          </div>
        </div>
      </article>

      {/* === Confidence gauge - 3 cols === */}
      <article
        className={cn(
          "panel-cinematic hm-corner relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 lg:col-span-3",
          conf.ring,
          conf.bg,
        )}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent" />
        <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground/70">
          Confidence
        </div>

        <div className="mt-4 flex items-center gap-4">
          <div className="relative h-[84px] w-[84px]">
            <svg viewBox="0 0 36 36" className="h-[84px] w-[84px] -rotate-90">
              <circle
                cx="18"
                cy="18"
                r="16"
                fill="none"
                stroke="oklch(1 0 0 / 6%)"
                strokeWidth="2.5"
              />
              <circle
                cx="18"
                cy="18"
                r="16"
                fill="none"
                strokeWidth="2.5"
                strokeDasharray={confRingDash}
                strokeDashoffset={confRingOffset}
                strokeLinecap="round"
                className={conf.stroke}
                style={{
                  transition: "stroke-dashoffset 700ms ease-out",
                  filter: "drop-shadow(0 0 6px currentColor)",
                }}
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <span className={cn("font-mono text-sm font-semibold tabular-nums", conf.text)}>
                {Math.round(derived.confidenceScore * 100)}%
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <ConfIcon className={cn("h-4 w-4", conf.text)} aria-hidden />
              <span className={cn("font-mono text-xl font-light tracking-widest", conf.text)}>
                {conf.label}
              </span>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground/80">{reportedPValue}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              ±{(derived.ci.halfWidth * 100).toFixed(1)}pp half-width
            </span>
          </div>
        </div>
      </article>

      {/* === Causal graph — 4 cols === */}
      <article className="panel-cinematic hm-corner hm-corner-violet relative overflow-hidden rounded-2xl border border-[color:var(--neon-violet)]/30 bg-gradient-to-br from-[color:var(--neon-violet)]/8 to-transparent p-6 lg:col-span-4">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--neon-violet)]/60 to-transparent" />
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-[color:var(--neon-violet)]/80">
            <Network className="mr-1.5 inline h-3 w-3" aria-hidden />
            Causal Graph
          </div>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest",
              derived.graph.acyclic
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                : "border-amber-400/40 bg-amber-500/10 text-amber-200",
            )}
          >
            {derived.graph.acyclic ? "✓ acyclic" : "⚠ cyclic"}
          </span>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          <Stat
            label="nodes"
            value={String(derived.graph.nodes).padStart(2, "0")}
            accent="text-foreground"
          />
          <Stat
            label="edges"
            value={String(derived.graph.edges).padStart(2, "0")}
            accent="text-[color:var(--neon-violet)]"
          />
          <Stat
            label="density"
            value={derived.graph.density.toFixed(2)}
            accent="text-[color:var(--neon-cyan)]"
          />
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/70">
            <span className="flex items-center gap-1">
              <GitBranch className="h-3 w-3" aria-hidden />
              max depth
            </span>
            <span className="tabular-nums text-foreground/80">{derived.graph.maxDepth}</span>
          </div>
          <div className="mt-2 grid grid-cols-8 gap-0.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "h-1 rounded",
                  i < derived.graph.maxDepth ? "bg-[color:var(--neon-violet)]" : "bg-white/5",
                )}
              />
            ))}
          </div>
        </div>
      </article>

      {/* === Run metadata strip — full width === */}
      <article className="panel-frame relative flex items-center gap-6 overflow-hidden rounded-xl px-5 py-3 lg:col-span-12">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
          <Hash className="h-3 w-3" aria-hidden />
          Run ID
        </div>
        <div className="font-mono text-xs text-foreground/90">{runId || "—"}</div>
        <div className="ml-auto flex items-center gap-5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-[color:var(--neon-cyan)]" />
            <span className="text-foreground/80 tabular-nums">{derived.ranked.length}</span>{" "}
            strategies
          </span>
          <span className="flex items-center gap-1.5">
            duration{" "}
            <span className="text-foreground/80 tabular-nums">
              {fmt.duration(derived.durationMs)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            rows <span className="text-foreground/80 tabular-nums">{rowCount}</span>
          </span>
        </div>
      </article>
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div className={cn("font-mono text-3xl font-thin tabular-nums leading-none", accent)}>
        {value}
      </div>
      <div className="mt-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
        {label}
      </div>
    </div>
  );
}
