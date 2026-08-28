import { ArrowRight, GitBranch, Hash, X } from "lucide-react";
import type { CausalEdge, CausalNode, CausalGraph } from "@/lib/causalops-types";

interface NodeInspectorProps {
  node: CausalNode | null;
  edge: CausalEdge | null;
  graph: CausalGraph;
  onClose: () => void;
}

export function NodeInspector({ node, edge, graph, onClose }: NodeInspectorProps) {
  if (!node && !edge) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
        <Hash className="h-4 w-4 opacity-50" />
        <p>Click a node or edge to inspect.</p>
      </div>
    );
  }

  if (edge) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Edge</p>
            <p className="mt-1 font-mono text-xs text-foreground/90">
              {edge.source} → {edge.target}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">
          <Field label="Relationship">
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-foreground/90">
              {edge.relationship}
            </span>
          </Field>
          <Field label="Source">
            <span className="font-mono text-[color:var(--neon-cyan)]">{edge.source}</span>
          </Field>
          <Field label="Target">
            <span className="font-mono text-[color:var(--neon-violet)]">{edge.target}</span>
          </Field>
          {edge.required_evidence && edge.required_evidence.length > 0 && (
            <Field label="Required evidence">
              <MiniList items={edge.required_evidence} />
            </Field>
          )}
          {edge.falsification_tests && edge.falsification_tests.length > 0 && (
            <Field label="Falsification tests">
              <MiniList items={edge.falsification_tests} />
            </Field>
          )}
        </div>
      </div>
    );
  }

  if (!node) return null;

  const incoming = graph.edges.filter((e) => e.target === node.id);
  const outgoing = graph.edges.filter((e) => e.source === node.id);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Node</p>
          <p className="mt-1 truncate font-semibold text-foreground">{node.label || node.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="space-y-4 overflow-auto p-4 text-sm">
        <Field label="ID">
          <span className="font-mono text-xs text-[color:var(--neon-cyan)]">{node.id}</span>
        </Field>
        {node.description && (
          <Field label="Description">
            <p className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5 text-xs leading-relaxed text-foreground/85">
              {node.description}
            </p>
          </Field>
        )}
        <Field label="Degree">
          <span className="font-mono text-xs">
            {incoming.length} in · {outgoing.length} out
          </span>
        </Field>

        <EdgeList title="Incoming" edges={incoming} highlightSide="source" />
        <EdgeList title="Outgoing" edges={outgoing} highlightSide="target" />
      </div>
    </div>
  );
}

function MiniList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li
          key={item}
          className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5 text-xs text-foreground/85"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}

function EdgeList({
  title,
  edges,
  highlightSide,
}: {
  title: string;
  edges: CausalEdge[];
  highlightSide: "source" | "target";
}) {
  if (edges.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <GitBranch className="h-3 w-3" />
        {title}
      </div>
      <ul className="space-y-1.5">
        {edges.map((e, i) => (
          <li
            key={`${e.source}-${e.target}-${i}`}
            className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5 text-xs"
          >
            <span
              className={
                highlightSide === "source"
                  ? "font-mono text-[color:var(--neon-cyan)]"
                  : "font-mono text-foreground/70"
              }
            >
              {e.source}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider">
              {e.relationship}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span
              className={
                highlightSide === "target"
                  ? "font-mono text-[color:var(--neon-violet)]"
                  : "font-mono text-foreground/70"
              }
            >
              {e.target}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
