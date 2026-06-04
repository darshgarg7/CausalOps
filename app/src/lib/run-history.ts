import type { HistoryEntry, RunResponse } from "./hivemind-types";

const STORAGE_KEY = "hivemind:history:v1";
const MAX_ENTRIES = 50;

function isBrowser() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function loadHistory(): HistoryEntry[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e === "object" && "runId" in e)
      .map((e) => ({
        ...e,
        ate: e.ate == null ? null : Number(e.ate),
      }));
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]) {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  } catch {
    // quota exceeded — drop oldest half and retry once
    try {
      const trimmed = entries.slice(0, Math.floor(entries.length / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* give up */
    }
  }
}

export function appendHistory(task: string, payload: RunResponse): HistoryEntry {
  const entry: HistoryEntry = {
    id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    runId: payload.run_id,
    timestamp: Date.now(),
    taskExcerpt: task.slice(0, 140),
    taskFull: task,
    ate: payload.impact?.ate ?? null,
    confidence: payload.impact?.confidence ?? "unknown",
    strategyCount: payload.strategies.length,
    payload,
  };
  const next = [entry, ...loadHistory()].slice(0, MAX_ENTRIES);
  saveHistory(next);
  return entry;
}

export function deleteHistoryEntry(id: string) {
  saveHistory(loadHistory().filter((e) => e.id !== id));
}

export function clearHistory() {
  saveHistory([]);
}

export const HISTORY_STORAGE_KEY = STORAGE_KEY;
