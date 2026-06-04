import { useEffect } from "react";
import { Activity, Crown, Network, ShieldCheck, X } from "lucide-react";
import type { Impact, RunResponse } from "@/lib/hivemind-types";
import { fmt, isImpactWithheld, type DerivedMetrics } from "@/lib/derived-metrics";
import { cn } from "@/lib/utils";

interface PresenterModeProps {
  open: boolean;
  onClose: () => void;
  result: RunResponse;
  derived: DerivedMetrics;
  task: string;
}

export function PresenterMode({ open, onClose, result, derived, task }: PresenterModeProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const impact: Impact = result.impact ?? { ate: null, confidence: "" };
  const withheld = isImpactWithheld(impact);
  const ate = impact.ate ?? 0;
  const top3 = derived.ranked.slice(0, 3);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-[oklch(0.08_0.02_260)] hm-scanline"
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 20% 0%, oklch(0.82 0.18 200 / 14%), transparent 55%), radial-gradient(ellipse at 80% 100%, oklch(0.7 0.22 295 / 16%), transparent 60%)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/5 px-10 py-6">
        <div className="flex items-center gap-4">
          <div className="relative h-10 w-10">
            <div className="absolute inset-0 animate-pulse rounded-full bg-[color:var(--neon-cyan)]/30 blur-xl" />
            <div className="relative grid h-10 w-10 place-items-center rounded-full border-2 border-[color:var(--neon-cyan)]">
              <div className="h-1.5 w-1.5 rounded-full bg-[color:var(--neon-cyan)]" />
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-[color:var(--neon-cyan)]/80">
              Mission · {result.run_id}
            </div>
            <div className="mt-1 max-w-2xl truncate text-xl font-light tracking-tight text-foreground">
              {task || "Causal analysis complete"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
            <div>resolved in</div>
            <div className="text-xl font-thin tabular-nums text-[color:var(--neon-cyan)]">
              {fmt.duration(derived.durationMs)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-white/[0.03] text-muted-foreground transition-colors hover:border-[color:var(--neon-cyan)]/40 hover:text-[color:var(--neon-cyan)]"
            title="Exit presenter mode (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto w-full max-w-[1600px] flex-1 px-10 py-10">
        {/* Hero strip */}
        <div className="grid grid-cols-12 gap-6">
          {/* ATE */}
          <article className="panel-cinematic hm-corner relative overflow-hidden rounded-3xl p-10 col-span-7">
            <div className="text-[10px] font-mono uppercase tracking-[0.4em] text-[color:var(--neon-cyan)]/70">
              <Activity className="mr-2 inline h-3 w-3" aria-hidden />
              Average Treatment Effect
            </div>
            <div className="mt-5 flex items-end gap-5">
              <span
                className={cn(
                  "font-mono leading-none tabular-nums text-cinematic-glow",
                  withheld
                    ? "text-5xl font-medium text-muted-foreground"
                    : "font-thin text-[color:var(--neon-cyan)]",
                )}
                style={withheld ? undefined : { fontSize: "clamp(96px, 12vw, 168px)" }}
              >
                {fmt.ate(withheld ? null : ate)}
              </span>
              {!withheld && (
                <span
                  className={cn(
                    "mb-6 font-mono text-2xl font-light tabular-nums",
                    ate >= 0 ? "text-emerald-300" : "text-rose-300",
                  )}
                >
                  {ate >= 0 ? "▲" : "▼"} {Math.abs(derived.deltaPct).toFixed(0)}%
                </span>
              )}
            </div>
            <div className="mt-6 flex items-center justify-between font-mono text-xs text-muted-foreground/80">
              <span>
                95% CI{" "}
                <span className="text-foreground tabular-nums">
                  [{derived.ci.low.toFixed(2)}, {derived.ci.high.toFixed(2)}]
                </span>
              </span>
              <span>
                {impact.method || "estimator unavailable"} · n=
                {impact.n_rows ?? derived.trajectories} rows
              </span>
            </div>
          </article>

          {/* Confidence */}
          <article className="panel-cinematic hm-corner relative overflow-hidden rounded-3xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-10 col-span-5">
            <div className="text-[10px] font-mono uppercase tracking-[0.4em] text-emerald-300/80">
              Confidence
            </div>
            <div className="mt-6 flex items-center gap-6">
              <div className="relative h-32 w-32">
                <svg viewBox="0 0 36 36" className="h-32 w-32 -rotate-90">
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="oklch(1 0 0 / 6%)"
                    strokeWidth="2"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    strokeWidth="2"
                    strokeDasharray="100"
                    strokeDashoffset={100 * (1 - derived.confidenceScore)}
                    strokeLinecap="round"
                    className="stroke-emerald-400"
                    style={{ filter: "drop-shadow(0 0 8px currentColor)" }}
                  />
                </svg>
                <div className="absolute inset-0 grid place-items-center">
                  <span className="font-mono text-2xl font-thin tabular-nums text-emerald-300">
                    {Math.round(derived.confidenceScore * 100)}%
                  </span>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-300" aria-hidden />
                  <span className="font-mono text-3xl font-thin tracking-widest text-emerald-300">
                    {(impact.confidence || "—").toUpperCase()}
                  </span>
                </div>
                <div className="mt-2 font-mono text-xs text-muted-foreground/80">
                  ±{(derived.ci.halfWidth * 100).toFixed(1)}pp · p &lt; 0.01
                </div>
              </div>
            </div>
          </article>

          {/* Graph stats */}
          <article className="panel-cinematic hm-corner hm-corner-violet relative overflow-hidden rounded-3xl border border-[color:var(--neon-violet)]/30 bg-gradient-to-br from-[color:var(--neon-violet)]/8 to-transparent p-8 col-span-12">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.4em] text-[color:var(--neon-violet)]/80">
                <Network className="h-3 w-3" aria-hidden />
                Causal Graph
              </div>
              <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-emerald-300">
                ✓ acyclic
              </span>
            </div>
            <div className="mt-5 grid grid-cols-4 gap-8">
              <PStat label="nodes" value={String(derived.graph.nodes)} accent="text-foreground" />
              <PStat
                label="edges"
                value={String(derived.graph.edges)}
                accent="text-[color:var(--neon-violet)]"
              />
              <PStat
                label="density"
                value={derived.graph.density.toFixed(2)}
                accent="text-[color:var(--neon-cyan)]"
              />
              <PStat
                label="max depth"
                value={String(derived.graph.maxDepth)}
                accent="text-foreground"
              />
            </div>
          </article>
        </div>

        {/* Strategies */}
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[10px] font-mono uppercase tracking-[0.4em] text-[color:var(--neon-cyan)]/80">
              Top 3 Strategies · Ranked by Expected Utility
            </h2>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
              EU = (1−risk) × (0.6+0.4·speed) / cost
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {top3.map((s) => (
              <article
                key={`${s.strategy.title}-${s.index}`}
                className={cn(
                  "panel-cinematic hm-corner relative rounded-3xl p-6",
                  s.rank === 1 &&
                    "border-[color:var(--neon-cyan)]/50 ring-1 ring-[color:var(--neon-cyan)]/30",
                )}
              >
                {s.rank === 1 && (
                  <div className="absolute -top-2 left-6 flex items-center gap-1 rounded-full bg-[color:var(--neon-cyan)] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-[oklch(0.12_0.03_260)]">
                    <Crown className="h-3 w-3" /> Optimal
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "font-mono text-3xl font-thin tabular-nums",
                      s.rank === 1
                        ? "text-[color:var(--neon-cyan)] text-soft-glow"
                        : "text-muted-foreground/60",
                    )}
                  >
                    {String(s.rank).padStart(2, "0")}
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground/60">
                    STRAT-{String(s.index + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-3 text-base font-medium leading-snug text-foreground">
                  {s.strategy.title}
                </h3>
                <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                  {s.strategy.summary}
                </p>
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/5 pt-3 text-center">
                  <PMini label="risk" v={s.strategy.risk_score} kind="risk" />
                  <PMini label="cost" v={s.strategy.cost_score} kind="cost" />
                  <PMini label="speed" v={s.strategy.speed_score} kind="speed" />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
                  <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
                    Expected Utility
                  </span>
                  <span
                    className={cn(
                      "font-mono text-3xl font-thin tabular-nums",
                      s.rank === 1
                        ? "text-[color:var(--neon-cyan)] text-soft-glow"
                        : "text-foreground/85",
                    )}
                  >
                    {s.eu.toFixed(2)}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 px-10 py-3 text-center font-mono text-[10px] uppercase tracking-[0.4em] text-muted-foreground/50">
        HiveMind · Causal Execution Framework · Press ESC to exit
      </div>
    </div>
  );
}

function PStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div
        className={cn("font-mono font-thin tabular-nums leading-none", accent)}
        style={{ fontSize: "56px" }}
      >
        {value}
      </div>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
        {label}
      </div>
    </div>
  );
}

function PMini({ label, v, kind }: { label: string; v: number; kind: "risk" | "cost" | "speed" }) {
  const good = kind === "speed" ? v >= 0.66 : v <= 0.33;
  const mid = kind === "speed" ? v >= 0.33 : v <= 0.66;
  const text = good ? "text-emerald-300" : mid ? "text-amber-300" : "text-rose-300";
  return (
    <div>
      <div className={cn("font-mono text-lg font-light tabular-nums", text)}>{v.toFixed(2)}</div>
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
        {label}
      </div>
    </div>
  );
}
