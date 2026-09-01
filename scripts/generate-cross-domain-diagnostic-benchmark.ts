#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  BENCHMARK_MANIFEST_VERSION,
  createFileBenchmarkArtifactReader,
  hashBenchmarkBytes,
  sealBenchmarkManifest,
  verifyBenchmarkCorpus,
  type BenchmarkArtifactRole,
  type BenchmarkCorpusManifest,
  type BenchmarkManifestDraft,
} from "../src/benchmark.js";
import { parseSealedBenchmarkValidatorV1 } from "../src/benchmark-validator.js";
import { CODEX_APP_SERVER_VERSION } from "../src/core/contracts.js";

const SEALED_AT = "2026-08-30T00:00:00.000Z";
const SOURCE_REVISION = "generated diagnostic";
const DEFAULT_ROOT = "/tmp/agent-trio-cross-domain-diagnostic-v1";

interface WorkspaceFile {
  path: string;
  contentUtf8: string;
}

interface Criterion {
  id: string;
  label: string;
  all?: readonly string[];
  any?: readonly string[];
  none?: readonly string[];
  regex?: readonly string[];
  noneRegex?: readonly string[];
}

interface InstanceDefinition {
  familyId:
    "algorithm-exact" | "research-frozen" | "paper-edit" | "office-document" | "auto-dossier";
  instanceId: string;
  seed: string;
  access: "readOnly" | "workspaceWrite";
  citationPolicy: "none" | "frozen-required";
  prompt: string;
  files: readonly WorkspaceFile[];
  criteria: readonly Criterion[];
}

export interface CrossDomainDiagnosticArtifact {
  path: string;
  bytes: Uint8Array;
}

export interface CrossDomainDiagnosticCorpus {
  manifest: BenchmarkCorpusManifest;
  artifacts: readonly CrossDomainDiagnosticArtifact[];
}

export interface GeneratedCrossDomainDiagnosticCorpus extends CrossDomainDiagnosticCorpus {
  rootDirectory: string;
  manifestPath: string;
}

const VALIDATOR_SOURCE = [
  "const { readFileSync } = require('node:fs');",
  "const text = readFileSync('.agent-trio-benchmark/model-output.txt', 'utf8')",
  "  .toLowerCase().replace(/[`*_]/gu, '').replace(/\\s+/gu, ' ').trim();",
  "const rule = JSON.parse(process.argv[1]);",
  "const all = (rule.all ?? []).every((value) => text.includes(value.toLowerCase()));",
  "const any = !rule.any || rule.any.some((value) => text.includes(value.toLowerCase()));",
  "const none = (rule.none ?? []).every((value) => !text.includes(value.toLowerCase()));",
  "const regex = (rule.regex ?? []).every((value) => new RegExp(value, 'iu').test(text));",
  "const noneRegex = (rule.noneRegex ?? []).every((value) => !new RegExp(value, 'iu').test(text));",
  "process.exit(all && any && none && regex && noneRegex ? 0 : 1);",
].join("\n");

const DEFINITIONS: readonly InstanceDefinition[] = [
  {
    familyId: "algorithm-exact",
    instanceId: "algorithm-exact-routes-01",
    seed: "five-weighted-route-cases",
    access: "readOnly",
    citationPolicy: "none",
    prompt: [
      "Solve all five weighted-route cases under cases/.",
      "For each case, report the exact minimum total cost and the complete path from start to goal.",
      "Edges are undirected. If minimum-cost paths tie, choose the lexicographically smallest complete node sequence.",
      "Show enough intermediate distance reasoning to make each answer auditable. Do not modify files.",
      "",
    ].join("\n"),
    files: [
      file("cases/a.txt", "start=A goal=D\nA B 4\nA C 1\nC B 2\nB D 1\nC D 7\n"),
      file("cases/b.txt", "start=S goal=T\nS A 2\nS B 2\nA T 3\nB T 3\n"),
      file("cases/c.txt", "start=P goal=Z\nP Q 6\nP R 2\nR Q 1\nQ Z 2\nR Z 8\n"),
      file("cases/d.txt", "start=H goal=L\nH I 5\nH J 3\nJ K 2\nK L 2\nI L 1\nJ L 9\n"),
      file("cases/e.txt", "start=U goal=X\nU V 1\nV W 1\nU W 5\nW X 2\nV X 6\n"),
    ],
    criteria: [
      criterion("route-a", "Case A path and cost", [], undefined, undefined, [
        routePathPattern("a", "c", "b", "d"),
        routeCostPattern(4),
      ]),
      criterion("route-b", "Case B lexicographic tie break", [], undefined, undefined, [
        routePathPattern("s", "a", "t"),
        routeCostPattern(5),
      ]),
      criterion("route-c", "Case C path and cost", [], undefined, undefined, [
        routePathPattern("p", "r", "q", "z"),
        routeCostPattern(5),
      ]),
      criterion("route-d", "Case D path and cost", [], undefined, undefined, [
        routePathPattern("h", "i", "l"),
        routeCostPattern(6),
      ]),
      criterion("route-e", "Case E path and cost", [], undefined, undefined, [
        routePathPattern("u", "v", "w", "x"),
        routeCostPattern(4),
      ]),
    ],
  },
  {
    familyId: "algorithm-exact",
    instanceId: "algorithm-exact-reconciliation-02",
    seed: "five-exact-subset-cases",
    access: "readOnly",
    citationPolicy: "none",
    prompt: [
      "Reconcile every account file under accounts/ by selecting invoice IDs whose amounts sum exactly to target.",
      "Use each invoice at most once. When more than one exact subset exists, choose the lexicographically smallest sorted ID sequence.",
      "For each account, report the chosen IDs, their arithmetic sum, and whether any alternate exact subset was rejected by the tie rule.",
      "Do not modify files.",
      "",
    ].join("\n"),
    files: [
      file("accounts/a.txt", "target=19\nA=8\nB=11\nC=7\nD=5\n"),
      file("accounts/b.txt", "target=23\nA=4\nB=9\nC=14\nD=18\n"),
      file("accounts/c.txt", "target=30\nA=12\nB=7\nC=11\nD=18\nE=19\n"),
      file("accounts/d.txt", "target=17\nA=3\nB=5\nC=6\nD=8\nE=9\n"),
      file("accounts/e.txt", "target=41\nA=10\nB=13\nC=17\nD=21\nE=28\n"),
    ],
    criteria: [
      criterion("account-a", "Account A exact subset", [], undefined, undefined, [
        accountLabelPattern("a"),
        idListPattern("a", "b"),
        "8\\s*\\+\\s*11\\s*=\\s*19",
      ]),
      criterion("account-b", "Account B exact subset", [], undefined, undefined, [
        accountLabelPattern("b"),
        idListPattern("b", "c"),
        "9\\s*\\+\\s*14\\s*=\\s*23",
      ]),
      criterion("account-c", "Account C tie resolution", [], undefined, undefined, [
        accountLabelPattern("c"),
        idListPattern("a", "b", "c"),
        "12\\s*\\+\\s*7\\s*\\+\\s*11\\s*=\\s*30",
      ]),
      criterion("account-d", "Account D tie resolution", [], undefined, undefined, [
        accountLabelPattern("d"),
        idListPattern("a", "b", "e"),
        "3\\s*\\+\\s*5\\s*\\+\\s*9\\s*=\\s*17",
      ]),
      criterion("account-e", "Account E exact subset", [], undefined, undefined, [
        accountLabelPattern("e"),
        idListPattern("b", "e"),
        "13\\s*\\+\\s*28\\s*=\\s*41",
      ]),
    ],
  },
  {
    familyId: "research-frozen",
    instanceId: "research-frozen-warehouse-01",
    seed: "warehouse-robot-evidence-synthesis",
    access: "readOnly",
    citationPolicy: "frozen-required",
    prompt: [
      "Prepare a decision brief comparing the two warehouse-robot proposals against every mandatory threshold in requirements.txt.",
      "State whether either proposal fully qualifies, enumerate each failure, identify the smaller remediation gap, and recommend a next step.",
      "Cite every numeric or factual claim using the exact frozen source ID in square brackets. Use only the supplied sources.",
      "Do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "sources/requirements.txt",
        "[REQ-WR-17]\nMandatory: throughput >= 110 picks/hour; uptime >= 99.5%; onboarding <= 5 weeks; price <= $450,000; energy <= 16 kWh/shift.\n",
      ),
      file(
        "sources/northstar.txt",
        "[NS-2026-Q2]\nNorthstar: 120 picks/hour; 99.2% uptime; 6-week onboarding; $480,000; 18 kWh/shift.\n",
      ),
      file(
        "sources/keystone.txt",
        "[KS-2026-Q2]\nKeystone: 108 picks/hour; 99.7% uptime; 4-week onboarding; $420,000; 14 kWh/shift.\n",
      ),
    ],
    criteria: [
      criterion(
        "qualification",
        "Neither proposal fully qualifies",
        ["qualif", "[req-wr-17]"],
        [
          "neither",
          "does not fully qualify",
          "do not fully qualify",
          "no proposal fully qualifies",
        ],
      ),
      criterion("northstar-uptime", "Northstar uptime failure", ["99.2%", "99.5%", "[ns-2026-q2]"]),
      criterion("northstar-other", "Northstar onboarding, price, and energy failures", [
        "6",
        "$480,000",
        "18",
        "[ns-2026-q2]",
      ]),
      criterion("keystone-gap", "Keystone two-pick throughput gap", [
        "108",
        "110",
        "2 pick",
        "[ks-2026-q2]",
      ]),
      criterion(
        "keystone-passes",
        "Keystone passes four other thresholds",
        ["99.7%", "$420,000", "14 kwh", "[ks-2026-q2]"],
        undefined,
        undefined,
        ["4(?:-|\\s+)weeks?"],
      ),
      criterion(
        "recommendation",
        "Conditional Keystone remediation recommendation",
        ["keystone"],
        ["pilot", "remediat", "validate"],
      ),
    ],
  },
  {
    familyId: "research-frozen",
    instanceId: "research-frozen-trials-02",
    seed: "trial-evidence-screening",
    access: "readOnly",
    citationPolicy: "frozen-required",
    prompt: [
      "Screen the three frozen trial summaries against the comparative-evidence protocol.",
      "The protocol requires randomization, serious-adverse-event rate no greater than 7%, and follow-up of at least 12 months.",
      "Report eligibility, compare response and safety without claiming significance, explain the main limitation of the highest response result, and recommend the best-supported candidate.",
      "Cite every factual claim with the exact frozen source ID. Use only supplied sources and do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "sources/protocol.txt",
        "[PROTO-CE-4]\nEligibility: randomized; serious adverse events <= 7%; follow-up >= 12 months.\n",
      ),
      file(
        "sources/alpha.txt",
        "[TRIAL-ALPHA]\nRandomized; n=240; response=62%; serious adverse events=8%; follow-up=12 months.\n",
      ),
      file(
        "sources/beta.txt",
        "[TRIAL-BETA]\nRandomized; n=310; response=58%; serious adverse events=5%; follow-up=18 months.\n",
      ),
      file(
        "sources/gamma.txt",
        "[TRIAL-GAMMA]\nSingle-arm; n=90; response=68%; serious adverse events=12%; follow-up=6 months.\n",
      ),
    ],
    criteria: [
      criterion("beta-eligible", "Beta alone meets the protocol", [
        "beta",
        "only",
        "eligible",
        "[trial-beta]",
      ]),
      criterion("alpha-safety", "Alpha fails the safety limit", [
        "alpha",
        "8%",
        "7%",
        "[trial-alpha]",
      ]),
      criterion("gamma-design", "Gamma is not randomized", [
        "gamma",
        "single-arm",
        "[trial-gamma]",
      ]),
      criterion("gamma-other-failures", "Gamma also fails safety and follow-up", [
        "12%",
        "6 months",
        "[trial-gamma]",
      ]),
      criterion("response-comparison", "Response rates are accurately compared", [
        "62%",
        "58%",
        "68%",
      ]),
      criterion(
        "no-significance",
        "No unsupported statistical-significance claim",
        [],
        undefined,
        undefined,
        undefined,
        [
          "(?:is|are|was|were|proved|demonstrated|showed|shows|established) statistically significant",
          "significantly (?:better|higher|lower|superior|outperform)",
        ],
      ),
    ],
  },
  {
    familyId: "paper-edit",
    instanceId: "paper-edit-survey-01",
    seed: "causal-overclaim-revision",
    access: "readOnly",
    citationPolicy: "none",
    prompt: [
      "Rewrite draft.md as one publication-ready abstract of 110 to 150 words.",
      "Preserve all reported measurements, replace causal overclaims with evidence-calibrated language, and state the design limitations that constrain interpretation.",
      "Return only the revised abstract. Do not invent analyses, citations, or results, and do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "draft.md",
        "Remote work causes employees to become more productive. We surveyed 84 software employees recruited through a convenience sample. Respondents reported a mean 7% productivity increase after moving off-site. The response rate was 42%. We had no control group and measured productivity by self-report. These obviously decisive results prove that every company should mandate remote work.\n",
      ),
    ],
    criteria: [
      criterion("sample", "Preserves sample size", ["84"]),
      criterion(
        "effect",
        "Preserves self-reported effect",
        ["7%"],
        ["self-report", "self-reported", "perception", "not objectively"],
      ),
      criterion("response", "Preserves response rate", ["42%", "response rate"]),
      criterion("sampling-limit", "States convenience-sample limitation", ["convenience sample"]),
      criterion(
        "causal-limit",
        "States control-group or causal limitation",
        [],
        [
          "no control group",
          "absence of a control group",
          "without a control group",
          "causal inference",
          "causality",
          "cannot be attributed",
        ],
      ),
      criterion(
        "calibrated",
        "Removes causal and rhetorical overclaims",
        [],
        ["associated", "reported", "observed"],
        ["prove", "causes", "obviously", "every company should"],
      ),
    ],
  },
  {
    familyId: "paper-edit",
    instanceId: "paper-edit-model-02",
    seed: "benchmark-overclaim-revision",
    access: "readOnly",
    citationPolicy: "none",
    prompt: [
      "Rewrite draft.md into a precise 100-to-140-word results paragraph suitable for peer review.",
      "Retain every numeric result, characterize the comparison proportionately, and make the uncertainty and external-validity limits explicit.",
      "Return only the revised paragraph. Do not add citations, tests, or results, and do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "draft.md",
        "Our revolutionary classifier beats all prior systems. Across 3 random seeds on a private internal corpus of 1,200 documents, it reached macro-F1 0.781 (SD 0.012), compared with 0.774 (SD 0.009) for the baseline. We did not run a significance test. This conclusive victory will generalize to any document collection.\n",
      ),
    ],
    criteria: [
      criterion(
        "evaluation-size",
        "Preserves seed and corpus counts",
        ["1,200"],
        ["3 random seeds", "three random seeds", "3 seeds", "three seeds"],
      ),
      criterion("candidate-score", "Preserves candidate score and dispersion", ["0.781", "0.012"]),
      criterion("baseline-score", "Preserves baseline score and dispersion", ["0.774", "0.009"]),
      criterion(
        "difference",
        "Characterizes the 0.007 difference proportionately",
        [],
        ["0.007", "modest", "small"],
      ),
      criterion(
        "significance-limit",
        "States absence of significance testing",
        ["significance"],
        ["not", "no"],
      ),
      criterion(
        "validity-limit",
        "States private-corpus generalizability limit",
        ["private"],
        ["generali", "external validity", "other document", "this dataset", "single private"],
        ["beats all", "conclusive", "any document"],
      ),
    ],
  },
  {
    familyId: "office-document",
    instanceId: "office-document-launch-01",
    seed: "launch-decision-memo",
    access: "readOnly",
    citationPolicy: "none",
    prompt: [
      "Turn the supplied meeting records into a concise executive action memo.",
      "Separate confirmed decisions, unresolved risks, and owner-tagged actions with exact deadlines. Reconcile the budget figures and flag the remaining amount.",
      "Do not invent owners or dates. Return the memo in Markdown and do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "records/decisions.txt",
        "Meeting date: 2026-09-03\nDecision: launch remains 2026-10-15.\nDecision: phase one is limited to EU web customers.\nDecision: mobile rollout is deferred.\n",
      ),
      file(
        "records/actions.txt",
        "Mina: finish privacy review by 2026-09-12.\nOwen: deliver rollback runbook by 2026-09-18.\nRavi: confirm localization coverage by 2026-09-10.\nUnowned risk: tax-copy approval is still pending.\n",
      ),
      file(
        "records/budget.txt",
        "Approved launch budget: $180,000.\nCommitted localization: $72,000.\nCommitted infrastructure: $46,000.\nContingency is not yet committed.\n",
      ),
    ],
    criteria: [
      criterion("launch-scope", "Captures launch date and EU web scope", ["2026-10-15", "eu web"]),
      criterion("mobile", "Captures deferred mobile rollout", ["mobile", "defer"]),
      criterion("mina", "Captures Mina action and deadline", [
        "mina",
        "privacy review",
        "2026-09-12",
      ]),
      criterion("owen", "Captures Owen action and deadline", [
        "owen",
        "rollback runbook",
        "2026-09-18",
      ]),
      criterion("ravi", "Captures Ravi action and deadline", [
        "ravi",
        "localization",
        "2026-09-10",
      ]),
      criterion("budget", "Computes remaining budget and flags tax-copy risk", [
        "$62,000",
        "tax-copy",
        "pending",
      ]),
    ],
  },
  {
    familyId: "office-document",
    instanceId: "office-document-incident-02",
    seed: "incident-handoff-brief",
    access: "readOnly",
    citationPolicy: "none",
    prompt: [
      "Create an operations handoff brief from the incident files.",
      "Include a UTC timeline, customer impact, current status, quantified recovery evidence, and every assigned next action with owner and due time.",
      "Distinguish confirmed cause from remaining uncertainty. Return Markdown only and do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "incident/timeline.txt",
        "2026-08-29 09:12 UTC: checkout error alerts fired.\n09:19 UTC: traffic shifted away from cluster c3.\n09:31 UTC: error rate returned below 0.5%.\n10:05 UTC: monitoring window remained stable.\n",
      ),
      file(
        "incident/impact.txt",
        "From 09:08 to 09:31 UTC, 14.2% of checkout attempts failed. 3,840 attempts were affected. No completed orders were lost.\n",
      ),
      file(
        "incident/cause.txt",
        "Confirmed: c3 connection pool exhausted after a configuration rollout. Unknown: why the pre-deploy load test did not reproduce exhaustion.\n",
      ),
      file(
        "incident/actions.txt",
        "Inez: revert the pool configuration by 2026-08-29 12:00 UTC.\nChen: reproduce the load pattern by 2026-08-30 16:00 UTC.\nSal: draft customer follow-up by 2026-08-29 14:00 UTC.\n",
      ),
    ],
    criteria: [
      criterion("impact", "Quantifies impact window and failures", [
        "09:08",
        "09:31",
        "14.2%",
        "3,840",
      ]),
      criterion("recovery", "Reports traffic shift and recovered error rate", [
        "09:19",
        "cluster c3",
        "below 0.5%",
      ]),
      criterion("cause", "Separates confirmed pool exhaustion from load-test uncertainty", [
        "connection pool",
        "confirmed",
        "load test",
        "unknown",
      ]),
      criterion("inez", "Captures Inez action", ["inez", "revert", "2026-08-29 12:00"]),
      criterion("chen", "Captures Chen action", ["chen", "reproduce", "2026-08-30 16:00"]),
      criterion("sal", "Captures Sal action", ["sal", "customer follow-up", "2026-08-29 14:00"]),
    ],
  },
  {
    familyId: "auto-dossier",
    instanceId: "auto-dossier-vendor-01",
    seed: "vendor-discrepancy-dossier",
    access: "readOnly",
    citationPolicy: "frozen-required",
    prompt: [
      "Produce a procurement risk dossier for Atlas Cloud using only the frozen files.",
      "Reconcile contradictions across the proposal, security questionnaire, finance note, and legal note. Classify each material issue as blocker, remediation, or accepted fact, and recommend go/no-go conditions.",
      "Cite every factual claim with its exact source ID. Do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "evidence/proposal.txt",
        "[ATLAS-PROP-7]\nPrice: $96,000 annually. Claimed 24/7 support. Claimed all customer data remains in the EU. Target start: 2026-10-01.\n",
      ),
      file(
        "evidence/security.txt",
        "[ATLAS-SEC-4]\nSOC 2 Type II report expired 2026-06-30. Backups are stored in the US for up to 35 days. Critical patches target 15 calendar days.\n",
      ),
      file(
        "evidence/finance.txt",
        "[FIN-ATLAS-2]\nApproved annual ceiling: $100,000. Migration services add a one-time $18,000 charge not included in the annual quote.\n",
      ),
      file(
        "evidence/legal.txt",
        "[LEGAL-ATLAS-9]\nDraft SLA provides business-hours support only. Required terms: EU-only storage, 24/7 P1 support, and critical patches within 7 days.\n",
      ),
    ],
    criteria: [
      criterion("support-conflict", "Finds 24/7 versus business-hours conflict", [
        "24/7",
        "business-hours",
        "[atlas-prop-7]",
        "[legal-atlas-9]",
      ]),
      criterion("residency-conflict", "Finds EU claim versus US backups", [
        "eu",
        "us",
        "35 days",
        "[atlas-sec-4]",
      ]),
      criterion("patch-gap", "Finds 15-day versus 7-day patch gap", [
        "15",
        "7",
        "patch",
        "[atlas-sec-4]",
      ]),
      criterion("assurance-expiry", "Flags expired SOC 2 report", [
        "soc 2",
        "expired",
        "2026-06-30",
        "[atlas-sec-4]",
      ]),
      criterion("budget", "Separates annual price from migration charge", [
        "$96,000",
        "$18,000",
        "$100,000",
        "[fin-atlas-2]",
      ]),
      criterion(
        "recommendation",
        "Makes contract remediation a go-live condition",
        [],
        ["no-go", "conditional", "condition"],
        ["unconditional approval"],
      ),
    ],
  },
  {
    familyId: "auto-dossier",
    instanceId: "auto-dossier-grants-02",
    seed: "grant-eligibility-dossier",
    access: "readOnly",
    citationPolicy: "frozen-required",
    prompt: [
      "Screen all three grant candidates against the frozen program rules and prepare a ranked dossier.",
      "For each candidate, calculate the requested matching contribution where applicable, identify every eligibility failure or evidence gap, then rank only eligible proposals using the program priority order.",
      "Cite each factual claim with the exact source ID. Use no outside facts and do not modify files.",
      "",
    ].join("\n"),
    files: [
      file(
        "program/rules.txt",
        "[GREEN-RULES-2026]\nEligible duration: <= 24 months. Request: <= $500,000. Applicant match: >= 20% of requested amount. Ethics approval required before award for human-subject work. Ranking priorities: verified emissions reduction first, then lower request.\n",
      ),
      file(
        "candidates/aurora.txt",
        "[APP-AURORA]\n18 months; requests $400,000; applicant match $90,000; no human subjects; verified reduction 1,200 tCO2e/year.\n",
      ),
      file(
        "candidates/beacon.txt",
        "[APP-BEACON]\n24 months; requests $450,000; applicant match $80,000; human-subject interviews; ethics approval pending; verified reduction 1,500 tCO2e/year.\n",
      ),
      file(
        "candidates/cascade.txt",
        "[APP-CASCADE]\n30 months; requests $320,000; applicant match $80,000; no human subjects; verified reduction 900 tCO2e/year.\n",
      ),
    ],
    criteria: [
      criterion("aurora-match", "Aurora is eligible and exceeds its match minimum", [
        "aurora",
        "$80,000",
        "$90,000",
        "eligible",
        "[app-aurora]",
      ]),
      criterion("beacon-match", "Beacon match is below the required amount", [
        "beacon",
        "$90,000",
        "$80,000",
        "[app-beacon]",
      ]),
      criterion("beacon-ethics", "Beacon ethics approval remains pending", [
        "beacon",
        "ethics",
        "pending",
        "[app-beacon]",
      ]),
      criterion(
        "cascade-duration",
        "Cascade fails the duration limit",
        ["cascade", "[app-cascade]"],
        undefined,
        undefined,
        ["30[- ]month", "(?:24|<=\\s*24)[- ]month"],
      ),
      criterion(
        "eligible-ranking",
        "Ranks Aurora as the only eligible proposal",
        ["aurora", "only eligible"],
        ["rank 1", "ranks first", "ranked first", "1. **aurora**"],
      ),
      criterion("emissions", "Accurately preserves all verified reductions", [
        "1,200",
        "1,500",
        "900",
        "tco2e",
      ]),
    ],
  },
] as const;

function file(path: string, contentUtf8: string): WorkspaceFile {
  return { path, contentUtf8 };
}

function accountLabelPattern(account: string): string {
  return (
    "(?:accounts?[/\\\\])?" +
    account +
    "\\.txt\\b|\\|\\s*" +
    account +
    "\\s*\\||(?:account|case)\\s*[-:#|*`]*\\s*" +
    account +
    "\\b"
  );
}

function idListPattern(...ids: readonly string[]): string {
  return ids.join("\\s*(?:\\+|,)\\s*");
}

function routePathPattern(...nodes: readonly string[]): string {
  return nodes.join("\\s*(?:->|→|[-,>])\\s*");
}

function routeCostPattern(cost: number): string {
  return `(?:cost|total|minimum)[^.;]{0,80}(?:=\\s*)?${String(cost)}\\b`;
}

function criterion(
  id: string,
  label: string,
  all: readonly string[] = [],
  any?: readonly string[],
  none?: readonly string[],
  regex?: readonly string[],
  noneRegex?: readonly string[],
): Criterion {
  return {
    id,
    label,
    ...(all.length === 0 ? {} : { all }),
    ...(any === undefined ? {} : { any }),
    ...(none === undefined ? {} : { none }),
    ...(regex === undefined ? {} : { regex }),
    ...(noneRegex === undefined ? {} : { noneRegex }),
  };
}

function validatorFor(criteria: readonly Criterion[]): string {
  const validator = {
    schemaVersion: 1,
    runnerSandboxBoundary: { networkIsolation: "runner-controlled" },
    commandChecks: criteria.map(({ id, all, any, none, regex, noneRegex }) => ({
      id,
      argv: [
        "node",
        "-e",
        VALIDATOR_SOURCE,
        JSON.stringify({
          ...(all === undefined ? {} : { all }),
          ...(any === undefined ? {} : { any }),
          ...(none === undefined ? {} : { none }),
          ...(regex === undefined ? {} : { regex }),
          ...(noneRegex === undefined ? {} : { noneRegex }),
        }),
      ],
      expectedExitCode: 0,
      timeoutMs: 2_000,
    })),
    requiredDeliverables: [],
  };
  parseSealedBenchmarkValidatorV1(validator);
  return `${JSON.stringify(validator, null, 2)}\n`;
}

function rubricFor(criteria: readonly Criterion[]): string {
  return `${JSON.stringify(
    {
      mode: "sealed-v1",
      version: 1,
      maximum: 100,
      criteria: criteria.map(({ id, label }) => ({ id, label, weight: 1 })),
    },
    null,
    2,
  )}\n`;
}

export function createCrossDomainDiagnosticCorpus(): CrossDomainDiagnosticCorpus {
  const generatedArtifacts: CrossDomainDiagnosticArtifact[] = [];
  const instances: BenchmarkManifestDraft["instances"] = [];

  for (const definition of DEFINITIONS) {
    const base = `instances/${definition.familyId}/${definition.instanceId}`;
    const workspace = `${JSON.stringify(
      {
        access: definition.access,
        citationPolicy: definition.citationPolicy,
        decomposition: definition.familyId === "algorithm-exact" ? "independent" : "coupled",
        files: definition.files,
      },
      null,
      2,
    )}\n`;
    const artifactDefinitions: ReadonlyArray<[string, BenchmarkArtifactRole, string]> = [
      ["prompt.txt", "prompt", definition.prompt],
      ["workspace.json", "workspace_snapshot", workspace],
      ["validator.json", "validator", validatorFor(definition.criteria)],
      ["rubric.json", "quality_rubric", rubricFor(definition.criteria)],
    ];
    const seals = artifactDefinitions.map(([name, role, content]) => {
      const bytes = new TextEncoder().encode(content);
      const path = `${base}/${name}`;
      generatedArtifacts.push({ path, bytes });
      return {
        path,
        role,
        sha256: hashBenchmarkBytes(bytes),
        sizeBytes: bytes.byteLength,
      };
    });
    const workspaceSeal = seals.find((artifact) => artifact.role === "workspace_snapshot");
    if (workspaceSeal === undefined) {
      throw new Error(`missing workspace seal for ${definition.instanceId}`);
    }
    instances.push({
      familyId: definition.familyId,
      instanceId: definition.instanceId,
      seed: definition.seed,
      sourceRevision: SOURCE_REVISION,
      evaluationClass: "direct-fast-path",
      initialStateSha256: workspaceSeal.sha256,
      artifacts: seals,
    });
  }

  const manifest = sealBenchmarkManifest({
    schemaVersion: BENCHMARK_MANIFEST_VERSION,
    suiteId: "agent-trio-cross-domain-diagnostic-v1",
    sealedAt: SEALED_AT,
    baseline: {
      model: "gpt-5.6-sol",
      modelRevision: `codex-cli-${CODEX_APP_SERVER_VERSION}`,
      effort: "ultra",
    },
    instances,
  });
  return { manifest, artifacts: generatedArtifacts };
}

export async function generateCrossDomainDiagnosticCorpus(
  rootDirectory = DEFAULT_ROOT,
): Promise<GeneratedCrossDomainDiagnosticCorpus> {
  const root = resolve(rootDirectory);
  const corpus = createCrossDomainDiagnosticCorpus();
  for (const artifact of corpus.artifacts) {
    const target = resolve(root, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.bytes);
  }
  const manifestPath = resolve(root, "manifest.json");
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(corpus.manifest, null, 2)}\n`, "utf8");
  await verifyBenchmarkCorpus(corpus.manifest, createFileBenchmarkArtifactReader(root));
  return { ...corpus, rootDirectory: root, manifestPath };
}

const entryPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  const result = await generateCrossDomainDiagnosticCorpus(process.argv[2] ?? DEFAULT_ROOT);
  process.stdout.write(
    `generated ${String(result.manifest.instances.length)} sealed pairs at ${result.manifestPath}\n`,
  );
}
