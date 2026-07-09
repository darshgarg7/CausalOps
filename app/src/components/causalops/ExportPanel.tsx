import { Code2, Download, FileText, Network } from "lucide-react";
import { toast } from "sonner";
import {
  toMitreJson,
  toYaml,
  toExecutiveSummary,
  type ScenarioState,
  buildKillChain,
} from "@/lib/scenario-builder";

interface Props {
  state: ScenarioState;
  ttpIds: string[];
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportPanel({ state, ttpIds }: Props) {
  const exports = [
    {
      icon: Code2,
      label: "MITRE JSON",
      hint: "ATT&CK-mapped, schema v1",
      run: () => {
        download(
          "causalops-scenario.json",
          JSON.stringify(toMitreJson(state, ttpIds), null, 2),
          "application/json",
        );
        toast.success("Exported MITRE JSON");
      },
    },
    {
      icon: Download,
      label: "YAML",
      hint: "Automation pipelines",
      run: () => {
        download("causalops-scenario.yaml", toYaml(state, ttpIds), "text/yaml");
        toast.success("Exported YAML");
      },
    },
    {
      icon: Network,
      label: "Attack graph",
      hint: "Nodes / edges JSON",
      run: () => {
        const chain = buildKillChain(state, ttpIds);
        const graph = {
          nodes: chain.steps.map((s) => ({
            id: s.technique.id,
            label: s.technique.name,
            tactic: s.technique.tactic,
            detected: s.detected,
          })),
          edges: chain.steps.slice(1).map((s, i) => ({
            from: chain.steps[i].technique.id,
            to: s.technique.id,
          })),
        };
        download("causalops-attack-graph.json", JSON.stringify(graph, null, 2), "application/json");
        toast.success("Exported attack graph");
      },
    },
    {
      icon: FileText,
      label: "Exec summary",
      hint: "Plain-text briefing",
      run: () => {
        const chain = buildKillChain(state, ttpIds);
        download(
          "causalops-executive-summary.txt",
          toExecutiveSummary(state, ttpIds, chain),
          "text/plain",
        );
        toast.success("Exported executive summary");
      },
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        Export
      </span>
      {exports.map((e) => (
        <button
          key={e.label}
          type="button"
          onClick={e.run}
          className="group flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-foreground/80 transition-all hover:border-[color:var(--neon-violet)]/40 hover:bg-[color:var(--neon-violet)]/10 hover:text-[color:var(--neon-violet)]"
          title={e.hint}
        >
          <e.icon className="h-3 w-3" />
          {e.label}
        </button>
      ))}
    </div>
  );
}
