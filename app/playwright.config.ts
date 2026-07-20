import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.03,
    },
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:8099",
    viewport: { width: 1440, height: 1100 },
    colorScheme: "dark",
  },
  webServer: {
    command: "VITE_HIVEMIND_VISUAL_TEST=1 npm run dev -- --host 127.0.0.1 --port 8099",
    url: "http://127.0.0.1:8099",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
