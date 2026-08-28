import { Plus, X } from "lucide-react";
import { TECHNIQUES, tacticById, sortByTactic } from "@/lib/mitre-catalog";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useState } from "react";

interface Props {
  selected: string[];
  onChange: (next: string[]) => void;
}

const tacticTone: Record<string, string> = {
  "initial-access": "border-rose-400/40 bg-rose-400/10 text-rose-200",
  execution: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  persistence: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  "privilege-escalation": "border-orange-400/40 bg-orange-400/10 text-orange-200",
  "defense-evasion": "border-violet-400/40 bg-violet-400/10 text-violet-200",
  "credential-access": "border-rose-400/40 bg-rose-400/10 text-rose-200",
  discovery: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  "lateral-movement": "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  collection: "border-indigo-400/40 bg-indigo-400/10 text-indigo-200",
  "command-and-control": "border-violet-400/40 bg-violet-400/10 text-violet-200",
  exfiltration: "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200",
  impact: "border-rose-500/50 bg-rose-500/15 text-rose-200",
  reconnaissance: "border-slate-400/40 bg-slate-400/10 text-slate-200",
  "resource-development": "border-slate-400/40 bg-slate-400/10 text-slate-200",
};

export function MitreChips({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ordered = sortByTactic(selected);

  const remove = (id: string) => onChange(selected.filter((s) => s !== id));
  const add = (id: string) => {
    if (!selected.includes(id)) onChange([...selected, id]);
  };

  const filtered = TECHNIQUES.filter(
    (t) =>
      !selected.includes(t.id) &&
      (query.trim() === "" ||
        t.id.toLowerCase().includes(query.toLowerCase()) ||
        t.name.toLowerCase().includes(query.toLowerCase()) ||
        t.tactic.includes(query.toLowerCase())),
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ordered.length === 0 && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
          No techniques mapped — describe the scenario or pick from library
        </span>
      )}
      {ordered.map((t) => {
        const tac = tacticById(t.tactic);
        return (
          <span
            key={t.id}
            className={cn(
              "group inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] tabular-nums",
              tacticTone[t.tactic] ?? "border-white/10 bg-white/5 text-foreground/80",
            )}
            title={`${tac.label} · ${t.name}`}
          >
            <span className="font-semibold">{t.id}</span>
            <span className="text-[10px] opacity-80">{t.name}</span>
            <button
              type="button"
              onClick={() => remove(t.id)}
              className="ml-0.5 rounded p-0.5 opacity-50 transition hover:bg-white/10 hover:opacity-100"
              aria-label={`Remove ${t.id}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/[0.05] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[color:var(--neon-cyan)] hover:bg-[color:var(--neon-cyan)]/15"
          >
            <Plus className="h-2.5 w-2.5" />
            Add technique
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 border-white/10 bg-[oklch(0.13_0.025_260)] p-2 text-foreground"
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search T-ID, name, or tactic…"
            className="mb-2 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-[color:var(--neon-cyan)]/50"
          />
          <div className="max-h-72 overflow-y-auto pr-1">
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                Nothing matches.
              </p>
            )}
            {filtered.map((t) => {
              const tac = tacticById(t.tactic);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    add(t.id);
                    setQuery("");
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/[0.06]"
                >
                  <span className="mt-0.5 font-mono text-[10px] tabular-nums text-[color:var(--neon-cyan)]">
                    {t.id}
                  </span>
                  <span className="flex-1">
                    <span className="block">{t.name}</span>
                    <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                      {tac.label}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { tacticTone };
