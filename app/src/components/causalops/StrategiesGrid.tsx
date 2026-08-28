import { Layers } from "lucide-react";
import { StrategyCard } from "./StrategyCard";
import type { ScoredStrategy } from "@/lib/derived-metrics";

interface StrategiesGridProps {
  ranked: ScoredStrategy[];
}

export function StrategiesGrid({ ranked }: StrategiesGridProps) {
  return (
    <section>
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-[color:var(--neon-cyan)]" aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-foreground">
            Recommended Strategies
          </h2>
          <span className="font-mono text-xs text-muted-foreground">({ranked.length})</span>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
          ranked by expected utility · EU = (1−risk) × (0.6+0.4·speed) / cost
        </div>
      </header>

      {ranked.length === 0 ? (
        <div className="panel-cinematic rounded-2xl p-8 text-center text-sm text-muted-foreground">
          No strategies returned for this run.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ranked.map((s) => (
            <StrategyCard key={`${s.strategy.title}-${s.index}`} scored={s} isTop={s.rank === 1} />
          ))}
        </div>
      )}
    </section>
  );
}
