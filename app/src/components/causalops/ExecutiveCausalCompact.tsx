import { useMemo, useState } from "react";
import { Activity, Crown, GitBranch, Network, Workflow } from "lucide-react";
import {
  domainLabel,
  evidenceColor,
  evidenceLabel,
  type AgentNode,
  type EdgeAnnotation,
  type ObservabilityTrace,
} from "@/lib/agent-runtime";
import type { CausalGraph } from "@/lib/causalops-types";
import { cn } from "@/lib/utils";

interface Props {
  graph: CausalGraph;
  trace: ObservabilityTrace | null;
}

/**
 * Executive-friendly compact visualization:
 *   - Interactive layered DAG (SVG) on the left
 *   - Dynamic agent hierarchy (Orchestrator → Domains → Atomic) on the right
 *
 * Cross-highlighting: hovering a graph node lights up the owning agent (and
 * vice versa). Edges are colored by evidence type (telemetry / intel / etc.)
 * and weighted by causal confidence.
 */
export function ExecutiveCausalCompact({ graph, trace }: Props) {
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverAgent, setHoverAgent] = useState<string | null>(null);
  const [pinnedNode, setPinnedNode] = useState<string | null>(null);

  const activeNode = pinnedNode ?? hoverNode;

  const nodeToAgent = useMemo(() => {
    const m = new Map<string, string>();
    if (!trace) return m;
    for (const a of trace.agents) {
      for (const nid of a.contributedNodeIds) m.set(nid, a.id);
    }
    return m;
  }, [trace]);

  const agentToNodes = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!trace) return m;
    for (const a of trace.agents) m.set(a.id, a.contributedNodeIds);
    return m;
  }, [trace]);

  const highlightedNodes = useMemo(() => {
    if (hoverAgent && agentToNodes.has(hoverAgent)) {
      return new Set(agentToNodes.get(hoverAgent) ?? []);
    }
    if (activeNode) return new Set([activeNode]);
    return new Set<string>();
  }, [hoverAgent, agentToNodes, activeNode]);

  const highlightedAgent = useMemo(() => {
    if (hoverAgent) return hoverAgent;
    if (activeNode) return nodeToAgent.get(activeNode) ?? null;
    return null;
  }, [hoverAgent, activeNode, nodeToAgent]);

  return (
    <section className="panel-frame rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Network className="h-3.5 w-3.5 text-[color:var(--neon-cyan)]" />
        <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground/90">
          Causal DAG · Agent Hierarchy
        </h3>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          hover or click a node to inspect
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <CompactDAG
          graph={graph}
          edges={trace?.edges ?? []}
          activeNode={activeNode}
          highlightedNodes={highlightedNodes}
          onHoverNode={setHoverNode}
          onClickNode={(id) => setPinnedNode((cur) => (cur === id ? null : id))}
        />

        <AgentHierarchy
          trace={trace}
          highlightedAgent={highlightedAgent}
          onHoverAgent={setHoverAgent}
        />
      </div>

      <Legend />

      {trace && activeNode && <NodeInsight nodeId={activeNode} graph={graph} trace={trace} />}
    </section>
  );
}

interface DagProps {
  graph: CausalGraph;
  edges: EdgeAnnotation[];
  activeNode: string | null;
  highlightedNodes: Set<string>;
  onHoverNode: (id: string | null) => void;
  onClickNode: (id: string) => void;
}

function CompactDAG({
  graph,
  edges,
  activeNode,
  highlightedNodes,
  onHoverNode,
  onClickNode,
}: DagProps) {
  const layout = useMemo(() => layoutLayered(graph), [graph]);

  const annByKey = useMemo(() => {
    const m = new Map<string, EdgeAnnotation>();
    for (const e of edges) m.set(e.key, e);
    return m;
  }, [edges]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-white/5 bg-black/20 text-xs text-muted-foreground">
        No causal graph yet — run the engine.
      </div>
    );
  }

  const { width, height, nodes } = layout;

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/5 bg-[radial-gradient(circle_at_30%_20%,rgba(56,189,248,0.08),transparent_60%)] p-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[300px] w-full"
        role="img"
        aria-label="Compact causal DAG"
      >
        <defs>
          <marker
            id="exec-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        <g>
          {graph.edges.map((e, idx) => {
            const s = nodes[e.source];
            const t = nodes[e.target];
            if (!s || !t) return null;
            const key = `${e.source}->${e.target}`;
            const ann = annByKey.get(key);
            const colorVar = ann ? cssVarName(evidenceColor(ann.evidenceType)) : "--neon-slate";
            const color = ann ? `var(${colorVar})` : "rgba(148,163,184,0.55)";
            const conf = ann?.confidence ?? 0.55;
            const stroke = 0.8 + conf * 2.2;
            const dim = activeNode != null && activeNode !== e.source && activeNode !== e.target;
            const path = curvedPath(s.x, s.y, t.x, t.y);
            return (
              <g key={idx} style={{ color }} opacity={dim ? 0.18 : 0.95}>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  markerEnd="url(#exec-arrow)"
                  className="transition-opacity"
                />
              </g>
            );
          })}
        </g>

        <g>
          {graph.nodes.map((n) => {
            const p = nodes[n.id];
            if (!p) return null;
            const isActive = activeNode === n.id;
            const isHi = highlightedNodes.has(n.id);
            const dim = activeNode != null && !isActive && !isHi;
            const fill = isActive
              ? "var(--neon-cyan)"
              : isHi
                ? "rgba(56,189,248,0.35)"
                : "rgba(15,23,42,0.85)";
            const stroke = isActive
              ? "var(--neon-cyan)"
              : isHi
                ? "var(--neon-cyan)"
                : "rgba(148,163,184,0.55)";
            return (
              <g
                key={n.id}
                transform={`translate(${p.x}, ${p.y})`}
                style={{ cursor: "pointer", opacity: dim ? 0.35 : 1 }}
                onMouseEnter={() => onHoverNode(n.id)}
                onMouseLeave={() => onHoverNode(null)}
                onClick={() => onClickNode(n.id)}
                className="transition-opacity"
              >
                {isActive && (
                  <circle
                    r={18}
                    fill="none"
                    stroke="var(--neon-cyan)"
                    strokeOpacity={0.45}
                    strokeWidth={1}
                  >
                    <animate
                      attributeName="r"
                      values="14;22;14"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="stroke-opacity"
                      values="0.55;0.05;0.55"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}
                <circle
                  r={11}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={1.5}
                  className="transition-all"
                />
                <text
                  y={-16}
                  textAnchor="middle"
                  className="pointer-events-none select-none"
                  fontSize={9}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fill={isActive || isHi ? "rgb(226,232,240)" : "rgb(148,163,184)"}
                >
                  {truncate(n.label, 22)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

interface HierarchyProps {
  trace: ObservabilityTrace | null;
  highlightedAgent: string | null;
  onHoverAgent: (id: string | null) => void;
}

function AgentHierarchy({ trace, highlightedAgent, onHoverAgent }: HierarchyProps) {
  if (!trace) {
    return (
      <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-white/5 bg-black/20 text-xs text-muted-foreground">
        Agent trace appears after execution.
      </div>
    );
  }

  const orchestrator = trace.agents.find((a) => a.level === "orchestrator");
  const domains = trace.agents.filter((a) => a.level === "domain" && a.status === "active");

  return (
    <div className="relative max-h-[300px] overflow-auto rounded-xl border border-white/5 bg-black/20 p-3">
      {orchestrator && (
        <AgentRow
          agent={orchestrator}
          icon={<Crown className="h-3 w-3" />}
          highlighted={highlightedAgent === orchestrator.id}
          onHover={onHoverAgent}
          accent="var(--neon-cyan)"
        />
      )}
      <div className="ml-3 mt-2 space-y-2 border-l border-dashed border-white/10 pl-3">
        {domains.length === 0 && (
          <div className="text-[11px] text-muted-foreground">
            No domain agents activated for this scenario.
          </div>
        )}
        {domains.map((d) => {
          const children = trace.agents.filter((a) => a.parentId === d.id);
          return (
            <DomainBlock
              key={d.id}
              agent={d}
              childAgents={children}
              highlightedAgent={highlightedAgent}
              onHover={onHoverAgent}
            />
          );
        })}
      </div>
    </div>
  );
}

function DomainBlock({
  agent,
  childAgents,
  highlightedAgent,
  onHover,
}: {
  agent: AgentNode;
  childAgents: AgentNode[];
  highlightedAgent: string | null;
  onHover: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <AgentRow
        agent={agent}
        icon={<Workflow className="h-3 w-3" />}
        highlighted={highlightedAgent === agent.id}
        onHover={onHover}
        accent="var(--neon-violet)"
        onToggle={() => setOpen((v) => !v)}
        toggled={open}
        childCount={childAgents.length}
      />
      {open && childAgents.length > 0 && (
        <div className="ml-3 mt-1 space-y-1 border-l border-dashed border-white/10 pl-3">
          {childAgents.map((c) => (
            <AgentRow
              key={c.id}
              agent={c}
              icon={<Activity className="h-3 w-3" />}
              highlighted={highlightedAgent === c.id}
              onHover={onHover}
              accent="var(--neon-emerald)"
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  icon,
  highlighted,
  onHover,
  accent,
  compact,
  onToggle,
  toggled,
  childCount,
}: {
  agent: AgentNode;
  icon: React.ReactNode;
  highlighted: boolean;
  onHover: (id: string | null) => void;
  accent: string;
  compact?: boolean;
  onToggle?: () => void;
  toggled?: boolean;
  childCount?: number;
}) {
  return (
    <div
      onMouseEnter={() => onHover(agent.id)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-all cursor-default",
        highlighted
          ? "bg-[color:var(--neon-cyan)]/15 ring-1 ring-[color:var(--neon-cyan)]/40"
          : "hover:bg-white/[0.04]",
      )}
    >
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full border"
        style={{
          color: accent,
          borderColor: `color-mix(in oklab, ${accent} 45%, transparent)`,
          background: `color-mix(in oklab, ${accent} 10%, transparent)`,
        }}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("truncate", compact ? "text-[11px]" : "text-xs")}>{agent.label}</div>
        {!compact && (
          <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {agent.domain ? domainLabel(agent.domain) : agent.level} · conf{" "}
            {(agent.selfConfidence * 100).toFixed(0)}%
            {childCount != null && childCount > 0 && (
              <>
                {" "}
                · {childCount} child{childCount === 1 ? "" : "ren"}
              </>
            )}
          </div>
        )}
      </div>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
      />
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="rounded p-0.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
          aria-label={toggled ? "Collapse" : "Expand"}
        >
          <GitBranch className={cn("h-3 w-3 transition-transform", toggled && "rotate-90")} />
        </button>
      )}
    </div>
  );
}

function NodeInsight({
  nodeId,
  graph,
  trace,
}: {
  nodeId: string;
  graph: CausalGraph;
  trace: ObservabilityTrace;
}) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const inEdges = trace.edges.filter((e) => e.target === nodeId);
  const outEdges = trace.edges.filter((e) => e.source === nodeId);
  const owner = trace.agents.find((a) => a.contributedNodeIds.includes(nodeId));
  if (!node) return null;

  return (
    <div className="mt-3 rounded-xl border border-[color:var(--neon-cyan)]/30 bg-[color:var(--neon-cyan)]/5 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--neon-cyan)]">
          Inspecting
        </span>
        <span className="font-medium text-foreground">{node.label}</span>
        {owner && (
          <span className="ml-auto rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            owned by {owner.label}
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <EdgeList title="Incoming causes" items={inEdges} side="source" />
        <EdgeList title="Downstream effects" items={outEdges} side="target" />
      </div>
    </div>
  );
}

function EdgeList({
  title,
  items,
  side,
}: {
  title: string;
  items: EdgeAnnotation[];
  side: "source" | "target";
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-muted-foreground/70">— none —</div>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 5).map((e) => (
            <li
              key={e.key}
              className="flex items-center gap-2 rounded border border-white/5 bg-black/20 px-2 py-1"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background: `var(${cssVarName(evidenceColor(e.evidenceType))})`,
                }}
                title={evidenceLabel(e.evidenceType)}
              />
              <span className="truncate text-[11px] text-foreground/90">{e.relationship}</span>
              <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                {(e.confidence * 100).toFixed(0)}%
              </span>
              <span className="font-mono text-[9px] uppercase text-muted-foreground/70">
                {side === "source" ? `← ${truncate(e.source, 14)}` : `→ ${truncate(e.target, 14)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend() {
  const items: { label: string; color: string }[] = [
    { label: "Telemetry", color: "var(--neon-emerald)" },
    { label: "External Intel", color: "var(--neon-cyan)" },
    { label: "Heuristic", color: "var(--neon-amber)" },
    { label: "Model-Inferred", color: "var(--neon-violet)" },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
      <span>Edge evidence:</span>
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span
            className="h-1 w-5 rounded"
            style={{ background: i.color, boxShadow: `0 0 6px ${i.color}` }}
          />
          {i.label}
        </span>
      ))}
      <span className="ml-auto">Edge thickness ≈ causal confidence</span>
    </div>
  );
}

function layoutLayered(graph: CausalGraph): {
  width: number;
  height: number;
  nodes: Record<string, { x: number; y: number; layer: number }>;
} {
  const nodes = graph.nodes;
  const edges = graph.edges;
  const idSet = new Set(nodes.map((n) => n.id));

  const layer = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) {
    layer.set(n.id, 0);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      incoming.get(e.target)!.push(e.source);
    }
  }
  for (let iter = 0; iter < nodes.length + 2; iter++) {
    let changed = false;
    for (const n of nodes) {
      const inc = incoming.get(n.id) ?? [];
      let max = 0;
      for (const s of inc) {
        const l = (layer.get(s) ?? 0) + 1;
        if (l > max) max = l;
      }
      if (max !== layer.get(n.id)) {
        layer.set(n.id, max);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    const arr = byLayer.get(l) ?? [];
    arr.push(n.id);
    byLayer.set(l, arr);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const layerCount = Math.max(1, layers.length);

  const colW = 150;
  const rowH = 56;
  const padX = 70;
  const padY = 36;
  const width = padX * 2 + colW * Math.max(1, layerCount - 1);
  const maxRows = Math.max(...[...byLayer.values()].map((v) => v.length));
  const height = padY * 2 + rowH * Math.max(1, maxRows - 1);

  const positions: Record<string, { x: number; y: number; layer: number }> = {};
  for (const l of layers) {
    const ids = byLayer.get(l)!;
    const count = ids.length;
    ids.forEach((id, i) => {
      const yMid = height / 2;
      const totalH = (count - 1) * rowH;
      const y = yMid - totalH / 2 + i * rowH;
      positions[id] = { x: padX + l * colW, y, layer: l };
    });
  }
  return { width, height, nodes: positions };
}

function curvedPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) * 0.45;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function cssVarName(varExpr: string): string {
  const m = varExpr.match(/--[\w-]+/);
  return m ? m[0] : "--neon-cyan";
}
