import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { refinePrompt } from "@/lib/refine-prompt.functions";
import { cn } from "@/lib/utils";
import { PromptToolbar } from "./PromptToolbar";
import { PromptScaffold } from "./PromptScaffold";
import { PromptSuggestions } from "./PromptSuggestions";
import { RefineDialog } from "./RefineDialog";

interface InputPanelProps {
  loading: boolean;
  onSubmit: (taskDescription: string) => void;
}

export interface InputPanelHandle {
  setValue: (text: string) => void;
  focus: () => void;
}

const PLACEHOLDER =
  "Describe the event space — what happened, when, target asset, suspected actor, observable indicators, the decision you must make, and the business constraint that bounds it. Tip: use a Scenario chip above to start from a battle-tested template.";

export const InputPanel = forwardRef<InputPanelHandle, InputPanelProps>(function InputPanel(
  { loading, onSubmit },
  ref,
) {
  const [value, setValue] = useState("");
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refined, setRefined] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const refineFn = useServerFn(refinePrompt);

  useImperativeHandle(ref, () => ({
    setValue: (text: string) => {
      setValue(text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    focus: () => textareaRef.current?.focus(),
  }));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Event space description is required.");
      textareaRef.current?.focus();
      return;
    }
    onSubmit(trimmed);
  };

  const insertText = (text: string) => {
    setValue((prev) => (prev.trim() ? prev.replace(/\n+$/, "") + "\n\n" + text : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const replaceText = (text: string) => {
    setValue(text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleRefine = async () => {
    const draft = value.trim();
    if (draft.length < 10) {
      toast.error("Write a draft (at least 10 chars) before refining.");
      return;
    }
    setRefining(true);
    try {
      const res = await refineFn({ data: { draft } });
      if (!res.ok) {
        toast.error("Refinement failed", { description: res.error });
        return;
      }
      setRefined(res.refined);
    } catch (err) {
      toast.error("Refinement failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRefining(false);
    }
  };

  const charCount = value.length;
  const charLimit = 8000;

  return (
    <section className="glass relative rounded-2xl p-6 sm:p-8">
      <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-muted-foreground">
        <Terminal className="h-3.5 w-3.5 text-[color:var(--neon-cyan)]" aria-hidden />
        <span>Massive Event Space</span>
      </div>

      <PromptToolbar
        onTemplate={(t) => replaceText(t)}
        onToggleScaffold={() => setScaffoldOpen((v) => !v)}
        onRefine={handleRefine}
        scaffoldOpen={scaffoldOpen}
        refining={refining}
        canRefine={value.trim().length >= 10 && !loading}
      />

      {scaffoldOpen && (
        <PromptScaffold
          onCompose={(t) => {
            insertText(t);
            setScaffoldOpen(false);
          }}
          onClose={() => setScaffoldOpen(false)}
        />
      )}

      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={7}
        disabled={loading}
        className={cn(
          "min-h-[160px] resize-y border-white/10 bg-black/30 font-mono text-sm leading-relaxed",
          "text-foreground placeholder:text-muted-foreground/60",
          "focus-visible:ring-2 focus-visible:ring-[color:var(--neon-cyan)]/60",
        )}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !loading) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />

      <PromptSuggestions text={value} onApply={(t) => insertText(t)} />

      <div className="mt-5 flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">
              ⌘
            </kbd>{" "}
            +{" "}
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>{" "}
            execute
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-mono text-[10px] tabular-nums">
            <span className={charCount > charLimit ? "text-rose-300" : ""}>{charCount}</span>
            <span className="text-muted-foreground/50"> / {charLimit}</span>
          </span>
        </div>
        <Button
          onClick={handleSubmit}
          disabled={loading || charCount > charLimit}
          size="lg"
          className={cn(
            "group relative overflow-hidden rounded-xl px-6 py-6 text-sm font-semibold uppercase tracking-wider",
            "bg-gradient-to-r from-[color:var(--neon-cyan)] via-[color:var(--neon-cyan)] to-[color:var(--neon-violet)]",
            "text-[color:oklch(0.12_0.03_260)] hover:opacity-95",
            !loading && "animate-pulse-glow",
            loading && "opacity-80",
          )}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              Executing Loop...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" aria-hidden />
              Initialize Causal Execution
            </>
          )}
        </Button>
      </div>

      <RefineDialog
        open={refined !== null}
        onOpenChange={(open) => {
          if (!open) setRefined(null);
        }}
        original={value}
        refined={refined ?? ""}
        onApply={() => {
          if (refined) replaceText(refined);
          setRefined(null);
          toast.success("Refined brief applied.");
        }}
      />
    </section>
  );
});
