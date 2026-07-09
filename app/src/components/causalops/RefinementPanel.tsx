import { Check, Lightbulb, Sparkles, X } from "lucide-react";
import { useState } from "react";
import type { RefinementSuggestion } from "@/lib/scenario-builder";
import { cn } from "@/lib/utils";

interface Props {
  suggestions: RefinementSuggestion[];
  onAccept: (s: RefinementSuggestion) => void;
}

const kindLabel: Record<RefinementSuggestion["kind"], { label: string; tone: string }> = {
  "add-ttp": { label: "ADD TTP", tone: "text-rose-300 border-rose-400/40 bg-rose-500/10" },
  "strengthen-field": {
    label: "STRENGTHEN",
    tone: "text-amber-300 border-amber-400/40 bg-amber-500/10",
  },
  "alt-strategy": {
    label: "ALT STRATEGY",
    tone: "text-violet-300 border-violet-400/40 bg-violet-500/10",
  },
  "missing-assumption": {
    label: "GAP",
    tone: "text-cyan-300 border-cyan-400/40 bg-cyan-500/10",
  },
};

export function RefinementPanel({ suggestions, onAccept }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visible = suggestions.filter((s) => !dismissed.has(s.id));

  if (visible.length === 0) return null;

  return (
    <div className="rounded-xl border border-[color:var(--neon-cyan)]/25 bg-[color:var(--neon-cyan)]/[0.04] p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-[color:var(--neon-cyan)]" />
        <h4 className="font-mono text-[10px] uppercase tracking-[0.25em] text-[color:var(--neon-cyan)]">
          Refine Scenario · {visible.length} explainable suggestion{visible.length === 1 ? "" : "s"}
        </h4>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          analyst-first · click to accept
        </span>
      </div>
      <div className="space-y-2">
        {visible.map((s) => {
          const k = kindLabel[s.kind];
          return (
            <div key={s.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={cn(
                    "rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wider",
                    k.tone,
                  )}
                >
                  {k.label}
                </span>
                <span className="text-xs font-medium text-foreground/90">{s.title}</span>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">{s.detail}</p>
              <div className="flex items-start gap-1.5 rounded-md border border-amber-400/20 bg-amber-500/[0.04] p-2 text-[10px] text-amber-200/90">
                <Lightbulb className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                <span className="leading-snug">
                  <span className="font-mono uppercase tracking-wider text-amber-300/80">
                    why ·{" "}
                  </span>
                  {s.rationale}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setDismissed((p) => new Set(p).add(s.id))}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                >
                  <X className="h-2.5 w-2.5" />
                  Dismiss
                </button>
                {s.apply && (
                  <button
                    type="button"
                    onClick={() => {
                      onAccept(s);
                      setDismissed((p) => new Set(p).add(s.id));
                    }}
                    className="flex items-center gap-1 rounded-md border border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 px-2 py-1 text-[10px] font-medium text-[color:var(--neon-cyan)] hover:bg-[color:var(--neon-cyan)]/20"
                  >
                    <Check className="h-2.5 w-2.5" />
                    Accept
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
