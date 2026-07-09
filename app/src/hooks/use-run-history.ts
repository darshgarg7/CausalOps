import { useCallback, useEffect, useState } from "react";
import type { HistoryEntry, RunResponse } from "@/lib/causalops-types";
import {
  HISTORY_STORAGE_KEY,
  appendHistory,
  clearHistory,
  deleteHistoryEntry,
  loadHistory,
} from "@/lib/run-history";

export function useRunHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    setHistory(loadHistory());
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === HISTORY_STORAGE_KEY) {
        setHistory(loadHistory());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const add = useCallback((task: string, payload: RunResponse) => {
    const entry = appendHistory(task, payload);
    setHistory(loadHistory());
    return entry;
  }, []);

  const remove = useCallback((id: string) => {
    deleteHistoryEntry(id);
    setHistory(loadHistory());
  }, []);

  const clear = useCallback(() => {
    clearHistory();
    setHistory([]);
  }, []);

  return { history, add, remove, clear };
}
