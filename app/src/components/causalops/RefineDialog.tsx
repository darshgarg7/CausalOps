import { Check, Sparkles, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RefineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original: string;
  refined: string;
  onApply: () => void;
}

export function RefineDialog({
  open,
  onOpenChange,
  original,
  refined,
  onApply,
}: RefineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl border-white/10 bg-[oklch(0.13_0.025_260)] text-foreground">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-[color:var(--neon-cyan)]" />
            AI-refined event-space brief
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Tightened by Lovable AI for clearer causal-reasoning input. Review and apply, or
            discard.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Original
            </p>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-3 font-sans text-xs leading-relaxed text-foreground/80">
              {original}
            </pre>
          </div>
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--neon-cyan)]">
              Refined
            </p>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--neon-cyan)]/30 bg-[color:var(--neon-cyan)]/[0.06] p-3 font-sans text-xs leading-relaxed text-foreground">
              {refined}
            </pre>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Discard
          </button>
          <button
            type="button"
            onClick={onApply}
            className="flex items-center gap-1.5 rounded-md bg-[color:var(--neon-cyan)] px-3 py-1.5 text-xs font-medium text-[oklch(0.12_0.03_260)] transition-colors hover:opacity-90"
          >
            <Check className="h-3 w-3" />
            Apply refined brief
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
