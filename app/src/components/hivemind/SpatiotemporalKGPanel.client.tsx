import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import {
  Activity,
  Calendar,
  Filter,
  Grid,
  Info,
  Layers,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { fetch5DGraph } from "@/lib/hivemind-api";
import { cn } from "@/lib/utils";

interface Props {
  runId: string;
}

type Node = {
  id: string;
  node_type:
    | "agent"
    | "asset"
    | "threat"
    | "artifact"
    | "causal_variable"
    | "user"
    | "finding"
    | "decision";
  label: string;
  description: string;
  location: {
    subnet?: string;
    ip?: string;
    tier?: string;
    domain?: string;
    zone?: string;
    [key: string]: any;
  };
  created_at: string;
  x?: number;
  y?: number;
};

type Edge = {
  source: string;
  target: string;
  relationship: string;
  observed_at: string;
  location: Record<string, any>;
  confidence: number;
  metadata: Record<string, any>;
};

export function SpatiotemporalKGPanelClient({ runId }: Props) {
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Replay & Timeline State
  const [playing, setPlaying] = useState(false);
  // Scrubbing happens in event-rank space (k-th distinct event timestamp),
  // not linear wall-clock time: telemetry is often weeks older than the run
  // events, and a linear axis would compress all activity into the ends.
  const [timelineIndex, setTimelineIndex] = useState<number>(0);
  const [eventTimes, setEventTimes] = useState<number[]>([]);
  const [minTime, setMinTime] = useState<number>(0);
  const [maxTime, setMaxTime] = useState<number>(0);
  const [activeTimeISO, setActiveTimeISO] = useState<string>("");

  // Filters State
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState<number>(0.0);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    new Set([
      "agent",
      "asset",
      "threat",
      "artifact",
      "causal_variable",
      "user",
      "finding",
      "decision",
    ])
  );
  const [selectedZone, setSelectedZone] = useState<string>("all");

  const fgRef = useRef<ForceGraphMethods<Node, Edge> | undefined>(undefined);
  const animationFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  // Fetch Graph data
  const loadGraph = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const graph = await fetch5DGraph(runId);
      setData(graph);

      // Compute Timeline bounds
      const timestamps: number[] = [];
      graph.nodes.forEach((n: Node) => {
        if (n.created_at) timestamps.push(new Date(n.created_at).getTime());
      });
      graph.edges.forEach((e: Edge) => {
        if (e.observed_at) timestamps.push(new Date(e.observed_at).getTime());
      });

      // Distinct, sorted event instants: the scrubber steps through these.
      const distinct = Array.from(new Set(timestamps)).sort((a, b) => a - b);
      const earliest = distinct.length ? distinct[0] : Date.now();
      const latest = distinct.length ? distinct[distinct.length - 1] : Date.now();

      setEventTimes(distinct);
      setMinTime(earliest);
      setMaxTime(latest);
      setTimelineIndex(Math.max(distinct.length - 1, 0)); // Slider at the end by default
      setLoading(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load 5D graph data");
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Handle Playback animation
  useEffect(() => {
    if (!playing || eventTimes.length < 2) {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      return;
    }

    const lastIndex = eventTimes.length - 1;
    // Steady event rate: a full sweep takes ~250ms per event, clamped to 8-30s
    // of real time, regardless of how unevenly the events sit on the clock.
    const sweepMs = Math.min(Math.max(eventTimes.length * 250, 8000), 30000);
    const eventsPerMs = lastIndex / sweepMs;
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      setTimelineIndex((prev) => {
        const next = prev + delta * eventsPerMs;
        if (next >= lastIndex) {
          setPlaying(false);
          return lastIndex;
        }
        return next;
      });

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [playing, eventTimes]);

  const eventCursor = eventTimes.length
    ? Math.min(Math.floor(timelineIndex), eventTimes.length - 1)
    : 0;
  const activeTimestamp = eventTimes.length ? eventTimes[eventCursor] : maxTime;

  // Synchronize active date ISO string for display
  useEffect(() => {
    if (activeTimestamp) {
      setActiveTimeISO(new Date(activeTimestamp).toISOString());
    }
  }, [activeTimestamp]);

  // Compute distinct subnets/zones available for filter
  const zones = useMemo(() => {
    const set = new Set<string>();
    if (data) {
      data.nodes.forEach((n) => {
        const zone = n.location?.subnet || n.location?.zone;
        if (zone) set.add(zone);
      });
    }
    return Array.from(set);
  }, [data]);

  // Filter Nodes & Edges dynamically based on timeline, filters and search
  const filteredData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };

    // 1. Filter nodes by time, type, zone and search term
    const visibleNodes = data.nodes.filter((node) => {
      const nodeTime = new Date(node.created_at).getTime();
      if (nodeTime > activeTimestamp) return false;
      if (!selectedTypes.has(node.node_type)) return false;

      const zone = node.location?.subnet || node.location?.zone;
      if (selectedZone !== "all" && zone !== selectedZone) return false;

      if (searchTerm) {
        const query = searchTerm.toLowerCase();
        const matchesLabel = node.label?.toLowerCase().includes(query);
        const matchesDesc = node.description?.toLowerCase().includes(query);
        const matchesId = node.id?.toLowerCase().includes(query);
        if (!matchesLabel && !matchesDesc && !matchesId) return false;
      }
      return true;
    });

    const nodeIds = new Set(visibleNodes.map((n) => n.id));

    // 2. Filter edges by time, connected nodes, confidence and type
    const visibleEdges = data.edges.filter((edge) => {
      const edgeTime = new Date(edge.observed_at).getTime();
      if (edgeTime > activeTimestamp) return false;
      if (edge.confidence < minConfidence) return false;

      // Both source and target must be visible nodes
      const sourceId = typeof edge.source === "object" ? (edge.source as any).id : edge.source;
      const targetId = typeof edge.target === "object" ? (edge.target as any).id : edge.target;

      return nodeIds.has(sourceId) && nodeIds.has(targetId);
    });

    return {
      nodes: visibleNodes,
      links: visibleEdges.map((e) => ({ ...e })), // Map edges to links for ForceGraph2D
    };
  }, [data, activeTimestamp, selectedTypes, selectedZone, searchTerm, minConfidence]);

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size > 1) next.delete(type); // Don't allow empty
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const getGlowColor = (type: string) => {
    switch (type) {
      case "agent":
        return "#bc34fa"; // Neon Violet
      case "asset":
        return "#50aaff"; // Blue
      case "threat":
        return "#ff4560"; // Red
      case "artifact":
        return "#ffb03a"; // Orange
      case "causal_variable":
        return "#eed202"; // Gold/Amber
      case "user":
        return "#50f0aa"; // Green/Emerald
      case "finding":
        return "#ff7a50"; // Coral — reasoning-layer anomaly findings
      case "decision":
        return "#3ae8c8"; // Teal — reasoning-layer recommendations
      default:
        return "#a891ff";
    }
  };

  const drawZoneClusterBoxes = useCallback(
    (nodes: Node[], ctx: CanvasRenderingContext2D) => {
      // Group nodes by zone/subnet to draw bounds
      const groups: Record<string, Node[]> = {};
      nodes.forEach((n) => {
        const z = n.location?.subnet || n.location?.zone || "unknown";
        if (n.x !== undefined && n.y !== undefined) {
          groups[z] = groups[z] || [];
          groups[z].push(n);
        }
      });

      ctx.save();
      Object.entries(groups).forEach(([zone, memberNodes]) => {
        if (memberNodes.length < 2) return;

        // Calculate bounding box
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        memberNodes.forEach((n) => {
          minX = Math.min(minX, n.x!);
          minY = Math.min(minY, n.y!);
          maxX = Math.max(maxX, n.x!);
          maxY = Math.max(maxY, n.y!);
        });

        // Add padding
        const pad = 25;
        minX -= pad;
        minY -= pad;
        maxX += pad;
        maxY += pad;
        const w = maxX - minX;
        const h = maxY - minY;

        // Draw light zone container outline
        ctx.strokeStyle = "rgba(168, 145, 255, 0.12)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(minX, minY, w, h);

        // Zone label
        ctx.fillStyle = "rgba(168, 145, 255, 0.35)";
        ctx.font = "8px monospace";
        ctx.fillText(zone.toUpperCase(), minX + 5, minY - 5);
      });
      ctx.restore();
    },
    []
  );

  return (
    <section className="glass overflow-hidden rounded-2xl">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Zap className="h-7 w-7 text-[color:var(--neon-cyan)] opacity-90 animate-pulse" />
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground">
              5D Spatiotemporal KG
            </h2>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Space-Time Reasoning & Telemetry Propagation
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>{filteredData.nodes.length} nodes active</span>
          <span>·</span>
          <span>{filteredData.links.length} edges active</span>
        </div>
      </header>

      {/* Control Toolbar */}
      <div className="flex flex-col gap-4 border-b border-white/5 bg-black/20 p-4">
        {/* Timeline scrubbing */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPlaying(!playing)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--neon-cyan)]/40 bg-[color:var(--neon-cyan)]/10 text-[color:var(--neon-cyan)] transition-colors hover:bg-[color:var(--neon-cyan)]/25"
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setTimelineIndex(0);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-1.5 min-w-[200px]">
            <input
              type="range"
              min={0}
              max={Math.max(eventTimes.length - 1, 1)}
              step={1}
              value={timelineIndex}
              onChange={(e) => {
                setPlaying(false);
                setTimelineIndex(Number(e.target.value));
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[color:var(--neon-cyan)]"
            />
            <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {new Date(minTime).toLocaleTimeString()}
              </span>
              <span className="text-[color:var(--neon-cyan)] font-semibold">
                event {eventCursor + 1}/{eventTimes.length || 1} &nbsp;·&nbsp; t+
                {Math.round((activeTimestamp - minTime) / 1000)}s &nbsp;(
                {activeTimeISO ? activeTimeISO.substring(11, 19) : ""})
              </span>
              <span>{new Date(maxTime).toLocaleTimeString()}</span>
            </div>
          </div>
        </div>

        {/* Filters and search */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/5 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground mr-2">
              <Filter className="h-3.5 w-3.5" />
              Types:
            </span>
            {([
              "agent",
              "asset",
              "threat",
              "artifact",
              "causal_variable",
              "user",
              "finding",
              "decision",
            ] as const).map(
              (type) => (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[10px] font-mono capitalize transition-all",
                    selectedTypes.has(type)
                      ? "border-opacity-50 text-foreground bg-white/5"
                      : "opacity-40 border-white/5 hover:opacity-75"
                  )}
                  style={{
                    borderColor: selectedTypes.has(type) ? getGlowColor(type) : undefined,
                    boxShadow: selectedTypes.has(type) ? `0 0 4px ${getGlowColor(type)}40` : undefined,
                  }}
                >
                  {type.replace("_", " ")}
                </button>
              )
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search nodes..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-40 rounded-md border border-white/10 bg-black/40 pl-8 pr-3 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:border-[color:var(--neon-cyan)]/50 focus:ring-1 focus:ring-[color:var(--neon-cyan)]/30"
              />
            </div>

            {/* Zone Filter */}
            <div className="relative flex items-center">
              <MapPin className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={selectedZone}
                onChange={(e) => setSelectedZone(e.target.value)}
                className="rounded-md border border-white/10 bg-black/40 pl-8 pr-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-[color:var(--neon-cyan)]/50"
              >
                <option value="all">All Zones</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.length > 15 ? `${z.substring(0, 15)}...` : z}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex h-96 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Activity className="h-8 w-8 animate-spin text-[color:var(--neon-cyan)]" />
          <p className="text-sm font-mono uppercase tracking-wider">Compiling Spatiotemporal Graph...</p>
        </div>
      ) : error ? (
        <div className="flex h-96 flex-col items-center justify-center gap-3 text-rose-400">
          <Info className="h-8 w-8" />
          <p className="text-sm font-mono">{error}</p>
          <button
            onClick={loadGraph}
            className="rounded border border-white/10 bg-white/5 px-3 py-1 text-xs text-foreground hover:bg-white/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="grid gap-px bg-white/5 lg:grid-cols-[1fr_300px]">
          {/* Main Visualizer */}
          <div className="relative min-w-0 bg-[oklch(0.16_0.03_260/0.6)] p-3">
            <ForceGraph2D<Node, Edge>
              ref={fgRef as never}
              graphData={filteredData}
              height={500}
              backgroundColor="rgba(0,0,0,0)"
              cooldownTicks={120}
              enableNodeDrag={true}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={0.92}
              linkWidth={(l) => {
                const sId = typeof l.source === "object" ? (l.source as any).id : l.source;
                const tId = typeof l.target === "object" ? (l.target as any).id : l.target;
                const isSelected = selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId;
                return isSelected ? 3 : 1;
              }}
              linkColor={(l) => {
                const sId = typeof l.source === "object" ? (l.source as any).id : l.source;
                const tId = typeof l.target === "object" ? (l.target as any).id : l.target;
                const isSelected = selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId;
                if (isSelected) return "rgba(0, 240, 255, 0.9)";
                
                // Color edges based on target node glow
                const targetNode = data?.nodes.find((n) => n.id === tId);
                return targetNode ? `${getGlowColor(targetNode.node_type)}60` : "rgba(255, 255, 255, 0.25)";
              }}
              linkDirectionalParticles={(l) => {
                const sId = typeof l.source === "object" ? (l.source as any).id : l.source;
                const tId = typeof l.target === "object" ? (l.target as any).id : l.target;
                const isSelected = selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId;
                return isSelected ? 4 : 1;
              }}
              linkDirectionalParticleColor={(l) => {
                const tId = typeof l.target === "object" ? (l.target as any).id : l.target;
                const targetNode = data?.nodes.find((n) => n.id === tId);
                return targetNode ? getGlowColor(targetNode.node_type) : "#00f0ff";
              }}
              linkDirectionalParticleSpeed={0.008}
              nodeRelSize={6}
              nodeCanvasObjectMode={() => "replace"}
              nodeCanvasObject={(node, ctx, scale) => {
                const n = node as Node & { x: number; y: number };
                const isSelected = selectedNode && selectedNode.id === n.id;
                const glow = getGlowColor(n.node_type);
                const r = isSelected ? 8 : 5;

                ctx.save();
                
                // Outer glow shadow
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
                ctx.fillStyle = `${glow}18`;
                ctx.fill();

                // Solid center node
                ctx.beginPath();
                ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = glow;
                ctx.fill();

                // White inner dot/structure
                ctx.beginPath();
                ctx.arc(n.x, n.y, r * 0.4, 0, 2 * Math.PI);
                ctx.fillStyle = "#ffffff";
                ctx.fill();

                // Draw outline
                ctx.strokeStyle = isSelected ? "#ffffff" : "rgba(255, 255, 255, 0.4)";
                ctx.lineWidth = 1.2 / scale;
                ctx.stroke();

                // Label. Drawing every label at once turns a dense graph into
                // unreadable overlap, so only low-cardinality structural nodes
                // are always labelled; high-volume asset/artifact/user nodes are
                // labelled on hover, selection, or when zoomed in.
                const isHovered = hoveredNodeId === n.id;
                const alwaysLabel =
                  n.node_type === "agent" ||
                  n.node_type === "threat" ||
                  n.node_type === "causal_variable" ||
                  n.node_type === "finding" ||
                  n.node_type === "decision";
                const showLabel = isSelected || isHovered || alwaysLabel || scale > 1.5;
                if (showLabel) {
                  const fontSize = 9 / scale;
                  ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
                  ctx.textAlign = "center";
                  ctx.textBaseline = "top";
                  
                  // Label shadow backplate
                  const text = n.label || n.id;
                  ctx.fillStyle = "rgba(10, 10, 12, 0.75)";
                  const tw = ctx.measureText(text).width;
                  ctx.fillRect(n.x - tw/2 - 2, n.y + r + 3, tw + 4, fontSize + 2);
                  
                  ctx.fillStyle = isSelected ? "#ffffff" : "rgba(226, 232, 240, 0.9)";
                  ctx.fillText(text, n.x, n.y + r + 4);
                }

                ctx.restore();
              }}
              onNodeClick={(n) => {
                setSelectedNode(n as Node);
                setSelectedEdge(null);
              }}
              onNodeHover={(n) => {
                setHoveredNodeId(n ? (n as Node).id : null);
              }}
              onLinkClick={(l) => {
                const sId = typeof l.source === "object" ? (l.source as any).id : l.source;
                const tId = typeof l.target === "object" ? (l.target as any).id : l.target;
                setSelectedEdge({
                  source: sId,
                  target: tId,
                  relationship: l.relationship,
                  observed_at: l.observed_at,
                  location: l.location,
                  confidence: l.confidence,
                  metadata: l.metadata,
                });
                setSelectedNode(null);
              }}
              onBackgroundClick={() => {
                setSelectedNode(null);
                setSelectedEdge(null);
              }}
              nodeCanvasBefore={(node, ctx) => {
                // Periodically check and draw background clusters
                if (node === filteredData.nodes[0]) {
                  drawZoneClusterBoxes(filteredData.nodes, ctx);
                }
              }}
            />

            <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-col gap-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground bg-black/40 p-2 rounded">
              <div>x-y · spatial grouping enabled</div>
              <div>t · timeline scrubber active</div>
            </div>
          </div>

          {/* Right Inspector Sidebar */}
          <aside className="border-l border-white/5 bg-[oklch(0.16_0.03_260/0.65)] p-4 overflow-y-auto">
            {!selectedNode && !selectedEdge ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground py-16">
                <Sparkles className="h-5 w-5 text-muted-foreground/45 animate-pulse" />
                <p>Click a node or edge to inspect spatiotemporal details.</p>
              </div>
            ) : selectedNode ? (
              <div className="space-y-4">
                <div className="border-b border-white/5 pb-3">
                  <span
                    className="inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider font-semibold"
                    style={{
                      color: getGlowColor(selectedNode.node_type),
                      backgroundColor: `${getGlowColor(selectedNode.node_type)}15`,
                    }}
                  >
                    {selectedNode.node_type.replace("_", " ")}
                  </span>
                  <h3 className="mt-1 text-sm font-semibold text-foreground">{selectedNode.label}</h3>
                  <code className="text-[10px] text-muted-foreground select-all break-all">{selectedNode.id}</code>
                </div>

                <div className="space-y-3.5 text-xs">
                  {selectedNode.description && (
                    <div className="space-y-1">
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Description</span>
                      <p className="text-foreground/90 bg-white/5 p-2 rounded border border-white/5">{selectedNode.description}</p>
                    </div>
                  )}

                  <div className="space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      Spatial Context (l)
                    </span>
                    <div className="rounded border border-white/5 bg-black/20 p-2 font-mono text-[10px] space-y-1">
                      {Object.entries(selectedNode.location).map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="text-muted-foreground">{k}:</span>
                          <span className="text-foreground/90">{String(v)}</span>
                        </div>
                      ))}
                      {Object.keys(selectedNode.location).length === 0 && (
                        <span className="text-muted-foreground italic">No spatial context</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      Temporal Context (t)
                    </span>
                    <div className="rounded border border-white/5 bg-black/20 p-2 font-mono text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Created:</span>
                        <span className="text-foreground/90">{new Date(selectedNode.created_at).toLocaleTimeString()}</span>
                      </div>
                      <div className="text-muted-foreground text-[8px] mt-1 break-all">{selectedNode.created_at}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="border-b border-white/5 pb-3">
                  <span className="inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider font-semibold bg-white/10 text-foreground">
                    Predicate / Edge
                  </span>
                  <h3 className="mt-1 text-sm font-semibold text-[color:var(--neon-cyan)]">{selectedEdge.relationship}</h3>
                  <div className="flex flex-wrap items-center gap-1 font-mono text-[9px] text-muted-foreground mt-1 select-all break-all">
                    <span>{selectedEdge.source.split(".").pop()}</span>
                    <span>→</span>
                    <span>{selectedEdge.target.split(".").pop()}</span>
                  </div>
                </div>

                <div className="space-y-3.5 text-xs">
                  <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Confidence</span>
                    <span className="font-mono font-semibold text-foreground/90">{Math.round(selectedEdge.confidence * 100)}%</span>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      Location (l)
                    </span>
                    <div className="rounded border border-white/5 bg-black/20 p-2 font-mono text-[10px] space-y-1">
                      {Object.entries(selectedEdge.location).map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="text-muted-foreground">{k}:</span>
                          <span className="text-foreground/90">{String(v)}</span>
                        </div>
                      ))}
                      {Object.keys(selectedEdge.location).length === 0 && (
                        <span className="text-muted-foreground italic">No location context</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      Timestamp (t)
                    </span>
                    <div className="rounded border border-white/5 bg-black/20 p-2 font-mono text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Observed:</span>
                        <span className="text-foreground/90">{new Date(selectedEdge.observed_at).toLocaleTimeString()}</span>
                      </div>
                      <div className="text-muted-foreground text-[8px] mt-1 break-all">{selectedEdge.observed_at}</div>
                    </div>
                  </div>

                  {Object.keys(selectedEdge.metadata).length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Metadata</span>
                      <pre className="rounded border border-white/5 bg-black/40 p-2 font-mono text-[9px] text-foreground/90 overflow-x-auto">
                        {JSON.stringify(selectedEdge.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
