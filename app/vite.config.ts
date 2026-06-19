// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("react-dom") || id.includes("/react/")) {
              return "react-vendor";
            }
            if (id.includes("@tanstack")) return "tanstack";
            if (id.includes("@radix-ui") || id.includes("cmdk") || id.includes("vaul")) {
              return "ui-primitives";
            }
            if (
              id.includes("react-force-graph") ||
              id.includes("force-graph") ||
              id.includes("d3-") ||
              id.includes("three")
            ) {
              return "graph-viz";
            }
            if (id.includes("html2canvas")) return "html2canvas";
            if (id.includes("jspdf")) return "pdf-vendor";
            if (id.includes("dompurify")) return "sanitize";
            if (id.includes("recharts")) return "charts";
            if (id.includes("@supabase")) return "supabase";
            if (id.includes("react-hook-form") || id.includes("@hookform") || id.includes("zod")) {
              return "forms";
            }
            return undefined;
          },
        },
      },
    },
  },
});
