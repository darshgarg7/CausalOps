import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Crosshair, Maximize2, Minimize2, RotateCcw, Tag, TagsIcon } from "lucide-react";
import type { CausalGraph as CausalGraphData, CausalNode, CausalEdge } from "@/lib/causalops-types";
import type { EdgeAnnotation } from "@/lib/agent-runtime";
import { cn } from "@/lib/utils";

export interface CausalGraphHandle {
  getCanvas: () => HTMLCanvasElement | null;
  fit: () => void;
}

interface CausalGraphProps {
  graph: CausalGraphData;
  onSelectNode?: (node: CausalNode | null) => void;
  onSelectEdge?: (edge: CausalEdge | null) => void;
  height?: number;
  edgeAnnotations?: EdgeAnnotation[];
}

type GNode = CausalNode & { __indeg?: number; __outdeg?: number; x?: number; y?: number };
type GLink = CausalEdge;

// react-force-graph mutates source/target from string ids into the node objects
// after the first simulation tick. Helper normalizes both shapes safely.
function endpointId(end: unknown): string {
  if (typeof end === "string") return end;
  if (end && typeof end === "object" && "id" in end) {
    return String((end as { id: unknown }).id);
  }
  return "";
}

export const CausalGraphClient = forwardRef<CausalGraphHandle, CausalGraphProps>(
  function CausalGraphClient(
    { graph, onSelectNode, onSelectEdge, height = 480, edgeAnnotations },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
    const [size, setSize] = useState({ w: 800, h: height });
    const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
    const [showLabels, setShowLabels] = useState(true);
    const [fullscreen, setFullscreen] = useState(false);

    const graphStr = JSON.stringify(graph);

    // Build node + link arrays with degree info
    const data = useMemo(() => {
      const nodes: GNode[] = graph.nodes.map((n) => ({ ...n, __indeg: 0, __outdeg: 0 }));
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      const links: GLink[] = [];
      for (const e of graph.edges) {
        // skip dangling refs to avoid force-graph crash
        if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;
        links.push({ ...e });
        nodeMap.get(e.source)!.__outdeg!++;
        nodeMap.get(e.target)!.__indeg!++;
      }
      return { nodes, links };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [graphStr]);

    // Annotation lookup
    const annByKey = useMemo(() => {
      const m = new Map<string, EdgeAnnotation>();
      if (edgeAnnotations) for (const a of edgeAnnotations) m.set(a.key, a);
      return m;
    }, [edgeAnnotations]);

    // Convert oklch CSS var to a usable canvas color via a runtime helper that
    // resolves the computed style once per render.
    const evidenceCanvasColor = useCallback((type: EdgeAnnotation["evidenceType"], alpha = 1) => {
      const map: Record<EdgeAnnotation["evidenceType"], string> = {
        telemetry: `rgba(80, 220, 170, ${alpha})`,
        external_intel: `rgba(120, 220, 255, ${alpha})`,
        heuristic: `rgba(245, 200, 100, ${alpha})`,
        model_inferred: `rgba(190, 150, 255, ${alpha})`,
      };
      return map[type];
    }, []);

    // Neighbor index for highlight
    const neighborIndex = useMemo(() => {
      const map = new Map<string, Set<string>>();
      for (const n of data.nodes) map.set(n.id, new Set());
      for (const l of data.links) {
        map.get(l.source)?.add(l.target);
        map.get(l.target)?.add(l.source);
      }
      return map;
    }, [data]);

    // Resize observer
    useEffect(() => {
      if (!containerRef.current) return;
      const el = containerRef.current;
      const ro = new ResizeObserver((entries) => {
        const r = entries[0].contentRect;
        setSize((prev) => {
          const nextW = Math.max(320, Math.floor(r.width));
          const nextH = Math.floor(r.height || height);
          if (Math.abs(prev.w - nextW) > 2 || Math.abs(prev.h - nextH) > 2) {
            return { w: nextW, h: nextH };
          }
          return prev;
        });
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [height]);

    const fit = useCallback(() => {
      fgRef.current?.zoomToFit(400, 40);
    }, []);

    const graphHash = `${graph.nodes.length}-${graph.edges.length}`;
    useEffect(() => {
      const t = setTimeout(fit, 200);
      return () => clearTimeout(t);
    }, [graphHash, fit]);

    useImperativeHandle(ref, () => ({
      getCanvas: () => {
        const el = containerRef.current?.querySelector("canvas");
        return (el as HTMLCanvasElement) || null;
      },
      fit,
    }));

    const reset = () => {
      setSelectedNodeId(null);
      setSelectedEdgeKey(null);
      onSelectNode?.(null);
      onSelectEdge?.(null);
      fit();
    };

    const activeId = hoverNodeId ?? selectedNodeId;

    const isDimmed = (nodeId: string) => {
      if (!activeId) return false;
      if (nodeId === activeId) return false;
      return !neighborIndex.get(activeId)?.has(nodeId);
    };

    return (
      <div
        ref={containerRef}
        className={cn(
          "relative w-full overflow-hidden rounded-xl border border-white/10 bg-[oklch(0.1_0.02_260/0.7)]",
          fullscreen && "fixed inset-4 z-50 h-auto",
        )}
        style={fullscreen ? undefined : { height }}
      >
        {/* Toolbar */}
        <div className="absolute right-3 top-3 z-10 flex gap-1.5 rounded-lg border border-white/10 bg-black/40 p-1 backdrop-blur">
          <button
            type="button"
            onClick={reset}
            title="Reset selection & view"
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={fit}
            title="Fit graph"
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowLabels((v) => !v)}
            title={showLabels ? "Hide labels" : "Show labels"}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-white/10",
              showLabels ? "text-[color:var(--neon-cyan)]" : "text-muted-foreground",
            )}
          >
            {showLabels ? <Tag className="h-3.5 w-3.5" /> : <TagsIcon className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            {fullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {/* Hint */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          scroll · zoom &nbsp;·&nbsp; drag · pan &nbsp;·&nbsp; hover · trace &nbsp;·&nbsp; click ·
          inspect
        </div>

        {data.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No graph data.
          </div>
        ) : (
          <ForceGraph2D<GNode, GLink>
            ref={fgRef as never}
            graphData={data}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            cooldownTicks={80}
            enableNodeDrag={true}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={0.92}
            linkWidth={(l) => {
              const sId = endpointId((l as { source: unknown }).source);
              const tId = endpointId((l as { target: unknown }).target);
              const isActive = activeId && (sId === activeId || tId === activeId);
              const ann = annByKey.get(`${sId}->${tId}`);
              const base = ann ? 0.8 + ann.confidence * 1.6 : 1;
              return isActive ? base + 1 : base;
            }}
            linkColor={(l) => {
              const sId = endpointId((l as { source: unknown }).source);
              const tId = endpointId((l as { target: unknown }).target);
              const isActive = activeId && (sId === activeId || tId === activeId);
              const dim = activeId && !isActive;
              const ann = annByKey.get(`${sId}->${tId}`);
              if (ann) {
                const a = dim ? 0.18 : 0.45 + ann.confidence * 0.45;
                return evidenceCanvasColor(ann.evidenceType, a);
              }
              return dim ? "rgba(168, 145, 255, 0.12)" : "rgba(168, 145, 255, 0.6)";
            }}
            linkDirectionalParticles={(l) => {
              const sId = endpointId((l as { source: unknown }).source);
              const tId = endpointId((l as { target: unknown }).target);
              const key = `${sId}->${tId}`;
              return key === selectedEdgeKey ? 4 : 0;
            }}
            linkDirectionalParticleColor={() => "rgba(120, 220, 255, 0.95)"}
            linkDirectionalParticleSpeed={0.012}
            linkCanvasObjectMode={() => "after"}
            linkCanvasObject={(link, ctx, scale) => {
              if (!showLabels || scale < 1.2) return;
              const src = (link as { source: unknown }).source as GNode;
              const tgt = (link as { target: unknown }).target as GNode;
              if (typeof src !== "object" || typeof tgt !== "object") return;
              if (src.x == null || src.y == null || tgt.x == null || tgt.y == null) return;
              const midX = (src.x + tgt.x) / 2;
              const midY = (src.y + tgt.y) / 2;
              const fontSize = 9 / scale;
              ctx.font = `${fontSize}px monospace`;
              const text = (link as GLink).relationship;
              const w = ctx.measureText(text).width + 4 / scale;
              const h = fontSize + 3 / scale;
              ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
              ctx.fillRect(midX - w / 2, midY - h / 2, w, h);
              ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(text, midX, midY);
            }}
            nodeRelSize={5}
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={(node, ctx, scale) => {
              const n = node as GNode & { x: number; y: number };
              const isSelected = n.id === selectedNodeId;
              const isHover = n.id === hoverNodeId;
              const dim = isDimmed(n.id);

              const baseR = 5 + Math.min(6, ((n.__indeg ?? 0) + (n.__outdeg ?? 0)) * 0.6);
              const r = isSelected ? baseR + 2 : baseR;

              // glow
              if (isSelected || isHover) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
                ctx.fillStyle = isSelected
                  ? "rgba(120, 220, 255, 0.25)"
                  : "rgba(168, 145, 255, 0.18)";
                ctx.fill();
              }

              ctx.beginPath();
              ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
              ctx.fillStyle = dim
                ? "rgba(120, 220, 255, 0.15)"
                : isSelected
                  ? "rgba(120, 220, 255, 1)"
                  : "rgba(120, 220, 255, 0.85)";
              ctx.fill();
              ctx.lineWidth = 1.2 / scale;
              ctx.strokeStyle = dim ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.6)";
              ctx.stroke();

              if (showLabels && scale > 0.6) {
                const fontSize = 11 / scale;
                ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
                ctx.fillStyle = dim ? "rgba(226,232,240,0.25)" : "rgba(226,232,240,0.95)";
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillText(n.label || n.id, n.x, n.y + r + 2 / scale);
              }
            }}
            onNodeHover={(n) => {
              setHoverNodeId(n ? (n as GNode).id : null);
              const canvas = containerRef.current?.querySelector("canvas");
              if (canvas) (canvas as HTMLCanvasElement).style.cursor = n ? "pointer" : "grab";
            }}
            onNodeClick={(n) => {
              const node = n as GNode;
              setSelectedNodeId(node.id);
              setSelectedEdgeKey(null);
              onSelectNode?.(node);
              onSelectEdge?.(null);
            }}
            onLinkClick={(l) => {
              const sId = endpointId((l as { source: unknown }).source);
              const tId = endpointId((l as { target: unknown }).target);
              setSelectedEdgeKey(`${sId}->${tId}`);
              setSelectedNodeId(null);
              onSelectNode?.(null);
              onSelectEdge?.({
                source: sId,
                target: tId,
                relationship: (l as GLink).relationship,
              });
            }}
            onBackgroundClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeKey(null);
              onSelectNode?.(null);
              onSelectEdge?.(null);
            }}
          />
        )}
      </div>
    );
  },
);
