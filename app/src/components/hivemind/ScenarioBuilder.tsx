import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Terminal, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ExecutionMode } from "@/lib/hivemind-types";
import {
  EMPTY_SCENARIO,
  FIELDS,
  buildKillChain,
  composeScenarioPrompt,
  decompose,
  generateRefinements,
  type ConfidenceState,
  type FieldKey,
  type ScenarioLibraryEntry,
  type ScenarioState,
} from "@/lib/scenario-builder";
import { validateScenario } from "@/lib/scenario-validation";
import { ScenarioLibrary } from "./ScenarioLibrary";
import { ScenarioField } from "./ScenarioField";
import { MitreChips } from "./MitreChips";
import { RefinementPanel } from "./RefinementPanel";
import { ExportPanel } from "./ExportPanel";
import { KillChainPanel } from "./KillChainPanel";
import { ValidationChecklist } from "./ValidationChecklist";

export interface ScenarioBuilderHandle {
  loadFromText: (text: string) => void;
  focus: () => void;
}

interface Props {
  loading: boolean;
  onSubmit: (
    composedPrompt: string,
    meta: { fields: ScenarioState; ttps: string[]; executionMode: ExecutionMode },
  ) => void;
}

export const ScenarioBuilder = forwardRef<ScenarioBuilderHandle, Props>(function ScenarioBuilder(
  { loading, onSubmit },
  ref,
) {
  const [raw, setRaw] = useState("");
  const [fields, setFields] = useState<ScenarioState>(EMPTY_SCENARIO);
  const [confidence, setConfidence] = useState<ConfidenceState>({});
  const [ttps, setTtps] = useState<string[]>([]);
  const [autoDecompose, setAutoDecompose] = useState(true);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("standard");
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [forceOpenField, setForceOpenField] = useState<FieldKey | null>(null);
  const fieldRefs = useRef<Partial<Record<FieldKey, HTMLDivElement | null>>>({});

  // Debounced auto-decompose
  useEffect(() => {
    if (!autoDecompose || raw.trim().length < 20) return;
    const t = setTimeout(() => {
      const result = decompose(raw, fields);
      setFields(result.fields);
      setConfidence((prev) => ({ ...prev, ...result.confidence }));
      // Merge TTPs (don't blow away user picks)
      setTtps((prev) => Array.from(new Set([...prev, ...result.ttps])));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, autoDecompose]);

  useImperativeHandle(ref, () => ({
    loadFromText: (text: string) => {
      setRaw(text);
      const result = decompose(text);
      setFields(result.fields);
      setConfidence(result.confidence);
      setTtps(result.ttps);
    },
    focus: () => {},
  }));

  const onPickLibrary = (entry: ScenarioLibraryEntry) => {
    setFields(entry.fields);
    setTtps(entry.ttps);
    setConfidence({
      asset: "high",
      actor: "high",
      objective: "high",
      vector: "high",
      ttps: "high",
      environment: "high",
      impact: "high",
      detection_gaps: "high",
    });
    setRaw(entry.oneLiner);
    toast.success(`Loaded: ${entry.label}`, {
      description: `${entry.ttps.length} ATT&CK techniques + 8 fields populated.`,
    });
    setLibraryOpen(false);
  };

  const updateField = (key: FieldKey, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setConfidence((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const refinements = useMemo(() => generateRefinements(fields, ttps), [fields, ttps]);
  const killChain = useMemo(() => buildKillChain(fields, ttps), [fields, ttps]);
  const validation = useMemo(() => validateScenario(fields, ttps), [fields, ttps]);

  const completeness = useMemo(() => {
    const filled = (Object.keys(fields) as FieldKey[]).filter((k) => {
      if (k === "ttps") return ttps.length > 0;
      return fields[k].trim().length > 0;
    }).length;
    return Math.round((filled / FIELDS.length) * 100);
  }, [fields, ttps]);

  const handleSubmit = () => {
    if (!validation.canRun) {
      toast.error("Resolve blocking issues before executing.", {
        description: `${validation.errors} blocker${validation.errors === 1 ? "" : "s"} in pre-flight checklist.`,
      });
      return;
    }
    const composed = composeScenarioPrompt(fields, ttps);
    if (composed.trim().length < 20) {
      toast.error("Scenario too thin — fill at least asset + objective.");
      return;
    }
    onSubmit(composed, { fields, ttps, executionMode });
  };

  const jumpToField = (key: string) => {
    const k = key as FieldKey;
    setForceOpenField(k);
    requestAnimationFrame(() => {
      const el = fieldRefs.current[k];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const input = el.querySelector<HTMLElement>("textarea, input, button");
        input?.focus({ preventScroll: true });
      }
    });
    // Reset force-open flag so the user can collapse later
    window.setTimeout(() => setForceOpenField(null), 1200);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      {/* Builder column */}
      <section className="glass relative rounded-2xl p-6 sm:p-7">
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-muted-foreground">
          <Terminal className="h-3.5 w-3.5 text-[color:var(--neon-cyan)]" aria-hidden />
          <span>Threat Scenario Builder</span>
          <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {completeness}% complete
            </span>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full bg-gradient-to-r from-[color:var(--neon-cyan)] to-[color:var(--neon-violet)] transition-all"
                style={{ width: `${completeness}%` }}
              />
            </span>
          </span>
        </div>

        {/* Library */}
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setLibraryOpen((v) => !v)}
            className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-[color:var(--neon-cyan)]"
          >
            {libraryOpen ? "− hide library" : "+ show library"}
          </button>
          {libraryOpen && <ScenarioLibrary onPick={onPickLibrary} />}
        </div>

        {/* Free-text input */}
        <div className="mb-4">
          <label className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/80">
            Describe the threat scenario you want to model
            <span className="ml-auto flex items-center gap-1.5 text-[10px] normal-case tracking-normal text-muted-foreground">
              <input
                type="checkbox"
                checked={autoDecompose}
                onChange={(e) => setAutoDecompose(e.target.checked)}
                className="h-3 w-3 accent-[color:var(--neon-cyan)]"
              />
              Auto-decompose
            </span>
          </label>
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Paste or type the scenario in plain English. Fields below will populate automatically as you type. e.g. 'Spear-phish hits finance, AiTM steals SSO session, attacker pivots to M365 mailbox of CFO during quarterly close...'"
            rows={3}
            disabled={loading}
            className={cn(
              "min-h-[80px] resize-y border-white/10 bg-black/30 font-mono text-sm leading-relaxed",
              "focus-visible:ring-2 focus-visible:ring-[color:var(--neon-cyan)]/60",
            )}
          />
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Wand2 className="h-2.5 w-2.5 text-[color:var(--neon-cyan)]/70" />
              Heuristic decomposer running locally — no scenario data leaves the browser until you
              Run.
            </span>
            <button
              type="button"
              onClick={() => {
                if (raw.trim().length < 10) {
                  toast.error("Write a draft first.");
                  return;
                }
                const r = decompose(raw);
                setFields(r.fields);
                setConfidence(r.confidence);
                setTtps(r.ttps);
                toast.success(`Decomposed · ${r.ttps.length} TTPs mapped`);
              }}
              className="rounded border border-white/10 px-2 py-0.5 hover:bg-white/5 hover:text-foreground"
            >
              Decompose now
            </button>
          </div>
        </div>

        {/* Structured fields */}
        <div className="mb-4 space-y-2">
          {FIELDS.map((f) => (
            <div
              key={f.key}
              ref={(el) => {
                fieldRefs.current[f.key] = el;
              }}
            >
              <ScenarioField
                field={f}
                value={fields[f.key]}
                confidence={confidence[f.key]}
                onChange={(v) => updateField(f.key, v)}
                defaultOpen={
                  f.key === "asset" ||
                  f.key === "actor" ||
                  f.key === "objective" ||
                  f.key === "ttps"
                }
                forceOpen={forceOpenField === f.key}
                customControl={
                  f.key === "ttps" ? <MitreChips selected={ttps} onChange={setTtps} /> : undefined
                }
              />
            </div>
          ))}
        </div>

        {/* Pre-flight validation */}
        <div className="mb-4">
          <ValidationChecklist
            result={validation}
            onJumpToField={jumpToField}
            onApplyFix={(issue) => {
              if (issue.addTtpIds && issue.addTtpIds.length > 0) {
                setTtps((prev) => {
                  const set = new Set(prev);
                  issue.addTtpIds!.forEach((id) => set.add(id));
                  return Array.from(set);
                });
              }
              if (issue.removeTtpIds && issue.removeTtpIds.length > 0) {
                setTtps((prev) => {
                  const remove = new Set(issue.removeTtpIds);
                  // Dedup: keep the first occurrence of duplicates only
                  const seen = new Set<string>();
                  return prev.filter((id) => {
                    if (!remove.has(id)) return true;
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                  });
                });
              }
              toast.success(`Applied fix: ${issue.title}`);
            }}
          />
        </div>

        {/* Refinements */}
        <div className="mb-4">
          <RefinementPanel
            suggestions={refinements}
            onAccept={(s) => {
              if (s.apply?.addTtpId) {
                setTtps((prev) =>
                  prev.includes(s.apply!.addTtpId!) ? prev : [...prev, s.apply!.addTtpId!],
                );
              }
              if (s.apply?.field) {
                setFields((prev) => {
                  const cur = prev[s.apply!.field!];
                  const append = s.apply!.appendText ?? "";
                  const next = cur.trim().length === 0 ? append : `${cur} · ${append}`;
                  return { ...prev, [s.apply!.field!]: next };
                });
              }
              toast.success(`Applied: ${s.title}`);
            }}
          />
        </div>

        {/* Export + Run */}
        <div className="flex flex-col gap-3 border-t border-white/5 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <ExportPanel state={fields} ttpIds={ttps} />
          <div className="flex flex-col gap-3 sm:items-end">
            <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span
                className={cn(
                  "rounded border px-2 py-1",
                  executionMode === "standard"
                    ? "border-[color:var(--neon-cyan)]/30 text-[color:var(--neon-cyan)]"
                    : "border-white/10",
                )}
                title="Standard mode: fast triage with a compact specialist swarm."
              >
                Standard
              </span>
              <Switch
                checked={executionMode === "deep"}
                onCheckedChange={(checked) => setExecutionMode(checked ? "deep" : "standard")}
                disabled={loading}
                aria-label="Toggle Deep Mode"
                className="data-[state=checked]:bg-[color:var(--neon-violet)] data-[state=unchecked]:bg-[color:var(--neon-cyan)]/30"
              />
              <span
                className={cn(
                  "rounded border px-2 py-1",
                  executionMode === "deep"
                    ? "border-[color:var(--neon-violet)]/40 text-[color:var(--neon-violet)]"
                    : "border-white/10",
                )}
                title="Deep mode: full swarm, LLM evaluation, causal synthesis, and policy learning."
              >
                Deep Mode
              </span>
            </label>
            <Button
              onClick={handleSubmit}
              disabled={loading || !validation.canRun}
              size="lg"
              title={
                !validation.canRun
                  ? `Resolve ${validation.errors} blocker${validation.errors === 1 ? "" : "s"} in pre-flight checklist`
                  : undefined
              }
              className={cn(
                "group relative overflow-hidden rounded-xl px-6 py-5 text-sm font-semibold uppercase tracking-wider",
                "bg-gradient-to-r from-[color:var(--neon-cyan)] via-[color:var(--neon-cyan)] to-[color:var(--neon-violet)]",
                "text-[color:oklch(0.12_0.03_260)] hover:opacity-95",
                !loading && validation.canRun && "animate-pulse-glow",
                (loading || !validation.canRun) && "opacity-60",
                !validation.canRun && "cursor-not-allowed",
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  {executionMode === "deep" ? "Executing Deep Loop..." : "Executing Fast Loop..."}
                </>
              ) : !validation.canRun ? (
                <>
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden />
                  {validation.errors} blocker{validation.errors === 1 ? "" : "s"} - resolve to run
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden />
                  {executionMode === "deep"
                    ? "Initialize Deep Execution"
                    : "Initialize Fast Execution"}
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      {/* Adversarial preview side panel */}
      <div className="hidden lg:block">
        <KillChainPanel chain={killChain} ttpCount={ttps.length} />
      </div>

      {/* Mobile/tablet — show below */}
      <div className="lg:hidden">
        <KillChainPanel chain={killChain} ttpCount={ttps.length} />
      </div>
    </div>
  );
});
