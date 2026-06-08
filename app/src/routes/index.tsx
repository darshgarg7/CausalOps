import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Brain, Crown, FileDown, Hexagon, History, Maximize2, Radar, UserCog } from "lucide-react";
import { toast } from "sonner";

import { ScenarioBuilder, type ScenarioBuilderHandle } from "@/components/hivemind/ScenarioBuilder";
import { ExecutiveView } from "@/components/hivemind/ExecutiveView";
import { EMPTY_SCENARIO, type ScenarioState } from "@/lib/scenario-builder";
import { MetricsBar } from "@/components/hivemind/MetricsBar";
import { StrategiesGrid } from "@/components/hivemind/StrategiesGrid";
import { CausalGraphPanel } from "@/components/hivemind/CausalGraphPanel";
import { SpatiotemporalKGPanel } from "@/components/hivemind/SpatiotemporalKGPanel";
import { ErrorPanel } from "@/components/hivemind/ErrorPanel";
import { ExecutionStream } from "@/components/hivemind/ExecutionStream";
import { CausalObservabilityPanel } from "@/components/hivemind/CausalObservabilityPanel";
import { buildObservabilityTrace } from "@/lib/agent-runtime";
import { RunHistoryDrawer } from "@/components/hivemind/RunHistoryDrawer";
import { PresenterMode } from "@/components/hivemind/PresenterMode";
import { executeWithProgress } from "@/lib/execution-simulator";
import { SchemaValidationError, type SchemaIssue } from "@/lib/hivemind-schema";
import type { ExecutionEvent, HistoryEntry, RunResponse } from "@/lib/hivemind-types";
import { useRunHistory } from "@/hooks/use-run-history";
import { exportRunReport } from "@/lib/pdf-export";
import type { CausalGraphHandle } from "@/components/hivemind/CausalGraph";
import { computeDerivedMetrics } from "@/lib/derived-metrics";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [schemaIssues, setSchemaIssues] = useState<SchemaIssue[] | null>(null);
  const [rawResponse, setRawResponse] = useState<unknown>(undefined);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<string>("");
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [presenterOpen, setPresenterOpen] = useState(false);
  const [mode, setMode] = useState<"analyst" | "executive">("analyst");
  const [scenarioFields, setScenarioFields] = useState<ScenarioState>(EMPTY_SCENARIO);
  const [scenarioTtps, setScenarioTtps] = useState<string[]>([]);

  const inputRef = useRef<ScenarioBuilderHandle>(null);
  const graphRef = useRef<CausalGraphHandle>(null);
  const { history, add, remove, clear } = useRunHistory();

  const handleRun = async (
    taskDescription: string,
    meta?: { fields: ScenarioState; ttps: string[] },
  ) => {
    if (meta) {
      setScenarioFields(meta.fields);
      setScenarioTtps(meta.ttps);
    }
    setLoading(true);
    setErrorMsg(null);
    setSchemaIssues(null);
    setRawResponse(undefined);
    setEvents([]);
    setActiveTask(taskDescription);
    try {
      const data = await executeWithProgress(taskDescription, (e) => {
        setEvents((prev) => [...prev, e]);
      });
      setResult(data);
      const entry = add(taskDescription, data);
      setActiveHistoryId(entry.id);
      toast.success("Causal loop complete", {
        description: `${data.strategies?.length ?? 0} strategies · ${
          data.causal_graph?.nodes?.length ?? 0
        } nodes`,
      });
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        setSchemaIssues(err.issues);
        setRawResponse(err.raw);
        setErrorMsg(err.message);
        toast.error("Backend response failed validation", {
          description: `${err.issues.length} issue(s) — see banner for details`,
        });
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        setErrorMsg(message);
        toast.error("Execution failed", { description: message });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSelectHistory = useCallback((entry: HistoryEntry) => {
    setResult(entry.payload);
    setActiveHistoryId(entry.id);
    setActiveTask(entry.taskFull);
    setErrorMsg(null);
    setSchemaIssues(null);
    setEvents([]);
    setHistoryOpen(false);
    toast.success(`Loaded run ${entry.runId}`);
  }, []);

  const handleReRun = useCallback((entry: HistoryEntry) => {
    inputRef.current?.loadFromText(entry.taskFull);
    setHistoryOpen(false);
    toast.message("Loaded into prompt", { description: "Edit and execute when ready." });
  }, []);

  const handleExport = useCallback(
    async (entry: HistoryEntry) => {
      try {
        const isCurrent = entry.id === activeHistoryId;
        const canvas = isCurrent ? (graphRef.current?.getCanvas() ?? null) : null;
        await exportRunReport(entry, canvas);
        toast.success("PDF exported", { description: `hivemind-${entry.runId}.pdf` });
      } catch (err) {
        toast.error("PDF export failed", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [activeHistoryId],
  );

  // Keyboard shortcuts: H toggles history, Esc closes drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (e.key.toLowerCase() === "h" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setHistoryOpen((v) => !v);
      }
      if (e.key.toLowerCase() === "p" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setPresenterOpen((v) => !v);
      }
      if (e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setMode((m) => (m === "analyst" ? "executive" : "analyst"));
      }
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const currentEntry: HistoryEntry | null =
    activeHistoryId != null ? (history.find((h) => h.id === activeHistoryId) ?? null) : null;
  const showStream = events.length > 0;
  const derived = result ? computeDerivedMetrics(result) : null;
  const observability = useMemo(
    () => (result ? buildObservabilityTrace(scenarioFields, scenarioTtps, result) : null),
    [result, scenarioFields, scenarioTtps],
  );

  return (
    <main className="relative z-10 mx-auto min-h-screen w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Header */}
      <header className="mb-10 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <Hexagon
              className="absolute inset-0 h-12 w-12 text-[color:var(--neon-cyan)] opacity-80"
              strokeWidth={1.25}
              aria-hidden
            />
            <Brain className="relative h-5 w-5 text-[color:var(--neon-cyan)]" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-tight text-foreground sm:text-2xl">
              HiveMind <span className="text-[color:var(--neon-cyan)]">Causal Engine</span>
            </h1>
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
              Adversarial Threat · Causal Reasoning Loop
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center rounded-full border border-white/10 bg-white/[0.03] p-0.5">
            <button
              type="button"
              onClick={() => setMode("analyst")}
              className={
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors " +
                (mode === "analyst"
                  ? "bg-[color:var(--neon-cyan)]/20 text-[color:var(--neon-cyan)]"
                  : "text-foreground/70 hover:text-foreground")
              }
              title="Analyst mode (E to toggle)"
            >
              <UserCog className="h-3.5 w-3.5" />
              Analyst
            </button>
            <button
              type="button"
              onClick={() => setMode("executive")}
              className={
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors " +
                (mode === "executive"
                  ? "bg-[color:var(--neon-violet)]/20 text-[color:var(--neon-violet)]"
                  : "text-foreground/70 hover:text-foreground")
              }
              title="Executive mode (E to toggle)"
            >
              <Crown className="h-3.5 w-3.5" />
              Executive
            </button>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              engine online
            </span>
          </div>
          {result && derived && (
            <button
              type="button"
              onClick={() => setPresenterOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 px-3 py-1.5 text-xs text-[color:var(--neon-cyan)] transition-colors hover:bg-[color:var(--neon-cyan)]/20"
              title="Presenter mode (P)"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Present
            </button>
          )}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-[color:var(--neon-cyan)]/40 hover:text-[color:var(--neon-cyan)]"
            title="Open run history (H)"
          >
            <History className="h-3.5 w-3.5" />
            History
            <span className="font-mono text-[10px] text-muted-foreground">{history.length}</span>
          </button>
          {currentEntry && (
            <button
              type="button"
              onClick={() => handleExport(currentEntry)}
              className="flex items-center gap-1.5 rounded-full border border-[color:var(--neon-violet)]/40 bg-[color:var(--neon-violet)]/10 px-3 py-1.5 text-xs text-[color:var(--neon-violet)] transition-colors hover:bg-[color:var(--neon-violet)]/20"
              title="Export current run as PDF"
            >
              <FileDown className="h-3.5 w-3.5" />
              Export PDF
            </button>
          )}
        </div>
      </header>

      <div className="space-y-6">
        {mode === "analyst" ? (
          <ScenarioBuilder ref={inputRef} loading={loading} onSubmit={handleRun} />
        ) : (
          <ExecutiveView
            fields={scenarioFields}
            ttps={scenarioTtps}
            result={result}
            derived={derived}
            observability={observability}
          />
        )}

        {mode === "analyst" && showStream && (
          <ExecutionStream events={events} isRunning={loading} />
        )}

        {mode === "analyst" && errorMsg && (
          <ErrorPanel
            message={errorMsg}
            schemaIssues={schemaIssues ?? undefined}
            raw={schemaIssues ? rawResponse : undefined}
          />
        )}

        {mode === "analyst" && !result && !errorMsg && !showStream && (
          <div className="glass flex items-center justify-center gap-3 rounded-2xl px-6 py-12 text-sm text-muted-foreground">
            <Radar className="h-4 w-4 text-[color:var(--neon-cyan)]/70" aria-hidden />
            Build a scenario above and Run to see strategies, causal graph, and impact.
          </div>
        )}

        {mode === "analyst" && result && !schemaIssues && (
          <div className="space-y-6">
            <MetricsBar impact={result.impact} runId={result.run_id} derived={derived!} />
            <StrategiesGrid ranked={derived!.ranked} />
            <CausalGraphPanel
              ref={graphRef}
              graph={result.causal_graph ?? { nodes: [], edges: [] }}
              edgeAnnotations={observability?.edges}
            />
            <SpatiotemporalKGPanel runId={result.run_id} />
            {observability && <CausalObservabilityPanel trace={observability} />}
          </div>
        )}
      </div>

      <RunHistoryDrawer
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        history={history}
        activeId={activeHistoryId}
        onSelect={handleSelectHistory}
        onDelete={remove}
        onClear={() => {
          clear();
          toast.success("Run history cleared.");
        }}
        onReRun={handleReRun}
        onExport={handleExport}
      />

      {result && derived && (
        <PresenterMode
          open={presenterOpen}
          onClose={() => setPresenterOpen(false)}
          result={result}
          derived={derived}
          task={activeTask}
        />
      )}

      <footer className="mt-16 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/60">
        HiveMind · Causal Execution Framework · <span className="text-foreground/60">E</span> mode ·{" "}
        <span className="text-foreground/60">H</span> history ·{" "}
        <span className="text-foreground/60">P</span> presenter
      </footer>
    </main>
  );
}
