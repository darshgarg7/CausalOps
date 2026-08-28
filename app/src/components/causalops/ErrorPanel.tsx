import { AlertTriangle } from "lucide-react";
import type { SchemaIssue } from "@/lib/causalops-schema";

export function ErrorPanel({
  message,
  schemaIssues,
  raw,
}: {
  message: string;
  schemaIssues?: SchemaIssue[];
  raw?: unknown;
}) {
  return (
    <section
      role="alert"
      className="glass relative overflow-hidden rounded-2xl border-rose-400/30 p-6"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-rose-400/70 to-transparent" />
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 ring-1 ring-rose-400/40">
          <AlertTriangle className="h-4 w-4 text-rose-300" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-300">
            {schemaIssues ? "Backend response failed validation" : "Execution failed"}
          </h2>
          <p className="text-sm text-foreground/90">{message}</p>
          {!schemaIssues && (
            <p className="text-xs text-muted-foreground">
              Check that the backend is running at{" "}
              <span className="font-mono">http://localhost:8000</span> and that CORS allows this
              origin.
            </p>
          )}
          {schemaIssues && schemaIssues.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Issues ({schemaIssues.length}) — UI render blocked to prevent partial state
              </p>
              <ul className="space-y-1 rounded-lg border border-rose-400/20 bg-rose-500/[0.04] p-3 text-xs">
                {schemaIssues.map((iss, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2 font-mono">
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-200">
                      {iss.path}
                    </span>
                    <span className="text-foreground/80">{iss.message}</span>
                    <span className="text-muted-foreground/60">[{iss.code}]</span>
                  </li>
                ))}
              </ul>
              {raw !== undefined && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none font-mono uppercase tracking-wider hover:text-foreground">
                    Raw response
                  </summary>
                  <pre className="mt-2 max-h-60 overflow-auto rounded-lg border border-white/5 bg-black/40 p-3 text-[11px] text-foreground/80">
                    {safeStringify(raw)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
