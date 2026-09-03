import { expect, test } from "@playwright/test";

import { seedVisualResult } from "./fixtures";

test("result layout keeps the 5D KG primary with DAG context visible", async ({ page }) => {
  await seedVisualResult(page);
  await page.goto("/");

  const workspace = page.getByTestId("result-graph-workspace");
  await expect(workspace).toBeVisible();
  await expect(page.getByTestId("primary-5d-kg")).toBeVisible();
  await expect(page.getByTestId("causal-dag-context")).toBeVisible();
  await expect(workspace).toContainText("5D Spatiotemporal KG");
  await expect(workspace).toContainText("Evidence DAG Context");

  await expect(workspace).toHaveScreenshot("result-graph-workspace.png", {
    animations: "disabled",
  });
});
