import { useEffect, useState } from "react";
import { Loader2, Plug, RotateCcw, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { DEFAULT_API_URL, clearApiUrl, getApiUrl, setApiUrl } from "@/lib/causalops-api";
import { cn } from "@/lib/utils";

interface ApiSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange?: (url: string) => void;
}

type ProbeState =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ok"; latencyMs: number }
  | { status: "error"; message: string };

export function ApiSettingsDialog({ open, onOpenChange, onChange }: ApiSettingsDialogProps) {
  const [value, setValue] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });

  useEffect(() => {
    if (open) {
      setValue(getApiUrl());
      setProbe({ status: "idle" });
    }
  }, [open]);

  const handleSave = () => {
    const next = setApiUrl(value);
    onChange?.(next);
    toast.success("API endpoint updated", { description: next });
    onOpenChange(false);
  };

  const handleReset = () => {
    clearApiUrl();
    setValue(DEFAULT_API_URL);
    onChange?.(DEFAULT_API_URL);
    toast.message("Reverted to default endpoint", { description: DEFAULT_API_URL });
  };

  const handleProbe = async () => {
    const target = value.trim().replace(/\/+$/, "") || DEFAULT_API_URL;
    const url = target === "/run" || /\/run$/i.test(target) ? target : `${target}/run`;
    setProbe({ status: "probing" });
    const t0 = performance.now();
    try {
      // Lightweight reachability probe — backend may 405/400 on OPTIONS/GET,
      // which still proves the host is alive and CORS is reachable.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const headers = { "Bypass-Tunnel-Reminder": "true" };
      await fetch(url, { method: "OPTIONS", mode: "cors", headers, signal: ctrl.signal }).catch(
        async () => fetch(url, { method: "GET", mode: "cors", headers, signal: ctrl.signal }),
      );
      clearTimeout(timer);
      setProbe({ status: "ok", latencyMs: Math.round(performance.now() - t0) });
    } catch (err) {
      setProbe({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "Unreachable — check tunnel URL, CORS, and that the backend is running.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-[oklch(0.14_0.03_260)]/95 backdrop-blur sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Plug className="h-4 w-4 text-[color:var(--neon-cyan)]" />
            Backend Endpoint
          </DialogTitle>
          <DialogDescription>
            CausalOps runs against the built-in backend by default. Override this only if you want to
            point execution at your own public causal engine endpoint.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Label
            htmlFor="api-url"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground"
          >
            API URL
          </Label>
          <Input
            id="api-url"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setProbe({ status: "idle" });
            }}
            placeholder="/run"
            className="border-white/10 bg-black/40 font-mono text-sm"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-[11px] text-muted-foreground">
            Use the FastAPI backend at <code className="font-mono">{DEFAULT_API_URL}</code>. URLs on
            this UI origin (port 8080) are redirected to port 8000 automatically.
          </p>

          <div
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
              probe.status === "ok" && "border-emerald-400/30 bg-emerald-400/5 text-emerald-300",
              probe.status === "error" && "border-rose-400/30 bg-rose-400/5 text-rose-300",
              (probe.status === "idle" || probe.status === "probing") &&
                "border-white/10 bg-white/[0.02] text-muted-foreground",
            )}
          >
            {probe.status === "probing" && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing endpoint…
              </>
            )}
            {probe.status === "ok" && (
              <>
                <ShieldCheck className="h-3.5 w-3.5" /> Reachable · {probe.latencyMs}ms round-trip
              </>
            )}
            {probe.status === "error" && (
              <>
                <ShieldAlert className="h-3.5 w-3.5" />
                <span className="truncate">{probe.message}</span>
              </>
            )}
            {probe.status === "idle" && (
              <>
                <ShieldAlert className="h-3.5 w-3.5 opacity-50" /> Untested — run a probe before
                executing.
              </>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset to default
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleProbe}
              disabled={probe.status === "probing"}
              className="border-white/15"
            >
              {probe.status === "probing" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="mr-1.5 h-3.5 w-3.5" />
              )}
              Test connection
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              className="bg-[color:var(--neon-cyan)] text-[color:oklch(0.12_0.03_260)] hover:opacity-90"
            >
              Save endpoint
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
