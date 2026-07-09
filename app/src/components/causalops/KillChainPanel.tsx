import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Crosshair,
  Database,
  Eye,
  EyeOff,
  GitBranchPlus,
  Radar,
  ShieldAlert,
  Timer,
  XCircle,
} from "lucide-react";
import { tacticById } from "@/lib/mitre-catalog";
import type { KillChainSummary } from "@/lib/scenario-builder";
import { evidenceFor } from "@/lib/detection-evidence";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { tacticTone } from "./MitreChips";

interface Props {
  chain: KillChainSummary;
  ttpCount: number;
}

export function KillChainPanel({ chain, ttpCount }: Props) {
  const [showEvidence, setShowEvidence] = useState(false);
  if (ttpCount === 0) {
    return (
      <aside className="panel-cinematic hm-corner sticky top-6 flex h-full flex-col gap-3 rounded-2xl p-5">
        <Header showEvidence={false} onToggle={() => {}} disabled />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-xs text-muted-foreground">
          <Radar className="h-6 w-6 text-[color:var(--neon-cyan)]/50" />
          <p className="max-w-[220px] leading-relaxed">
            Kill chain assembles automatically as you describe the scenario or pick a template.
          </p>
        </div>
      </aside>
    );
  }

  const dwell = chain.totalDwellHours;
  const dwellLabel = dwell >= 24 ? `${(dwell / 24).toFixed(1)}d` : `${dwell.toFixed(1)}h`;

  return (
    <aside className="panel-cinematic hm-corner sticky top-6 flex max-h-[calc(100vh-3rem)] flex-col gap-3 overflow-hidden rounded-2xl p-5">
      <Header showEvidence={showEvidence} onToggle={setShowEvidence} />

      {/* Top stats */}
      <div className="grid grid-cols-3 gap-2 border-y border-white/5 py-2">
        <Stat icon={Timer} label="Dwell" value={dwellLabel} tone="cyan" />
        <Stat
          icon={Eye}
          label="Detection pts"
          value={`${chain.detectionPoints}/${chain.steps.length}`}
          tone="emerald"
        />
        <Stat
          icon={EyeOff}
          label="Blind spots"
          value={String(chain.blindSpots)}
          tone={chain.blindSpots > 0 ? "rose" : "muted"}
        />
      </div>

      {/* Escalation path */}
      <div className="border-b border-white/5 pb-2">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          <GitBranchPlus className="h-2.5 w-2.5" />
          Escalation path
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          {chain.escalationPath.map((p, i) => (
            <span key={p} className="inline-flex items-center gap-1">
              <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-foreground/80">
                {p}
              </span>
              {i < chain.escalationPath.length - 1 && (
                <span className="text-[color:var(--neon-cyan)]/60">›</span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Steps */}
      <div className="flex-1 overflow-y-auto pr-1">
        <ol className="relative space-y-2 pl-5">
          <span
            className="absolute left-[7px] top-1 bottom-1 w-px bg-gradient-to-b from-[color:var(--neon-cyan)]/40 via-white/10 to-[color:var(--neon-violet)]/40"
            aria-hidden
          />
          {chain.steps.map((s) => {
            const tac = tacticById(s.technique.tactic);
            const detTone =
              s.detected === "likely"
                ? "text-emerald-300"
                : s.detected === "blind"
                  ? "text-rose-300"
                  : "text-amber-300";
            const evidence = showEvidence ? evidenceFor(s.technique.id, s.technique.tactic) : null;
            return (
              <li key={s.technique.id + s.order} className="relative">
                <span
                  className={cn(
                    "absolute -left-[18px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                    s.detected === "likely"
                      ? "border-emerald-400/60 bg-emerald-500/20"
                      : s.detected === "blind"
                        ? "border-rose-400/60 bg-rose-500/20"
                        : "border-amber-400/60 bg-amber-500/20",
                  )}
                >
                  <span className="font-mono text-[8px] tabular-nums text-foreground/80">
                    {String(s.order).padStart(2, "0")}
                  </span>
                </span>
                <div className="rounded-md border border-white/5 bg-white/[0.02] p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[9px] tabular-nums",
                        tacticTone[s.technique.tactic] ?? "bg-white/5 text-foreground/80",
                      )}
                    >
                      {s.technique.id}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      {tac.shortLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-foreground/90">
                    {s.technique.name}
                  </p>
                  <div className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-snug text-muted-foreground">
                    <Crosshair className={cn("mt-0.5 h-2.5 w-2.5 shrink-0", detTone)} />
                    <span className={detTone}>
                      {s.detected === "blind"
                        ? "Blind: "
                        : s.detected === "likely"
                          ? "Detect: "
                          : "Partial: "}
                    </span>
                    <span className="text-foreground/60">{s.detection}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground">
                    <span className="font-mono uppercase tracking-wider">
                      +{s.dwellHours}h dwell
                    </span>
                    <span className="font-mono uppercase tracking-wider opacity-70">
                      mit: {s.technique.mitigation.split(",")[0]}
                    </span>
                  </div>
                  {evidence && (
                    <div className="mt-2 space-y-1.5 rounded border border-white/5 bg-black/30 p-2">
                      <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.2em] text-[color:var(--neon-cyan)]/80">
                        <Database className="h-2.5 w-2.5" />
                        Evidence — {evidence.source}
                      </div>
                      <ul className="space-y-0.5">
                        {evidence.confirm.map((c) => (
                          <li key={c} className="flex items-start gap-1.5 text-[10px] leading-snug">
                            <CheckCircle2 className="mt-0.5 h-2.5 w-2.5 shrink-0 text-emerald-300" />
                            <span className="text-foreground/80">
                              <span className="font-mono text-[8px] uppercase tracking-wider text-emerald-300/90 mr-1">
                                Confirms
                              </span>
                              {c}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <ul className="space-y-0.5">
                        {evidence.falsify.map((f) => (
                          <li key={f} className="flex items-start gap-1.5 text-[10px] leading-snug">
                            <XCircle className="mt-0.5 h-2.5 w-2.5 shrink-0 text-rose-300" />
                            <span className="text-foreground/80">
                              <span className="font-mono text-[8px] uppercase tracking-wider text-rose-300/90 mr-1">
                                Falsifies
                              </span>
                              {f}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {chain.blindSpots > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-[10px] text-rose-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="leading-snug">
            <strong>{chain.blindSpots}</strong> chain step{chain.blindSpots > 1 ? "s" : ""} likely
            undetected. Containment options will skew defensive.
          </span>
        </div>
      )}
    </aside>
  );
}

function Header({
  showEvidence,
  onToggle,
  disabled = false,
}: {
  showEvidence: boolean;
  onToggle: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-[color:var(--neon-cyan)]" />
        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
          Adversarial Preview
        </h3>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          How this unfolds
        </span>
      </div>
      <label
        className={cn(
          "flex items-center justify-between gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5",
          disabled && "opacity-50",
        )}
      >
        <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
          <Database className="h-2.5 w-2.5 text-[color:var(--neon-cyan)]" />
          Evidence hints
          <span className="text-foreground/50 normal-case tracking-normal">
            — confirm / falsify per step
          </span>
        </span>
        <Switch
          checked={showEvidence}
          onCheckedChange={onToggle}
          disabled={disabled}
          aria-label="Show per-step detection evidence hints"
          className="scale-75"
        />
      </label>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Timer;
  label: string;
  value: string;
  tone: "cyan" | "emerald" | "rose" | "muted";
}) {
  const toneClass =
    tone === "cyan"
      ? "text-[color:var(--neon-cyan)]"
      : tone === "emerald"
        ? "text-emerald-300"
        : tone === "rose"
          ? "text-rose-300"
          : "text-muted-foreground";
  return (
    <div className="flex flex-col items-center gap-0.5 text-center">
      <Icon className={cn("h-3 w-3", toneClass)} />
      <span className={cn("font-mono text-sm tabular-nums", toneClass)}>{value}</span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/80">
        {label}
      </span>
    </div>
  );
}
