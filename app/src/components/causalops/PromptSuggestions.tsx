import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { analyzePrompt, type PromptSuggestion } from "@/lib/prompt-analyzer";

interface PromptSuggestionsProps {
  text: string;
  onApply: (insert: string) => void;
}

export function PromptSuggestions({ text, onApply }: PromptSuggestionsProps) {
  const [debounced, setDebounced] = useState(text);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 600);
    return () => clearTimeout(t);
  }, [text]);

  const suggestions: PromptSuggestion[] = analyzePrompt(debounced).filter(
    (s) => !dismissed.has(s.id),
  );

  if (suggestions.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-amber-300/80">
        <Lightbulb className="h-3 w-3" />
        Missing
      </span>
      {suggestions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => {
            onApply(s.insert);
            setDismissed((prev) => new Set(prev).add(s.id));
          }}
          className="group flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/[0.06] px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:border-amber-400/50 hover:bg-amber-400/15"
          title={s.hint}
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setDismissed(new Set(suggestions.map((s) => s.id)))}
        className="text-[10px] text-muted-foreground/60 hover:text-foreground"
      >
        dismiss
      </button>
    </div>
  );
}
