import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Beaker,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Crown,
  Database,
  Eye,
  GitBranch,
  Hexagon,
  Layers,
  ListTree,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Workflow,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import {
  domainLabel,
  evidenceColor,
  evidenceLabel,
  type AgentNode,
  type DecisionLogEntry,
  type EdgeAnnotation,
  type ObservabilityTrace,
} from "@/lib/agent-runtime";
import { cn } from "@/lib/utils";

interface Props {
  trace: ObservabilityTrace;
}

type View = "hierarchy" | "decisions" | "validation" | "rejected";

export function CausalObservabilityPanel({ trace }: Props) {
  const [view, setView] = useState<View>("hierarchy");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    trace.agents.find((a) => a.level === "orchestrator")?.id ?? null,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const agentById = useMemo(() => {
    const m = new Map<string, AgentNode>();
    for (const a of trace.agents) m.set(a.id, a);
    return m;
  }, [trace]);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, AgentNode[]>();
    for (const a of trace.agents) {
      const arr = m.get(a.parentId) ?? [];
      arr.push(a);
      m.set(a.parentId, arr);
    }
    return m;
  }, [trace]);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selected = selectedAgentId ? (agentById.get(selectedAgentId) ?? null) : null;

  // Counts for tab badges
  const counts = useMemo(() => {
    const active = trace.agents.filter((a) => a.status === "active").length;
    const rejected = trace.agents.filter((a) => a.status === "rejected").length;
    return { active, rejected };
  }, [trace]);

  return (
    <section className="glass overflow-hidden rounded-2xl">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Hexagon
              className="h-7 w-7 text-[color:var(--neon-violet)] opacity-90"
              strokeWidth={1.25}
            />
            <Eye className="absolute inset-0 m-auto h-3 w-3 text-[color:var(--neon-violet)]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground">
              Causal Observability
            </h2>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Agent activation transparency · decision trace
            </p>
          </div>
          <span
            className="ml-3 rounded-full border border-[color:var(--neon-violet)]/40 bg-[color:var(--neon-violet)]/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--neon-violet)]"
            title="Client-side overlay derived from the /run JSON response — not the live Execution Stream (Kafka telemetry)"
          >
            Derived overlay
          </span>
        </div>

        {/* View tabs */}
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
          <TabBtn
            active={view === "hierarchy"}
            onClick={() => setView("hierarchy")}
            icon={<ListTree className="h-3 w-3" />}
            label="Hierarchy"
            badge={counts.active}
          />
          <TabBtn
            active={view === "decisions"}
            onClick={() => setView("decisions")}
            icon={<Workflow className="h-3 w-3" />}
            label="Decision Log"
            badge={trace.log.length}
          />
          <TabBtn
            active={view === "validation"}
            onClick={() => setView("validation")}
            icon={<ShieldCheck className="h-3 w-3" />}
            label="DoWhy"
            badge={`${trace.validation.placeboPassed}/${trace.validation.placeboTotal}`}
          />
          <TabBtn
            active={view === "rejected"}
            onClick={() => setView("rejected")}
            icon={<XCircle className="h-3 w-3" />}
            label="Rejected"
            badge={counts.rejected}
          />
        </div>
      </header>

      {/* Body */}
      {view === "hierarchy" && (
        <div className="grid gap-px bg-white/5 lg:grid-cols-[1fr_360px]">
          <div className="min-h-[380px] bg-[oklch(0.16_0.03_260/0.6)] p-3">
            <HierarchyTree
              roots={childrenOf.get(null) ?? []}
              childrenOf={childrenOf}
              selectedId={selectedAgentId}
              collapsed={collapsed}
              onSelect={setSelectedAgentId}
              onToggleCollapse={toggleCollapse}
            />
          </div>
          <aside className="bg-[oklch(0.16_0.03_260/0.6)]">
            <AgentInspector
              agent={selected}
              edges={trace.edges.filter((e) =>
                selected ? e.attributedAgentId === selected.id : false,
              )}
              onClose={() => setSelectedAgentId(null)}
            />
          </aside>
        </div>
      )}

      {view === "decisions" && (
        <DecisionLogView log={trace.log} agentById={agentById} totalMs={trace.totalDurationMs} />
      )}

      {view === "validation" && <ValidationView trace={trace} />}

      {view === "rejected" && <RejectedView trace={trace} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function TabBtn({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number | string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors",
        active
          ? "bg-[color:var(--neon-violet)]/15 text-[color:var(--neon-violet)]"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
      {badge !== undefined && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-mono text-[9px]",
            active
              ? "bg-[color:var(--neon-violet)]/20 text-[color:var(--neon-violet)]"
              : "bg-white/5 text-muted-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Hierarchy tree
// ---------------------------------------------------------------------------

function HierarchyTree({
  roots,
  childrenOf,
  selectedId,
  collapsed,
  onSelect,
  onToggleCollapse,
}: {
  roots: AgentNode[];
  childrenOf: Map<string | null, AgentNode[]>;
  selectedId: string | null;
  collapsed: Set<string>;
  onSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {roots.map((r) => (
        <TreeNode
          key={r.id}
          node={r}
          depth={0}
          childrenOf={childrenOf}
          selectedId={selectedId}
          collapsed={collapsed}
          onSelect={onSelect}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  childrenOf,
  selectedId,
  collapsed,
  onSelect,
  onToggleCollapse,
}: {
  node: AgentNode;
  depth: number;
  childrenOf: Map<string | null, AgentNode[]>;
  selectedId: string | null;
  collapsed: Set<string>;
  onSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const kids = childrenOf.get(node.id) ?? [];
  const isSelected = selectedId === node.id;
  const isCollapsed = collapsed.has(node.id);
  const isRejected = node.status === "rejected";

  const Icon = node.level === "orchestrator" ? Crown : node.level === "domain" ? Layers : Brain;

  const tone =
    node.level === "orchestrator"
      ? "var(--neon-cyan)"
      : node.level === "domain"
        ? "var(--neon-violet)"
        : "var(--neon-emerald)";

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
          isSelected ? "bg-white/10 text-foreground" : "text-foreground/85 hover:bg-white/5",
          isRejected && "opacity-50",
        )}
        style={{ paddingLeft: 8 + depth * 18 }}
      >
        {kids.length > 0 ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(node.id);
            }}
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </span>
        ) : (
          <span className="h-4 w-4" />
        )}
        <Icon
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: isRejected ? "rgba(255,255,255,0.4)" : `oklch(${tone})` }}
        />
        <span className="flex-1 truncate">
          {isRejected && (
            <span className="mr-1 text-[10px] uppercase tracking-wider text-rose-300/70">
              [rejected]
            </span>
          )}
          {node.label}
        </span>
        {node.status === "active" && (
          <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
            {Math.round(node.selfConfidence * 100)}%
          </span>
        )}
        {node.contributedNodeIds.length > 0 && (
          <span
            className="rounded border border-white/10 px-1 py-0 font-mono text-[9px] text-muted-foreground"
            title={`${node.contributedNodeIds.length} graph node(s) attributed`}
          >
            {node.contributedNodeIds.length}n
          </span>
        )}
        {node.contributedEdgeKeys.length > 0 && (
          <span
            className="rounded border border-white/10 px-1 py-0 font-mono text-[9px] text-muted-foreground"
            title={`${node.contributedEdgeKeys.length} edge(s) attributed`}
          >
            {node.contributedEdgeKeys.length}e
          </span>
        )}
      </button>
      {!isCollapsed && kids.length > 0 && (
        <ul className="space-y-0.5">
          {kids.map((k) => (
            <TreeNode
              key={k.id}
              node={k}
              depth={depth + 1}
              childrenOf={childrenOf}
              selectedId={selectedId}
              collapsed={collapsed}
              onSelect={onSelect}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Agent inspector
// ---------------------------------------------------------------------------

function AgentInspector({
  agent,
  edges,
  onClose,
}: {
  agent: AgentNode | null;
  edges: EdgeAnnotation[];
  onClose: () => void;
}) {
  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center text-xs text-muted-foreground">
        <Sparkles className="h-4 w-4 opacity-50" />
        <p>Select an agent to inspect its activation reasoning.</p>
      </div>
    );
  }

  const Icon = agent.level === "orchestrator" ? Crown : agent.level === "domain" ? Layers : Brain;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            <Icon className="h-3 w-3" />
            {agent.level} agent
            {agent.domain && (
              <span className="ml-1 text-[color:var(--neon-violet)]">
                · {domainLabel(agent.domain)}
              </span>
            )}
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-foreground">{agent.label}</p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{agent.id}</p>
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
        {/* Status row */}
        <div className="flex items-center gap-3 text-xs">
          <StatusBadge status={agent.status} />
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">confidence</span>
            <ConfidenceBar value={agent.selfConfidence} />
            <span className="font-mono text-[10px] tabular-nums text-foreground">
              {Math.round(agent.selfConfidence * 100)}%
            </span>
          </div>
        </div>

        <Field label="Why was this agent activated?">
          <p className="text-foreground/90">{agent.activationReason}</p>
        </Field>

        <Field label="Triggering hypothesis">
          <p className="rounded-md border border-[color:var(--neon-violet)]/20 bg-[color:var(--neon-violet)]/5 px-3 py-2 italic text-foreground/95">
            “{agent.triggeringHypothesis}”
          </p>
        </Field>

        {agent.triggeringSignals.length > 0 && (
          <Field label="Triggering signals">
            <ul className="flex flex-wrap gap-1.5">
              {agent.triggeringSignals.map((s, i) => (
                <li
                  key={i}
                  className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-foreground/85"
                >
                  {s}
                </li>
              ))}
            </ul>
          </Field>
        )}

        {agent.parentId && (
          <Field label="Spawned by">
            <p className="font-mono text-[11px] text-[color:var(--neon-cyan)]">{agent.parentId}</p>
          </Field>
        )}

        {agent.rejectedReason && (
          <Field label="Rejection reason">
            <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200/95">
              {agent.rejectedReason}
            </p>
          </Field>
        )}

        {agent.contributedNodeIds.length > 0 && (
          <Field label={`Contributed graph nodes (${agent.contributedNodeIds.length})`}>
            <ul className="flex flex-wrap gap-1">
              {agent.contributedNodeIds.map((id) => (
                <li
                  key={id}
                  className="rounded border border-[color:var(--neon-cyan)]/30 bg-[color:var(--neon-cyan)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--neon-cyan)]"
                >
                  {id}
                </li>
              ))}
            </ul>
          </Field>
        )}

        {edges.length > 0 && (
          <Field label={`Attributed edges (${edges.length})`}>
            <ul className="space-y-1.5">
              {edges.map((e) => (
                <EdgeRow key={e.key} edge={e} />
              ))}
            </ul>
          </Field>
        )}

        <div className="flex items-center justify-between border-t border-white/5 pt-3 font-mono text-[10px] text-muted-foreground">
          <span>activated · t+{agent.activatedAtMs}ms</span>
          <span>completed · t+{agent.completedAtMs}ms</span>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentNode["status"] }) {
  const cfg = {
    active: {
      label: "Active",
      cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    rejected: {
      label: "Rejected",
      cls: "border-rose-400/40 bg-rose-400/10 text-rose-300",
      icon: <XCircle className="h-3 w-3" />,
    },
    pruned: {
      label: "Pruned",
      cls: "border-amber-400/40 bg-amber-400/10 text-amber-300",
      icon: <AlertTriangle className="h-3 w-3" />,
    },
    merged: {
      label: "Merged",
      cls: "border-violet-400/40 bg-violet-400/10 text-violet-300",
      icon: <GitBranch className="h-3 w-3" />,
    },
  }[status];
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        cfg.cls,
      )}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="relative inline-block h-1.5 w-20 overflow-hidden rounded-full bg-white/10">
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[color:var(--neon-cyan)] to-[color:var(--neon-violet)]"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}

function EdgeRow({ edge }: { edge: EdgeAnnotation }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5 text-[11px]">
      <span className="font-mono text-[color:var(--neon-cyan)]">{edge.source}</span>
      <span className="text-muted-foreground">→</span>
      <span className="font-mono text-[color:var(--neon-violet)]">{edge.target}</span>
      <span className="ml-1 rounded border border-white/10 bg-white/5 px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-foreground/70">
        {edge.relationship}
      </span>
      <span
        className="ml-auto rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
        style={{
          color: `oklch(${evidenceColor(edge.evidenceType)})`,
          background: `oklch(${evidenceColor(edge.evidenceType)} / 0.12)`,
        }}
      >
        {evidenceLabel(edge.evidenceType)} · {Math.round(edge.confidence * 100)}%
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Decision log (timeline replay)
// ---------------------------------------------------------------------------

function DecisionLogView({
  log,
  agentById,
  totalMs,
}: {
  log: DecisionLogEntry[];
  agentById: Map<string, AgentNode>;
  totalMs: number;
}) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(totalMs);
  const [filter, setFilter] = useState<DecisionLogEntry["kind"] | "all">("all");
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const baseRef = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    startRef.current = performance.now();
    baseRef.current = t >= totalMs ? 0 : t;
    if (t >= totalMs) setT(0);
    const tick = () => {
      const elapsed = (performance.now() - startRef.current) * 2; // 2x speed for replay
      const next = Math.min(totalMs, baseRef.current + elapsed);
      setT(next);
      if (next >= totalMs) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const visible = useMemo(() => {
    return log.filter((e) => e.tMs <= t && (filter === "all" || e.kind === filter));
  }, [log, t, filter]);

  return (
    <div>
      {/* Replay controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-black/20 px-4 py-3">
        <button
          type="button"
          onClick={() => setPlaying((v) => !v)}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 text-[color:var(--neon-cyan)] transition-colors hover:bg-[color:var(--neon-cyan)]/20"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setT(0);
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-muted-foreground transition-colors hover:text-foreground"
          title="Reset"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <input
          type="range"
          min={0}
          max={totalMs}
          step={20}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          className="h-1 flex-1 min-w-[200px] cursor-pointer appearance-none rounded-full bg-white/10 accent-[color:var(--neon-cyan)]"
        />
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          t+{Math.round(t)}ms / {totalMs}ms
        </span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as DecisionLogEntry["kind"] | "all")}
          className="rounded border border-white/10 bg-black/30 px-2 py-1 font-mono text-[10px] text-foreground/90"
        >
          <option value="all">all events ({log.length})</option>
          <option value="spawn">spawn</option>
          <option value="reject">reject</option>
          <option value="hypothesis">hypothesis</option>
          <option value="evidence">evidence</option>
          <option value="merge">merge</option>
          <option value="validate">validate</option>
          <option value="prune">prune</option>
        </select>
      </div>

      {/* Log */}
      <div className="max-h-[420px] overflow-auto bg-[oklch(0.16_0.03_260/0.6)] px-4 py-3 font-mono text-[11px]">
        {visible.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            // no events at t+{Math.round(t)}ms
          </p>
        ) : (
          <ul className="space-y-1">
            {visible.map((e, i) => {
              const agent = agentById.get(e.agentId);
              return (
                <li key={i} className="flex items-start gap-2">
                  <span className="shrink-0 text-muted-foreground/70">
                    [t+{String(e.tMs).padStart(5, " ")}ms]
                  </span>
                  <KindIcon kind={e.kind} />
                  <span
                    className="shrink-0 font-semibold uppercase tracking-wider"
                    style={{ color: kindColor(e.kind) }}
                  >
                    {e.kind}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="shrink-0 text-[color:var(--neon-cyan)]">
                    {agent?.label ?? e.agentId}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="min-w-0 flex-1 break-words text-foreground/90">{e.message}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function kindColor(k: DecisionLogEntry["kind"]): string {
  switch (k) {
    case "spawn":
      return "oklch(var(--neon-emerald))";
    case "reject":
      return "oklch(var(--neon-rose))";
    case "hypothesis":
      return "oklch(var(--neon-violet))";
    case "evidence":
      return "oklch(var(--neon-cyan))";
    case "merge":
      return "oklch(var(--neon-violet))";
    case "validate":
      return "oklch(var(--neon-emerald))";
    case "prune":
      return "oklch(var(--neon-amber))";
  }
}

function KindIcon({ kind }: { kind: DecisionLogEntry["kind"] }) {
  const cls = "mt-0.5 h-3 w-3 shrink-0";
  const style = { color: kindColor(kind) };
  switch (kind) {
    case "spawn":
      return <Zap className={cls} style={style} />;
    case "reject":
      return <XCircle className={cls} style={style} />;
    case "hypothesis":
      return <Brain className={cls} style={style} />;
    case "evidence":
      return <Database className={cls} style={style} />;
    case "merge":
      return <GitBranch className={cls} style={style} />;
    case "validate":
      return <ShieldCheck className={cls} style={style} />;
    case "prune":
      return <AlertTriangle className={cls} style={style} />;
  }
}

// ---------------------------------------------------------------------------
// Validation view (DoWhy-style)
// ---------------------------------------------------------------------------

function ValidationView({ trace }: { trace: ObservabilityTrace }) {
  const v = trace.validation;
  const validatedPct = v.totalEdges ? (v.validatedEdges / v.totalEdges) * 100 : 0;
  const placeboPct = v.placeboTotal ? (v.placeboPassed / v.placeboTotal) * 100 : 0;

  // Group edges by evidence type
  const groups = useMemo(() => {
    const m = new Map<EdgeAnnotation["evidenceType"], EdgeAnnotation[]>();
    for (const e of trace.edges) {
      const arr = m.get(e.evidenceType) ?? [];
      arr.push(e);
      m.set(e.evidenceType, arr);
    }
    return m;
  }, [trace]);

  return (
    <div className="grid gap-px bg-white/5 lg:grid-cols-2">
      {/* Stats */}
      <div className="space-y-4 bg-[oklch(0.16_0.03_260/0.6)] p-5">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          <Beaker className="h-3 w-3 text-[color:var(--neon-emerald)]" />
          DoWhy-style refutation pass
        </div>

        <Stat
          label="Refutation score"
          value={`${Math.round(v.refutationScore * 100)}%`}
          sub="Composite: placebo + random-confounder + subset-sampling"
          tone="emerald"
          pct={v.refutationScore * 100}
        />
        <Stat
          label="Placebo tests passed"
          value={`${v.placeboPassed} / ${v.placeboTotal}`}
          sub="Edges that survive null-effect injection"
          tone="cyan"
          pct={placeboPct}
        />
        <Stat
          label="Statistically validated edges"
          value={`${v.validatedEdges} / ${v.totalEdges}`}
          sub="Backed by telemetry or external CTI"
          tone="violet"
          pct={validatedPct}
        />
        <Stat
          label="Avg confidence (validated)"
          value={`${Math.round(v.avgValidatedConfidence * 100)}%`}
          sub={`vs. ${Math.round(v.avgConfidence * 100)}% across all edges`}
          tone="amber"
          pct={v.avgValidatedConfidence * 100}
        />
      </div>

      {/* Edge breakdown by evidence type */}
      <div className="space-y-4 bg-[oklch(0.16_0.03_260/0.6)] p-5">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          <Target className="h-3 w-3 text-[color:var(--neon-violet)]" />
          Inferred vs. validated relationships
        </div>
        {(["telemetry", "external_intel", "model_inferred", "heuristic"] as const).map((type) => {
          const items = groups.get(type) ?? [];
          const isValidated = type === "telemetry" || type === "external_intel";
          return (
            <div key={type} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: `oklch(${evidenceColor(type)})` }}
                  />
                  <span className="font-mono uppercase tracking-wider text-foreground/85">
                    {evidenceLabel(type)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-0 font-mono text-[9px] uppercase tracking-wider",
                      isValidated
                        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                        : "border-amber-400/40 bg-amber-400/10 text-amber-300",
                    )}
                  >
                    {isValidated ? "validated" : "inferred"}
                  </span>
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {items.length} edge{items.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full"
                  style={{
                    width: trace.edges.length
                      ? `${(items.length / trace.edges.length) * 100}%`
                      : "0%",
                    background: `oklch(${evidenceColor(type)})`,
                  }}
                />
              </div>
            </div>
          );
        })}

        <p className="border-t border-white/5 pt-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
          The system distinguishes <span className="text-emerald-300">statistically validated</span>{" "}
          relationships (telemetry / CTI) from{" "}
          <span className="text-amber-300">model-inferred</span> ones. Refutation tests randomly
          inject placebo treatments and confirm that <em>only</em> real causal edges retain effect.
        </p>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  pct,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "cyan" | "violet" | "emerald" | "amber";
  pct: number;
}) {
  const colorVar = {
    cyan: "var(--neon-cyan)",
    violet: "var(--neon-violet)",
    emerald: "var(--neon-emerald)",
    amber: "var(--neon-amber)",
  }[tone];
  return (
    <div className="space-y-1.5 rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {label}
        </span>
        <span
          className="font-mono text-2xl font-semibold tabular-nums"
          style={{ color: `oklch(${colorVar})` }}
        >
          {value}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: `oklch(${colorVar})` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rejected branches view (counterfactuals)
// ---------------------------------------------------------------------------

function RejectedView({ trace }: { trace: ObservabilityTrace }) {
  return (
    <div className="space-y-3 bg-[oklch(0.16_0.03_260/0.6)] p-5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        <XCircle className="h-3 w-3 text-rose-300" />
        Counterfactual branches considered & rejected
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
        For full audit trust, every domain partition the orchestrator considered is recorded —
        including those it ruled out, with a justification.
      </p>
      {trace.domainsRejected.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          All domain partitions were activated. No branches rejected.
        </p>
      ) : (
        <ul className="space-y-2">
          {trace.domainsRejected.map((r) => (
            <li
              key={r.domain}
              className="flex items-start gap-3 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground/95">{domainLabel(r.domain)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{r.reason}</p>
              </div>
              <span className="rounded border border-rose-400/40 bg-rose-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-rose-300">
                rejected
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
