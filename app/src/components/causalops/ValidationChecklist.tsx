import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ValidationIssue, ValidationResult } from "@/lib/scenario-validation";

interface Props {
  result: ValidationResult;
  onJumpToField?: (field: string) => void;
  onApplyFix?: (issue: ValidationIssue) => void;
}

export function ValidationChecklist({ result, onJumpToField, onApplyFix }: Props) {
  const [open, setOpen] = useState(true);
  const { issues, errors, warnings, score, canRun } = result;

  const toneRing = canRun
    ? errors === 0 && warnings === 0
      ? "border-emerald-400/40 bg-emerald-500/[0.05]"
      : "border-amber-400/40 bg-amber-500/[0.04]"
    : "border-rose-400/50 bg-rose-500/[0.05]";

  const headerIcon = canRun ? (
    issues.length === 0 ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
    ) : (
      <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
    )
  ) : (
    <AlertCircle className="h-3.5 w-3.5 text-rose-300" />
  );

  const headerLabel = canRun
    ? issues.length === 0
      ? "Pre-flight clean — ready to execute"
      : `${warnings} warning${warnings === 1 ? "" : "s"} · run allowed`
    : `${errors} blocker${errors === 1 ? "" : "s"} · run disabled`;

  return (
    <div className={cn("rounded-xl border", toneRing)}>
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
        {headerIcon}
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground/90">
          Pre-flight
        </span>
        <span className="text-[11px] text-foreground/80">{headerLabel}</span>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:inline-flex">
            integrity
            <span
              className={cn(
                "tabular-nums",
                score >= 90 ? "text-emerald-300" : score >= 70 ? "text-amber-300" : "text-rose-300",
              )}
            >
              {score}
            </span>
            <span className="text-muted-foreground/60">/ 100</span>
          </span>
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-white/10">
            <span
              className={cn(
                "block h-full rounded-full transition-all",
                score >= 90 ? "bg-emerald-400" : score >= 70 ? "bg-amber-400" : "bg-rose-400",
              )}
              style={{ width: `${score}%` }}
            />
          </span>
        </div>
      </button>

      {open && issues.length > 0 && (
        <ul className="space-y-1.5 border-t border-white/5 px-3 py-2">
          {issues.map((issue) => (
            <ChecklistRow
              key={issue.id}
              issue={issue}
              onJumpToField={onJumpToField}
              onApplyFix={onApplyFix}
            />
          ))}
        </ul>
      )}

      {open && issues.length === 0 && (
        <div className="border-t border-white/5 px-3 py-2 text-[11px] text-emerald-300">
          All required fields present, MITRE chain coherent, no conflicts detected.
        </div>
      )}
    </div>
  );
}

function ChecklistRow({
  issue,
  onJumpToField,
  onApplyFix,
}: {
  issue: ValidationIssue;
  onJumpToField?: (field: string) => void;
  onApplyFix?: (issue: ValidationIssue) => void;
}) {
  const tone =
    issue.severity === "error"
      ? {
          icon: <AlertCircle className="h-3 w-3 text-rose-300" />,
          label: "BLOCK",
          chip: "border-rose-400/40 bg-rose-500/15 text-rose-200",
        }
      : issue.severity === "warning"
        ? {
            icon: <AlertTriangle className="h-3 w-3 text-amber-300" />,
            label: "WARN",
            chip: "border-amber-400/40 bg-amber-500/10 text-amber-200",
          }
        : {
            icon: <Info className="h-3 w-3 text-cyan-300" />,
            label: "INFO",
            chip: "border-cyan-400/30 bg-cyan-500/10 text-cyan-200",
          };

  const canApply = Boolean(onApplyFix && (issue.addTtpIds || issue.removeTtpIds));

  return (
    <li className="flex items-start gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5">
      <span className="mt-0.5">{tone.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded border px-1 py-px font-mono text-[8px] tracking-wider",
              tone.chip,
            )}
          >
            {tone.label}
          </span>
          <span className="text-[11px] font-medium text-foreground/95">{issue.title}</span>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{issue.detail}</p>
        <p className="mt-0.5 flex items-start gap-1 text-[10.5px] leading-snug text-foreground/80">
          <Wrench className="mt-0.5 h-2.5 w-2.5 shrink-0 text-[color:var(--neon-cyan)]/70" />
          <span>
            <span className="font-mono uppercase tracking-wider text-muted-foreground/80">
              fix ·{" "}
            </span>
            {issue.fix}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {issue.field && onJumpToField && (
          <button
            type="button"
            onClick={() => onJumpToField(issue.field!)}
            className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-foreground/80 hover:border-[color:var(--neon-cyan)]/40 hover:text-[color:var(--neon-cyan)]"
          >
            Jump
          </button>
        )}
        {canApply && (
          <button
            type="button"
            onClick={() => onApplyFix!(issue)}
            className="rounded border border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[color:var(--neon-cyan)] hover:bg-[color:var(--neon-cyan)]/20"
          >
            Apply
          </button>
        )}
      </div>
    </li>
  );
}
