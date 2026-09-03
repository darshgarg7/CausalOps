/**
 * Pure, DOM-free helpers for the force-directed graph panels (5D KG, causal
 * DAG). Kept separate from the React components so the fit/label/layout
 * decisions can be unit tested without a browser renderer — this project's
 * vitest config runs in a plain "node" environment (see vitest.config.ts),
 * not jsdom, so nothing here may touch `window`, `document`, or a canvas.
 */

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Bounding box of every node with finite x/y coordinates. Returns null when
 * no node has been positioned yet (e.g. before the force engine has run any
 * ticks) — callers use that to distinguish "no nodes" from "not laid out".
 */
export function computeGraphBounds(
  nodes: ReadonlyArray<{ x?: number; y?: number }>,
): Bounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const node of nodes) {
    if (typeof node.x !== "number" || typeof node.y !== "number") continue;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    found = true;
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }

  return found ? { minX, maxX, minY, maxY } : null;
}

/** True once node positions have actually spread out from a single point. */
export function boundsAreSettled(bounds: Bounds | null, minSpan = 1): boolean {
  if (!bounds) return false;
  return bounds.maxX - bounds.minX >= minSpan || bounds.maxY - bounds.minY >= minSpan;
}

export interface FitTriggerState {
  containerWidth: number;
  containerHeight: number;
  nodeCount: number;
  bounds: Bounds | null;
  /** Whether a fit already ran for the currently loaded dataset. */
  alreadyFittedForDataset: boolean;
}

/**
 * Decides whether an automatic zoom-to-fit should run. Requires a
 * non-zero-sized container, at least one node, and positions that have
 * actually settled out of the force engine — fitting against a
 * zero-size container or an unsettled (0,0)-clustered layout is what
 * produces the "nodes appear outside the viewport until you zoom" bug.
 */
export function shouldFitToView(state: FitTriggerState): boolean {
  return (
    state.containerWidth > 0 &&
    state.containerHeight > 0 &&
    state.nodeCount > 0 &&
    !state.alreadyFittedForDataset &&
    boundsAreSettled(state.bounds)
  );
}

export type LabelTier = "hidden" | "short" | "full";

export interface LabelTierParams {
  /** react-force-graph's globalScale (1 = default zoom). */
  scale: number;
  isImportant: boolean;
  isSelected: boolean;
  isHovered: boolean;
}

// Below this zoom, showing every label produces unreadable overlap on any
// graph with more than a handful of nodes.
const LOW_ZOOM_THRESHOLD = 0.6;
// Above this zoom there's enough on-screen space per node for full labels.
const HIGH_ZOOM_THRESHOLD = 1.5;

/**
 * Tiers label detail by zoom level and node importance/selection state.
 * Selected/hovered nodes always get a full label regardless of zoom so the
 * user's current focus is never unlabeled.
 */
export function labelTier(params: LabelTierParams): LabelTier {
  const { scale, isImportant, isSelected, isHovered } = params;
  if (isSelected || isHovered) return "full";
  if (scale >= HIGH_ZOOM_THRESHOLD) return "full";
  if (scale >= LOW_ZOOM_THRESHOLD) return isImportant ? "short" : "hidden";
  return "hidden";
}

/** Truncates to at most `maxChars`, adding an ellipsis when text was cut. */
export function truncateLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(maxChars, 0));
  return `${text.slice(0, maxChars - 1)}…`;
}

export type DetailPanelLayoutMode = "split" | "sheet";

// Below this measured card width, a fixed-width side column would leave too
// little room for the canvas; the detail panel becomes a bottom sheet
// instead. Measured against the graph card's own width (not the viewport),
// since sibling panels (the compact DAG, the outer workspace grid) change
// how much width the card actually gets at a given viewport size.
const DETAIL_PANEL_SPLIT_MIN_WIDTH = 620;

export function detailPanelLayoutMode(containerWidth: number): DetailPanelLayoutMode {
  return containerWidth >= DETAIL_PANEL_SPLIT_MIN_WIDTH ? "split" : "sheet";
}

export type GraphViewState = "loading" | "error" | "no-data" | "filtered-empty" | "ready";

/** Which empty/loading/ready state the canvas area should communicate. */
export function graphViewState(params: {
  loading: boolean;
  error: string | null;
  totalNodeCount: number;
  visibleNodeCount: number;
}): GraphViewState {
  if (params.loading) return "loading";
  if (params.error) return "error";
  if (params.totalNodeCount === 0) return "no-data";
  if (params.visibleNodeCount === 0) return "filtered-empty";
  return "ready";
}

/** True when a selected node/edge id has dropped out of the visible set. */
export function isSelectionStale(
  selectedId: string | null,
  visibleIds: ReadonlySet<string>,
): boolean {
  if (selectedId === null) return false;
  return !visibleIds.has(selectedId);
}

// ---------------------------------------------------------------------------
// Camera policy: deciding when a resize/layout/data change is big enough to
// warrant re-framing the camera, vs. small enough that the user's current
// pan/zoom should be left alone.
//
// force-graph's own resize handling (force-graph/dist/force-graph.mjs,
// adjustCanvasSize) only pans by half the size delta at the *existing* zoom
// level — it never rescales `k` or re-fits bounds. That's correct for a
// small resize (a few px as a sidebar re-flows text), but for a large
// width/aspect-ratio change it leaves the previously-fitted node cluster
// off-frame at the new canvas size. classifyResize() is how callers detect
// that "small vs. large" boundary so they know when to call zoomToFit again.
// ---------------------------------------------------------------------------

export interface Size {
  width: number;
  height: number;
}

export type ResizeClass = "none" | "minor" | "major";

// A resize is "major" once either dimension moves by more than ~1/5, or the
// aspect ratio itself shifts by a comparable amount (a width-only change can
// still leave height untouched while completely changing the frame shape).
const MAJOR_SIZE_DELTA_RATIO = 0.22;
const MAJOR_ASPECT_DELTA_RATIO = 0.22;

/**
 * Classifies a container resize as "none" (unchanged), "minor" (camera
 * should be preserved), or "major" (camera should be re-fit). A transition
 * from a zero/absent size to a real one (e.g. the canvas card just mounted,
 * or was hidden behind a loading state) is always "major".
 */
export function classifyResize(prev: Size | null, next: Size): ResizeClass {
  if (next.width <= 0 || next.height <= 0) return "none"; // not visible yet
  if (!prev || prev.width <= 0 || prev.height <= 0) return "major"; // became visible
  if (prev.width === next.width && prev.height === next.height) return "none";

  const widthDelta = Math.abs(next.width - prev.width) / prev.width;
  const heightDelta = Math.abs(next.height - prev.height) / prev.height;
  const prevAspect = prev.width / prev.height;
  const nextAspect = next.width / next.height;
  const aspectDelta = Math.abs(nextAspect - prevAspect) / prevAspect;

  if (
    widthDelta > MAJOR_SIZE_DELTA_RATIO ||
    heightDelta > MAJOR_SIZE_DELTA_RATIO ||
    aspectDelta > MAJOR_ASPECT_DELTA_RATIO
  ) {
    return "major";
  }
  return "minor";
}

/**
 * True when a layout-mode-like value just changed (detail panel split vs.
 * sheet, or the richer inspector split/single/sheet tri-state below).
 * Generic so the same comparison serves both.
 */
export function shouldRefitForLayoutModeChange<T>(prev: T | null, next: T): boolean {
  return prev !== null && prev !== next;
}

// ---------------------------------------------------------------------------
// Inspector-aware canvas layout: whether the detail panel actually occupies
// a grid column right now. Unlike `detailPanelLayoutMode` (a pure function
// of measured width — "capable of a split layout or not"), this also
// depends on whether anything is selected, because the split-mode aside
// only claims space once there's something to show in it — an unselected
// desktop card gives the canvas the full width instead of reserving a
// column for a permanent "click to inspect" placeholder.
// ---------------------------------------------------------------------------

export type CanvasLayoutMode = "single" | "split" | "sheet";

/**
 * `single`: split-capable width, nothing selected — canvas gets full width.
 * `split`: split-capable width, something selected — canvas + inspector
 *   columns side by side.
 * `sheet`: too narrow for a column — canvas always full width; a selection
 *   shows the inspector as a bottom sheet overlay instead (handled by the
 *   caller, not this function).
 */
export function canvasLayoutMode(cardWidth: number, hasSelection: boolean): CanvasLayoutMode {
  const capacity = detailPanelLayoutMode(cardWidth);
  if (capacity === "sheet") return "sheet";
  return hasSelection ? "split" : "single";
}

/** Fraction of `nextIds` that were already present in `prevIds` (0..1). */
export function nodeSetRetention(
  prevIds: ReadonlySet<string>,
  nextIds: ReadonlySet<string>,
): number {
  if (nextIds.size === 0) return 1;
  if (prevIds.size === 0) return 0;
  let overlap = 0;
  for (const id of nextIds) {
    if (prevIds.has(id)) overlap++;
  }
  return overlap / nextIds.size;
}

// Below this retention fraction, "most" of the currently-visible nodes are
// ones the last fit never saw (e.g. the timeline scrub jumped far, or a
// type filter swapped in a mostly-disjoint set) — the old framing is no
// longer a reasonable guess at where the new set actually sits.
const MAJOR_NODE_SET_CHANGE_MAX_RETENTION = 0.3;

/**
 * True when the visible node set changed enough that the previous camera
 * framing is unlikely to still contain most of it. Ordinary single-filter
 * toggles keep the bulk of the set and return false here; jumping the
 * timeline across most of its range, or clearing/swapping every type
 * filter at once, returns true.
 */
export function shouldFitForNodeSetChange(
  prevIds: ReadonlySet<string>,
  nextIds: ReadonlySet<string>,
): boolean {
  if (nextIds.size === 0) return false;
  return nodeSetRetention(prevIds, nextIds) < MAJOR_NODE_SET_CHANGE_MAX_RETENTION;
}

// ---------------------------------------------------------------------------
// Label placement: keeping node/edge labels inside the canvas's own bounds
// (never drawing into the inspector column) and thinning them out in dense
// clusters. All of this operates in *screen* pixel space — the caller is
// responsible for converting to/from the canvas's graph-space coordinates
// (see the `graph2ScreenCoords`/`screen2GraphCoords` calls in the
// component); nothing here needs to know about force-graph's zoom/pan
// transform.
// ---------------------------------------------------------------------------

export type LabelAlign = "left" | "center" | "right";

export interface LabelPlacement {
  /** Screen-space x to pass as the canvas `textAlign`-relative anchor. */
  anchorX: number;
  align: LabelAlign;
}

/**
 * Chooses a horizontal label anchor/alignment that keeps a `textWidth`-wide
 * label inside `[margin, canvasWidth - margin]`. Prefers staying centered
 * on the node, but flips fully to one side — right-aligned ending at the
 * node when the node is near the right edge, left-aligned starting at the
 * node when near the left edge — rather than letting the label bleed past
 * the canvas (and, on desktop, into the inspector column beyond it). Falls
 * back to a clamped center for a canvas narrower than the label itself.
 */
export function placeLabelX(
  nodeX: number,
  textWidth: number,
  canvasWidth: number,
  margin = 10,
): LabelPlacement {
  const half = textWidth / 2;
  const minX = margin;
  const maxX = Math.max(margin, canvasWidth - margin);

  const overflowsRight = nodeX + half > maxX;
  const overflowsLeft = nodeX - half < minX;

  if (!overflowsRight && !overflowsLeft) {
    return { anchorX: nodeX, align: "center" };
  }
  if (overflowsRight && !overflowsLeft) {
    const anchorX = Math.min(Math.max(nodeX, minX + textWidth), maxX);
    return { anchorX, align: "right" };
  }
  if (overflowsLeft && !overflowsRight) {
    const anchorX = Math.max(Math.min(nodeX, maxX - textWidth), minX);
    return { anchorX, align: "left" };
  }
  // Canvas narrower than the label itself: best-effort clamped center.
  const anchorX = Math.min(Math.max(nodeX, minX + half), maxX - half);
  return { anchorX, align: "center" };
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Suggested priority (lower = drawn/kept first when space is contested):
// causal variables carry the most causal-reasoning weight, then
// decision/finding (reasoning-layer outputs), then agent/threat, then
// everything else. Selected/hovered nodes bypass this entirely via
// `forceShow` in LabelCandidate — they're never suppressed on collision.
const NODE_LABEL_PRIORITY: Record<string, number> = {
  causal_variable: 1,
  decision: 2,
  finding: 2,
  agent: 3,
  threat: 3,
};

export function labelPriority(nodeType: string): number {
  return NODE_LABEL_PRIORITY[nodeType] ?? 4;
}

export interface LabelCandidate {
  id: string;
  priority: number;
  /** Selected node, hovered node, or an endpoint of the selected edge. */
  forceShow: boolean;
  rect: ScreenRect;
}

/**
 * Greedy label-collision suppression: processes candidates with
 * `forceShow` first, then the rest in ascending priority order, keeping a
 * running list of claimed screen rectangles. A candidate is skipped only
 * when it collides with an already-claimed rect AND it isn't `forceShow`
 * — the selected/hovered label is never hidden, but it can (by being
 * claimed first) cause a lower-priority neighbor to be skipped.
 *
 * O(n^2) in the number of *candidate* labels, which stays small (a
 * handful to a few dozen visible nodes), so no spatial index is needed —
 * this is intentionally not a full layout-optimization pass.
 */
export function resolveLabelCollisions(candidates: ReadonlyArray<LabelCandidate>): Set<string> {
  const ordered = [...candidates].sort((a, b) => {
    if (a.forceShow !== b.forceShow) return a.forceShow ? -1 : 1;
    return a.priority - b.priority;
  });
  const claimed: ScreenRect[] = [];
  const visible = new Set<string>();
  for (const candidate of ordered) {
    const collides = !candidate.forceShow && claimed.some((r) => rectsIntersect(r, candidate.rect));
    if (collides) continue;
    claimed.push(candidate.rect);
    visible.add(candidate.id);
  }
  return visible;
}

/**
 * An edge label is only ever drawn for the selected or hovered edge — this
 * is zoom-independent by design (unlike node labels, there's only ever at
 * most one edge label on screen at a time, so there's nothing to thin out).
 * Ordinary edges never get an on-canvas label at any zoom level.
 */
export function shouldShowEdgeLabel(params: { isSelected: boolean; isHovered: boolean }): boolean {
  return params.isSelected || params.isHovered;
}

/**
 * Trailing-edge debouncer: repeated calls within `waitMs` of each other
 * collapse into a single invocation of `fn`, fired `waitMs` after the last
 * call. Used to coalesce a burst of ResizeObserver events from a window
 * drag-resize into exactly one reframe, instead of one per event.
 */
export function createDebouncer(fn: () => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const call = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  };
  call.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return call;
}
