import { forwardRef, useMemo, useState } from "react";
import { ArrowRight, GitBranch, Network, Table2, Workflow } from "lucide-react";
import type { CausalEdge, CausalGraph, CausalNode } from "@/lib/hivemind-types";
import { CausalGraph as CausalGraphViz, type CausalGraphHandle } from "./CausalGraph";
import { NodeInspector } from "./NodeInspector";
import { cn } from "@/lib/utils";
import { evidenceColor, evidenceLabel, type EdgeAnnotation } from "@/lib/agent-runtime";

interface CausalGraphPanelProps {
  graph: CausalGraph;
  edgeAnnotations?: EdgeAnnotation[];
  compact?: boolean;
}

export const CausalGraphPanel = forwardRef<CausalGraphHandle, CausalGraphPanelProps>(
  function CausalGraphPanel({ graph, edgeAnnotations, compact = false }, ref) {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];
    const [view, setView] = useState<"graph" | "table">("graph");
    const [selectedNode, setSelectedNode] = useState<CausalNode | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<CausalEdge | null>(null);
    const isSparseGraph = nodes.length > 0 && nodes.length <= 6;

    const annByKey = useMemo(() => {
      const m = new Map<string, EdgeAnnotation>();
      if (edgeAnnotations) for (const a of edgeAnnotations) m.set(a.key, a);
      return m;
    }, [edgeAnnotations]);
    const orderedNodes = useMemo(() => orderNodes(graph), [graph]);

    return (
      <section className="glass overflow-hidden rounded-2xl">
        <header className="flex items-center justify-between border-b border-white/5 px-6 py-4">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-[color:var(--neon-violet)]" aria-hidden />
            <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground">
              Causal Graph
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden gap-3 font-mono text-xs text-muted-foreground sm:flex">
              <span>{nodes.length} nodes</span>
              <span className="text-white/20">·</span>
              <span>{edges.length} edges</span>
              {edgeAnnotations && edgeAnnotations.length > 0 && (
                <>
                  <span className="text-white/20">·</span>
                  <span className="text-emerald-300/80">
                    {edgeAnnotations.filter((e) => e.validated).length} validated
                  </span>
                </>
              )}
            </div>
            <div className="flex rounded-lg border border-white/10 bg-black/30 p-0.5">
              <button
                type="button"
                onClick={() => setView("graph")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors",
                  view === "graph"
                    ? "bg-[color:var(--neon-cyan)]/15 text-[color:var(--neon-cyan)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Workflow className="h-3 w-3" />
                Graph
              </button>
              <button
                type="button"
                onClick={() => setView("table")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors",
                  view === "table"
                    ? "bg-[color:var(--neon-cyan)]/15 text-[color:var(--neon-cyan)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Table2 className="h-3 w-3" />
                Tables
              </button>
            </div>
          </div>
        </header>

        {view === "graph" ? (
          <div
            className={cn(
              "grid gap-px bg-white/5",
              compact ? "grid-cols-1" : "lg:grid-cols-[1fr_280px]",
            )}
          >
            <div className="min-w-0 bg-[oklch(0.16_0.03_260/0.6)] p-3">
              {isSparseGraph ? (
                <CausalDAGBoard
                  graph={graph}
                  orderedNodes={orderedNodes}
                  edgeAnnotations={edgeAnnotations}
                  compact={compact}
                  onSelectNode={(node) => {
                    setSelectedNode(node);
                    setSelectedEdge(null);
                  }}
                  onSelectEdge={(edge) => {
                    setSelectedEdge(edge);
                    setSelectedNode(null);
                  }}
                />
              ) : (
                <CausalGraphViz
                  ref={ref}
                  graph={graph}
                  edgeAnnotations={edgeAnnotations}
                  onSelectNode={(n) => {
                    setSelectedNode(n);
                    if (n) setSelectedEdge(null);
                  }}
                  onSelectEdge={(e) => {
                    setSelectedEdge(e);
                    if (e) setSelectedNode(null);
                  }}
                  height={compact ? 420 : 480}
                />
              )}
            </div>
            <aside
              className={cn("bg-[oklch(0.16_0.03_260/0.6)]", compact && "border-t border-white/5")}
            >
              <NodeInspector
                node={selectedNode}
                edge={selectedEdge}
                graph={graph}
                onClose={() => {
                  setSelectedNode(null);
                  setSelectedEdge(null);
                }}
              />
            </aside>
          </div>
        ) : (
          <div className="grid gap-px bg-white/5 lg:grid-cols-2">
            {/* Nodes */}
            <div className="bg-[oklch(0.16_0.03_260/0.6)]">
              <div className="flex items-center gap-2 px-6 py-3 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--neon-cyan)]" />
                Nodes
              </div>
              <div className="max-h-[420px] overflow-auto px-2 pb-3">
                {nodes.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">No nodes.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-[oklch(0.16_0.03_260/0.85)] backdrop-blur">
                      <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-2 font-medium">ID</th>
                        <th className="px-4 py-2 font-medium">Label</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodes.map((n) => (
                        <tr
                          key={n.id}
                          className="border-t border-white/5 transition-colors hover:bg-white/5"
                        >
                          <td className="px-4 py-2.5 font-mono text-xs text-[color:var(--neon-cyan)]">
                            {n.id}
                          </td>
                          <td className="px-4 py-2.5 text-foreground/90">{n.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Edges */}
            <div className="bg-[oklch(0.16_0.03_260/0.6)]">
              <div className="flex items-center gap-2 px-6 py-3 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                <GitBranch className="h-3 w-3 text-[color:var(--neon-violet)]" aria-hidden />
                Edges
              </div>
              <div className="max-h-[420px] overflow-auto px-2 pb-3">
                {edges.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">No edges.</p>
                ) : (
                  <ul className="space-y-1.5 px-2 py-1">
                    {edges.map((e, i) => {
                      const ann = annByKey.get(`${e.source}->${e.target}`);
                      return (
                        <li
                          key={`${e.source}-${e.target}-${i}`}
                          className="group flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-[color:var(--neon-violet)]/30 hover:bg-white/[0.04]"
                        >
                          <span className="font-mono text-xs text-[color:var(--neon-cyan)]">
                            {e.source}
                          </span>
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <ArrowRight className="h-3 w-3" aria-hidden />
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider">
                              {e.relationship}
                            </span>
                            <ArrowRight className="h-3 w-3" aria-hidden />
                          </div>
                          <span className="font-mono text-xs text-[color:var(--neon-violet)]">
                            {e.target}
                          </span>
                          {ann && (
                            <span className="ml-auto flex items-center gap-1.5">
                              <span
                                className="rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                                style={{
                                  color: evidenceColor(ann.evidenceType),
                                }}
                                title={ann.evidenceSummary}
                              >
                                {evidenceLabel(ann.evidenceType)}
                              </span>
                              <span className="font-mono text-[10px] tabular-nums text-foreground/85">
                                {Math.round(ann.confidence * 100)}%
                              </span>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    );
  },
);

function CausalDAGBoard({
  graph,
  orderedNodes,
  edgeAnnotations,
  compact,
  onSelectNode,
  onSelectEdge,
}: {
  graph: CausalGraph;
  orderedNodes: CausalNode[];
  edgeAnnotations?: EdgeAnnotation[];
  compact: boolean;
  onSelectNode: (node: CausalNode) => void;
  onSelectEdge: (edge: CausalEdge) => void;
}) {
  const stages = useMemo(() => buildStages(graph, orderedNodes), [graph, orderedNodes]);
  const annByKey = useMemo(() => {
    const map = new Map<string, EdgeAnnotation>();
    for (const annotation of edgeAnnotations ?? []) map.set(annotation.key, annotation);
    return map;
  }, [edgeAnnotations]);

  return (
    <div className="space-y-3">
      <div
        className={cn("grid gap-3", compact ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-4")}
      >
        {stages.map((stage) => (
          <section key={stage.id} className="min-w-0 rounded-lg border border-white/10 bg-black/20">
            <header className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                {stage.label}
              </span>
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
                  stageTone(stage.id),
                )}
              >
                {stage.nodes.length}
              </span>
            </header>
            <div className="space-y-2 p-2">
              {stage.nodes.map((node) => {
                const role = causalRole(graph, node.id);
                return (
                  <button
                    type="button"
                    key={node.id}
                    onClick={() => onSelectNode(node)}
                    className={cn(
                      "group w-full rounded-md border bg-white/[0.035] px-3 py-2 text-left transition-colors hover:bg-white/[0.07]",
                      roleTone(role),
                    )}
                  >
                    <span className="block text-sm font-semibold leading-snug text-foreground">
                      {node.label || shortId(node.id)}
                    </span>
                    <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.18em] opacity-80">
                      {role}
                    </span>
                    {node.description && (
                      <span className="mt-2 block line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                        {node.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <section className="rounded-lg border border-white/10 bg-black/20">
        <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <GitBranch className="h-3.5 w-3.5 text-[color:var(--neon-violet)]" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Mechanisms
          </span>
        </header>
        <div className="space-y-2 p-2">
          {graph.edges.map((edge, index) => {
            const ann = annByKey.get(`${edge.source}->${edge.target}`);
            return (
              <button
                type="button"
                key={`${edge.source}-${edge.target}-${index}`}
                onClick={() => onSelectEdge(edge)}
                className="w-full rounded-md border border-white/8 bg-white/[0.025] px-3 py-2 text-left transition-colors hover:border-[color:var(--neon-cyan)]/35 hover:bg-white/[0.055]"
              >
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-[color:var(--neon-cyan)]">
                    {shortId(edge.source)}
                  </span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />
                  <span className="font-mono text-[color:var(--neon-violet)]">
                    {shortId(edge.target)}
                  </span>
                  {ann && (
                    <span
                      className="rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                      style={{ color: evidenceColor(ann.evidenceType) }}
                    >
                      {evidenceLabel(ann.evidenceType)}
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {edge.relationship}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function causalRole(graph: CausalGraph, nodeId: string) {
  if (graph.treatment_variable === nodeId) return "treatment";
  if (graph.outcome_variable === nodeId) return "outcome";
  if ((graph.candidate_confounders ?? []).includes(nodeId)) return "confounder";
  return "variable";
}

function roleTone(role: string) {
  switch (role) {
    case "treatment":
      return "border-[color:var(--neon-cyan)]/35";
    case "outcome":
      return "border-[color:var(--neon-violet)]/40";
    case "confounder":
      return "border-amber-300/30";
    default:
      return "border-white/10";
  }
}

function stageTone(stageId: string) {
  switch (stageId) {
    case "context":
      return "border-amber-300/30 bg-amber-300/10 text-amber-100";
    case "intervention":
      return "border-[color:var(--neon-cyan)]/35 bg-[color:var(--neon-cyan)]/10 text-[color:var(--neon-cyan)]";
    case "outcome":
      return "border-[color:var(--neon-violet)]/40 bg-[color:var(--neon-violet)]/10 text-[color:var(--neon-violet)]";
    default:
      return "border-white/10 bg-white/[0.04] text-foreground";
  }
}

function buildStages(graph: CausalGraph, orderedNodes: CausalNode[]) {
  const confounders = new Set(graph.candidate_confounders ?? []);
  const treatment = graph.treatment_variable;
  const outcome = graph.outcome_variable;

  const stages = [
    {
      id: "context",
      label: "Context",
      nodes: orderedNodes.filter((node) => confounders.has(node.id)),
    },
    {
      id: "intervention",
      label: "Intervention",
      nodes: orderedNodes.filter((node) => node.id === treatment),
    },
    {
      id: "mediators",
      label: "Mediators",
      nodes: orderedNodes.filter(
        (node) => !confounders.has(node.id) && node.id !== treatment && node.id !== outcome,
      ),
    },
    {
      id: "outcome",
      label: "Outcome",
      nodes: orderedNodes.filter((node) => node.id === outcome),
    },
  ];

  const staged = new Set(stages.flatMap((stage) => stage.nodes.map((node) => node.id)));
  const unassigned = orderedNodes.filter((node) => !staged.has(node.id));
  if (unassigned.length) {
    stages.splice(2, 0, {
      id: "variables",
      label: "Variables",
      nodes: unassigned,
    });
  }

  return stages.filter((stage) => stage.nodes.length > 0);
}

function shortId(id: string) {
  return id.replace(/^.*\./, "").replaceAll("_", " ");
}

function orderNodes(graph: CausalGraph) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length <= 1) return nodes;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => nodePriority(graph, a.id) - nodePriority(graph, b.id));
  const ordered: CausalNode[] = [];
  const seen = new Set<string>();

  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    ordered.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      indegree.set(target, Math.max(0, (indegree.get(target) ?? 0) - 1));
      if ((indegree.get(target) ?? 0) === 0 && byId.has(target)) {
        queue.push(byId.get(target)!);
      }
    }
    queue.sort((a, b) => nodePriority(graph, a.id) - nodePriority(graph, b.id));
  }

  for (const node of nodes) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}

function nodePriority(graph: CausalGraph, nodeId: string) {
  if ((graph.candidate_confounders ?? []).includes(nodeId)) return 0;
  if (graph.treatment_variable === nodeId) return 1;
  if (graph.outcome_variable === nodeId) return 3;
  return 2;
}
