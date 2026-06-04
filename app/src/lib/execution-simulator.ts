import type { ExecutionEvent, RunResponse } from "./hivemind-types";
import {
  enqueueRun,
  fetchRunResult,
  fetchRunStatus,
  newRunId,
  streamRunEvents,
} from "./hivemind-api";

function uid() {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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

  throw new Error("Timed out waiting for run to finish.");
}

/**
 * Enqueues a run, streams SSE telemetry, then fetches the artifact when complete.
 */
export async function executeWithProgress(
  taskDescription: string,
  onEvent: (event: ExecutionEvent) => void,
): Promise<RunResponse> {
  const runId = newRunId();
  const controller = new AbortController();
  let terminalPhase: ExecutionEvent["phase"] | null = null;

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
    const enqueued = await enqueueRun(taskDescription, { runId });

    if (enqueued.mode === "sync") {
      return enqueued.artifact;
    }

    await waitForRunReady(enqueued.run_id, () => terminalPhase, 600_000);
    return await fetchRunResult(enqueued.run_id);
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
