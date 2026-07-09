import { Crown, DollarSign, Gauge, ShieldAlert, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, type ScoredStrategy } from "@/lib/derived-metrics";

interface StrategyCardProps {
  scored: ScoredStrategy;
  isTop: boolean;
}

function metricTone(value: number, kind: "risk" | "cost" | "speed") {
  // For risk/cost: lower is better. For speed: higher is better.
  const good = kind === "speed" ? value >= 0.66 : value <= 0.33;
  const mid = kind === "speed" ? value >= 0.33 : value <= 0.66;
  if (good) return { text: "text-emerald-300", bar: "bg-emerald-400" };
  if (mid) return { text: "text-amber-300", bar: "bg-amber-400" };
  return { text: "text-rose-300", bar: "bg-rose-400" };
}

function MetricRow({
  label,
  value,
  icon: Icon,
  kind,
}: {
  label: string;
  value: number;
  icon: typeof ShieldAlert;
  kind: "risk" | "cost" | "speed";
}) {
  const tone = metricTone(value, kind);
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </span>
        <span className={cn("font-mono text-sm tabular-nums", tone.text)}>{fmt.score(value)}</span>
      </div>
      <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={cn("h-full rounded-full transition-all duration-700", tone.bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function StrategyCard({ scored, isTop }: StrategyCardProps) {
  const { strategy: s, rank, eu, pareto } = scored;

  return (
    <article
      className={cn(
        "panel-cinematic hm-corner group relative flex flex-col overflow-hidden rounded-2xl p-6 transition-all duration-300",
        isTop
          ? "border-[color:var(--neon-cyan)]/50 ring-1 ring-[color:var(--neon-cyan)]/30 hover:-translate-y-0.5"
          : "hover:-translate-y-0.5 hover:border-[color:var(--neon-cyan)]/30",
      )}
    >
      {isTop && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px shimmer-bar"
          aria-hidden
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "font-mono text-2xl font-thin tabular-nums leading-none",
              isTop ? "text-[color:var(--neon-cyan)] text-soft-glow" : "text-muted-foreground/60",
            )}
          >
            {String(rank).padStart(2, "0")}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground/60">
            STRAT-{String(scored.index + 1).padStart(2, "0")}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          {isTop && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--neon-cyan)] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[oklch(0.12_0.03_260)]">
              <Crown className="h-2.5 w-2.5" aria-hidden /> Optimal
            </span>
          )}
          {pareto && !isTop && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--neon-violet)]/40 bg-[color:var(--neon-violet)]/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-[color:var(--neon-violet)]">
              Pareto
            </span>
          )}
        </div>
      </div>

      <h3 className="mt-4 text-base font-medium leading-snug text-foreground">{s.title}</h3>
      <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{s.summary}</p>

      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-white/5 pt-4">
        <MetricRow label="Risk" value={s.risk_score} icon={ShieldAlert} kind="risk" />
        <MetricRow label="Cost" value={s.cost_score} icon={DollarSign} kind="cost" />
        <MetricRow label="Speed" value={s.speed_score} icon={Gauge} kind="speed" />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
        <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
          <Sparkles className="h-3 w-3" aria-hidden />
          Expected Utility
        </span>
        <span
          className={cn(
            "font-mono text-2xl font-thin tabular-nums",
            isTop ? "text-[color:var(--neon-cyan)] text-soft-glow" : "text-foreground/85",
          )}
        >
          {eu.toFixed(2)}
        </span>
      </div>
    </article>
  );
}
