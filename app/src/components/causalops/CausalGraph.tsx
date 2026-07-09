import { forwardRef, lazy, Suspense, useImperativeHandle, useRef } from "react";
import { ClientOnly } from "@tanstack/react-router";
import type { CausalGraph as CausalGraphData, CausalNode, CausalEdge } from "@/lib/causalops-types";
import type { EdgeAnnotation } from "@/lib/agent-runtime";

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

// Lazy-load the client-only implementation. react-force-graph-2d touches
// `window` at import time, so it must never be evaluated during SSR.
// The dynamic import is wrapped in <ClientOnly> so the chunk is never
// requested during the server render pass.
const ClientGraph = lazy(async () => {
  const m = await import("./CausalGraph.client");
  return { default: m.CausalGraphClient };
});

export const CausalGraph = forwardRef<CausalGraphHandle, CausalGraphProps>(
  function CausalGraph(props, ref) {
    const innerRef = useRef<CausalGraphHandle | null>(null);

    useImperativeHandle(ref, () => ({
      getCanvas: () => innerRef.current?.getCanvas() ?? null,
      fit: () => innerRef.current?.fit(),
    }));

    const fallback = (
      <div
        className="flex w-full items-center justify-center rounded-xl border border-white/10 bg-[oklch(0.1_0.02_260/0.7)] text-xs uppercase tracking-widest text-muted-foreground"
        style={{ height: props.height ?? 480 }}
      >
        Initializing graph engine…
      </div>
    );

    return (
      <ClientOnly fallback={fallback}>
        <Suspense fallback={fallback}>
          <ClientGraph ref={innerRef} {...props} />
        </Suspense>
      </ClientOnly>
    );
  },
);
