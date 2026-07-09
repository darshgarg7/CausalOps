/**
 * Agent runtime simulator (client-side, deterministic).
 *
 * Derives a hierarchical multi-agent activation trace from:
 *   - the structured ScenarioState the analyst built
 *   - the selected MITRE TTPs
 *   - the actual /run causal_graph + strategies returned by the backend
 *
 * Output is a fully-formed `ObservabilityTrace` containing:
 *   - hierarchical agents (Grand Orchestrator → Domain Parents → Atomic Children)
 *   - per-agent activation reason + triggering hypothesis + parent
 *   - rejected counterfactual branches with why they were pruned
 *   - causal-edge annotations (confidence, evidence type, directionality)
 *   - a chronological decision log suitable for replay
 *
 * This is presented in the UI behind a "Derived overlay" badge so the
 * analyst knows it is a synthetic reconstruction layered on top of the
 * real backend response, not a live agent stream.
 */
import type { CausalEdge, CausalGraph, RunResponse, Strategy } from "./causalops-types";
import type { ScenarioState } from "./scenario-builder";
import { TECHNIQUES, tacticById, type TacticId } from "./mitre-catalog";

export type AgentLevel = "orchestrator" | "domain" | "atomic";
export type AgentStatus = "active" | "rejected" | "pruned" | "merged";
export type DomainKey =
  | "identity"
  | "network"
  | "endpoint"
  | "cloud"
  | "supply_chain"
  | "insider"
  | "data";

export type EvidenceType = "telemetry" | "heuristic" | "model_inferred" | "external_intel";

export interface AgentNode {
  id: string;
  level: AgentLevel;
  domain?: DomainKey;
  label: string;
  parentId: string | null;
  status: AgentStatus;

  // Why was this agent activated?
  activationReason: string;
  triggeringHypothesis: string;
  triggeringSignals: string[]; // e.g. "actor: FIN7", "TTP T1566"

  // What did this agent contribute?
  contributedNodeIds: string[]; // ids in the causal graph
  contributedEdgeKeys: string[]; // "src->tgt" keys

  // Confidence the agent had in its output (0..1)
  selfConfidence: number;

  // Counterfactual: domain that *was* considered but rejected, why
  rejectedReason?: string;

  // Wallclock — synthetic but monotonically increasing per agent
  activatedAtMs: number;
  completedAtMs: number;
}

export interface EdgeAnnotation {
  key: string; // `${source}->${target}`
  source: string;
  target: string;
  relationship: string;
  confidence: number; // 0..1
  evidenceType: EvidenceType;
  evidenceSummary: string;
  attributedAgentId: string;
  validated: boolean; // true if backed by telemetry / external intel
}

export interface DecisionLogEntry {
  tMs: number;
  agentId: string;
  kind: "spawn" | "reject" | "prune" | "hypothesis" | "evidence" | "merge" | "validate";
  message: string;
}

export interface ObservabilityTrace {
  agents: AgentNode[];
  edges: EdgeAnnotation[];
  log: DecisionLogEntry[];
  domainsConsidered: DomainKey[];
  domainsActivated: DomainKey[];
  domainsRejected: { domain: DomainKey; reason: string }[];
  totalDurationMs: number;
  // Aggregate validation metrics derived from edges
  validation: {
    totalEdges: number;
    validatedEdges: number;
    avgConfidence: number;
    avgValidatedConfidence: number;
    placeboPassed: number;
    placeboTotal: number;
    refutationScore: number; // 0..1
  };
}

// ---------------------------------------------------------------------------
// Domain catalog
// ---------------------------------------------------------------------------

const DOMAIN_LABELS: Record<DomainKey, string> = {
  identity: "Identity & Access",
  network: "Network & Edge",
  endpoint: "Endpoint & EDR",
  cloud: "Cloud Control Plane",
  supply_chain: "Supply Chain",
  insider: "Insider Threat",
  data: "Data & Exfiltration",
};

const TACTIC_TO_DOMAIN: Partial<Record<TacticId, DomainKey>> = {
  "initial-access": "network",
  execution: "endpoint",
  persistence: "endpoint",
  "privilege-escalation": "identity",
  "defense-evasion": "endpoint",
  "credential-access": "identity",
  discovery: "network",
  "lateral-movement": "network",
  collection: "data",
  "command-and-control": "network",
  exfiltration: "data",
  impact: "data",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hash(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pickEvidence(rand: () => number, domain: DomainKey, hasTelemetry: boolean): EvidenceType {
  const r = rand();
  if (hasTelemetry && r < 0.45) return "telemetry";
  if (r < 0.7) return "model_inferred";
  if (r < 0.88) return "heuristic";
  if (domain === "supply_chain" || domain === "cloud") return "external_intel";
  return "model_inferred";
}

function evidenceSummary(type: EvidenceType, domain: DomainKey, rel: string): string {
  switch (type) {
    case "telemetry":
      return `${DOMAIN_LABELS[domain]} telemetry corroborates "${rel}" relationship across observed events.`;
    case "external_intel":
      return `External threat intel (CTI feeds) validates "${rel}" pattern in recent ${DOMAIN_LABELS[domain]} campaigns.`;
    case "heuristic":
      return `Rule-based heuristic on ${DOMAIN_LABELS[domain]} surface implies "${rel}" with moderate confidence.`;
    case "model_inferred":
      return `Model-inferred from latent causal embeddings of similar ${DOMAIN_LABELS[domain]} kill chains.`;
  }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildObservabilityTrace(
  scenario: ScenarioState,
  ttps: string[],
  result: RunResponse,
): ObservabilityTrace {
  const seed = hash(`${result.run_id}|${scenario.asset}|${scenario.actor}|${ttps.join(",")}`);
  const rand = rng(seed);

  const graph = result.causal_graph ?? { nodes: [], edges: [] };
  const strategies = result.strategies ?? [];

  // 1. Determine which domains the scenario touches
  const domainSignals = scoreDomains(scenario, ttps);

  // Activate domains above threshold; reject the rest with reasons
  const allDomains: DomainKey[] = [
    "identity",
    "network",
    "endpoint",
    "cloud",
    "supply_chain",
    "insider",
    "data",
  ];
  const activeDomains: DomainKey[] = allDomains.filter((d) => domainSignals[d] >= 1);
  // Always include data if there's an objective like exfil
  if (
    !activeDomains.includes("data") &&
    /exfil|encrypt|ransom|disclose|leak/i.test(scenario.objective)
  ) {
    activeDomains.push("data");
  }
  // Cap at 5 to stay readable
  activeDomains.sort((a, b) => domainSignals[b] - domainSignals[a]);
  const activated = activeDomains.slice(0, 5);
  const rejected: { domain: DomainKey; reason: string }[] = allDomains
    .filter((d) => !activated.includes(d))
    .map((d) => ({
      domain: d,
      reason: rejectionReason(d, scenario, ttps),
    }));

  // 2. Build agents
  const agents: AgentNode[] = [];
  const log: DecisionLogEntry[] = [];
  let tCursor = 0;

  // Orchestrator
  const orchestratorId = "agent.orchestrator";
  agents.push({
    id: orchestratorId,
    level: "orchestrator",
    label: "Grand Orchestrator",
    parentId: null,
    status: "active",
    activationReason: "Top-level decomposition of analyst hypothesis into domain partitions.",
    triggeringHypothesis: composeRootHypothesis(scenario),
    triggeringSignals: [
      `asset:${scenario.asset || "?"}`.slice(0, 64),
      `actor:${scenario.actor || "?"}`.slice(0, 64),
      `objective:${scenario.objective || "?"}`.slice(0, 64),
    ],
    contributedNodeIds: [],
    contributedEdgeKeys: [],
    selfConfidence: 0.92,
    activatedAtMs: tCursor,
    completedAtMs: (tCursor += 180),
  });
  log.push({
    tMs: 0,
    agentId: orchestratorId,
    kind: "spawn",
    message: "Grand Orchestrator initialized — decomposing intent.",
  });
  log.push({
    tMs: 60,
    agentId: orchestratorId,
    kind: "hypothesis",
    message: `Root hypothesis: ${composeRootHypothesis(scenario)}`,
  });

  // Rejected domain log entries
  for (const r of rejected) {
    tCursor += 40 + Math.floor(rand() * 60);
    const aid = `agent.domain.${r.domain}.rejected`;
    agents.push({
      id: aid,
      level: "domain",
      domain: r.domain,
      label: DOMAIN_LABELS[r.domain],
      parentId: orchestratorId,
      status: "rejected",
      activationReason: "Considered as candidate domain partition.",
      triggeringHypothesis: `Could ${DOMAIN_LABELS[r.domain]} contain a viable attack path?`,
      triggeringSignals: [],
      contributedNodeIds: [],
      contributedEdgeKeys: [],
      selfConfidence: 0.18,
      rejectedReason: r.reason,
      activatedAtMs: tCursor,
      completedAtMs: tCursor + 40,
    });
    log.push({
      tMs: tCursor,
      agentId: aid,
      kind: "reject",
      message: `${DOMAIN_LABELS[r.domain]} branch rejected — ${r.reason}`,
    });
  }

  // Activated domain agents
  const domainAgentByKey = new Map<DomainKey, string>();
  for (const d of activated) {
    tCursor += 120 + Math.floor(rand() * 140);
    const id = `agent.domain.${d}`;
    domainAgentByKey.set(d, id);
    const hyp = domainHypothesis(d, scenario);
    agents.push({
      id,
      level: "domain",
      domain: d,
      label: DOMAIN_LABELS[d],
      parentId: orchestratorId,
      status: "active",
      activationReason: `Domain signal score ${domainSignals[d].toFixed(1)} exceeds activation threshold.`,
      triggeringHypothesis: hyp,
      triggeringSignals: domainTriggers(d, scenario, ttps),
      contributedNodeIds: [],
      contributedEdgeKeys: [],
      selfConfidence: 0.7 + rand() * 0.22,
      activatedAtMs: tCursor,
      completedAtMs: tCursor + 220 + Math.floor(rand() * 180),
    });
    log.push({
      tMs: tCursor,
      agentId: id,
      kind: "spawn",
      message: `${DOMAIN_LABELS[d]} agent spawned — score ${domainSignals[d].toFixed(1)}`,
    });
    log.push({
      tMs: tCursor + 40,
      agentId: id,
      kind: "hypothesis",
      message: hyp,
    });
  }

  // 3. Atomic agents — assign each causal graph node to a domain agent
  const nodeToAgent = new Map<string, string>();
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const domain = inferNodeDomain(node.label, activated);
    const parentId = domainAgentByKey.get(domain) ?? orchestratorId;
    tCursor += 80 + Math.floor(rand() * 90);
    const aid = `agent.atom.${node.id}`;
    const taskKind = atomicTaskKind(node.label);
    agents.push({
      id: aid,
      level: "atomic",
      domain,
      label: `${taskKind} · ${node.label}`,
      parentId,
      status: "active",
      activationReason: `Spawned by ${DOMAIN_LABELS[domain]} parent to perform ${taskKind.toLowerCase()}.`,
      triggeringHypothesis: `Resolve causal contribution of "${node.label}" within ${DOMAIN_LABELS[domain]}.`,
      triggeringSignals: [`graph_node:${node.id}`, `domain:${domain}`],
      contributedNodeIds: [node.id],
      contributedEdgeKeys: [],
      selfConfidence: 0.6 + rand() * 0.35,
      activatedAtMs: tCursor,
      completedAtMs: tCursor + 110 + Math.floor(rand() * 130),
    });
    nodeToAgent.set(node.id, aid);
    log.push({
      tMs: tCursor,
      agentId: aid,
      kind: "spawn",
      message: `${taskKind} agent spawned for "${node.label}" by ${DOMAIN_LABELS[domain]}.`,
    });
  }

  // 4. Edge annotations — attribute each edge to the agent that "owns" the target node
  const edges: EdgeAnnotation[] = [];
  let confSum = 0;
  let valConfSum = 0;
  let validatedCount = 0;
  for (const e of graph.edges) {
    const key = `${e.source}->${e.target}`;
    const ownerAgent = nodeToAgent.get(e.target) ?? nodeToAgent.get(e.source) ?? orchestratorId;
    const ownerNode = agents.find((a) => a.id === ownerAgent);
    const domain = ownerNode?.domain ?? "network";
    const hasTel = /tel|edr|log|alert|siem/i.test(scenario.environment);
    const evType = pickEvidence(rand, domain, hasTel);
    const baseConf = 0.55 + rand() * 0.4;
    const conf =
      evType === "telemetry"
        ? Math.min(0.98, baseConf + 0.1)
        : evType === "external_intel"
          ? Math.min(0.95, baseConf + 0.05)
          : evType === "heuristic"
            ? Math.max(0.45, baseConf - 0.1)
            : baseConf;
    const validated = evType === "telemetry" || evType === "external_intel";
    confSum += conf;
    if (validated) {
      valConfSum += conf;
      validatedCount += 1;
    }
    edges.push({
      key,
      source: e.source,
      target: e.target,
      relationship: e.relationship,
      confidence: Math.round(conf * 100) / 100,
      evidenceType: evType,
      evidenceSummary: evidenceSummary(evType, domain, e.relationship),
      attributedAgentId: ownerAgent,
      validated,
    });
    // Attach edge key to owning agent
    if (ownerNode) ownerNode.contributedEdgeKeys.push(key);
    log.push({
      tMs: ownerNode?.completedAtMs ?? tCursor,
      agentId: ownerAgent,
      kind: "evidence",
      message: `Edge ${e.source} → ${e.target} (${e.relationship}) · ${evType.replace("_", " ")} · ${(conf * 100).toFixed(0)}%`,
    });
  }

  // 5. Synthesis log entry
  tCursor += 240;
  log.push({
    tMs: tCursor,
    agentId: orchestratorId,
    kind: "merge",
    message: `Causal Synthesis Layer merged ${activated.length} domain outputs into unified DAG (${graph.nodes.length} nodes, ${graph.edges.length} edges).`,
  });

  // 6. DoWhy-style validation pass
  tCursor += 180;
  const placeboTotal = Math.max(3, Math.min(8, Math.floor(graph.edges.length / 2)));
  const placeboPassed = Math.max(
    1,
    placeboTotal - Math.floor(rand() * Math.max(1, Math.floor(placeboTotal * 0.3))),
  );
  const refutationScore = Math.max(
    0.55,
    Math.min(0.97, 0.7 + (placeboPassed / placeboTotal - 0.7) * 0.6),
  );
  log.push({
    tMs: tCursor,
    agentId: orchestratorId,
    kind: "validate",
    message: `DoWhy refutation pass: ${placeboPassed}/${placeboTotal} placebo tests passed · refutation score ${(refutationScore * 100).toFixed(0)}%.`,
  });

  // Boost orchestrator's contributed nodes (none — it's pure decomposition)
  // Sort log
  log.sort((a, b) => a.tMs - b.tMs);

  const totalDurationMs = tCursor + 120;
  return {
    agents,
    edges,
    log,
    domainsConsidered: allDomains,
    domainsActivated: activated,
    domainsRejected: rejected,
    totalDurationMs,
    validation: {
      totalEdges: edges.length,
      validatedEdges: validatedCount,
      avgConfidence: edges.length ? confSum / edges.length : 0,
      avgValidatedConfidence: validatedCount ? valConfSum / validatedCount : 0,
      placeboPassed,
      placeboTotal,
      refutationScore,
    },
  };

  // (strategies referenced for future use)
  void strategies as unknown as Strategy[];
}

// ---------------------------------------------------------------------------
// Scoring + reasoning helpers
// ---------------------------------------------------------------------------

function scoreDomains(s: ScenarioState, ttps: string[]): Record<DomainKey, number> {
  const text = [s.asset, s.actor, s.objective, s.vector, s.environment, s.impact, s.detection_gaps]
    .join(" \n ")
    .toLowerCase();

  const score: Record<DomainKey, number> = {
    identity: 0,
    network: 0,
    endpoint: 0,
    cloud: 0,
    supply_chain: 0,
    insider: 0,
    data: 0,
  };

  const bump = (k: DomainKey, n: number) => (score[k] += n);

  // Keyword evidence
  if (/sso|aitm|mfa|oauth|entra|okta|saml|token|session|kerb|ad |active dir/.test(text))
    bump("identity", 3);
  if (/phish|email|smtp|cdn|edge|firewall|vpn|tunnel|c2|beacon|dns/.test(text)) bump("network", 2);
  if (/edr|defender|crowd|sentinel|lsass|powershell|wmi|scheduled task|registry/.test(text))
    bump("endpoint", 3);
  if (/aws|azure|gcp|s3|iam|kms|tenant|m365|exchange|sharepoint|graph api/.test(text))
    bump("cloud", 3);
  if (
    /supply chain|vendor|3rd party|third[- ]party|dependency|build|ci\/cd|sbom|3cx|solar/.test(text)
  )
    bump("supply_chain", 4);
  if (/insider|contractor|disgrunt|departing|admin abuse|leaver/.test(text)) bump("insider", 4);
  if (/exfil|leak|dump|backup|database|pii|phi|crown jew|encrypt|ransom|s3 bucket/.test(text))
    bump("data", 3);

  // TTP-based bumps
  for (const id of ttps) {
    const t = TECHNIQUES.find((x) => x.id === id);
    if (!t) continue;
    const dom = TACTIC_TO_DOMAIN[t.tactic];
    if (dom) bump(dom, 1);
  }

  return score;
}

function rejectionReason(d: DomainKey, s: ScenarioState, ttps: string[]): string {
  const text = `${s.asset} ${s.environment} ${s.vector}`.toLowerCase();
  switch (d) {
    case "identity":
      return "No identity-provider signals (SSO/MFA/Entra/Okta) detected in scenario.";
    case "network":
      return "No edge, C2, or network-tier indicators referenced.";
    case "endpoint":
      return /no edr|edr off|no agent/.test(text)
        ? "Scenario explicitly states EDR is absent — endpoint partition not load-bearing."
        : "No endpoint execution indicators (EDR alerts, LSASS, PowerShell, WMI).";
    case "cloud":
      return "Asset is on-prem; cloud control-plane not in scope.";
    case "supply_chain":
      return "No third-party / vendor / dependency / CI-CD signals.";
    case "insider":
      return "No insider, contractor, or privileged-abuse signals.";
    case "data":
      return ttps.length
        ? "Selected TTPs do not terminate in collection / exfiltration / impact tactics."
        : "No data-disposition signals (exfil, encrypt, leak).";
  }
}

function composeRootHypothesis(s: ScenarioState): string {
  const actor = s.actor || "an unknown adversary";
  const objective = s.objective || "achieve unauthorized objective";
  const asset = s.asset || "the target asset";
  return `${actor} can ${objective.toLowerCase()} against ${asset}.`;
}

function domainHypothesis(d: DomainKey, s: ScenarioState): string {
  switch (d) {
    case "identity":
      return `Adversary can compromise an identity that grants access to ${s.asset || "the target"}.`;
    case "network":
      return `A network-edge or C2 path exists from external surface to internal target.`;
    case "endpoint":
      return `Execution on at least one endpoint is achievable and persists below detection.`;
    case "cloud":
      return `A cloud-plane misconfiguration or token-theft path reaches ${s.asset || "the asset"}.`;
    case "supply_chain":
      return `A trusted upstream component can deliver malicious code into the target environment.`;
    case "insider":
      return `A privileged human can directly act against ${s.asset || "the asset"} without crossing a perimeter.`;
    case "data":
      return `Once interior, the adversary can reach, stage, and remove the asset's data.`;
  }
}

function domainTriggers(d: DomainKey, s: ScenarioState, ttps: string[]): string[] {
  const sigs: string[] = [];
  const text = `${s.actor} ${s.vector} ${s.environment} ${s.objective}`.toLowerCase();
  if (d === "identity" && /sso|aitm|mfa|entra|okta|token/.test(text))
    sigs.push("identity provider in scope");
  if (d === "endpoint" && /edr|defender|lsass|powershell/.test(text))
    sigs.push("endpoint execution context");
  if (d === "cloud" && /aws|azure|gcp|m365|graph/.test(text))
    sigs.push("cloud control plane present");
  if (d === "supply_chain" && /vendor|supply|ci\/cd|build|dependency/.test(text))
    sigs.push("upstream dependency referenced");
  if (d === "insider" && /insider|contractor|disgrunt/.test(text))
    sigs.push("insider scenario flagged");
  if (d === "data" && /exfil|encrypt|leak|dump|ransom/.test(text))
    sigs.push("data-disposition objective");
  if (d === "network" && /phish|email|edge|vpn|c2/.test(text))
    sigs.push("network surface exposure");
  for (const id of ttps) {
    const t = TECHNIQUES.find((x) => x.id === id);
    if (!t) continue;
    const dom = TACTIC_TO_DOMAIN[t.tactic];
    if (dom === d) sigs.push(`TTP ${t.id} (${tacticById(t.tactic)?.label ?? t.tactic})`);
  }
  return sigs.slice(0, 5);
}

function inferNodeDomain(label: string, activated: DomainKey[]): DomainKey {
  const t = label.toLowerCase();
  if (/sso|mfa|token|sess|cred|user|account|kerber/.test(t))
    return pickFrom(["identity"], activated);
  if (/phish|email|edge|c2|beacon|dns|tunnel|vpn/.test(t)) return pickFrom(["network"], activated);
  if (/edr|lsass|powershell|wmi|persist|scheduled|registry|process/.test(t))
    return pickFrom(["endpoint"], activated);
  if (/aws|azure|gcp|s3|iam|kms|m365|exchange|sharepoint|tenant/.test(t))
    return pickFrom(["cloud"], activated);
  if (/supply|vendor|build|ci|dependency|sbom|3cx|solar/.test(t))
    return pickFrom(["supply_chain"], activated);
  if (/insider|contractor/.test(t)) return pickFrom(["insider"], activated);
  if (/exfil|leak|dump|encrypt|ransom|database|pii|backup|stage/.test(t))
    return pickFrom(["data"], activated);
  return activated[0] ?? "network";
}

function pickFrom(prefer: DomainKey[], activated: DomainKey[]): DomainKey {
  for (const p of prefer) if (activated.includes(p)) return p;
  return activated[0] ?? "network";
}

function atomicTaskKind(label: string): string {
  const t = label.toLowerCase();
  if (/exploit|cve|vuln/.test(t)) return "Exploit Mapper";
  if (/telemetry|alert|siem|edr|log/.test(t)) return "Telemetry Analyst";
  if (/vendor|supply|trust/.test(t)) return "Vendor-Trust Evaluator";
  if (/ttp|attack|technique|adversary/.test(t)) return "Adversary TTP Inferencer";
  if (/cred|token|session|sso/.test(t)) return "Identity Path Solver";
  if (/exfil|stage|encrypt|impact/.test(t)) return "Impact Estimator";
  return "Causal Subgraph Solver";
}

// ---------------------------------------------------------------------------
// Convenience: lookup helpers
// ---------------------------------------------------------------------------

export function evidenceColor(t: EvidenceType): string {
  switch (t) {
    case "telemetry":
      return "var(--neon-emerald)";
    case "external_intel":
      return "var(--neon-cyan)";
    case "heuristic":
      return "var(--neon-amber)";
    case "model_inferred":
      return "var(--neon-violet)";
  }
}

export function evidenceLabel(t: EvidenceType): string {
  switch (t) {
    case "telemetry":
      return "Telemetry";
    case "external_intel":
      return "External Intel";
    case "heuristic":
      return "Heuristic";
    case "model_inferred":
      return "Model-Inferred";
  }
}

export function domainLabel(d: DomainKey): string {
  return DOMAIN_LABELS[d];
}

// Re-export for downstream consumers (so they don't need to know about CausalGraph)
export type { CausalGraph, CausalEdge };
