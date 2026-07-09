import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface ScoreBarProps {
  label: string;
  value: number;
  icon: LucideIcon;
  tone: "rose" | "amber" | "emerald";
}

const TONE_STYLES: Record<ScoreBarProps["tone"], { bar: string; text: string; icon: string }> = {
  rose: {
    bar: "from-rose-500/80 to-rose-400",
    text: "text-rose-300",
    icon: "text-rose-300",
  },
  amber: {
    bar: "from-amber-500/80 to-amber-300",
    text: "text-amber-200",
    icon: "text-amber-200",
  },
  emerald: {
    bar: "from-emerald-500/80 to-emerald-300",
    text: "text-emerald-200",
    icon: "text-emerald-200",
  },
};

export function ScoreBar({ label, value, icon: Icon, tone }: ScoreBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const styles = TONE_STYLES[tone];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className={cn("h-3.5 w-3.5", styles.icon)} aria-hidden />
          <span className="uppercase tracking-wider">{label}</span>
        </div>
        <span className={cn("font-mono tabular-nums font-semibold", styles.text)}>
          {pct.toFixed(0)}
          <span className="text-muted-foreground">%</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r transition-all duration-700",
            styles.bar,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
