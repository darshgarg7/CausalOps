import { TECHNIQUES, tacticById, type Technique, type TacticId } from "./mitre-catalog";

// ============================================================================
// Structured threat-scenario fields shown in the Builder
// ============================================================================

export type FieldKey =
  | "asset"
  | "actor"
  | "objective"
  | "vector"
  | "ttps"
  | "environment"
  | "impact"
  | "detection_gaps";

export interface ScenarioField {
  key: FieldKey;
  label: string;
  helper: string;
  placeholder: string;
  multiline?: boolean;
}

export const FIELDS: ScenarioField[] = [
  {
    key: "asset",
    label: "Asset / Target System",
    helper: "What are we defending? Be specific (system, data class, tenant).",
    placeholder: "e.g. Production Postgres holding customer PII (eu-west-1)",
  },
  {
    key: "actor",
    label: "Threat Actor",
    helper: "APT, nation-state, cybercrime crew, insider, unknown.",
    placeholder: "e.g. FIN7-aligned cybercrime crew, financially motivated",
  },
  {
    key: "objective",
    label: "Attack Objective",
    helper: "What does the adversary want? Encrypt, exfiltrate, persist, disrupt.",
    placeholder: "e.g. Exfiltrate customer PII, then deploy ransomware for double extortion",
  },
  {
    key: "vector",
    label: "Attack Surface / Entry Vector",
    helper: "How do they get in? Identity, edge, supply chain, insider.",
    placeholder: "e.g. Spear-phishing finance dept with malicious .docm",
  },
  {
    key: "ttps",
    label: "TTPs (MITRE ATT&CK)",
    helper: "Auto-mapped from your description. Click chips to add or remove.",
    placeholder: "Auto-decomposed",
  },
  {
    key: "environment",
    label: "Environmental Constraints",
    helper: "Cloud / hybrid / OT / zero-trust posture, identity provider, EDR coverage.",
    placeholder: "e.g. Hybrid: Entra ID + on-prem AD, Defender XDR, no segmentation between tiers",
    multiline: true,
  },
  {
    key: "impact",
    label: "Expected Impact",
    helper: "Business + technical blast radius if successful.",
    placeholder:
      "e.g. ~14h customer-facing outage, regulatory disclosure (GDPR), board notification",
    multiline: true,
  },
  {
    key: "detection_gaps",
    label: "Detection Gaps / Blind Spots",
    helper: "Where defenders are likely to miss this.",
    placeholder: "e.g. No EDR on jump host; LSASS protection disabled on legacy DC",
    multiline: true,
  },
];

export type ScenarioState = Record<FieldKey, string>;
export type ConfidenceState = Partial<Record<FieldKey, "high" | "medium" | "low">>;

export const EMPTY_SCENARIO: ScenarioState = {
  asset: "",
  actor: "",
  objective: "",
  vector: "",
  ttps: "",
  environment: "",
  impact: "",
  detection_gaps: "",
};

// ============================================================================
// Library — one-click templates that auto-expand into structured fields
// ============================================================================

export interface ScenarioLibraryEntry {
  id: string;
  emoji: string;
  label: string;
  oneLiner: string;
  fields: ScenarioState;
  /** Pre-curated TTPs in kill-chain order (technique IDs). */
  ttps: string[];
}

export const SCENARIO_LIBRARY: ScenarioLibraryEntry[] = [
  {
    id: "ransomware-cloud",
    emoji: "🔒",
    label: "Ransomware in enterprise cloud",
    oneLiner:
      "Edge appliance compromise → cloud admin abuse → mass encryption + recovery sabotage.",
    fields: {
      asset:
        "Production AWS environment (3 accounts, ~480 EC2, RDS, S3 with customer PII). Crown-jewel data warehouse on Snowflake.",
      actor:
        "Financially motivated ransomware affiliate (LockBit-aligned), confirmed via leak-site post.",
      objective:
        "Double extortion — exfiltrate customer + financial data, then encrypt/destroy backups, deploy ransomware across hypervisors.",
      vector:
        "Initial access via 0-day in internet-facing VPN appliance (CVE pending). 36h dwell before detonation.",
      ttps: "",
      environment:
        "Hybrid: AWS multi-account + on-prem hypervisors. Entra ID for SSO, Defender for Cloud, CrowdStrike on endpoints. Backup MFA enabled. Limited east-west segmentation in cloud.",
      impact:
        "Estimated $14M/day revenue at risk, ~72h customer outage, GDPR / SEC 8-K disclosure. Board + regulator notification required within 24h.",
      detection_gaps:
        "VPN appliance not in EDR scope. Snowflake egress not monitored by DLP. No canary files in prod S3. Backup deletion alerting not piped to SOC.",
    },
    ttps: [
      "T1190",
      "T1078.004",
      "T1003.001",
      "T1018",
      "T1021.002",
      "T1213",
      "T1567.002",
      "T1490",
      "T1486",
    ],
  },
  {
    id: "insider-exfil",
    emoji: "🕵️",
    label: "Insider data exfiltration (privileged user)",
    oneLiner:
      "Resigning data engineer abuses legitimate access to bulk-exfil customer data to personal cloud.",
    fields: {
      asset:
        "Internal data lake (S3 + Snowflake) — 14GB downloaded over 4 nights including customer PII and pricing models.",
      actor:
        "Senior data engineer, 2-week notice served, joining a direct competitor. Privileged read on data lake.",
      objective: "Exfiltrate proprietary pricing models + customer PII to use at next employer.",
      vector:
        "Legitimate authenticated access. Personal cloud-sync client used briefly before being blocked by CASB.",
      ttps: "",
      environment:
        "Snowflake + S3 + Looker. CASB inline. Identity governed by Okta. No DLP on outbound personal cloud beyond CASB block.",
      impact:
        "Reputational + legal — competitor lawsuit precedent ($30M+). Notification obligations under state PII laws.",
      detection_gaps:
        "No volume baseline per data engineer. CASB blocked but no historical signal review. HR / IT not coupled for departing-employee monitoring.",
    },
    ttps: ["T1078", "T1213", "T1119", "T1567.002"],
  },
  {
    id: "supply-chain-cicd",
    emoji: "🔗",
    label: "Supply chain via CI/CD",
    oneLiner:
      "Malicious upstream npm package executes postinstall script in build agents, exfils secrets.",
    fields: {
      asset:
        "Customer-facing web app (Node.js). Build pipeline in GitHub Actions with access to AWS deploy role + Stripe / Twilio secrets.",
      actor: "Unattributed supply-chain actor — pattern matches recent npm typosquat campaigns.",
      objective:
        "Steal CI/CD credentials → pivot to production infra → potential supply-chain compromise to downstream customers.",
      vector:
        "Auto-bumped dependency on a feature branch yesterday. Postinstall script exfils env vars to attacker-controlled domain.",
      ttps: "",
      environment:
        "GitHub Actions self-hosted runners, AWS OIDC for deploys, Vault for secrets. SBOM generated but not diffed on PR.",
      impact:
        "All CI secrets must be rotated. If shipped: customer-side compromise + SEC disclosure. ~$2M direct cost + brand impact.",
      detection_gaps:
        "No egress allow-list on build runners. Postinstall scripts run by default. SBOM not gated in PR.",
    },
    ttps: ["T1195.002", "T1059.001", "T1071.001", "T1041"],
  },
  {
    id: "phishing-identity",
    emoji: "🎣",
    label: "Phishing-led identity takeover (M365 / Workspace)",
    oneLiner:
      "Spear-phish → AiTM session theft → cloud admin escalation → mailbox + SharePoint pivot.",
    fields: {
      asset: "M365 tenant (~28k users), Entra ID, SharePoint Online with sensitive M&A documents.",
      actor:
        "Financially motivated, AiTM toolkit (EvilProxy-style). Credential broker resale likely downstream.",
      objective:
        "Mailbox access to executives → BEC / wire fraud, plus M&A document staging for extortion.",
      vector:
        "Spear-phish with lookalike Microsoft login on AiTM proxy. Session cookie captured + replayed.",
      ttps: "",
      environment:
        "Entra ID with conditional access (IP-based, no device binding). Defender for Cloud Apps. No FIDO2 enforcement on execs.",
      impact: "Direct fraud risk $5–20M, plus M&A disclosure / deal collapse risk.",
      detection_gaps:
        "No token binding. Session reuse from new device flagged but not auto-revoked. Exec mailbox rules not monitored.",
    },
    ttps: ["T1566.002", "T1539", "T1078", "T1550.004", "T1078.004", "T1657"],
  },
  {
    id: "lateral-edge",
    emoji: "🛰️",
    label: "Lateral movement post edge-device compromise",
    oneLiner: "Edge router 0-day → DMZ pivot → AD enumeration → SMB lateral → domain dominance.",
    fields: {
      asset:
        "Internet-facing edge appliance fronting corporate network. On-prem AD, ~12k endpoints, file servers with regulated data.",
      actor: "Suspected nation-state aligned (TTP overlap with Volt-Typhoon-style staging).",
      objective: "Persistence + intel collection + pre-positioning for disruptive impact.",
      vector:
        "RCE in management plane of edge appliance, exposed to internet. ~36h LSASS dump on jump host before detection.",
      ttps: "",
      environment:
        "Flat AD design, tier-0 not enforced. EDR on workstations but not jump hosts or appliances. SMB signing partial.",
      impact:
        "Potential domain dominance — full reset required if confirmed. Regulatory posture for critical infra applies.",
      detection_gaps:
        "No EDR on jump host. SMB writes to file servers not baselined. AD attack-path tooling not in production.",
    },
    ttps: [
      "T1190",
      "T1133",
      "T1003.001",
      "T1087.002",
      "T1018",
      "T1021.002",
      "T1021.001",
      "T1136",
      "T1547",
    ],
  },
  {
    id: "zero-day-perimeter",
    emoji: "💥",
    label: "Zero-day in perimeter service",
    oneLiner: "Unauthenticated RCE in internet-facing service → webshell → C2 → discovery.",
    fields: {
      asset:
        "Internet-facing collaboration / file-transfer service (MOVEit-class). Holds regulated documents in transit.",
      actor: "Cl0p-style mass-exploitation actor — opportunistic, broad targeting.",
      objective: "Bulk exfiltration of in-transit files, leak-site extortion.",
      vector: "Unauthenticated RCE, no patch available at first contact (true 0-day).",
      ttps: "",
      environment:
        "Service in DMZ, behind WAF (vendor signatures only). EDR present but not behavior-based for this service. TLS inspection off for performance.",
      impact: "Mass disclosure of regulated documents. Customer notification within 72h (GDPR).",
      detection_gaps:
        "WAF lags 0-day. No outbound egress allow-list from DMZ. Webshell behavior not modeled.",
    },
    ttps: ["T1190", "T1059.001", "T1071.001", "T1090", "T1018", "T1041"],
  },
];

// ============================================================================
// Decomposer — heuristic that turns free text into structured fields
// ============================================================================

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function firstMatch(text: string, regex: RegExp): string | null {
  const m = text.match(regex);
  return m ? m[0] : null;
}

function detectActor(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  if (/\b(insider|employee|contractor|resigning|departing)\b/i.test(text)) {
    return {
      value: "Insider — current/departing employee with privileged access",
      confidence: "high",
    };
  }
  if (
    /\b(apt|nation[- ]state|state[- ]sponsored|volt[- ]?typhoon|fancy bear|equation)\b/i.test(text)
  ) {
    return {
      value: "Nation-state aligned APT (likely strategic, long dwell)",
      confidence: "medium",
    };
  }
  if (/\b(ransomware|lockbit|cl0p|black ?cat|alphv|conti)\b/i.test(text)) {
    return { value: "Financially motivated ransomware affiliate", confidence: "high" };
  }
  if (/\b(supply chain|npm|typosquat|malicious package)\b/i.test(text)) {
    return { value: "Supply-chain actor (opportunistic, downstream impact)", confidence: "medium" };
  }
  if (/\b(phish|bec|business email)\b/i.test(text)) {
    return {
      value: "Financially motivated cybercrime, credential / wire fraud focus",
      confidence: "medium",
    };
  }
  if (/\b(attacker|adversary|threat actor)\b/i.test(text)) {
    return { value: "External attacker (attribution unknown at this stage)", confidence: "low" };
  }
  return null;
}

function detectAsset(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  const m = firstMatch(
    text,
    /\b(production [\w\- ]{2,30}|customer (?:pii|data|database)|data lake|data warehouse|file servers?|domain controllers?|m365 tenant|aws (?:account|environment)|kubernetes cluster|ci\/cd pipeline|edge appliance|vpn appliance)\b/i,
  );
  if (m) return { value: m.trim(), confidence: "medium" };
  return null;
}

function detectVector(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  if (/\bphish/i.test(text)) return { value: "Spear-phishing (email-borne)", confidence: "high" };
  if (/\b(0[- ]?day|zero[- ]?day|cve|rce|unauth(enticated)? rce)\b/i.test(text))
    return {
      value: "Exploit of internet-facing service (0-day / unpatched CVE)",
      confidence: "high",
    };
  if (/\b(rdp|exposed (?:rdp|service)|jump host)\b/i.test(text))
    return { value: "Exposed remote service (RDP / jump host)", confidence: "high" };
  if (/\b(supply chain|malicious (?:package|dependency)|postinstall|npm|pypi)\b/i.test(text))
    return { value: "Software supply-chain compromise (upstream dependency)", confidence: "high" };
  if (/\b(insider|employee|contractor)\b/i.test(text))
    return { value: "Legitimate authenticated access (insider abuse)", confidence: "high" };
  if (/\b(sso|okta|session cookie|token|aitm|evilproxy)\b/i.test(text))
    return { value: "Adversary-in-the-middle / session-token theft on SSO", confidence: "medium" };
  return null;
}

function detectObjective(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  if (/\b(ransomware|encrypt|ransom note|\.lck|double extortion)\b/i.test(text))
    return { value: "Encrypt for impact + exfil for double extortion", confidence: "high" };
  if (/\b(exfil|exfiltration|data theft|leak[- ]site)\b/i.test(text))
    return { value: "Bulk data exfiltration for resale or extortion", confidence: "high" };
  if (/\b(ddos|flood|volumetric)\b/i.test(text))
    return { value: "Service disruption (denial of service)", confidence: "high" };
  if (/\b(persistence|pre[- ]position|long dwell|intel|espionage)\b/i.test(text))
    return {
      value: "Persistence + intelligence collection (no immediate impact)",
      confidence: "medium",
    };
  if (/\b(bec|wire fraud|payment fraud|invoice)\b/i.test(text))
    return { value: "Financial fraud (BEC / wire / invoice)", confidence: "high" };
  return null;
}

function detectEnvironment(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  const parts: string[] = [];
  if (/\b(aws|azure|gcp|cloud)\b/i.test(text)) parts.push("Cloud workloads present");
  if (/\b(on[- ]prem|hypervisor|esxi|vmware)\b/i.test(text)) parts.push("On-prem / hypervisor");
  if (/\b(okta|entra|azure ad|active directory|sso)\b/i.test(text))
    parts.push("Identity = SSO + directory");
  if (/\b(edr|crowdstrike|defender|sentinel ?one|carbon black)\b/i.test(text))
    parts.push("EDR present");
  if (/\b(zero ?trust|microsegment|segmentation)\b/i.test(text))
    parts.push("Zero-trust posture stated");
  if (parts.length === 0) return null;
  return { value: parts.join(" · "), confidence: parts.length >= 3 ? "medium" : "low" };
}

function detectImpact(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  const parts: string[] = [];
  if (/\b(pii|personal data|customer data)\b/i.test(text))
    parts.push("Customer PII exposure (regulatory disclosure)");
  if (/\b(downtime|outage|customer[- ]facing)\b/i.test(text)) parts.push("Customer-facing outage");
  if (/\b(ransomware|encrypt)\b/i.test(text)) parts.push("Encryption / business halt");
  if (/\b(reputational|brand|disclosure|sec |8[- ]k)\b/i.test(text))
    parts.push("Reputational + regulatory disclosure");
  if (parts.length === 0) return null;
  return { value: parts.join(" · "), confidence: "low" };
}

function detectDetectionGaps(
  text: string,
): { value: string; confidence: "high" | "medium" | "low" } | null {
  const gaps: string[] = [];
  if (/\b(no edr|edr not|legacy|jump host|appliance)\b/i.test(text))
    gaps.push("EDR coverage gap on edge / legacy systems");
  if (/\b(no dlp|egress|outbound)\b/i.test(text)) gaps.push("Egress / DLP gap");
  if (/\b(backup|shadow|vssadmin)\b/i.test(text)) gaps.push("Backup-deletion telemetry not in SOC");
  if (/\b(session cookie|token replay|aitm)\b/i.test(text))
    gaps.push("Session-token theft not detected");
  if (gaps.length === 0) return null;
  return { value: gaps.join(" · "), confidence: "low" };
}

/** Match free text to MITRE techniques. */
export function inferTechniques(text: string): Technique[] {
  if (!text || text.trim().length < 10) return [];
  const lower = text.toLowerCase();
  const matched = TECHNIQUES.filter((tech) =>
    tech.keywords.some((k) => lower.includes(k.toLowerCase())),
  );
  // Dedup by tactic order
  return matched;
}

export interface DecomposeResult {
  fields: ScenarioState;
  confidence: ConfidenceState;
  ttps: string[]; // ordered technique IDs
  rationales: { field: FieldKey; reason: string }[];
}

/** Decompose free text into structured fields + TTPs. Pure heuristic — fast. */
export function decompose(text: string, current?: ScenarioState): DecomposeResult {
  const next: ScenarioState = { ...EMPTY_SCENARIO, ...(current ?? {}) };
  const conf: ConfidenceState = {};
  const rationales: { field: FieldKey; reason: string }[] = [];

  const detections: [FieldKey, ReturnType<typeof detectActor>][] = [
    ["actor", detectActor(text)],
    ["asset", detectAsset(text)],
    ["vector", detectVector(text)],
    ["objective", detectObjective(text)],
    ["environment", detectEnvironment(text)],
    ["impact", detectImpact(text)],
    ["detection_gaps", detectDetectionGaps(text)],
  ];

  for (const [key, det] of detections) {
    if (!det) continue;
    if (!next[key] || next[key].trim().length === 0) {
      next[key] = det.value;
      conf[key] = det.confidence;
      rationales.push({
        field: key,
        reason: `Inferred from keywords in your description (${det.confidence} confidence).`,
      });
    }
  }

  const techs = inferTechniques(text);
  const ttps = techs.map((t) => t.id);
  if (ttps.length > 0) {
    next.ttps = techs.map((t) => `${t.id} ${t.name}`).join(", ");
    conf.ttps = ttps.length >= 4 ? "high" : ttps.length >= 2 ? "medium" : "low";
    rationales.push({
      field: "ttps",
      reason: `${ttps.length} ATT&CK technique${ttps.length === 1 ? "" : "s"} matched by keyword. Refine with AI to add inferred chain steps.`,
    });
  }

  return { fields: next, confidence: conf, ttps, rationales };
}

/** Compose structured fields back into the prompt that POST /run expects. */
export function composeScenarioPrompt(state: ScenarioState, ttpIds: string[]): string {
  const lines: string[] = [];
  if (state.asset.trim()) lines.push(`Asset / Target: ${state.asset.trim()}`);
  if (state.actor.trim()) lines.push(`Threat Actor: ${state.actor.trim()}`);
  if (state.objective.trim()) lines.push(`Attack Objective: ${state.objective.trim()}`);
  if (state.vector.trim()) lines.push(`Entry Vector: ${state.vector.trim()}`);
  if (ttpIds.length > 0) {
    const named = ttpIds
      .map((id) => {
        const t = TECHNIQUES.find((x) => x.id === id);
        return t ? `${t.id} (${t.name})` : id;
      })
      .join(", ");
    lines.push(`MITRE ATT&CK TTPs: ${named}`);
  }
  if (state.environment.trim()) lines.push(`Environment: ${state.environment.trim()}`);
  if (state.impact.trim()) lines.push(`Expected Impact: ${state.impact.trim()}`);
  if (state.detection_gaps.trim()) lines.push(`Detection Gaps: ${state.detection_gaps.trim()}`);
  return lines.join("\n");
}

// ============================================================================
// AI-style refinement (mocked, deterministic) with explanations
// ============================================================================

export interface RefinementSuggestion {
  id: string;
  kind: "add-ttp" | "strengthen-field" | "alt-strategy" | "missing-assumption";
  title: string;
  detail: string;
  /** Optional structural change to apply on accept. */
  apply?: {
    field?: FieldKey;
    appendText?: string;
    addTtpId?: string;
  };
  /** Why we suggested this — analyst transparency requirement. */
  rationale: string;
}

/** Generate explainable refinement suggestions (mock — frontend only). */
export function generateRefinements(
  state: ScenarioState,
  ttpIds: string[],
): RefinementSuggestion[] {
  const out: RefinementSuggestion[] = [];
  const has = (id: string) => ttpIds.includes(id);

  // Phishing implies credential dumping / session theft downstream
  if (
    (has("T1566.001") || has("T1566.002") || /phish/i.test(state.vector + state.objective)) &&
    !has("T1003.001") &&
    !has("T1539")
  ) {
    out.push({
      id: "ttp-creds",
      kind: "add-ttp",
      title: "Add T1539 — Steal Web Session Cookie",
      detail:
        "Phishing initial access in 2024+ campaigns is dominated by AiTM toolkits that capture session cookies, bypassing MFA. Adding this strengthens the chain's realism.",
      apply: { addTtpId: "T1539" },
      rationale:
        "Initial access via phishing implies likely credential or session-token capture; explicit chain step prevents the engine from treating MFA as a hard stop.",
    });
  }

  // RDP / jump host implies LSASS dump
  if ((/rdp|jump host|exposed/i.test(state.vector) || has("T1133")) && !has("T1003.001")) {
    out.push({
      id: "ttp-lsass",
      kind: "add-ttp",
      title: "Add T1003.001 — LSASS Memory Dump",
      detail:
        "Hands-on-keyboard intrusions via RDP/jump hosts almost always proceed to credential dumping for lateral movement. Without it, the chain skips the most reliable detection point.",
      apply: { addTtpId: "T1003.001" },
      rationale:
        "Hands-on-keyboard intrusion implies credential reuse opportunity. Adding LSASS dump matches observed adversary behavior in this class.",
    });
  }

  // Ransomware implies recovery sabotage
  if (has("T1486") && !has("T1490")) {
    out.push({
      id: "ttp-inhibit",
      kind: "add-ttp",
      title: "Add T1490 — Inhibit System Recovery",
      detail:
        "Modern ransomware crews delete shadow copies and target backup consoles before encryption. Excluding this understates recovery cost.",
      apply: { addTtpId: "T1490" },
      rationale:
        "Encryption without recovery sabotage is unrealistic — affiliates routinely target backups first.",
    });
  }

  // Supply chain implies C2 + exfil
  if (has("T1195.002") && !has("T1041")) {
    out.push({
      id: "ttp-exfil",
      kind: "add-ttp",
      title: "Add T1041 — Exfiltration over C2",
      detail:
        "Postinstall scripts that beacon out almost always exfil environment variables / secrets in the same channel.",
      apply: { addTtpId: "T1041" },
      rationale:
        "Establishing C2 from a build runner without exfil is implausible — the chain should reflect both.",
    });
  }

  // Missing detection-gap field
  if (!state.detection_gaps.trim()) {
    out.push({
      id: "field-gaps",
      kind: "missing-assumption",
      title: "Detection Gaps not specified",
      detail:
        "The engine cannot weight defensive blind spots without explicit gap statements. Even one line ('no EDR on jump hosts') materially changes recommended strategies.",
      apply: {
        field: "detection_gaps",
        appendText: "EDR coverage gap on edge / legacy systems; egress not baselined per workload.",
      },
      rationale:
        "Without stated gaps, the engine assumes uniform detection coverage and downweights containment options.",
    });
  }

  // Alt strategy — destructive backup
  if (has("T1486") || /ransomware|encrypt/i.test(state.objective)) {
    out.push({
      id: "alt-destructive",
      kind: "alt-strategy",
      title: "Consider destructive-only variant (no encryption)",
      detail:
        "Some affiliates skip encryption and pure-wipe + leak. This removes the 'pay to decrypt' option and forces a different decision tree (restore + disclose).",
      rationale:
        "Forces analysts to consider non-monetizable destruction — common pivot when affiliates are sanctioned.",
    });
  }

  // Missing actor attribution
  if (!state.actor.trim()) {
    out.push({
      id: "field-actor",
      kind: "strengthen-field",
      title: "Threat Actor unspecified",
      detail:
        "Even 'unknown — external, financially motivated' is more useful than blank. The engine adjusts dwell-time priors based on actor class.",
      apply: {
        field: "actor",
        appendText:
          "External attacker, attribution unknown — financially motivated based on observed indicators.",
      },
      rationale:
        "Actor class drives dwell-time and persistence priors; omitting it widens the engine's uncertainty band.",
    });
  }

  return out;
}

// ============================================================================
// Adversarial preview — turn TTPs into a kill-chain narrative
// ============================================================================

export interface KillChainStep {
  order: number;
  technique: Technique;
  detection: string;
  /** Whether the env stated has detection coverage for this step (heuristic). */
  detected: "likely" | "partial" | "blind";
  /** Estimated dwell hours for this step (heuristic). */
  dwellHours: number;
}

function detectionStatus(state: ScenarioState, tech: Technique): KillChainStep["detected"] {
  const env = state.environment.toLowerCase();
  const gaps = state.detection_gaps.toLowerCase();
  const hasEdr = /edr|crowdstrike|defender|sentinel|carbon/i.test(env);
  const hasDlp = /dlp|casb/i.test(env);
  const blindEdr = /no edr|edr.*gap|legacy|jump host/i.test(gaps);
  const blindEgress = /no dlp|egress|outbound/i.test(gaps);

  if (
    tech.tactic === "credential-access" ||
    tech.tactic === "execution" ||
    tech.tactic === "lateral-movement"
  ) {
    if (blindEdr) return "blind";
    return hasEdr ? "likely" : "partial";
  }
  if (tech.tactic === "exfiltration" || tech.tactic === "command-and-control") {
    if (blindEgress) return "blind";
    return hasDlp ? "likely" : "partial";
  }
  if (tech.tactic === "impact") return hasEdr ? "likely" : "partial";
  return "partial";
}

const DWELL_BY_TACTIC: Record<TacticId, number> = {
  reconnaissance: 24,
  "resource-development": 12,
  "initial-access": 1,
  execution: 0.5,
  persistence: 1,
  "privilege-escalation": 4,
  "defense-evasion": 0.5,
  "credential-access": 2,
  discovery: 8,
  "lateral-movement": 12,
  collection: 6,
  "command-and-control": 0.5,
  exfiltration: 4,
  impact: 0.5,
};

export interface KillChainSummary {
  steps: KillChainStep[];
  totalDwellHours: number;
  detectionPoints: number;
  blindSpots: number;
  escalationPath: string[];
}

export function buildKillChain(state: ScenarioState, ttpIds: string[]): KillChainSummary {
  const ordered = ttpIds
    .map((id) => TECHNIQUES.find((t) => t.id === id))
    .filter((t): t is Technique => Boolean(t))
    .sort((a, b) => {
      const ta = TECHNIQUES.find((x) => x.id === a.id)!;
      const tb = TECHNIQUES.find((x) => x.id === b.id)!;
      return tacticOrder(ta.tactic) - tacticOrder(tb.tactic);
    });

  const steps: KillChainStep[] = ordered.map((tech, i) => ({
    order: i + 1,
    technique: tech,
    detection: tech.detection,
    detected: detectionStatus(state, tech),
    dwellHours: DWELL_BY_TACTIC[tech.tactic] ?? 1,
  }));

  const totalDwellHours = steps.reduce((sum, s) => sum + s.dwellHours, 0);
  const detectionPoints = steps.filter((s) => s.detected !== "blind").length;
  const blindSpots = steps.filter((s) => s.detected === "blind").length;

  const escalationPath = Array.from(new Set(steps.map((s) => s.technique.tactic))).map((t) => {
    const tac = tacticById(t);
    return tac.shortLabel;
  });

  return { steps, totalDwellHours, detectionPoints, blindSpots, escalationPath };
}

function tacticOrder(t: TacticId): number {
  return tacticById(t).order;
}

// ============================================================================
// Export helpers (MITRE-mapped JSON / YAML / executive summary)
// ============================================================================

export function toMitreJson(state: ScenarioState, ttpIds: string[]) {
  return {
    schema: "causalops.scenario/v1",
    asset: state.asset,
    actor: state.actor,
    objective: state.objective,
    entry_vector: state.vector,
    environment: state.environment,
    expected_impact: state.impact,
    detection_gaps: state.detection_gaps,
    mitre_attack: ttpIds.map((id) => {
      const t = TECHNIQUES.find((x) => x.id === id);
      return t ? { technique_id: t.id, name: t.name, tactic: t.tactic } : { technique_id: id };
    }),
  };
}

export function toYaml(state: ScenarioState, ttpIds: string[]): string {
  const lines: string[] = [];
  lines.push("schema: causalops.scenario/v1");
  lines.push(`asset: ${JSON.stringify(state.asset)}`);
  lines.push(`actor: ${JSON.stringify(state.actor)}`);
  lines.push(`objective: ${JSON.stringify(state.objective)}`);
  lines.push(`entry_vector: ${JSON.stringify(state.vector)}`);
  lines.push(`environment: ${JSON.stringify(state.environment)}`);
  lines.push(`expected_impact: ${JSON.stringify(state.impact)}`);
  lines.push(`detection_gaps: ${JSON.stringify(state.detection_gaps)}`);
  lines.push("mitre_attack:");
  for (const id of ttpIds) {
    const t = TECHNIQUES.find((x) => x.id === id);
    if (!t) continue;
    lines.push(`  - id: ${t.id}`);
    lines.push(`    name: ${JSON.stringify(t.name)}`);
    lines.push(`    tactic: ${t.tactic}`);
  }
  return lines.join("\n");
}

export function toExecutiveSummary(
  state: ScenarioState,
  ttpIds: string[],
  chain: KillChainSummary,
): string {
  const dwell = chain.totalDwellHours.toFixed(1);
  const lines = [
    `THREAT SCENARIO — ${state.asset || "[asset]"}`,
    "",
    `Actor: ${state.actor || "Unknown / external"}`,
    `Objective: ${state.objective || "Not specified"}`,
    `Entry: ${state.vector || "Not specified"}`,
    "",
    `Estimated dwell time before impact: ~${dwell}h`,
    `Detection points along chain: ${chain.detectionPoints} of ${chain.steps.length} steps`,
    `Blind spots: ${chain.blindSpots}`,
    "",
    `Kill chain (${ttpIds.length} ATT&CK techniques):`,
    ...chain.steps.map(
      (s) =>
        `  ${String(s.order).padStart(2, "0")}. ${s.technique.id} ${s.technique.name}  [${s.detected.toUpperCase()}]`,
    ),
    "",
    `Expected impact: ${state.impact || "Not specified"}`,
    `Known detection gaps: ${state.detection_gaps || "Not specified"}`,
  ];
  return lines.join("\n");
}
