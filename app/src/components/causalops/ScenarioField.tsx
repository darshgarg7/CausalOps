import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ScenarioField as Field } from "@/lib/scenario-builder";

interface Props {
  field: Field;
  value: string;
  confidence?: "high" | "medium" | "low";
  onChange: (v: string) => void;
  /** Optional rendered chip area (used for TTPs). Replaces the input. */
  customControl?: React.ReactNode;
  defaultOpen?: boolean;
  /** Externally force the field open (e.g. when the user clicks "Jump" in the checklist). */
  forceOpen?: boolean;
}

const confTone: Record<string, string> = {
  high: "bg-emerald-400/70",
  medium: "bg-amber-400/70",
  low: "bg-rose-400/70",
};

export function ScenarioField({
  field,
  value,
  confidence,
  onChange,
  customControl,
  defaultOpen = true,
  forceOpen,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  // When forceOpen flips true, auto-expand. We never auto-collapse from this signal.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const filled = value.trim().length > 0 || Boolean(customControl);

  return (
    <div
      className={cn(
        "rounded-lg border bg-white/[0.015] transition-colors",
        filled ? "border-white/10" : "border-white/5",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-foreground/80">
          {field.label}
        </span>
        {confidence && (
          <span
            className="ml-auto flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
            title={`AI confidence: ${confidence}`}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", confTone[confidence])} />
            {confidence}
          </span>
        )}
        {!confidence && filled && (
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-foreground/30" />
        )}
        {!filled && !customControl && (
          <span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
            empty
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <p className="mb-2 flex items-start gap-1 text-[10px] leading-snug text-muted-foreground/70">
            <Sparkles className="mt-0.5 h-2.5 w-2.5 shrink-0 text-[color:var(--neon-cyan)]/60" />
            {field.helper}
          </p>
          {customControl ? (
            customControl
          ) : field.multiline ? (
            <Textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder}
              rows={2}
              className="min-h-[60px] resize-y border-white/10 bg-black/30 text-xs leading-relaxed"
            />
          ) : (
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder}
              className="border-white/10 bg-black/30 text-xs"
            />
          )}
        </div>
      )}
    </div>
  );
}
