import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";

interface Props {
  runId: string;
}

const ClientPanel = lazy(async () => {
  const m = await import("./SpatiotemporalKGPanel.client");
  return { default: m.SpatiotemporalKGPanelClient };
});

export function SpatiotemporalKGPanel(props: Props) {
  const fallback = (
    <div
      className="flex w-full items-center justify-center rounded-xl border border-white/10 bg-[oklch(0.1_0.02_260/0.7)] text-xs uppercase tracking-widest text-muted-foreground"
      style={{ height: 480 }}
    >
      Initializing 5D Spatiotemporal KG Engine…
    </div>
  );

  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <ClientPanel {...props} />
      </Suspense>
    </ClientOnly>
  );
}
