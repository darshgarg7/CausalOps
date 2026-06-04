import { FileDown, History, MoreHorizontal, RotateCw, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { HistoryEntry } from "@/lib/hivemind-types";
import { fmt } from "@/lib/derived-metrics";
import { cn } from "@/lib/utils";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function absTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

interface RunHistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: HistoryEntry[];
  activeId: string | null;
  onSelect: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onReRun: (entry: HistoryEntry) => void;
  onExport: (entry: HistoryEntry) => void;
}

export function RunHistoryDrawer({
  open,
  onOpenChange,
  history,
  activeId,
  onSelect,
  onDelete,
  onClear,
  onReRun,
  onExport,
}: RunHistoryDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 border-l border-white/10 bg-[oklch(0.13_0.025_260)] p-0 sm:max-w-md"
      >
        <SheetHeader className="space-y-1 border-b border-white/5 px-5 py-4">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-foreground">
              <History className="h-4 w-4 text-[color:var(--neon-cyan)]" />
              Run History
              <span className="font-mono text-xs font-normal text-muted-foreground">
                ({history.length})
              </span>
            </SheetTitle>
            {history.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-rose-400/40 hover:text-rose-300"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear all run history?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Permanently removes all {history.length} stored runs from this browser. This
                      cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onClear}>Clear all</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          <SheetDescription className="text-xs text-muted-foreground">
            Stored locally in this browser. Press{" "}
            <kbd className="rounded border border-white/10 bg-white/5 px-1 font-mono text-[10px]">
              H
            </kbd>{" "}
            to toggle.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-auto p-3">
          {!open ? null : history.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <History className="h-6 w-6 opacity-50" />
              <p>No runs yet.</p>
              <p className="text-xs opacity-70">Completed runs appear here automatically.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {history.map((e) => {
                const conf = e.confidence?.toLowerCase();
                const confColor =
                  conf === "high"
                    ? "bg-emerald-400 shadow-[0_0_8px_var(--neon-emerald)]"
                    : conf === "low"
                      ? "bg-rose-400 shadow-[0_0_8px_var(--neon-rose)]"
                      : "bg-amber-400";
                const isActive = e.id === activeId;
                return (
                  <li
                    key={e.id}
                    className={cn(
                      "group relative overflow-hidden rounded-xl border bg-white/[0.02] transition-all",
                      isActive
                        ? "border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/[0.06]"
                        : "border-white/5 hover:border-white/15 hover:bg-white/[0.04]",
                    )}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-0 h-full w-0.5 bg-[color:var(--neon-cyan)]" />
                    )}
                    <button
                      type="button"
                      onClick={() => onSelect(e)}
                      className="block w-full px-3 py-2.5 text-left"
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <span title={absTime(e.timestamp)}>{relTime(e.timestamp)}</span>
                        <span className="flex items-center gap-1.5">
                          <span className={cn("h-1.5 w-1.5 rounded-full", confColor)} />
                          <span className="font-mono">ATE {fmt.ate(e.ate)}</span>
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-foreground/90">
                        {e.taskExcerpt}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                        <span className="truncate">{e.runId}</span>
                        <span>{e.strategyCount} strat</span>
                      </div>
                    </button>
                    <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => onReRun(e)}>
                            <RotateCw className="mr-2 h-3.5 w-3.5" /> Load into prompt
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onExport(e)}>
                            <FileDown className="mr-2 h-3.5 w-3.5" /> Export PDF
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDelete(e.id)}
                            className="text-rose-300 focus:text-rose-300"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
