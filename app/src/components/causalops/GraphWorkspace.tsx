import { forwardRef } from "react";
import { Boxes, GitBranch, Network } from "lucide-react";

import type { CausalGraph } from "@/lib/causalops-types";
import { cn } from "@/lib/utils";
import { CausalGraphPanel } from "./CausalGraphPanel";
import type { CausalGraphHandle } from "./CausalGraph";
import { SpatiotemporalKGPanel } from "./SpatiotemporalKGPanel";

interface GraphWorkspaceProps {
  graph: CausalGraph;
  runId: string;
}

export const GraphWorkspace = forwardRef<CausalGraphHandle, GraphWorkspaceProps>(
  function GraphWorkspace({ graph, runId }, ref) {
    const nodes = graph.nodes ?? [];
    const edges = graph.edges ?? [];
    const isSparse = nodes.length > 0 && nodes.length <= 6;

    return (
      <section className="space-y-3" data-testid="result-graph-workspace">
        <div className="flex flex-col gap-3 border-y border-white/5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-[color:var(--neon-cyan)]" aria-hidden />
              <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground">
                Graph Workspace
              </h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              The 5D knowledge graph is the run artifact; the DAG stays beside it as causal context.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span
              className={cn(
                "rounded-full border px-2.5 py-1",
                isSparse
                  ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
                  : "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
              )}
            >
              {isSparse ? "compact DAG" : "expanded DAG"}
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1">
              {nodes.length} variables
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1">
              {edges.length} mechanisms
            </span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.62fr)_minmax(320px,0.38fr)] 2xl:grid-cols-[minmax(0,1fr)_560px]">
          <div className="min-w-0 space-y-2" data-testid="primary-5d-kg">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--neon-violet)]">
              <Boxes className="h-3.5 w-3.5" aria-hidden />
              5D Spatiotemporal KG
            </div>
            <SpatiotemporalKGPanel runId={runId} />
          </div>

          <div className="min-w-0 space-y-2" data-testid="causal-dag-context">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--neon-cyan)]">
              <GitBranch className="h-3.5 w-3.5" aria-hidden />
              Evidence DAG Context
            </div>
            <CausalGraphPanel ref={ref} graph={graph} compact />
          </div>
        </div>
      </section>
    );
  },
);
