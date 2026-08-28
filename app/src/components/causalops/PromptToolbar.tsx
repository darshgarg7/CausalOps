import { Loader2, Sparkles, SquareStack, Wand2 } from "lucide-react";
import { SCENARIO_TEMPLATES } from "@/lib/prompt-templates";
import { cn } from "@/lib/utils";

interface PromptToolbarProps {
  onTemplate: (text: string) => void;
  onToggleScaffold: () => void;
  onRefine: () => void;
  scaffoldOpen: boolean;
  refining: boolean;
  canRefine: boolean;
}

export function PromptToolbar({
  onTemplate,
  onToggleScaffold,
  onRefine,
  scaffoldOpen,
  refining,
  canRefine,
}: PromptToolbarProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          Scenarios
        </span>
        {SCENARIO_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTemplate(t.prompt)}
            className="group flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-foreground/80 transition-all hover:border-[color:var(--neon-cyan)]/40 hover:bg-[color:var(--neon-cyan)]/10 hover:text-[color:var(--neon-cyan)]"
            title={`Insert: ${t.label}`}
          >
            <span className="text-sm leading-none">{t.emoji}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleScaffold}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-all",
            scaffoldOpen
              ? "border-[color:var(--neon-violet)]/50 bg-[color:var(--neon-violet)]/15 text-[color:var(--neon-violet)]"
              : "border-white/10 bg-white/[0.03] text-foreground/80 hover:border-[color:var(--neon-violet)]/40 hover:text-[color:var(--neon-violet)]",
          )}
          title="Compose prompt from structured fields"
        >
          <SquareStack className="h-3 w-3" />
          Frame it
        </button>
        <button
          type="button"
          onClick={onRefine}
          disabled={!canRefine || refining}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-all",
            "border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 text-[color:var(--neon-cyan)]",
            "hover:border-[color:var(--neon-cyan)]/60 hover:bg-[color:var(--neon-cyan)]/20",
            (!canRefine || refining) && "cursor-not-allowed opacity-50",
          )}
          title="Tighten draft with Lovable AI"
        >
          {refining ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          Refine with AI
          <Sparkles className="h-3 w-3 opacity-70" />
        </button>
      </div>
    </div>
  );
}
