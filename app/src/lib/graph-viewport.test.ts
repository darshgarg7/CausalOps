import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  boundsAreSettled,
  canvasLayoutMode,
  classifyResize,
  computeGraphBounds,
  createDebouncer,
  detailPanelLayoutMode,
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
  type LabelCandidate,
} from "./graph-viewport";

describe("computeGraphBounds", () => {
  it("returns null when no node has a finite position yet", () => {
    expect(computeGraphBounds([])).toBeNull();
    expect(computeGraphBounds([{}, { x: undefined, y: undefined }])).toBeNull();
    expect(computeGraphBounds([{ x: NaN, y: NaN }])).toBeNull();
  });

  it("computes the exact bounding box of positioned nodes", () => {
    const bounds = computeGraphBounds([
      { x: -10, y: 5 },
      { x: 20, y: -3 },
      { x: 4, y: 4 },
    ]);
    expect(bounds).toEqual({ minX: -10, maxX: 20, minY: -3, maxY: 5 });
  });

  it("ignores unpositioned nodes mixed in with positioned ones", () => {
    const bounds = computeGraphBounds([{ x: 1, y: 1 }, {}, { x: 3, y: 3 }]);
    expect(bounds).toEqual({ minX: 1, maxX: 3, minY: 1, maxY: 3 });
  });
});

describe("boundsAreSettled", () => {
  it("is false with no bounds (layout hasn't run)", () => {
    expect(boundsAreSettled(null)).toBe(false);
  });

  it("is false when every node still sits at the same point", () => {
    expect(boundsAreSettled({ minX: 0, maxX: 0, minY: 0, maxY: 0 })).toBe(false);
  });

  it("is true once nodes have spread out along either axis", () => {
    expect(boundsAreSettled({ minX: 0, maxX: 50, minY: 0, maxY: 0 })).toBe(true);
    expect(boundsAreSettled({ minX: 0, maxX: 0, minY: -50, maxY: 0 })).toBe(true);
  });
});

describe("shouldFitToView", () => {
  const settledBounds = { minX: -100, maxX: 100, minY: -50, maxY: 50 };

  it("requires a non-zero-sized container", () => {
    expect(
      shouldFitToView({
        containerWidth: 0,
        containerHeight: 400,
        nodeCount: 5,
        bounds: settledBounds,
        alreadyFittedForDataset: false,
      }),
    ).toBe(false);
  });

  it("requires at least one node", () => {
    expect(
      shouldFitToView({
        containerWidth: 800,
        containerHeight: 400,
        nodeCount: 0,
        bounds: null,
        alreadyFittedForDataset: false,
      }),
    ).toBe(false);
  });

  it("does not re-fit once the dataset has already been fitted", () => {
    expect(
      shouldFitToView({
        containerWidth: 800,
        containerHeight: 400,
        nodeCount: 5,
        bounds: settledBounds,
        alreadyFittedForDataset: true,
      }),
    ).toBe(false);
  });

  it("does not fit before the force layout has settled node positions", () => {
    // Regression guard for the bug where fit ran against nodes still
    // clustered at the origin, so the resulting view showed nothing.
    expect(
      shouldFitToView({
        containerWidth: 800,
        containerHeight: 400,
        nodeCount: 5,
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
        alreadyFittedForDataset: false,
      }),
    ).toBe(false);
  });

  it("fits when container is sized, nodes exist, positions settled, and not yet fitted", () => {
    expect(
      shouldFitToView({
        containerWidth: 800,
        containerHeight: 400,
        nodeCount: 5,
        bounds: settledBounds,
        alreadyFittedForDataset: false,
      }),
    ).toBe(true);
  });
});

describe("labelTier", () => {
  it("always shows a full label for the selected or hovered node, regardless of zoom", () => {
    expect(labelTier({ scale: 0.1, isImportant: false, isSelected: true, isHovered: false })).toBe(
      "full",
    );
    expect(labelTier({ scale: 0.1, isImportant: false, isSelected: false, isHovered: true })).toBe(
      "full",
    );
  });

  it("hides unimportant labels when zoomed far out, to avoid overlap", () => {
    expect(labelTier({ scale: 0.3, isImportant: false, isSelected: false, isHovered: false })).toBe(
      "hidden",
    );
    expect(labelTier({ scale: 0.3, isImportant: true, isSelected: false, isHovered: false })).toBe(
      "hidden",
    );
  });

  it("shows short labels for important nodes only at medium zoom", () => {
    expect(labelTier({ scale: 1.0, isImportant: true, isSelected: false, isHovered: false })).toBe(
      "short",
    );
    expect(labelTier({ scale: 1.0, isImportant: false, isSelected: false, isHovered: false })).toBe(
      "hidden",
    );
  });

  it("shows full labels for every node once zoomed in enough to read them", () => {
    expect(labelTier({ scale: 2.0, isImportant: false, isSelected: false, isHovered: false })).toBe(
      "full",
    );
  });
});

describe("truncateLabel", () => {
  it("returns short text unchanged", () => {
    expect(truncateLabel("short", 20)).toBe("short");
  });

  it("truncates long text with an ellipsis, respecting the character budget", () => {
    const result = truncateLabel("A very long node label that would overlap neighbors", 12);
    expect(result.length).toBe(12);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("detailPanelLayoutMode", () => {
  it("uses a side-by-side split once the card has enough measured width", () => {
    expect(detailPanelLayoutMode(1200)).toBe("split");
    expect(detailPanelLayoutMode(620)).toBe("split");
  });

  it("falls back to a bottom sheet when the card is too narrow for a column", () => {
    expect(detailPanelLayoutMode(619)).toBe("sheet");
    expect(detailPanelLayoutMode(360)).toBe("sheet");
  });
});

describe("graphViewState", () => {
  it("prioritizes loading over every other state", () => {
    expect(
      graphViewState({ loading: true, error: "boom", totalNodeCount: 5, visibleNodeCount: 5 }),
    ).toBe("loading");
  });

  it("reports error when the fetch failed", () => {
    expect(
      graphViewState({ loading: false, error: "boom", totalNodeCount: 0, visibleNodeCount: 0 }),
    ).toBe("error");
  });

  it("distinguishes 'no data at all' from 'filtered down to nothing'", () => {
    expect(
      graphViewState({ loading: false, error: null, totalNodeCount: 0, visibleNodeCount: 0 }),
    ).toBe("no-data");
    expect(
      graphViewState({ loading: false, error: null, totalNodeCount: 12, visibleNodeCount: 0 }),
    ).toBe("filtered-empty");
  });

  it("is ready once there is data visible", () => {
    expect(
      graphViewState({ loading: false, error: null, totalNodeCount: 12, visibleNodeCount: 3 }),
    ).toBe("ready");
  });
});

describe("isSelectionStale", () => {
  it("is false when nothing is selected", () => {
    expect(isSelectionStale(null, new Set())).toBe(false);
  });

  it("is true once the selected id drops out of the visible set (e.g. a filter change)", () => {
    expect(isSelectionStale("node-1", new Set(["node-2", "node-3"]))).toBe(true);
  });

  it("is false while the selected id remains visible", () => {
    expect(isSelectionStale("node-1", new Set(["node-1", "node-2"]))).toBe(false);
  });
});

describe("classifyResize", () => {
  it("classifies a major width increase (e.g. 1024px -> 1440px card) as major", () => {
    // Regression guard for the narrow-to-wide bug: force-graph's own resize
    // handling only re-centers by half the size delta at the *existing*
    // zoom, which is not enough to keep a fitted cluster in frame across a
    // change this large — the caller must re-fit instead of preserving it.
    expect(classifyResize({ width: 640, height: 540 }, { width: 1000, height: 540 })).toBe("major");
  });

  it("does not classify a small width change as major (camera should be preserved)", () => {
    expect(classifyResize({ width: 640, height: 540 }, { width: 660, height: 540 })).toBe("minor");
  });

  it("classifies a meaningful aspect-ratio change as major even when width and height deltas are individually under the threshold", () => {
    // width +20%, height -20%: neither delta alone crosses the ~22%
    // threshold, but the frame shape (1.6 -> 2.4 aspect ratio) changed by
    // 50% — a pure width/height-delta check would miss this case.
    expect(classifyResize({ width: 800, height: 500 }, { width: 960, height: 400 })).toBe("major");
  });

  it("classifies a zero-size to visible transition as major", () => {
    expect(classifyResize(null, { width: 640, height: 540 })).toBe("major");
    expect(classifyResize({ width: 0, height: 0 }, { width: 640, height: 540 })).toBe("major");
  });

  it("returns none for an unchanged or still-invisible size", () => {
    expect(classifyResize({ width: 640, height: 540 }, { width: 640, height: 540 })).toBe("none");
    expect(classifyResize({ width: 640, height: 540 }, { width: 0, height: 0 })).toBe("none");
  });
});

describe("shouldRefitForLayoutModeChange", () => {
  it("is false on the first measurement (no prior mode to compare against)", () => {
    expect(shouldRefitForLayoutModeChange(null, "split")).toBe(false);
  });

  it("is true when the detail panel crosses between split and sheet", () => {
    expect(shouldRefitForLayoutModeChange("sheet", "split")).toBe(true);
    expect(shouldRefitForLayoutModeChange("split", "sheet")).toBe(true);
  });

  it("is false when the mode is unchanged", () => {
    expect(shouldRefitForLayoutModeChange("split", "split")).toBe(false);
  });
});

describe("nodeSetRetention / shouldFitForNodeSetChange", () => {
  it("retains 1.0 when the new set is empty (nothing lost)", () => {
    expect(nodeSetRetention(new Set(["a", "b"]), new Set())).toBe(1);
  });

  it("retains 0 when nothing in the new set was previously visible", () => {
    expect(nodeSetRetention(new Set(), new Set(["a", "b"]))).toBe(0);
  });

  it("computes the fraction of the new set that was already visible", () => {
    expect(nodeSetRetention(new Set(["a", "b", "c"]), new Set(["b", "c", "d", "e"]))).toBe(0.5);
  });

  it("does not fit for an ordinary single-filter toggle that keeps most nodes", () => {
    const prev = new Set(["a", "b", "c", "d", "e"]);
    const next = new Set(["a", "b", "c", "d"]); // one type filter removed one node
    expect(shouldFitForNodeSetChange(prev, next)).toBe(false);
  });

  it("fits when a timeline jump or filter swap replaces most of the visible set", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["x", "y", "z", "w"]); // almost entirely different nodes
    expect(shouldFitForNodeSetChange(prev, next)).toBe(true);
  });

  it("does not fit when the new set is empty (filtered-empty state, handled separately)", () => {
    expect(shouldFitForNodeSetChange(new Set(["a"]), new Set())).toBe(false);
  });
});

describe("createDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses repeated calls within the wait window into a single invocation", () => {
    // Regression guard: dragging a browser edge fires many ResizeObserver
    // events in quick succession — only the last one should ever result in
    // an actual zoomToFit call.
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 180);

    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(180);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires again for a call that starts after the previous debounce settled", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 180);

    debounced();
    vi.advanceTimersByTime(180);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced();
    vi.advanceTimersByTime(180);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() prevents a pending call from firing", () => {
    const fn = vi.fn();
    const debounced = createDebouncer(fn, 180);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("canvasLayoutMode", () => {
  it("is 'single' at a split-capable width with nothing selected — the inspector claims no column", () => {
    expect(canvasLayoutMode(900, false)).toBe("single");
  });

  it("is 'split' at a split-capable width once something is selected", () => {
    expect(canvasLayoutMode(900, true)).toBe("split");
  });

  it("is 'sheet' below the split-capable width regardless of selection", () => {
    expect(canvasLayoutMode(400, false)).toBe("sheet");
    expect(canvasLayoutMode(400, true)).toBe("sheet");
  });

  it("classifies inspector open/close as a major layout transition", () => {
    // Regression guard: opening the inspector shrinks the canvas column
    // (single -> split) and closing it expands it again (split -> single)
    // — both must be treated the same as any other major resize.
    expect(
      shouldRefitForLayoutModeChange(canvasLayoutMode(900, false), canvasLayoutMode(900, true)),
    ).toBe(true);
    expect(
      shouldRefitForLayoutModeChange(canvasLayoutMode(900, true), canvasLayoutMode(900, false)),
    ).toBe(true);
  });

  it("does not treat a selection-content change (same width state) as a layout transition", () => {
    // Selecting a different node while already in split mode, or swapping
    // a node selection for an edge selection, doesn't change canvasMode —
    // only whether *something* is selected does.
    const prev = canvasLayoutMode(900, true);
    const next = canvasLayoutMode(900, true); // still selected, different item
    expect(shouldRefitForLayoutModeChange(prev, next)).toBe(false);
  });
});

describe("placeLabelX", () => {
  const canvasWidth = 400;

  it("centers the label under the node when there's room on both sides", () => {
    const placement = placeLabelX(200, 60, canvasWidth);
    expect(placement).toEqual({ anchorX: 200, align: "center" });
  });

  it("clamps against the right canvas edge by flipping the label to the left of the node", () => {
    const placement = placeLabelX(390, 60, canvasWidth, 10);
    expect(placement.align).toBe("right");
    // Right-aligned text of this width must not extend past the margin.
    expect(placement.anchorX).toBeLessThanOrEqual(canvasWidth - 10);
  });

  it("clamps against the left canvas edge by flipping the label to the right of the node", () => {
    const placement = placeLabelX(10, 60, canvasWidth, 10);
    expect(placement.align).toBe("left");
    // Left-aligned text of this width must not start before the margin.
    expect(placement.anchorX).toBeGreaterThanOrEqual(10);
  });

  it("never lets a right-flipped label's own left edge cross the left margin", () => {
    // Node right at the edge with a label wider than the available space.
    const placement = placeLabelX(398, 300, canvasWidth, 10);
    expect(placement.align).toBe("right");
    expect(placement.anchorX - 300).toBeGreaterThanOrEqual(10 - 0.001);
  });

  it("falls back to a clamped center when the canvas is narrower than the label itself", () => {
    const placement = placeLabelX(50, 500, 100, 10);
    expect(placement.align).toBe("center");
  });
});

describe("rectsIntersect", () => {
  it("detects overlapping rectangles", () => {
    expect(
      rectsIntersect({ x: 0, y: 0, width: 50, height: 20 }, { x: 30, y: 5, width: 50, height: 20 }),
    ).toBe(true);
  });

  it("detects non-overlapping rectangles", () => {
    expect(
      rectsIntersect(
        { x: 0, y: 0, width: 50, height: 20 },
        { x: 100, y: 0, width: 50, height: 20 },
      ),
    ).toBe(false);
  });
});

describe("labelPriority", () => {
  it("ranks causal_variable highest, then decision/finding, then agent/threat, then everything else", () => {
    expect(labelPriority("causal_variable")).toBeLessThan(labelPriority("decision"));
    expect(labelPriority("decision")).toBe(labelPriority("finding"));
    expect(labelPriority("decision")).toBeLessThan(labelPriority("agent"));
    expect(labelPriority("agent")).toBe(labelPriority("threat"));
    expect(labelPriority("agent")).toBeLessThan(labelPriority("asset"));
    expect(labelPriority("asset")).toBe(labelPriority("nonexistent-type"));
  });
});

describe("resolveLabelCollisions", () => {
  function candidate(overrides: Partial<LabelCandidate> & { id: string }): LabelCandidate {
    return {
      priority: 4,
      forceShow: false,
      rect: { x: 0, y: 0, width: 40, height: 12 },
      ...overrides,
    };
  }

  it("keeps every candidate when nothing overlaps", () => {
    const visible = resolveLabelCollisions([
      candidate({ id: "a", rect: { x: 0, y: 0, width: 40, height: 12 } }),
      candidate({ id: "b", rect: { x: 100, y: 0, width: 40, height: 12 } }),
    ]);
    expect(visible).toEqual(new Set(["a", "b"]));
  });

  it("a forceShow (selected/hovered) label always survives, even overlapping a higher-priority neighbor", () => {
    const visible = resolveLabelCollisions([
      candidate({
        id: "selected",
        forceShow: true,
        priority: 9,
        rect: { x: 0, y: 0, width: 40, height: 12 },
      }),
      candidate({
        id: "important",
        forceShow: false,
        priority: 1,
        rect: { x: 10, y: 0, width: 40, height: 12 },
      }),
    ]);
    expect(visible.has("selected")).toBe(true);
  });

  it("suppresses a lower-priority label that collides with a higher-priority one", () => {
    const visible = resolveLabelCollisions([
      candidate({ id: "high", priority: 1, rect: { x: 0, y: 0, width: 40, height: 12 } }),
      candidate({ id: "mid", priority: 2, rect: { x: 10, y: 0, width: 40, height: 12 } }),
      candidate({ id: "low", priority: 4, rect: { x: 20, y: 0, width: 40, height: 12 } }),
    ]);
    // Only the highest-priority label in this mutually-overlapping chain
    // survives — dense-cluster collision suppression, not a full solver.
    expect(visible).toEqual(new Set(["high"]));
  });

  it("suppresses a non-forced label that collides with an already-claimed forceShow rect", () => {
    const visible = resolveLabelCollisions([
      candidate({ id: "selected", forceShow: true, rect: { x: 0, y: 0, width: 40, height: 12 } }),
      candidate({
        id: "other",
        forceShow: false,
        priority: 1,
        rect: { x: 10, y: 0, width: 40, height: 12 },
      }),
    ]);
    expect(visible).toEqual(new Set(["selected"]));
  });
});

describe("shouldShowEdgeLabel", () => {
  it("shows the label for a selected edge regardless of zoom", () => {
    expect(shouldShowEdgeLabel({ isSelected: true, isHovered: false })).toBe(true);
  });

  it("shows the label for a hovered edge regardless of zoom", () => {
    expect(shouldShowEdgeLabel({ isSelected: false, isHovered: true })).toBe(true);
  });

  it("hides the label for an ordinary (unselected, unhovered) edge", () => {
    // Ordinary edges never get an on-canvas label at any zoom level — only
    // the active one ever does, so there's nothing to "thin out" by zoom.
    expect(shouldShowEdgeLabel({ isSelected: false, isHovered: false })).toBe(false);
  });
});
