import { Library } from "lucide-react";
import { SCENARIO_LIBRARY, type ScenarioLibraryEntry } from "@/lib/scenario-builder";

interface Props {
  onPick: (entry: ScenarioLibraryEntry) => void;
}

export function ScenarioLibrary({ onPick }: Props) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        <Library className="h-3 w-3 text-[color:var(--neon-cyan)]" />
        Scenario Library · one-click structured insert
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SCENARIO_LIBRARY.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s)}
            className="group flex flex-col items-start gap-1 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left transition-all hover:border-[color:var(--neon-cyan)]/50 hover:bg-[color:var(--neon-cyan)]/[0.06]"
          >
            <div className="flex items-center gap-2">
              <span className="text-base leading-none">{s.emoji}</span>
              <span className="text-xs font-medium text-foreground/90 group-hover:text-[color:var(--neon-cyan)]">
                {s.label}
              </span>
            </div>
            <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {s.oneLiner}
            </p>
            <span className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
              {s.ttps.length} ATT&CK techniques · auto-fills 8 fields
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
