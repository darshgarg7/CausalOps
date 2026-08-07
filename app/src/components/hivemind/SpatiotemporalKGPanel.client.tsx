import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import {
  Activity,
  Calendar,
  Filter,
  FilterX,
  Grid,
  Info,
  Layers,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { fetch5DGraph } from "@/lib/hivemind-api";
import { cn } from "@/lib/utils";
import {
  canvasLayoutMode,
  classifyResize,
  computeGraphBounds,
  createDebouncer,
  graphViewState,
  isSelectionStale,
  labelPriority,
  labelTier,
  nodeSetRetention,
  placeLabelX,
  rectsIntersect,
  resolveLabelCollisions,
  shouldFitForNodeSetChange,
  shouldFitToView,
  shouldRefitForLayoutModeChange,
  shouldShowEdgeLabel,
  truncateLabel,
  type CanvasLayoutMode,
  type LabelPlacement,
  type ScreenRect,
  type Size,
} from "@/lib/graph-viewport";

const DEV = import.meta.env.DEV;
function debugLog(label: string, data: Record<string, unknown>) {
  if (DEV) console.debug(`[5D KG] ${label}`, data);
}

// Test-only instrumentation, matching the existing VITE_HIVEMIND_VISUAL_TEST
// pattern (see routes/index.tsx): exposes the current label plan so
// Playwright can assert "how many labels are visible" and "is the selected
// one among them" without fragile canvas-pixel text detection. A no-op
// (and dead-code-eliminated) in production builds.
const IS_VISUAL_TEST = import.meta.env.VITE_HIVEMIND_VISUAL_TEST === "1";
declare global {
  interface Window {
    __KG_LABEL_PLAN__?: { count: number; ids: string[] };
    // Screen-space (canvas-pixel) positions, so Playwright can click an
    // exact node/edge midpoint instead of sweeping a grid of guesses over
    // a canvas with no other DOM handles to target.
    __KG_NODE_SCREEN__?: Record<string, { x: number; y: number }>;
    __KG_EDGE_SCREEN__?: Record<string, { x: number; y: number }>;
  }
}

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
    [key: string]: unknown;
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
  location: Record<string, unknown>;
  confidence: number;
  metadata: Record<string, unknown>;
};

const IMPORTANT_NODE_TYPES = new Set<Node["node_type"]>([
  "agent",
  "threat",
  "causal_variable",
  "finding",
  "decision",
]);

// Labels are drawn at a screen-constant size (font size divided by zoom in
// graph-space, see nodeCanvasObject below), so measuring/placing them in
// plain screen pixels at this same size gives an exact match regardless of
// current zoom — no scale conversion needed for width/collision math.
const LABEL_SCREEN_FONT_PX = 9;
const EDGE_LABEL_SCREEN_FONT_PX = 10;
// Minimum gap kept between a label and the canvas edge (and, since the
// inspector is a sibling column outside the canvas entirely, this margin
// is also what keeps labels clear of the inspector boundary).
const LABEL_EDGE_MARGIN = 10;

interface NodeLabelPlan {
  text: string;
  align: CanvasTextAlign;
  graphAnchorX: number;
  dim: boolean;
}

interface EdgeLabelPlan {
  text: string;
  align: CanvasTextAlign;
  graphAnchorX: number;
  graphAnchorY: number;
}

/**
 * Measures an element's content box via ResizeObserver; DOM-only, no
 * fit/layout logic (that lives in graph-viewport.ts).
 *
 * Uses a callback ref rather than `useRef` + `useEffect([])`: the canvas
 * card is only mounted once the loading/error/empty states resolve, so an
 * effect-based observer set up against the pre-mount `null` ref would never
 * re-attach once the real element appeared. A callback ref fires exactly
 * when React attaches/detaches the node, whenever that happens.
 */
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize((prev) => {
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);
        if (Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1) {
          return { width, height };
        }
        return prev;
      });
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);

  return { ref, size };
}

export function SpatiotemporalKGPanelClient({ runId }: Props) {
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState(true);

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
  const [hoveredLinkKey, setHoveredLinkKey] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState<number>(0.0);
  const [searchTerm, setSearchTerm] = useState("");
  const ALL_TYPES = [
    "agent",
    "asset",
    "threat",
    "artifact",
    "causal_variable",
    "user",
    "finding",
    "decision",
  ] as const;
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set(ALL_TYPES));
  const [selectedZone, setSelectedZone] = useState<string>("all");

  const fgRef = useRef<ForceGraphMethods<Node, Edge> | undefined>(undefined);
  const animationFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const { ref: rowRef, size: rowSize } = useElementSize<HTMLDivElement>();
  const { ref: graphBoxRef, size: graphBoxSize } = useElementSize<HTMLDivElement>();
  // The inspector column only exists once there's something to inspect — an
  // unselected desktop card gives the canvas full width instead of
  // permanently reserving ~30% for a "click to inspect" placeholder. See
  // canvasLayoutMode() for the single/split/sheet tri-state this drives.
  const hasSelection = Boolean(selectedNode || selectedEdge);
  const canvasMode: CanvasLayoutMode = canvasLayoutMode(rowSize.width, hasSelection);

  // Camera policy state — replaces a single "already fitted" boolean, which
  // could never trigger the *second* fit a major resize needs. See the
  // policy comment above `performFit` for exactly when each field is read.
  const fitTrackerRef = useRef({
    hasFittedOnce: false,
    lastWidth: 0,
    lastHeight: 0,
    lastLayoutMode: null as CanvasLayoutMode | null,
    lastNodeIds: new Set<string>(),
    userInteracted: false,
  });
  // Always-current snapshot of what performFit() needs, so a debounced
  // timeout/rAF callback firing later never reads stale closure values.
  const latestRef = useRef({ width: 0, height: 0, nodes: [] as Node[] });
  const programmaticZoomRef = useRef(false);

  // Per-frame label layout, computed once in onRenderFramePre (screen
  // space) and consumed by nodeCanvasObject/linkCanvasObject (graph
  // space) — see the comment on onRenderFramePre below for why this needs
  // a separate precompute pass rather than being decided per-node inline.
  const nodeLabelPlanRef = useRef<Map<string, NodeLabelPlan>>(new Map());
  const edgeLabelPlanRef = useRef<EdgeLabelPlan | null>(null);
  const lastScaleRef = useRef(1);

  // Fetch Graph data
  const loadGraph = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setSettling(true);
      fitTrackerRef.current.hasFittedOnce = false;
      fitTrackerRef.current.userInteracted = false;
      fitTrackerRef.current.lastNodeIds = new Set();
      const graph = (await fetch5DGraph(runId)) as unknown as {
        nodes: Node[];
        edges: Edge[];
      };
      setData(graph);
      setSelectedNode(null);
      setSelectedEdge(null);

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
      const sourceId =
        typeof edge.source === "object" ? (edge.source as { id: string }).id : edge.source;
      const targetId =
        typeof edge.target === "object" ? (edge.target as { id: string }).id : edge.target;

      return nodeIds.has(sourceId) && nodeIds.has(targetId);
    });

    return {
      nodes: visibleNodes,
      links: visibleEdges.map((e) => ({ ...e })), // Map edges to links for ForceGraph2D
    };
  }, [data, activeTimestamp, selectedTypes, selectedZone, searchTerm, minConfidence]);

  // A selected node/edge that has dropped out of the filtered set (timeline
  // scrubbed past it, its type/zone deselected, ...) must not keep showing
  // stale details for something no longer on screen.
  useEffect(() => {
    const visibleNodeIds = new Set(filteredData.nodes.map((n) => n.id));
    if (isSelectionStale(selectedNode?.id ?? null, visibleNodeIds)) {
      setSelectedNode(null);
    }
    const visibleEdgeIds = new Set(filteredData.links.map((e) => `${e.source}->${e.target}`));
    if (
      selectedEdge &&
      isSelectionStale(`${selectedEdge.source}->${selectedEdge.target}`, visibleEdgeIds)
    ) {
      setSelectedEdge(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredData]);

  const viewState = graphViewState({
    loading,
    error,
    totalNodeCount: data?.nodes.length ?? 0,
    visibleNodeCount: filteredData.nodes.length,
  });

  const resetFilters = () => {
    setSelectedTypes(new Set(ALL_TYPES));
    setSelectedZone("all");
    setSearchTerm("");
    setMinConfidence(0);
  };

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

  const drawZoneClusterBoxes = useCallback((nodes: Node[], ctx: CanvasRenderingContext2D) => {
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
  }, []);

  // Keep a ref-mirror of whatever performFit() needs, updated every render,
  // so a debounced timeout/rAF callback that fires later always reads the
  // current container size and node set instead of a stale closure.
  latestRef.current.width = graphBoxSize.width;
  latestRef.current.height = graphBoxSize.height;
  latestRef.current.nodes = filteredData.nodes;

  // --- Camera policy -------------------------------------------------
  // - initial load (new dataset): fit once the container is measured and
  //   the force engine has actually spread nodes apart.
  // - minor resize (container width/height/aspect ratio barely changed):
  //   preserve the camera — force-graph's own resize handling already
  //   re-centers around the same point without touching zoom, which is
  //   the right behavior for small changes.
  // - major resize (container width/height changed by >~22%, the aspect
  //   ratio shifted by a comparable amount, or the canvas just became
  //   visible): force-graph's half-delta pan is not enough to keep the
  //   fitted cluster in frame, so re-fit once, after the resize settles.
  // - split/sheet detail-panel transition: treated the same as a major
  //   resize, since it changes how much width the canvas actually has.
  // - large timeline/filter change that swaps out most of the visible
  //   node set: re-fit, since the old framing was chosen for a
  //   different set of nodes and may no longer contain the new one.
  // - ordinary single-filter tweaks that keep most of the visible set:
  //   preserve the camera.
  // - explicit Reset button: fit immediately, unconditionally.
  // - user pan/zoom: never overridden by the passive initial-fit retry
  //   loop; only a major resize/layout/dataset change reframes after
  //   that (see `userInteracted` below).
  //
  // Inspector-aware additions (canvasLayoutMode, single/split/sheet):
  //   | event                                            | behavior        |
  //   |---------------------------------------------------|-----------------|
  //   | inspector opens (single -> split)                  | refit once      |
  //   | inspector closes (split -> single)                 | refit once      |
  //   | selection changes, inspector width unchanged       | preserve camera |
  //   | node inspector -> edge inspector, same width       | preserve camera |
  //   | split <-> sheet (width-driven)                     | refit once      |
  //   | minor inspector content change (same selection)    | preserve camera |
  // These all fall out of the same `layoutChanged` check in the resize
  // effect below, since canvasMode only changes on a single<->split<->sheet
  // boundary crossing — never merely because *which* node/edge is selected
  // changed while the mode itself stayed put.
  const performFit = useCallback(() => {
    const { width, height, nodes } = latestRef.current;
    const bounds = computeGraphBounds(nodes);
    const canFit = shouldFitToView({
      containerWidth: width,
      containerHeight: height,
      nodeCount: nodes.length,
      bounds,
      alreadyFittedForDataset: false,
    });
    debugLog("fit attempt", { width, height, nodeCount: nodes.length, bounds, canFit });
    if (!canFit) return false;

    programmaticZoomRef.current = true;
    fgRef.current?.zoomToFit(400, 60);
    window.setTimeout(() => {
      programmaticZoomRef.current = false;
    }, 500);

    const tracker = fitTrackerRef.current;
    tracker.hasFittedOnce = true;
    tracker.lastWidth = width;
    tracker.lastHeight = height;
    tracker.lastNodeIds = new Set(nodes.map((n) => n.id));
    tracker.userInteracted = false;
    setSettling(false);
    debugLog("fit performed", { width, height, nodeCount: nodes.length });
    return true;
  }, []);

  // Debounces bursts of ResizeObserver events (e.g. dragging the browser
  // edge fires many times per second) into a single reframe after the
  // container has stopped changing size, then waits two animation frames
  // so the new width/height have definitely been applied to the canvas
  // before asking the library to fit it. The debouncer itself is created
  // once and reused so repeated schedule calls keep collapsing into it.
  const debouncedFitRef = useRef<ReturnType<typeof createDebouncer> | null>(null);
  if (debouncedFitRef.current === null) {
    debouncedFitRef.current = createDebouncer(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          performFit();
        });
      });
    }, 180);
  }
  const scheduleFit = useCallback((reason: string) => {
    debugLog("fit scheduled", { reason });
    debouncedFitRef.current?.();
  }, []);

  // Drives the *first* fit for a dataset. Bound only to onEngineStop (fired
  // once, when the force simulation's cooldown genuinely finishes), never
  // onEngineTick: bounds technically satisfy shouldFitToView()'s "spread
  // out" check within the first tick or two — long before layout actually
  // settles — so ticking would zoom-to-fit a barely-clustered snapshot and
  // then never get a second chance (a fit past this point is intentionally
  // never automatically retried), leaving most nodes to drift outside the
  // frame as the simulation kept spreading them over the following seconds.
  // Backs off entirely if the user already took manual control of the
  // camera before cooldown finished.
  const attemptInitialFit = useCallback(() => {
    const tracker = fitTrackerRef.current;
    if (tracker.hasFittedOnce || tracker.userInteracted) return;
    performFit();
  }, [performFit]);

  // Detects major container resizes and single/split/sheet inspector-layout
  // changes on the canvas cell itself (never the outer card or the
  // workspace) and schedules a debounced re-fit for them. Minor resizes —
  // and selection changes that don't cross a layout boundary, e.g. picking
  // a different node while already in split mode — just update the tracked
  // baseline so the *next* comparison is against fresh values, per the
  // inspector-aware camera policy documented above `performFit`:
  //   - inspector opens (single -> split): canvas shrinks, refit once
  //   - inspector closes (split -> single): canvas expands, refit once
  //   - selection changes with the inspector already open/closed: preserve
  //   - split <-> sheet (width-driven): refit once
  useEffect(() => {
    const width = graphBoxSize.width;
    const height = graphBoxSize.height;
    if (width <= 0 || height <= 0) return;

    const tracker = fitTrackerRef.current;
    if (!tracker.hasFittedOnce) {
      // Initial fit is owned by attemptInitialFit(); just record a
      // baseline so the first post-fit resize has something to diff.
      tracker.lastWidth = width;
      tracker.lastHeight = height;
      tracker.lastLayoutMode = canvasMode;
      return;
    }

    const prevSize: Size | null =
      tracker.lastWidth > 0 && tracker.lastHeight > 0
        ? { width: tracker.lastWidth, height: tracker.lastHeight }
        : null;
    const sizeClass = classifyResize(prevSize, { width, height });
    const layoutChanged = shouldRefitForLayoutModeChange(tracker.lastLayoutMode, canvasMode);

    debugLog("resize", {
      prevSize,
      nextSize: { width, height },
      aspectRatio: width / height,
      sizeClass,
      canvasMode,
      layoutChanged,
    });

    if (sizeClass === "major" || layoutChanged) {
      setSettling(true);
      scheduleFit(layoutChanged ? "layout-mode-change" : "major-resize");
    }

    tracker.lastWidth = width;
    tracker.lastHeight = height;
    tracker.lastLayoutMode = canvasMode;
  }, [graphBoxSize.width, graphBoxSize.height, canvasMode, scheduleFit]);

  // Detects a visible-node-set change large enough that the previous fit
  // likely no longer frames it (big timeline jump, type/zone filter swap),
  // as opposed to an ordinary single-filter tweak that keeps most nodes.
  useEffect(() => {
    const tracker = fitTrackerRef.current;
    if (!tracker.hasFittedOnce) return;
    const nextIds = new Set(filteredData.nodes.map((n) => n.id));
    const major = shouldFitForNodeSetChange(tracker.lastNodeIds, nextIds);
    debugLog("node set change", {
      prevCount: tracker.lastNodeIds.size,
      nextCount: nextIds.size,
      retention: nodeSetRetention(tracker.lastNodeIds, nextIds),
      major,
    });
    if (major) {
      setSettling(true);
      scheduleFit("node-set-change");
    }
    tracker.lastNodeIds = nextIds;
  }, [filteredData.nodes, scheduleFit]);

  useEffect(() => {
    return () => {
      debouncedFitRef.current?.cancel();
    };
  }, []);

  // Light, bounded force tuning: the d3-force defaults (charge -30) read as
  // an almost-empty graph once sizing is fixed, because same-zone nodes sit
  // nearly on top of each other. This is the smallest adjustment that gives
  // the active node set a readable spread without scattering unrelated
  // nodes far enough apart to obscure their relationships.
  useEffect(() => {
    if (!data) return;
    fgRef.current?.d3Force("charge")?.strength(-140);
    fgRef.current?.d3Force("link")?.distance(70);
  }, [data]);

  const fitNow = useCallback(() => {
    setSettling(true);
    // Explicit user action: fit immediately (buffered by one frame so the
    // just-reset timeline state has applied) rather than going through the
    // resize-settle debounce.
    requestAnimationFrame(() => performFit());
  }, [performFit]);

  // Mobile/narrow (sheet) mode: the detail sheet covers the bottom ~45% of
  // the canvas. A full zoomToFit would be disruptive for a single
  // selection, so instead just nudge the *pan* (not zoom) to bias the
  // selected node toward the upper, uncovered portion of the frame — a
  // recenter, not a reframe, and it never fires in split/single mode
  // where nothing covers the canvas.
  useEffect(() => {
    if (canvasMode !== "sheet" || !selectedNode) return;
    const n = selectedNode as Node & { x?: number; y?: number };
    if (n.x == null || n.y == null || graphBoxSize.height <= 0) return;
    const graph = fgRef.current;
    if (!graph) return;
    const screenBiasPx = graphBoxSize.height * 0.18;
    const graphBias = screenBiasPx / Math.max(lastScaleRef.current, 0.01);
    programmaticZoomRef.current = true;
    graph.centerAt(n.x, n.y + graphBias, 300);
    window.setTimeout(() => {
      programmaticZoomRef.current = false;
    }, 400);
    // Only re-run when the *identity* of the selected node changes, not on
    // every render (n.x/n.y mutate in place from the simulation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasMode, selectedNode?.id]);

  const closeDetails = () => {
    setSelectedNode(null);
    setSelectedEdge(null);
  };

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
                fitNow();
              }}
              title="Reset timeline and view"
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
            {ALL_TYPES.map((type) => (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[10px] font-mono capitalize transition-all",
                  selectedTypes.has(type)
                    ? "border-opacity-50 text-foreground bg-white/5"
                    : "opacity-40 border-white/5 hover:opacity-75",
                )}
                style={{
                  borderColor: selectedTypes.has(type) ? getGlowColor(type) : undefined,
                  boxShadow: selectedTypes.has(type)
                    ? `0 0 4px ${getGlowColor(type)}40`
                    : undefined,
                }}
              >
                {type.replace("_", " ")}
              </button>
            ))}
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

      {viewState === "loading" ? (
        <div
          className="flex h-96 flex-col items-center justify-center gap-3 text-muted-foreground"
          data-testid="kg-state-loading"
        >
          <Activity className="h-8 w-8 animate-spin text-[color:var(--neon-cyan)]" />
          <p className="text-sm font-mono uppercase tracking-wider">
            Compiling Spatiotemporal Graph...
          </p>
        </div>
      ) : viewState === "error" ? (
        <div
          className="flex h-96 flex-col items-center justify-center gap-3 text-rose-400"
          data-testid="kg-state-error"
        >
          <Info className="h-8 w-8" />
          <p className="text-sm font-mono">{error}</p>
          <button
            onClick={loadGraph}
            className="rounded border border-white/10 bg-white/5 px-3 py-1 text-xs text-foreground hover:bg-white/10"
          >
            Retry
          </button>
        </div>
      ) : viewState === "no-data" ? (
        <div
          className="flex h-96 flex-col items-center justify-center gap-3 text-muted-foreground"
          data-testid="kg-state-no-data"
        >
          <Layers className="h-8 w-8 opacity-50" />
          <p className="text-sm font-mono uppercase tracking-wider">
            No spatiotemporal graph recorded for this run.
          </p>
        </div>
      ) : (
        <div
          ref={rowRef}
          className="grid gap-px bg-white/5"
          style={{
            // Fixed 260-320px clamp, not a percentage of the row: at wide
            // viewports a %-based track would grow the inspector far past
            // a readable width. The canvas (minmax(0,1fr)) absorbs
            // everything else, and both columns keep min-width:0 so a
            // long label/description can't force the row to overflow.
            gridTemplateColumns:
              canvasMode === "split" ? "minmax(0, 1fr) minmax(260px, 320px)" : "minmax(0, 1fr)",
          }}
        >
          {/* Main Visualizer */}
          <div
            ref={graphBoxRef}
            className="relative min-w-0 overflow-hidden h-[420px] sm:h-[460px] xl:h-[540px] 2xl:h-[640px] bg-[oklch(0.16_0.03_260/0.6)] p-3"
            data-testid="kg-canvas-box"
          >
            {viewState === "filtered-empty" && (
              <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[oklch(0.1_0.02_260/0.55)] text-center">
                <FilterX className="h-6 w-6 text-muted-foreground" />
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  No nodes match the current filters
                </p>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="pointer-events-auto rounded border border-white/10 bg-white/5 px-3 py-1 text-xs text-foreground hover:bg-white/10"
                >
                  Reset filters
                </button>
              </div>
            )}

            {settling && viewState === "ready" && (
              <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/50 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                <Activity className="h-3 w-3 animate-spin" />
                Arranging graph…
              </div>
            )}

            {graphBoxSize.width > 0 && graphBoxSize.height > 0 && (
              <ForceGraph2D<Node, Edge>
                ref={fgRef as never}
                graphData={filteredData}
                width={graphBoxSize.width}
                height={graphBoxSize.height}
                backgroundColor="rgba(0,0,0,0)"
                cooldownTicks={120}
                enableNodeDrag={true}
                onEngineStop={attemptInitialFit}
                onZoom={() => {
                  // zoomToFit() itself fires onZoom; ignore that
                  // programmatic move so only genuine user pan/zoom marks
                  // the camera as manually controlled. Also ignore anything
                  // before the first successful fit: force-graph fires an
                  // onZoom during its own d3-zoom setup on mount, before
                  // performFit() has run even once — without this guard
                  // that init-time event gets misread as "the user already
                  // took control," permanently blocking the passive
                  // initial-fit retry loop (attemptInitialFit) below.
                  if (programmaticZoomRef.current) return;
                  if (!fitTrackerRef.current.hasFittedOnce) return;
                  fitTrackerRef.current.userInteracted = true;
                }}
                onRenderFramePre={(ctx, scale) => {
                  // Runs once per frame, in plain screen-pixel space,
                  // *before* nodes/links are drawn — the only place we can
                  // see every node's position at once to decide label
                  // placement/collisions before nodeCanvasObject starts
                  // drawing them one at a time. Labels are always rendered
                  // at a screen-constant 9px (nodeCanvasObject divides by
                  // `scale`), so measuring here at that same literal 9px
                  // gives an exact width match with no scale conversion.
                  lastScaleRef.current = scale;
                  const graph = fgRef.current;
                  const canvasWidth = graphBoxSize.width;
                  const canvasHeight = graphBoxSize.height;
                  if (!graph || canvasWidth <= 0 || canvasHeight <= 0) {
                    nodeLabelPlanRef.current = new Map();
                    edgeLabelPlanRef.current = null;
                    return;
                  }

                  const endpointIds = selectedEdge
                    ? new Set([selectedEdge.source, selectedEdge.target])
                    : null;

                  ctx.font = `${LABEL_SCREEN_FONT_PX}px Inter, system-ui, sans-serif`;
                  const candidates: Array<{
                    id: string;
                    priority: number;
                    forceShow: boolean;
                    rect: ScreenRect;
                    text: string;
                    align: CanvasTextAlign;
                    graphAnchorX: number;
                  }> = [];
                  const nodeScreenPositions: Record<string, { x: number; y: number }> = {};

                  for (const raw of filteredData.nodes) {
                    const n = raw as Node & { x?: number; y?: number };
                    if (n.x == null || n.y == null) continue;
                    if (IS_VISUAL_TEST) {
                      nodeScreenPositions[n.id] = graph.graph2ScreenCoords(n.x, n.y);
                    }
                    const isSelected = selectedNode?.id === n.id;
                    const isHovered = hoveredNodeId === n.id;
                    const isEndpoint = endpointIds?.has(n.id) ?? false;
                    const forceShow = isSelected || isHovered || isEndpoint;
                    const tier = labelTier({
                      scale,
                      isImportant: IMPORTANT_NODE_TYPES.has(n.node_type),
                      isSelected: forceShow,
                      isHovered,
                    });
                    if (tier === "hidden") continue;

                    const maxChars = tier === "full" ? 24 : 14;
                    const text = truncateLabel(n.label || n.id, maxChars);
                    const textWidth = ctx.measureText(text).width;
                    const screen = graph.graph2ScreenCoords(n.x, n.y);
                    const placement = placeLabelX(
                      screen.x,
                      textWidth,
                      canvasWidth,
                      LABEL_EDGE_MARGIN,
                    );
                    const rectX =
                      placement.align === "right"
                        ? placement.anchorX - textWidth
                        : placement.align === "left"
                          ? placement.anchorX
                          : placement.anchorX - textWidth / 2;
                    const graphAnchorX = graph.screen2GraphCoords(placement.anchorX, screen.y).x;
                    candidates.push({
                      id: n.id,
                      priority: labelPriority(n.node_type),
                      forceShow,
                      rect: {
                        x: rectX - 2,
                        y: screen.y,
                        width: textWidth + 4,
                        height: LABEL_SCREEN_FONT_PX + 6,
                      },
                      text,
                      align: placement.align,
                      graphAnchorX,
                    });
                  }

                  const visibleIds = resolveLabelCollisions(candidates);
                  const plan = new Map<string, NodeLabelPlan>();
                  const claimedRects: ScreenRect[] = [];
                  for (const c of candidates) {
                    if (!visibleIds.has(c.id)) continue;
                    plan.set(c.id, {
                      text: c.text,
                      align: c.align,
                      graphAnchorX: c.graphAnchorX,
                      dim: hasSelection && !c.forceShow,
                    });
                    claimedRects.push(c.rect);
                  }
                  nodeLabelPlanRef.current = plan;
                  if (IS_VISUAL_TEST) {
                    window.__KG_LABEL_PLAN__ = { count: plan.size, ids: [...plan.keys()] };
                    window.__KG_NODE_SCREEN__ = nodeScreenPositions;
                    const edgeScreenPositions: Record<string, { x: number; y: number }> = {};
                    for (const l of filteredData.links) {
                      const sId =
                        typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                      const tId =
                        typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                      const sp = nodeScreenPositions[sId];
                      const tp = nodeScreenPositions[tId];
                      if (sp && tp) {
                        edgeScreenPositions[`${sId}->${tId}`] = {
                          x: (sp.x + tp.x) / 2,
                          y: (sp.y + tp.y) / 2,
                        };
                      }
                    }
                    window.__KG_EDGE_SCREEN__ = edgeScreenPositions;
                  }

                  // Selected/hovered edge label: placed at the link
                  // midpoint, nudged clear of any node label already
                  // claimed above, and clamped inside the canvas bounds.
                  edgeLabelPlanRef.current = null;
                  const activeLink = filteredData.links.find((l) => {
                    const sId =
                      typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                    const tId =
                      typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                    const isSelected = Boolean(
                      selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId,
                    );
                    const isHovered = hoveredLinkKey === `${sId}->${tId}`;
                    return shouldShowEdgeLabel({ isSelected, isHovered });
                  });
                  if (activeLink) {
                    const sId =
                      typeof activeLink.source === "object"
                        ? (activeLink.source as { id: string }).id
                        : activeLink.source;
                    const tId =
                      typeof activeLink.target === "object"
                        ? (activeLink.target as { id: string }).id
                        : activeLink.target;
                    const sourceNode = filteredData.nodes.find((n) => n.id === sId) as
                      | (Node & { x?: number; y?: number })
                      | undefined;
                    const targetNode = filteredData.nodes.find((n) => n.id === tId) as
                      | (Node & { x?: number; y?: number })
                      | undefined;
                    if (
                      sourceNode?.x != null &&
                      sourceNode?.y != null &&
                      targetNode?.x != null &&
                      targetNode?.y != null
                    ) {
                      const midGraphX = (sourceNode.x + targetNode.x) / 2;
                      const midGraphY = (sourceNode.y + targetNode.y) / 2;
                      const screen = graph.graph2ScreenCoords(midGraphX, midGraphY);
                      ctx.font = `${EDGE_LABEL_SCREEN_FONT_PX}px monospace`;
                      const text = truncateLabel(activeLink.relationship, 40);
                      const textWidth = ctx.measureText(text).width;
                      const placement = placeLabelX(
                        screen.x,
                        textWidth,
                        canvasWidth,
                        LABEL_EDGE_MARGIN,
                      );
                      const rectX =
                        placement.align === "right"
                          ? placement.anchorX - textWidth
                          : placement.align === "left"
                            ? placement.anchorX
                            : placement.anchorX - textWidth / 2;
                      let screenY = screen.y - 14;
                      let rect: ScreenRect = {
                        x: rectX - 2,
                        y: screenY - 2,
                        width: textWidth + 4,
                        height: EDGE_LABEL_SCREEN_FONT_PX + 4,
                      };
                      if (claimedRects.some((r) => rectsIntersect(r, rect))) {
                        screenY = screen.y + 16;
                        rect = { ...rect, y: screenY - 2 };
                      }
                      screenY = Math.min(
                        Math.max(screenY, LABEL_EDGE_MARGIN + EDGE_LABEL_SCREEN_FONT_PX),
                        canvasHeight - LABEL_EDGE_MARGIN,
                      );
                      const graphAnchor = graph.screen2GraphCoords(placement.anchorX, screenY);
                      edgeLabelPlanRef.current = {
                        text,
                        align: placement.align,
                        graphAnchorX: graphAnchor.x,
                        graphAnchorY: graphAnchor.y,
                      };
                    }
                  }
                }}
                linkCanvasObjectMode={() => "after"}
                linkCanvasObject={(link, ctx) => {
                  const sId =
                    typeof link.source === "object"
                      ? (link.source as { id: string }).id
                      : link.source;
                  const tId =
                    typeof link.target === "object"
                      ? (link.target as { id: string }).id
                      : link.target;
                  const isSelected = Boolean(
                    selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId,
                  );
                  const plan = edgeLabelPlanRef.current;
                  if (!plan) return;
                  // Only the single active (selected/hovered) edge has a
                  // plan at all, but guard explicitly in case two edges
                  // ever share endpoints.
                  const isHovered = hoveredLinkKey === `${sId}->${tId}`;
                  if (!isSelected && !isHovered) return;

                  ctx.save();
                  ctx.font = `${EDGE_LABEL_SCREEN_FONT_PX / lastScaleRef.current}px monospace`;
                  ctx.textAlign = plan.align;
                  ctx.textBaseline = "middle";
                  const tw = ctx.measureText(plan.text).width;
                  const padX = 4 / lastScaleRef.current;
                  const padY = 3 / lastScaleRef.current;
                  const boxX =
                    plan.align === "right"
                      ? plan.graphAnchorX - tw - padX
                      : plan.align === "left"
                        ? plan.graphAnchorX - padX
                        : plan.graphAnchorX - tw / 2 - padX;
                  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
                  ctx.fillRect(
                    boxX,
                    plan.graphAnchorY - EDGE_LABEL_SCREEN_FONT_PX / lastScaleRef.current / 2 - padY,
                    tw + padX * 2,
                    EDGE_LABEL_SCREEN_FONT_PX / lastScaleRef.current + padY * 2,
                  );
                  ctx.fillStyle = "rgba(120, 220, 255, 0.95)";
                  ctx.fillText(plan.text, plan.graphAnchorX, plan.graphAnchorY);
                  ctx.restore();
                }}
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={0.92}
                linkWidth={(l) => {
                  const sId =
                    typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                  const tId =
                    typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                  const isSelected =
                    selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId;
                  return isSelected ? 3 : 1;
                }}
                linkColor={(l) => {
                  const sId =
                    typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                  const tId =
                    typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                  const isSelected =
                    selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId;
                  if (isSelected) return "rgba(0, 240, 255, 0.9)";

                  // Color edges based on target node glow
                  const targetNode = data?.nodes.find((n) => n.id === tId);
                  return targetNode
                    ? `${getGlowColor(targetNode.node_type)}60`
                    : "rgba(255, 255, 255, 0.25)";
                }}
                linkDirectionalParticles={(l) => {
                  const sId =
                    typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                  const tId =
                    typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                  const isSelected =
                    selectedEdge && selectedEdge.source === sId && selectedEdge.target === tId;
                  return isSelected ? 4 : 1;
                }}
                linkDirectionalParticleColor={(l) => {
                  const tId =
                    typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                  const targetNode = data?.nodes.find((n) => n.id === tId);
                  return targetNode ? getGlowColor(targetNode.node_type) : "#00f0ff";
                }}
                linkDirectionalParticleSpeed={0.008}
                nodeRelSize={6}
                nodeCanvasObjectMode={() => "replace"}
                nodeCanvasObject={(node, ctx, scale) => {
                  const n = node as Node & { x: number; y: number };
                  const isSelected = selectedNode && selectedNode.id === n.id;
                  const isHovered = hoveredNodeId === n.id;
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

                  // Label. Placement, truncation, canvas-edge clamping and
                  // dense-cluster collision suppression are all decided
                  // once per frame in onRenderFramePre (screen space) —
                  // this just draws whatever survived that pass, if
                  // anything, converting back to graph-space coordinates.
                  const plan = nodeLabelPlanRef.current.get(n.id);
                  if (plan) {
                    const fontSize = LABEL_SCREEN_FONT_PX / scale;
                    ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
                    ctx.textAlign = plan.align;
                    ctx.textBaseline = "top";
                    const tw = ctx.measureText(plan.text).width;
                    const backplateX =
                      plan.align === "right"
                        ? plan.graphAnchorX - tw - 2
                        : plan.align === "left"
                          ? plan.graphAnchorX - 2
                          : plan.graphAnchorX - tw / 2 - 2;

                    // Label shadow backplate
                    ctx.fillStyle = plan.dim ? "rgba(10, 10, 12, 0.35)" : "rgba(10, 10, 12, 0.75)";
                    ctx.fillRect(backplateX, n.y + r + 3, tw + 4, fontSize + 2);

                    ctx.fillStyle = isSelected
                      ? "#ffffff"
                      : plan.dim
                        ? "rgba(226, 232, 240, 0.4)"
                        : "rgba(226, 232, 240, 0.9)";
                    ctx.fillText(plan.text, plan.graphAnchorX, n.y + r + 4);
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
                onLinkHover={(l) => {
                  if (!l) {
                    setHoveredLinkKey(null);
                    return;
                  }
                  const sId =
                    typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                  const tId =
                    typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
                  setHoveredLinkKey(`${sId}->${tId}`);
                }}
                onLinkClick={(l) => {
                  const sId =
                    typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
                  const tId =
                    typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
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
                nodeCanvasBefore={(node: Node, ctx: CanvasRenderingContext2D) => {
                  // Periodically check and draw background clusters
                  if (node === filteredData.nodes[0]) {
                    drawZoneClusterBoxes(filteredData.nodes, ctx);
                  }
                }}
              />
            )}

            <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-col gap-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground bg-black/40 p-2 rounded">
              <div>x-y · spatial grouping enabled</div>
              <div>t · timeline scrubber active</div>
              {canvasMode === "single" && <div>click a node or edge to inspect</div>}
            </div>

            {/* Narrow viewports: the detail panel becomes a dismissible
                bottom sheet inside the canvas card instead of a fixed-width
                side column that would leave almost no room for the graph. */}
            {canvasMode === "sheet" && hasSelection && (
              <div
                className="absolute inset-x-0 bottom-0 z-30 max-h-[45%] overflow-y-auto rounded-t-xl border-t border-white/10 bg-[oklch(0.14_0.03_260/0.97)] shadow-[0_-8px_24px_rgba(0,0,0,0.4)]"
                data-testid="kg-detail-panel"
              >
                <DetailPanelContent
                  selectedNode={selectedNode}
                  selectedEdge={selectedEdge}
                  onClose={closeDetails}
                />
              </div>
            )}
          </div>

          {/* Wide viewports: in-flow side column, never overlapping the
              canvas — a real grid sibling with a solid (non-transparent)
              background, so nothing drawn on the canvas can show through
              even if it briefly overflows during a resize. */}
          {canvasMode === "split" && (
            <aside
              className="min-w-0 overflow-y-auto border-l border-white/5 bg-[oklch(0.16_0.03_260/0.98)]"
              data-testid="kg-detail-panel"
            >
              <DetailPanelContent
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                onClose={closeDetails}
              />
            </aside>
          )}
        </div>
      )}
    </section>
  );
}

function DetailPanelContent({
  selectedNode,
  selectedEdge,
  onClose,
}: {
  selectedNode: Node | null;
  selectedEdge: Edge | null;
  onClose: () => void;
}) {
  if (!selectedNode && !selectedEdge) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground py-16 px-4">
        <Sparkles className="h-5 w-5 text-muted-foreground/45 animate-pulse" />
        <p>Click a node or edge to inspect spatiotemporal details.</p>
      </div>
    );
  }

  if (selectedNode) {
    const glow = glowColorFor(selectedNode.node_type);
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-2 border-b border-white/5 pb-3">
          <div className="min-w-0">
            <span
              className="inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider font-semibold"
              style={{ color: glow, backgroundColor: `${glow}15` }}
            >
              {selectedNode.node_type.replace("_", " ")}
            </span>
            <h3 className="mt-1 text-sm font-semibold text-foreground">{selectedNode.label}</h3>
            <code className="text-[10px] text-muted-foreground select-all break-all">
              {selectedNode.id}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3.5 text-xs">
          {selectedNode.description && (
            <div className="space-y-1">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Description
              </span>
              <p className="text-foreground/90 bg-white/5 p-2 rounded border border-white/5">
                {selectedNode.description}
              </p>
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
                <span className="text-foreground/90">
                  {new Date(selectedNode.created_at).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-muted-foreground text-[8px] mt-1 break-all">
                {selectedNode.created_at}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const edge = selectedEdge!;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-2 border-b border-white/5 pb-3">
        <div className="min-w-0">
          <span className="inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider font-semibold bg-white/10 text-foreground">
            Predicate / Edge
          </span>
          <h3 className="mt-1 text-sm font-semibold text-[color:var(--neon-cyan)]">
            {edge.relationship}
          </h3>
          <div className="flex flex-wrap items-center gap-1 font-mono text-[9px] text-muted-foreground mt-1 select-all break-all">
            <span>{edge.source.split(".").pop()}</span>
            <span>→</span>
            <span>{edge.target.split(".").pop()}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3.5 text-xs">
        <div className="flex justify-between items-center py-1.5 border-b border-white/5">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Confidence
          </span>
          <span className="font-mono font-semibold text-foreground/90">
            {Math.round(edge.confidence * 100)}%
          </span>
        </div>

        <div className="space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            Location (l)
          </span>
          <div className="rounded border border-white/5 bg-black/20 p-2 font-mono text-[10px] space-y-1">
            {Object.entries(edge.location).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted-foreground">{k}:</span>
                <span className="text-foreground/90">{String(v)}</span>
              </div>
            ))}
            {Object.keys(edge.location).length === 0 && (
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
              <span className="text-foreground/90">
                {new Date(edge.observed_at).toLocaleTimeString()}
              </span>
            </div>
            <div className="text-muted-foreground text-[8px] mt-1 break-all">
              {edge.observed_at}
            </div>
          </div>
        </div>

        {Object.keys(edge.metadata).length > 0 && (
          <div className="space-y-1">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Metadata
            </span>
            <pre className="rounded border border-white/5 bg-black/40 p-2 font-mono text-[9px] text-foreground/90 overflow-x-auto">
              {JSON.stringify(edge.metadata, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function glowColorFor(type: string) {
  switch (type) {
    case "agent":
      return "#bc34fa";
    case "asset":
      return "#50aaff";
    case "threat":
      return "#ff4560";
    case "artifact":
      return "#ffb03a";
    case "causal_variable":
      return "#eed202";
    case "user":
      return "#50f0aa";
    case "finding":
      return "#ff7a50";
    case "decision":
      return "#3ae8c8";
    default:
      return "#a891ff";
  }
}
