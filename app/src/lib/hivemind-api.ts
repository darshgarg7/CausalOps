import type {
  EnqueueResult,
  ExecutionEvent,
  RunEnqueueResponse,
  RunResponse,
  RunStatusResponse,
} from "./hivemind-types";
import { parseRunResponse, SchemaValidationError } from "./hivemind-schema";

const DEFAULT_ENDPOINT = "http://localhost:8000/run";
const STORAGE_KEY = "hivemind:apiUrl";
const ENQUEUE_TIMEOUT_MS = 30_000;
const RUN_POLL_TIMEOUT_MS = 600_000;
const RUN_POLL_INTERVAL_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveApiEndpoint(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_ENDPOINT;

  // Relative "/run" always targets the FastAPI backend in local compose.
  if (trimmed === "/run") return DEFAULT_ENDPOINT;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const withPath = /\/run$/i.test(withScheme) ? withScheme : `${withScheme}/run`;

  if (typeof window !== "undefined") {
    try {
      const target = new URL(withPath);
      const ui = new URL(window.location.href);
      // Avoid the UI dev server's mock POST /run route on port 8080.
      if (target.origin === ui.origin) {
        return DEFAULT_ENDPOINT;
      }
    } catch {
      return DEFAULT_ENDPOINT;
    }
  }

  return withPath;
}

export function getApiUrl(): string {
  if (typeof window === "undefined") return DEFAULT_ENDPOINT;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim()) return resolveApiEndpoint(stored);
  } catch {
    /* ignore */
  }
  return DEFAULT_ENDPOINT;
}

/** API origin without the `/run` suffix (for SSE and health). */
export function getApiBase(): string {
  return getApiUrl().replace(/\/run\/?$/i, "");
}

export function setApiUrl(url: string): string {
  const next = url.trim();
  if (typeof window !== "undefined") {
    try {
      if (!next) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }
  return getApiUrl();
}

export function clearApiUrl(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export const DEFAULT_API_URL = DEFAULT_ENDPOINT;

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const suffix =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `run-${stamp}-${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function streamRunEvents(
  runId: string,
  onEvent: (event: ExecutionEvent) => void,
  signal?: AbortSignal,
  onError?: (message: string) => void,
): () => void {
  const url = `${getApiBase()}/run/${encodeURIComponent(runId)}/events`;
  const source = new EventSource(url);
  let reportedError = false;

  const onMessage = (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as ExecutionEvent;
      onEvent(parsed);
    } catch {
      /* ignore malformed SSE payloads */
    }
  };

  const onStreamError = () => {
    if (reportedError || source.readyState === EventSource.CLOSED) return;
    reportedError = true;
    onError?.(
      "Lost connection to execution stream. Check that the API is running and KAFKA_BOOTSTRAP is set.",
    );
  };

  source.addEventListener("message", onMessage as EventListener);
  source.onerror = onStreamError;

  const abort = () => {
    source.removeEventListener("message", onMessage as EventListener);
    source.onerror = null;
    source.close();
  };

  signal?.addEventListener("abort", abort, { once: true });

  return abort;
}

export async function enqueueRun(
  taskDescription: string,
  options?: { runId?: string },
): Promise<EnqueueResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENQUEUE_TIMEOUT_MS);
  const endpoint = getApiUrl();
  const runId = options?.runId;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Bypass-Tunnel-Reminder": "true",
      },
      body: JSON.stringify({
        task_description: taskDescription,
        ...(runId ? { run_id: runId } : {}),
      }),
      signal: controller.signal,
    });

    const json: unknown = await res.json().catch(() => null);

    if (res.status === 200 && isRecord(json)) {
      return {
        mode: "sync",
        run_id: String(json.run_id ?? runId ?? newRunId()),
        artifact: parseRunResponse(json),
      };
    }

    if (res.status === 202 && isRecord(json)) {
      const body = json as RunEnqueueResponse;
      return {
        mode: "async",
        run_id: String(body.run_id ?? runId ?? newRunId()),
        status: body.status === "queued" ? "queued" : "queued",
      };
    }

    const text = json ? JSON.stringify(json).slice(0, 200) : "";
    throw new Error(`Backend returned ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      throw err;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Enqueue request timed out after 30 seconds.");
    }
    if (err instanceof TypeError) {
      throw new Error(
        `Could not reach the HiveMind backend at ${endpoint}. Check the API is running on port 8000.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRunStatus(runId: string): Promise<RunStatusResponse> {
  const res = await fetch(`${getApiBase()}/run/${encodeURIComponent(runId)}`, {
    headers: { "Bypass-Tunnel-Reminder": "true" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch run status (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  return (await res.json()) as RunStatusResponse;
}

export async function fetchRunResult(runId: string): Promise<RunResponse> {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await fetchRunStatus(runId);
    if (status.status === "completed" && status.artifact) {
      return parseRunResponse(status);
    }
    if (status.status === "failed") {
      throw new Error(status.error ?? `Run ${runId} failed.`);
    }
    await sleep(RUN_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${Math.round(RUN_POLL_TIMEOUT_MS / 60_000)} minutes waiting for run ${runId}.`,
  );
}

/** Convenience wrapper for callers that only need the final artifact. */
export async function runCausalEngine(
  taskDescription: string,
  options?: { runId?: string },
): Promise<RunResponse> {
  const runId = options?.runId ?? newRunId();
  const enqueued = await enqueueRun(taskDescription, { runId });
  if (enqueued.mode === "sync") {
    return enqueued.artifact;
  }
  return fetchRunResult(enqueued.run_id);
}

export async function fetch5DGraph(runId: string): Promise<any> {
  const res = await fetch(`${getApiBase()}/run/${encodeURIComponent(runId)}/graph/5d`, {
    headers: { "Bypass-Tunnel-Reminder": "true" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch 5D graph (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
  return await res.json();
}

export { SchemaValidationError, parseRunResponse };
export { extractRunArtifact } from "./hivemind-schema";
