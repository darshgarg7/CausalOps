import type { ExecutionEvent, ExecutionMode, RunResponse } from "./causalops-types";
import {
  enqueueRun,
  fetchRunResult,
  fetchRunStatus,
  newRunId,
  RUN_POLL_TIMEOUT_MS,
  streamRunEvents,
} from "./causalops-api";

function uid() {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function localEvent(
  phase: string,
  message: string,
  status: ExecutionEvent["status"] = "running",
  durationMs?: number,
): ExecutionEvent {
  return {
    id: `local-${phase.toLowerCase()}`,
    phase,
    message,
    status,
    ts: Date.now(),
    ...(durationMs == null ? {} : { durationMs }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunReady(
  runId: string,
  getTerminalPhase: () => ExecutionEvent["phase"] | null,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (getTerminalPhase() === "COMPLETE") {
      return;
    }

    try {
      const status = await fetchRunStatus(runId);
      if (status.status === "failed") {
        throw new Error(status.error ?? `Run ${runId} failed.`);
      }
      if (status.status === "completed" && status.artifact) {
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("failed")) {
        throw err;
      }
    }

    await sleep(500);
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for run to finish.`,
  );
}

/**
 * Enqueues a run, streams SSE telemetry, then fetches the artifact when complete.
 */
export async function executeWithProgress(
  taskDescription: string,
  onEvent: (event: ExecutionEvent) => void,
  options?: { executionMode?: ExecutionMode },
): Promise<RunResponse> {
  const runId = newRunId();
  const controller = new AbortController();
  let terminalPhase: ExecutionEvent["phase"] | null = null;
  const startedAt = performance.now();

  const executionMode = options?.executionMode ?? "standard";

  onEvent(
    localEvent(
      "SUBMIT",
      executionMode === "deep"
        ? "Opening telemetry stream for deep swarm run"
        : "Opening telemetry stream for standard fast run",
    ),
  );

  const stopStream = streamRunEvents(
    runId,
    (event) => {
      onEvent(event);
      if (event.phase === "COMPLETE" || event.phase === "ERROR") {
        terminalPhase = event.phase;
      }
    },
    controller.signal,
  );

  try {
    const enqueueStartedAt = performance.now();
    const enqueued = await enqueueRun(taskDescription, { runId, executionMode });
    onEvent(
      localEvent(
        "SUBMIT",
        `Run ${enqueued.run_id} accepted by coordinator`,
        "done",
        Math.round(performance.now() - enqueueStartedAt),
      ),
    );

    if (enqueued.mode === "sync") {
      onEvent(
        localEvent(
          "COMPLETE",
          "Synchronous artifact received",
          "done",
          Math.round(performance.now() - startedAt),
        ),
      );
      return enqueued.artifact;
    }

    onEvent(
      localEvent(
        "WAIT",
        executionMode === "deep"
          ? "Full swarm is reasoning; waiting for streamed artifacts"
          : "Specialists are drafting concise memos; waiting for artifact",
      ),
    );
    await waitForRunReady(enqueued.run_id, () => terminalPhase, RUN_POLL_TIMEOUT_MS);
    onEvent(localEvent("FETCH", "Loading completed run artifact"));
    const result = await fetchRunResult(enqueued.run_id);
    onEvent(
      localEvent(
        "COMPLETE",
        "Run artifact ready",
        "done",
        Math.round(performance.now() - startedAt),
      ),
    );
    return result;
  } catch (err) {
    onEvent({
      id: uid(),
      phase: "ERROR",
      message: err instanceof Error ? err.message : "Execution failed",
      status: "error",
      ts: Date.now(),
    });
    throw err;
  } finally {
    controller.abort();
    stopStream();
  }
}
