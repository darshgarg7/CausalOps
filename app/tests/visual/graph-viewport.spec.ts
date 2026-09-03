import { expect, test, type Page } from "@playwright/test";

import { seedVisualResult } from "./fixtures";

/**
 * Samples the 5D KG canvas and reports, for each of `bands` equal-width
 * horizontal slices, whether any non-transparent pixel was drawn there.
 * The canvas is rendered with a transparent background, so alpha > 0 means
 * something (a node, link, or label) was actually painted at that x.
 */
async function canvasContentBands(page: Page, bands = 5): Promise<boolean[]> {
  return page.evaluate((bandCount) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="kg-canvas-box"] canvas',
    );
    if (!canvas) return new Array(bandCount).fill(false);
    const ctx = canvas.getContext("2d");
    if (!ctx) return new Array(bandCount).fill(false);
    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);
    const hasContent = new Array(bandCount).fill(false);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 10) continue; // effectively transparent
      const pixelIndex = i / 4;
      const x = pixelIndex % width;
      const band = Math.min(bandCount - 1, Math.floor((x / width) * bandCount));
      hasContent[band] = true;
    }
    return hasContent;
  }, bands);
}

async function bandsWithContent(page: Page): Promise<number> {
  return (await canvasContentBands(page)).filter(Boolean).length;
}

/**
 * Weighted-average position of every drawn pixel, as a 0..1 fraction of the
 * canvas's own width/height. A well-centered fit lands roughly mid-frame;
 * a graph left un-reframed after a major resize collapses toward one edge
 * or corner (the exact "nodes near the bottom or edges" failure mode).
 */
async function contentCentroid(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="kg-canvas-box"] canvas',
    );
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 10) continue;
      const pixelIndex = i / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      sumX += x;
      sumY += y;
      count++;
    }
    if (count === 0) return null;
    return { x: sumX / count / width, y: sumY / count / height };
  });
}

async function expectCenteredContent(page: Page) {
  await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  await expect
    .poll(async () => (await contentCentroid(page))?.x ?? null, { timeout: 8000 })
    .toBeGreaterThan(0.25);
  await expect
    .poll(async () => (await contentCentroid(page))?.x ?? null, { timeout: 8000 })
    .toBeLessThan(0.75);
  const centroid = await contentCentroid(page);
  expect(centroid).not.toBeNull();
  if (!centroid) return;
  expect(centroid.y).toBeGreaterThan(0.2);
  expect(centroid.y).toBeLessThan(0.8);
}

// The "Predicate / Edge" chip is rendered with a Tailwind `uppercase` CSS
// class, so `.innerText()` (which reflects rendered, not literal, text)
// returns "PREDICATE / EDGE" — comparisons against it must be
// case-insensitive or they silently never match.
function isEdgeInspectorText(text: string): boolean {
  return /predicate\s*\/\s*edge/i.test(text);
}

function isNodeInspectorText(text: string): boolean {
  return !text.includes("Click a node or edge to inspect") && !isEdgeInspectorText(text);
}

// Small spiral of offsets tried around a target point, closest first. Link
// hit-testing in particular has a narrow tolerance band around the exact
// line, and node positions can drift a few px between the frame the test
// reads coordinates from and the frame the click event is processed in
// (still-cooling force simulation, in-flight zoom transition) — a single
// exact-pixel click is occasionally a near miss.
const CLICK_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [3, 3],
  [-3, -3],
  [3, -3],
  [-3, 3],
];

/**
 * Clicks at (or very near) a canvas-pixel point — converted to page
 * coordinates — until `isSelected` reports success. Canvas-drawn
 * nodes/edges have no DOM handles to target directly, so the component
 * exposes its own live screen-space positions via window.__KG_NODE_SCREEN__
 * / __KG_EDGE_SCREEN__ (gated behind the same VITE_HIVEMIND_VISUAL_TEST
 * flag as the rest of the visual fixtures) rather than sweeping a blind
 * grid of guesses over the whole canvas.
 */
async function clickCanvasScreenPoint(
  page: Page,
  point: { x: number; y: number },
  isSelected: () => Promise<boolean>,
): Promise<boolean> {
  const canvas = page.getByTestId("kg-canvas-box");
  // boundingBox() returns page-relative coordinates regardless of scroll
  // position; the card sits well below the fold, so without this the
  // click lands outside the actually-visible viewport and hits nothing.
  await canvas.scrollIntoViewIfNeeded();
  for (const [dx, dy] of CLICK_OFFSETS) {
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) return false;
    await page.mouse.click(canvasBox.x + point.x + dx, canvasBox.y + point.y + dy);
    // The click's React state update (setSelectedNode/setSelectedEdge)
    // lands a render tick after the input event resolves.
    await page.waitForTimeout(120);
    if (await isSelected()) return true;
  }
  return false;
}

async function detailPanelShows(
  page: Page,
  predicate: (text: string) => boolean,
): Promise<boolean> {
  if ((await page.getByTestId("kg-detail-panel").count()) === 0) return false;
  return predicate(await page.getByTestId("kg-detail-panel").innerText());
}

/** Selects an arbitrary visible node by clicking its exact screen position. */
async function selectAnyNode(page: Page): Promise<boolean> {
  const positions = await page.evaluate(() => window.__KG_NODE_SCREEN__ ?? null);
  const first = positions && Object.values(positions)[0];
  if (!first) return false;
  return clickCanvasScreenPoint(page, first, () => detailPanelShows(page, isNodeInspectorText));
}

/** Selects an arbitrary visible edge by clicking near its midpoint. */
async function selectAnyEdge(page: Page): Promise<boolean> {
  const positions = await page.evaluate(() => window.__KG_EDGE_SCREEN__ ?? null);
  if (!positions) return false;
  for (const point of Object.values(positions)) {
    const ok = await clickCanvasScreenPoint(page, point, () =>
      detailPanelShows(page, isEdgeInspectorText),
    );
    if (ok) return true;
  }
  return false;
}

test.describe("5D KG viewport fitting and layout", () => {
  test("graph shows nodes spread across the canvas immediately after load, with no manual zoom", async ({
    page,
  }) => {
    await seedVisualResult(page);
    await page.goto("/");

    await expect(page.getByTestId("kg-canvas-box")).toBeVisible();
    // Node count in the header reaching a non-zero value confirms the data
    // loaded and passed the timeline/type filters.
    await expect(page.locator("text=/\\d+ nodes active/")).toBeVisible();

    // Regression guard for the bug where the canvas defaulted to
    // window.innerWidth and got clipped by the card's overflow, leaving
    // only a thin sliver of drawn content near one edge until the user
    // zoomed. A healthy fit spreads content across most horizontal bands.
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  });

  test("selecting a node opens an inspector that never overlaps the canvas, and the node stays visible", async ({
    page,
  }) => {
    await seedVisualResult(page);
    await page.goto("/");
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);

    // Nothing selected: the inspector claims no column at all (this is the
    // "single" canvas layout mode — see canvasLayoutMode() in
    // graph-viewport.ts), so there's nothing to assert non-overlap against
    // yet. Select something first.
    expect(await page.getByTestId("kg-detail-panel").count()).toBe(0);
    const selected = await selectAnyNode(page);
    expect(selected).toBe(true);
    await expect
      .poll(
        async () => isNodeInspectorText(await page.getByTestId("kg-detail-panel").innerText()),
        { timeout: 4000 },
      )
      .toBe(true);

    const canvasBox = await page.getByTestId("kg-canvas-box").boundingBox();
    const detailBox = await page.getByTestId("kg-detail-panel").boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    if (!canvasBox || !detailBox) return;

    // Split layout: the detail column starts at or after the canvas's
    // right edge — never overlapping it.
    expect(detailBox.x).toBeGreaterThanOrEqual(canvasBox.x + canvasBox.width - 2);

    // The selected node must still be visible inside the (now narrower)
    // canvas after the inspector-triggered reframe, not pushed off-frame.
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
  });

  test("selecting an edge opens the edge inspector, keeps the edge visible, and draws no graph text into the inspector column", async ({
    page,
  }) => {
    await seedVisualResult(page);
    await page.goto("/");
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);

    const selected = await selectAnyEdge(page);
    expect(selected).toBe(true);
    await expect
      .poll(
        async () => isEdgeInspectorText(await page.getByTestId("kg-detail-panel").innerText()),
        { timeout: 4000 },
      )
      .toBe(true);

    const canvasBox = await page.getByTestId("kg-canvas-box").boundingBox();
    const detailBox = await page.getByTestId("kg-detail-panel").boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    if (!canvasBox || !detailBox) return;

    // Same non-overlap guarantee as node selection, and — since the canvas
    // element's own width is what was passed to ForceGraph2D — nothing it
    // draws can physically extend past canvasBox's right edge into the
    // inspector's screen region in the first place.
    expect(detailBox.x).toBeGreaterThanOrEqual(canvasBox.x + canvasBox.width - 2);
    expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(detailBox.x + 2);

    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
  });

  test("opening and closing the inspector reframes the graph exactly once each way", async ({
    page,
  }) => {
    await seedVisualResult(page);
    await page.goto("/");
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);

    const wideCanvasBox = await page.getByTestId("kg-canvas-box").boundingBox();
    expect(wideCanvasBox).not.toBeNull();

    // Opens the inspector — canvas column shrinks (single -> split).
    const selected = await selectAnyNode(page);
    expect(selected).toBe(true);
    await expect(page.getByTestId("kg-detail-panel")).toHaveCount(1);
    const narrowCanvasBox = await page.getByTestId("kg-canvas-box").boundingBox();
    expect(narrowCanvasBox).not.toBeNull();
    if (wideCanvasBox && narrowCanvasBox) {
      expect(narrowCanvasBox.width).toBeLessThan(wideCanvasBox.width);
    }
    // Debounced fit (180ms settle + 2 rAF + 400ms zoomToFit) re-centers
    // content within the new, narrower canvas.
    await expectCenteredContent(page);

    // Closes the inspector — canvas column expands back (split -> single).
    await page.getByTitle("Close").click();
    await expect(page.getByTestId("kg-detail-panel")).toHaveCount(0);
    const reopenedCanvasBox = await page.getByTestId("kg-canvas-box").boundingBox();
    expect(reopenedCanvasBox).not.toBeNull();
    if (narrowCanvasBox && reopenedCanvasBox) {
      expect(reopenedCanvasBox.width).toBeGreaterThan(narrowCanvasBox.width);
    }
    await expectCenteredContent(page);
  });

  test("dense clusters keep a bounded, non-overlapping set of labels, and the selected label always survives", async ({
    page,
  }) => {
    await seedVisualResult(page);
    await page.goto("/");
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);

    const totalNodes = await page.evaluate(() => {
      const text = document.body.innerText.match(/(\d+) nodes active/);
      return text ? Number(text[1]) : 0;
    });
    expect(totalNodes).toBeGreaterThan(0);

    // Stable instrumentation (window.__KG_LABEL_PLAN__, gated behind the
    // same VITE_HIVEMIND_VISUAL_TEST flag as the rest of the visual-test
    // fixtures) rather than fragile canvas-pixel text detection — labels
    // are anti-aliased, sub-pixel-positioned text, not reliably
    // distinguishable from node glyphs by color sampling alone.
    const plan = await page.evaluate(() => window.__KG_LABEL_PLAN__ ?? null);
    expect(plan).not.toBeNull();
    if (!plan) return;
    // Bounded: never more labels than nodes exist, i.e. collision
    // suppression never *adds* labels, only ever removes them.
    expect(plan.count).toBeLessThanOrEqual(totalNodes);

    const selected = await selectAnyNode(page);
    expect(selected).toBe(true);
    const getSelectedId = () =>
      page.evaluate(() => {
        const code = document.querySelector('[data-testid="kg-detail-panel"] code');
        return code?.textContent ?? null;
      });
    await expect.poll(getSelectedId, { timeout: 4000 }).not.toBeNull();
    const selectedId = await getSelectedId();
    expect(selectedId).not.toBeNull();

    await expect
      .poll(
        async () => {
          const p = await page.evaluate(() => window.__KG_LABEL_PLAN__ ?? null);
          return p?.ids.includes(selectedId ?? "") ?? false;
        },
        { timeout: 8000 },
      )
      .toBe(true);
  });

  test("the detail panel becomes a dismissible bottom sheet on narrow viewports, not a fixed side column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedVisualResult(page);
    await page.goto("/");
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(2);

    // Nothing selected yet: no fixed-width column should be reserved,
    // so the canvas gets the full narrow card width.
    await expect(page.getByTestId("kg-detail-panel")).toHaveCount(0);
    const canvasBox = await page.getByTestId("kg-canvas-box").boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(300);
  });

  test("resizing the workspace does not make the graph disappear", async ({ page }) => {
    await seedVisualResult(page);
    await page.goto("/");
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 768, height: 900 });
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(2);

    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(() => bandsWithContent(page), { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  });

  test("reframes and re-centers the graph across a major narrow-to-wide widening", async ({
    page,
  }) => {
    // Reproduces the reported regression: fit correctly at ~1024px, then
    // widening the browser left the canvas visually empty or with only a
    // few nodes stranded near an edge, because force-graph's own resize
    // handling only re-centers by half the size delta at the *existing*
    // zoom — it never re-fits. classifyResize() should treat each of these
    // jumps as "major" and the component should schedule exactly one
    // zoomToFit per jump, landing the cluster back near the frame center.
    await page.setViewportSize({ width: 1024, height: 900 });
    await seedVisualResult(page);
    await page.goto("/");
    await expectCenteredContent(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expectCenteredContent(page);

    await page.setViewportSize({ width: 1728, height: 950 });
    await expectCenteredContent(page);

    await page.setViewportSize({ width: 1920, height: 1000 });
    await expectCenteredContent(page);

    // And back down again — the reverse transition must also reframe.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expectCenteredContent(page);
  });

  test("Graph Workspace uses the wide viewport instead of staying in a narrow centered column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await seedVisualResult(page);
    await page.goto("/");
    await expectCenteredContent(page);

    const workspaceBox = await page.getByTestId("result-graph-workspace").boundingBox();
    expect(workspaceBox).not.toBeNull();
    // The page previously capped at max-w-7xl (1280px) regardless of a much
    // wider viewport; the workspace should now visibly use most of a
    // 1920px-wide browser, not remain pinned near that old cap.
    expect(workspaceBox?.width).toBeGreaterThan(1500);

    // The 5D KG and causal DAG columns must still sit side by side with no
    // overlap even though both got wider.
    const kgBox = await page.getByTestId("primary-5d-kg").boundingBox();
    const dagBox = await page.getByTestId("causal-dag-context").boundingBox();
    expect(kgBox).not.toBeNull();
    expect(dagBox).not.toBeNull();
    if (!kgBox || !dagBox) return;
    expect(dagBox.x).toBeGreaterThanOrEqual(kgBox.x + kgBox.width - 2);
  });
});
