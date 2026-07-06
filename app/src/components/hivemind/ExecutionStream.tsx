import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, Clock3, Gauge, Loader2, Terminal, X, Zap } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import type { ExecutionEvent } from "@/lib/hivemind-types";
import { cn } from "@/lib/utils";

interface ExecutionStreamProps {
  events: ExecutionEvent[];
  isRunning: boolean;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const PHASE_PLAN = [
  {
    label: "Submit",
    detail: "Coordinator accepted request",
    match: ["submit", "queued"],
  },
  {
    label: "Orchestrate",
    detail: "Incident tracks selected",
    match: ["orchestrator", "orchestrate"],
  },
  {
    label: "Parents",
    detail: "Senior agents branch work",
    match: ["parent", "parents"],
  },
  {
    label: "Children",
    detail: "Focused memos generated",
    match: ["child", "children", "memo"],
  },
  {
    label: "Evaluate",
    detail: "Strategies ranked",
    match: ["evaluate", "evaluator"],
  },
  {
    label: "Causal",
    detail: "DAG and evidence plan",
    match: ["causal", "synthesis"],
  },
  {
    label: "Estimate",
    detail: "Data gates and ATE",
    match: ["estimate", "estimator", "dowhy"],
  },
  {
    label: "Reason",
    detail: "Anomalies and actions",
    match: ["reason", "reasoning"],
  },
  {
    label: "Policy",
    detail: "KG policy update",
    match: ["policy", "learning"],
  },
  {
    label: "Complete",
    detail: "Artifact ready",
    match: ["complete", "fetch"],
  },
];

function matchesPlan(event: ExecutionEvent, step: (typeof PHASE_PLAN)[number]) {
  const haystack = `${event.phase} ${event.message}`.toLowerCase();
  return step.match.some((token) => haystack.includes(token));
}

export function ExecutionStream({ events, isRunning }: ExecutionStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedAtRef = useRef(Date.now());
  const wasRunningRef = useRef(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    if (isRunning && !wasRunningRef.current) {
      startedAtRef.current = Date.now();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  // Deduplicate by id, keeping the last status update for each
  const merged = new Map<string, ExecutionEvent>();
  for (const e of events) merged.set(e.id, e);
  const list = Array.from(merged.values());
  const elapsedMs = now - (list[0]?.ts ?? startedAtRef.current);
  const hasError = list.some((e) => e.phase === "ERROR" || e.status === "error");
  const isSuccessful = list.some((e) => e.phase === "COMPLETE" && e.status !== "error");
  const latestMatchedIndex = useMemo(() => {
    let matched = -1;
    for (const event of list) {
      const index = PHASE_PLAN.findIndex((step) => matchesPlan(event, step));
      if (index >= 0) matched = Math.max(matched, index);
    }
    return matched;
  }, [list]);
  const estimatedIndex = isRunning
    ? Math.min(PHASE_PLAN.length - 2, Math.floor(elapsedMs / 12_000))
    : latestMatchedIndex;
  const activeIndex = isSuccessful
    ? PHASE_PLAN.length - 1
    : Math.max(0, latestMatchedIndex, estimatedIndex);
  const progress = isSuccessful
    ? 100
    : Math.min(94, Math.round(((activeIndex + 0.45) / PHASE_PLAN.length) * 100));
  const activeStep = PHASE_PLAN[activeIndex];
  const doneCount = list.filter((e) => e.status === "done").length;
  const headerLabel = hasError ? "Execution failed" : activeStep.label;
  const headerDetail = hasError ? "Review the latest backend or model error" : activeStep.detail;
  const HeaderIcon = hasError ? X : isSuccessful ? Check : isRunning ? Loader2 : Zap;

  return (
    <section className="glass overflow-hidden rounded-2xl">
      <header className="border-b border-white/5 bg-black/20 px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-[color:var(--neon-cyan)]" aria-hidden />
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-foreground/80">
                Execution Cockpit
              </span>
              {isRunning && (
                <span className="flex items-center gap-1 font-mono text-[10px] text-[color:var(--neon-cyan)]">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--neon-cyan)] opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[color:var(--neon-cyan)]" />
                  </span>
                  live
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm text-foreground">
              <HeaderIcon
                className={cn(
                  "h-4 w-4",
                  isRunning && !hasError && !isSuccessful && "animate-spin",
                  hasError ? "text-rose-300" : "text-[color:var(--neon-violet)]",
                )}
                aria-hidden
              />
              <span className="truncate">{headerLabel}</span>
              <span className="text-muted-foreground">·</span>
              <span className="truncate text-muted-foreground">{headerDetail}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:min-w-[300px]">
            <span className="flex items-center justify-end gap-1.5">
              <Clock3 className="h-3 w-3" />
              {fmtElapsed(elapsedMs)}
            </span>
            <span className="flex items-center justify-end gap-1.5">
              <Activity className="h-3 w-3" />
              {doneCount}/{list.length}
            </span>
            <span
              className={cn(
                "flex items-center justify-end gap-1.5",
                hasError ? "text-rose-300" : "text-[color:var(--neon-cyan)]",
              )}
            >
              <Gauge className="h-3 w-3" />
              {progress}%
            </span>
          </div>
        </div>

        <Progress
          value={progress}
          className="mt-3 h-1.5 bg-white/10"
          aria-label="Estimated execution progress"
        />
      </header>

      <div className="grid gap-2 border-b border-white/5 bg-black/10 px-4 py-3 sm:grid-cols-5 lg:grid-cols-10">
        {PHASE_PLAN.map((step, index) => {
          const matched = list.some((event) => matchesPlan(event, step));
          const failed =
            list.some((event) => event.status === "error" && matchesPlan(event, step)) ||
            (hasError && index === activeIndex);
          const state = failed
            ? "error"
            : matched && index <= activeIndex
              ? "seen"
              : index === activeIndex
                ? "active"
                : "queued";
          return (
            <div
              key={step.label}
              className={cn(
                "min-h-[66px] rounded-md border px-2.5 py-2 transition-colors",
                state === "active" &&
                  "border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 text-[color:var(--neon-cyan)]",
                state === "seen" && "border-emerald-400/30 bg-emerald-400/5 text-emerald-200",
                state === "queued" && "border-white/8 bg-white/[0.025] text-muted-foreground",
                state === "error" && "border-rose-400/35 bg-rose-400/10 text-rose-200",
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
                  {step.label}
                </span>
                {state === "active" ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : state === "seen" ? (
                  <Check className="h-3 w-3" aria-hidden />
                ) : state === "error" ? (
                  <X className="h-3 w-3" aria-hidden />
                ) : (
                  <span className="h-2 w-2 rounded-full border border-current opacity-40" />
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug opacity-80">{step.detail}</p>
            </div>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        className="max-h-[260px] overflow-auto bg-black/30 px-4 py-3 font-mono text-[12px] leading-relaxed"
      >
        {list.length === 0 ? (
          <div className="space-y-1 text-muted-foreground">
            <p>// run submitted locally</p>
            <p>// waiting for backend telemetry or completed artifact...</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {list.map((e) => (
              <li
                key={e.id}
                className={cn(
                  "flex items-start gap-2",
                  e.status === "queued" && "text-muted-foreground/60",
                  e.status === "running" && "text-[color:var(--neon-cyan)]",
                  e.status === "done" && "text-foreground/90",
                  e.status === "error" && "text-rose-300",
                )}
              >
                <span className="shrink-0 text-muted-foreground/70">[{fmtTime(e.ts)}]</span>
                <StatusIcon status={e.status} />
                <span className="shrink-0 font-semibold">{e.phase}</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="min-w-0 flex-1 break-words">{e.message}</span>
                {e.durationMs != null && e.status === "done" && (
                  <span className="shrink-0 text-muted-foreground/60">{e.durationMs}ms</span>
                )}
              </li>
            ))}
            {isRunning && (
              <li className="flex items-center gap-2 text-[color:var(--neon-cyan)]">
                <span className="text-muted-foreground/70">[{fmtTime(Date.now())}]</span>
                <span className="animate-pulse">▮</span>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

function StatusIcon({ status }: { status: ExecutionEvent["status"] }) {
  if (status === "running")
    return <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" aria-hidden />;
  if (status === "done") return <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />;
  if (status === "error") return <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />;
  return <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full border border-current opacity-40" />;
}
