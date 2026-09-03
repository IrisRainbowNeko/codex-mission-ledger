#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_MANIFEST_VERSION,
  createFileBenchmarkArtifactReader,
  economicEligibilityFromCalibration,
  hashBenchmarkBytes,
  loadBenchmarkCalibrationTable,
  sealBenchmarkManifest,
  verifyBenchmarkCorpus,
  type BenchmarkArtifactRole,
  type BenchmarkCorpusManifest,
  type LoadedBenchmarkCalibration,
  type BenchmarkManifestDraft,
} from "../src/benchmark.js";
import { parseSealedBenchmarkValidatorV1 } from "../src/benchmark-validator.js";
import { CODEX_APP_SERVER_VERSION } from "../src/core/contracts.js";

const DEFAULT_ROOT = "/tmp/agent-trio-economic-cross-domain-v3";
const SEALED_AT = "2026-08-31T00:00:00.000Z";

type FamilyId =
  "algorithm-exact" | "research-frozen" | "paper-revision" | "office-document" | "auto-dossier";

interface WorkspaceFile {
  path: string;
  contentUtf8: string;
}

interface Criterion {
  id: string;
  label: string;
  anchor: string;
  all?: readonly string[];
  allAny?: ReadonlyArray<readonly string[]>;
  any?: readonly string[];
  none?: readonly string[];
  noneUnlessNegated?: readonly string[];
  regex?: readonly string[];
  noneRegex?: readonly string[];
  minWords?: number;
  maxWords?: number;
}

interface IndependentUnit {
  id: string;
  instruction: string;
  files: readonly WorkspaceFile[];
  criteria: readonly Criterion[];
}

interface InstanceDefinition {
  familyId: FamilyId;
  instanceId: string;
  seed: string;
  title: string;
  citationPolicy: "none" | "frozen-required";
  units: readonly IndependentUnit[];
}

export interface EconomicCrossDomainCorpus {
  manifest: BenchmarkCorpusManifest;
  artifacts: Array<{ path: string; bytes: Uint8Array }>;
}

const VALIDATOR_SOURCE = [
  "const { readFileSync } = require('node:fs');",
  "const normalize = (value) => value.toLowerCase().replace(/[`*_]/gu, '').replace(/(?<=\\d),(?=\\d{3}\\b)/gu, '').replace(/\\s+/gu, ' ').trim();",
  "const raw = normalize(readFileSync('.agent-trio-benchmark/model-output.txt', 'utf8'));",
  "const rule = JSON.parse(process.argv[1]);",
  "const anchor = normalize(rule.anchor);",
  "const start = raw.indexOf(anchor);",
  "if (start < 0) process.exit(1);",
  "const searchFrom = start + anchor.length;",
  "const itemEnd = raw.indexOf('[item:', searchFrom);",
  "const unitEnd = raw.indexOf('[unit:', searchFrom);",
  "const ends = [itemEnd, unitEnd].filter((value) => value >= 0);",
  "const end = ends.length === 0 ? raw.length : Math.min(...ends);",
  "const text = raw.slice(start, end);",
  "const includes = (value) => text.includes(normalize(value));",
  "const all = (rule.all ?? []).every(includes);",
  "const allAny = (rule.allAny ?? []).every((group) => group.some(includes));",
  "const any = !rule.any || rule.any.some(includes);",
  "const none = (rule.none ?? []).every((value) => !includes(value));",
  "const negated = (value) => {",
  "  const needle = normalize(value); let from = 0;",
  "  while (true) {",
  "    const index = text.indexOf(needle, from); if (index < 0) return true;",
  "    const boundary = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf(';', index - 1), text.lastIndexOf('!', index - 1), text.lastIndexOf('?', index - 1));",
  "    const prefix = text.slice(Math.max(boundary + 1, index - 120), index);",
  "    const nextBoundary = [text.indexOf('.', index), text.indexOf(';', index), text.indexOf('!', index), text.indexOf('?', index)].filter((value) => value >= 0);",
  "    const suffixEnd = nextBoundary.length === 0 ? Math.min(text.length, index + needle.length + 120) : Math.min(...nextBoundary, index + needle.length + 120);",
  "    const suffix = text.slice(index + needle.length, suffixEnd);",
  "    const rejectedAfter = /\\b(?:exceed(?:s|ed)?(?: what)?[^.;]{0,40}(?:support|evidence)|unsupported|not supported|cannot support|unwarranted|overclaim)\\b/iu.test(suffix);",
  "    if ((!/\\b(?:not|never|cannot|can't|does not|do not|did not|without|unsupported|remove|removed|avoid|rather than)\\b/iu.test(prefix) || /\\bnot only\\b/iu.test(prefix)) && !rejectedAfter) return false;",
  "    from = index + needle.length;",
  "  }",
  "};",
  "const noneUnlessNegated = (rule.noneUnlessNegated ?? []).every(negated);",
  "const regex = (rule.regex ?? []).every((value) => new RegExp(value, 'iu').test(text));",
  "const noneRegex = (rule.noneRegex ?? []).every((value) => !new RegExp(value, 'iu').test(text));",
  "const words = text.replace(anchor, '').trim().split(/\\s+/u).filter(Boolean).length;",
  "const minWords = rule.minWords === undefined || words >= rule.minWords;",
  "const maxWords = rule.maxWords === undefined || words <= rule.maxWords;",
  "process.exit(all && allAny && any && none && noneUnlessNegated && regex && noneRegex && minWords && maxWords ? 0 : 1);",
].join("\n");

function file(path: string, contentUtf8: string): WorkspaceFile {
  return { path, contentUtf8 };
}

function itemMarker(id: string): string {
  return `[item:${id}]`;
}

function unitMarker(id: string): string {
  return `[unit:${id}]`;
}

function criterion(
  id: string,
  label: string,
  anchor: string,
  options: Omit<Criterion, "id" | "label" | "anchor">,
): Criterion {
  return { id, label, anchor, ...options };
}

interface RouteSpec {
  id: string;
  content: string;
  path: readonly string[];
  cost: number;
}

function routeSpec(unitRevision: number, caseIndex: number, unitId: string): RouteSpec {
  const id = `${unitId}-route-${String(caseIndex + 1).padStart(2, "0")}`;
  const first = 2 + ((unitRevision + caseIndex) % 3);
  const second = 2 + ((unitRevision * 2 + caseIndex) % 3);
  const third = 2 + ((unitRevision + caseIndex * 2) % 3);
  const cost = first + second + third;
  const lines = [
    "start=A goal=F undirected=true",
    `case=${id} objective=minimum-total-transit-minutes`,
    "All weights are non-negative integer minutes; no duplicate edges are present; every listed edge is traversable in both directions.",
    `A B ${first}`,
    `B C ${second}`,
    `C F ${third}`,
    `A D ${first + 3}`,
    `D E ${second + 3}`,
    `E F ${third + 3}`,
    `B D ${cost + 4}`,
    `C E ${cost + 5}`,
    `A E ${cost + 8}`,
    `B F ${cost + 7}`,
  ];
  if (caseIndex % 3 === 2) {
    lines.push(`A G ${first}`, `G H ${second}`, `H F ${third}`);
  }
  return {
    id,
    content: `${lines.join("\n")}\n`,
    path: ["a", "b", "c", "f"],
    cost,
  };
}

function routeUnit(id: string, revision: number): IndependentUnit {
  const routes = Array.from({ length: 10 }, (_, index) => routeSpec(revision, index, id));
  return {
    id,
    instruction: [
      `Solve all ten undirected weighted graphs under data/${id}/.`,
      "For each graph, compute the exact minimum cost, complete path, and an explicit edge-sum check.",
      "If minimum paths tie, choose the lexicographically smallest complete node sequence.",
      `Begin with ${unitMarker(id)}. Begin every graph result with its exact [item:...] marker.`,
      "Keep all ten fully worked results in the user-visible summary.",
    ].join(" "),
    files: routes.map((route) => file(`data/${id}/${route.id}.txt`, route.content)),
    criteria: routes.map((route) =>
      criterion(
        `${route.id}-exact`,
        `${route.id} exact shortest path and cost`,
        itemMarker(route.id),
        {
          regex: [
            route.path.join("\\s*(?:->|→|,|-)\\s*"),
            `(?:cost|minimum|total)[^0-9]{0,12}${String(route.cost)}\\b`,
            "(?:edge|sum|check)",
          ],
        },
      ),
    ),
  };
}

function algorithmInstances(): InstanceDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => ({
    familyId: "algorithm-exact" as const,
    instanceId: `algorithm-economic-${String(instanceIndex + 1).padStart(2, "0")}`,
    seed: `three-ten-route-portfolios-${instanceIndex + 1}`,
    title: "Solve three independent ten-case exact shortest-path portfolios",
    citationPolicy: "none" as const,
    units: Array.from({ length: 3 }, (_, unitIndex) => {
      const id = `alg-${instanceIndex + 1}${String.fromCharCode(97 + unitIndex)}`;
      return routeUnit(id, instanceIndex * 3 + unitIndex + 1);
    }),
  }));
}

function researchScreen(unitId: string, revision: number, screenIndex: number) {
  const id = `${unitId}-screen-${String(screenIndex + 1).padStart(2, "0")}`;
  const minimum = 78 + ((revision + screenIndex * 2) % 11);
  const maximumDefects = 3 + ((revision + screenIndex) % 4);
  const maximumWeeks = 6 + ((revision * 2 + screenIndex) % 5);
  const alphaScore = minimum + 6;
  const alphaDefects = maximumDefects + 2;
  const alphaWeeks = maximumWeeks - 1;
  const betaScore = minimum + 3;
  const betaDefects = maximumDefects - 1;
  const betaWeeks = maximumWeeks - 1;
  const gammaScore = minimum - 2;
  const gammaDefects = maximumDefects;
  const gammaWeeks = maximumWeeks + 2;
  const prefix = id.toUpperCase();
  const req = `REQ-${prefix}`;
  const alpha = `SRC-${prefix}-ALPHA`;
  const beta = `SRC-${prefix}-BETA`;
  const gamma = `SRC-${prefix}-GAMMA`;
  return {
    id,
    files: [
      file(
        `data/${unitId}/${id}/requirements.txt`,
        `[${req}]\nMandatory evidence thresholds: evaluation score >= ${minimum}; observed critical-defect rate <= ${maximumDefects}%; deployment time <= ${maximumWeeks} weeks. All three thresholds are required.\n`,
      ),
      file(
        `data/${unitId}/${id}/alpha.txt`,
        `[${alpha}]\nAlpha evaluation: score ${alphaScore}; critical defects ${alphaDefects}%; deployment ${alphaWeeks} weeks. Measurements cover the same frozen evaluation window.\n`,
      ),
      file(
        `data/${unitId}/${id}/beta.txt`,
        `[${beta}]\nBeta evaluation: score ${betaScore}; critical defects ${betaDefects}%; deployment ${betaWeeks} weeks. Measurements cover the same frozen evaluation window.\n`,
      ),
      file(
        `data/${unitId}/${id}/gamma.txt`,
        `[${gamma}]\nGamma evaluation: score ${gammaScore}; critical defects ${gammaDefects}%; deployment ${gammaWeeks} weeks. Measurements cover the same frozen evaluation window.\n`,
      ),
    ],
    criteria: [
      criterion(`${id}-eligible`, `${id} exact eligibility decision`, itemMarker(id), {
        all: ["beta", String(betaScore), `${betaDefects}%`, `[${beta}]`],
        allAny: [
          [
            `${betaWeeks} weeks`,
            `${betaWeeks} versus`,
            `${betaWeeks} vs`,
            `deployment ${betaWeeks}`,
          ],
        ],
        any: ["eligible", "qualifies", "meets all"],
        regex: [`(?:only|sole).{0,30}beta|beta.{0,30}(?:only|sole)|(?:only|sole)\\s+eligible`],
      }),
      criterion(`${id}-alpha`, `${id} exact Alpha defect failure`, itemMarker(id), {
        all: ["alpha", `${alphaDefects}%`, `${maximumDefects}%`, `[${alpha}]`],
        regex: [
          `alpha.{0,260}(?:fail|exceed|above).{0,120}(?:by\\s+)?(?:\\+?\\s*2(?:[ -]percentage)?[ -]points?)`,
        ],
      }),
      criterion(`${id}-gamma`, `${id} exact Gamma dual gap`, itemMarker(id), {
        all: ["gamma", String(gammaScore), String(minimum), `[${gamma}]`],
        allAny: [
          [
            `${gammaWeeks} weeks`,
            `${gammaWeeks} versus`,
            `${gammaWeeks} vs`,
            `deployment ${gammaWeeks}`,
          ],
          [`${maximumWeeks} weeks`, `${maximumWeeks} maximum`, `${maximumWeeks} limit`],
        ],
        regex: [
          `(?:score|evaluation)[^.]{0,200}(?:by\\s+2|2[ -]?points?\\s+(?:below|short|under)|(?:gap|shortfall|(?:failure\\s+)?margin)[^.;]{0,20}2|[-+]\\s*2[ -]?points?)`,
          `deploy(?:ment|s|ed|ing)?[^.]{0,200}(?:by\\s+2|2[ -]weeks?\\s+(?:over|above|excess)|(?:gap|over|exceed|(?:failure\\s+)?margin)[^.;]{0,24}2|[-+]\\s*2[ -]?weeks?)`,
        ],
      }),
    ],
  };
}

function researchUnit(id: string, revision: number): IndependentUnit {
  const screens = Array.from({ length: 3 }, (_, index) => researchScreen(id, revision, index));
  return {
    id,
    instruction: [
      `Prepare three complete frozen-source evidence briefs from the three screen directories under data/${id}/.`,
      "For each screen, apply every threshold, identify the sole eligible candidate, and state the exact observed value, governing threshold, and margin for every failure before recommending a bounded validation step.",
      "Cite every factual claim with exact source IDs; do not infer statistical significance.",
      `Begin with ${unitMarker(id)} and use the supplied [item:...] marker before each self-contained brief.`,
    ].join(" "),
    files: screens.flatMap((screen) => screen.files),
    criteria: screens.flatMap((screen) => screen.criteria),
  };
}

function researchInstances(): InstanceDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => ({
    familyId: "research-frozen" as const,
    instanceId: `research-economic-${String(instanceIndex + 1).padStart(2, "0")}`,
    seed: `three-leaves-nine-frozen-briefs-${instanceIndex + 1}`,
    title: "Prepare nine independent frozen-source decision briefs",
    citationPolicy: "frozen-required" as const,
    units: Array.from({ length: 3 }, (_, unitIndex) => {
      const id = `research-${instanceIndex + 1}${String.fromCharCode(97 + unitIndex)}`;
      return researchUnit(id, instanceIndex * 3 + unitIndex + 1);
    }),
  }));
}

const DESIGNS = [
  "cross-sectional survey",
  "retrospective cohort",
  "single-site before-after study",
  "private-corpus benchmark",
] as const;
const LIMITATIONS = [
  "self-reported outcome",
  "no concurrent control group",
  "convenience sampling",
  "no external validation",
] as const;

function limitationAlternatives(limitation: (typeof LIMITATIONS)[number]): readonly string[] {
  switch (limitation) {
    case "self-reported outcome":
      return ["self-reported outcome", "outcome was self-reported", "outcome is self-reported"];
    case "no concurrent control group":
      return [
        "no concurrent control group",
        "absence of a concurrent control group",
        "absence of concurrent control group",
        "lack of a concurrent control group",
        "lack of concurrent control group",
      ];
    case "no external validation":
      return [
        "no external validation",
        "absence of external validation",
        "lack of external validation",
      ];
    case "convenience sampling":
      return ["convenience sampling"];
  }
}
const OVERCLAIMS = [
  {
    sentence: "These results prove the intervention causes improvement in every setting.",
    banned: ["prove", "causes"],
  },
  {
    sentence: "The finding obviously guarantees improvement for every organization.",
    banned: ["obviously", "guarantees"],
  },
  {
    sentence: "This conclusive evidence supports a universal policy without qualification.",
    banned: ["conclusive", "universal"],
  },
  {
    sentence: "The method certainly dominates every alternative in all settings.",
    banned: ["certainly", "dominates"],
  },
] as const;

function paperUnit(id: string, revision: number): IndependentUnit {
  const paragraphs = Array.from({ length: 4 }, (_, index) => {
    const itemId = `${id}-paragraph-${String(index + 1).padStart(2, "0")}`;
    const sample = 84 + revision * 23 + index * 17;
    const effect = `${4 + ((revision + index) % 7)}.${(revision * 3 + index) % 10}%`;
    const coverage = `${38 + ((revision * 2 + index * 3) % 29)}%`;
    const design = DESIGNS[(revision + index) % DESIGNS.length]!;
    const limitation = LIMITATIONS[(revision * 2 + index) % LIMITATIONS.length]!;
    const overclaim = OVERCLAIMS[(revision + index * 2) % OVERCLAIMS.length]!;
    const banned = overclaim.banned;
    const draft = [
      overclaim.sentence,
      `The ${design} included ${sample} observations and measured a ${effect} change with ${coverage} response or evaluation coverage.`,
      "The original draft nevertheless treats the estimate as universally decisive and does not distinguish observation from causation.",
    ].join(" ");
    return {
      itemId,
      files: [
        file(`data/${id}/${itemId}.draft.md`, `${draft}\n`),
        file(
          `data/${id}/${itemId}.methods.txt`,
          `Methods card for ${itemId}: design=${design}; primary limitation=${limitation}; no additional causal, uncertainty, or external-validity analysis was performed.\n`,
        ),
        file(
          `data/${id}/${itemId}.editor.txt`,
          `Editorial request for ${itemId}: produce one self-contained 85-145 word paragraph; preserve ${sample}, ${effect}, and ${coverage}; remove the unsupported terms '${banned[0]}' and '${banned[1]}'; do not invent results or citations.\n`,
        ),
      ],
      criteria: [
        criterion(`${itemId}-facts`, `${itemId} preserves measurements`, itemMarker(itemId), {
          all: [String(sample), effect, coverage],
        }),
        criterion(
          `${itemId}-calibration`,
          `${itemId} calibrates the design claim`,
          itemMarker(itemId),
          {
            all: [design],
            allAny: [limitationAlternatives(limitation)],
            any: [
              "associated",
              "observed",
              "reported",
              "suggests",
              "estimate",
              "finding",
              "result",
            ],
            noneUnlessNegated: banned,
          },
        ),
        criterion(
          `${itemId}-length`,
          `${itemId} is a substantive bounded revision`,
          itemMarker(itemId),
          {
            minWords: 85,
            maxWords: 145,
          },
        ),
      ],
    };
  });
  return {
    id,
    instruction: [
      `Revise all four independent draft paragraphs in data/${id}/.`,
      "Each revision must be 85-145 words, preserve all measurements, calibrate claims to the study design, and explicitly state the supplied limitation.",
      "Return only the four revised paragraphs; invent no results or citations.",
      `Begin with ${unitMarker(id)} and place the exact [item:...] marker before each paragraph.`,
    ].join(" "),
    files: paragraphs.flatMap((paragraph) => paragraph.files),
    criteria: paragraphs.flatMap((paragraph) => paragraph.criteria),
  };
}

function paperInstances(): InstanceDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => ({
    familyId: "paper-revision" as const,
    instanceId: `paper-economic-${String(instanceIndex + 1).padStart(2, "0")}`,
    seed: `three-leaves-twelve-paragraphs-${instanceIndex + 1}`,
    title: "Revise twelve independent manuscript paragraphs",
    citationPolicy: "none" as const,
    units: Array.from({ length: 3 }, (_, unitIndex) => {
      const id = `paper-${instanceIndex + 1}${String.fromCharCode(97 + unitIndex)}`;
      return paperUnit(id, instanceIndex * 3 + unitIndex + 1);
    }),
  }));
}

const OWNER_NAMES = ["Mina", "Owen", "Ravi", "Inez", "Chen", "Sal"] as const;
const SMALL_NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
] as const;

function officeMemo(unitId: string, revision: number, memoIndex: number) {
  const id = `${unitId}-memo-${String(memoIndex + 1).padStart(2, "0")}`;
  const budget = 145 + revision * 4 + memoIndex * 3;
  const optionACost = budget + 14;
  const optionBCost = budget - 9;
  const deadlineWeeks = 8 + ((revision + memoIndex) % 4);
  const optionAWeeks = deadlineWeeks - 1;
  const optionBWeeks = deadlineWeeks;
  const riskDays = 2 + ((revision * 2 + memoIndex) % 6);
  const mitigationOwner = OWNER_NAMES[(revision + memoIndex) % OWNER_NAMES.length]!;
  const decisionOwner = OWNER_NAMES[(revision + memoIndex + 2) % OWNER_NAMES.length]!;
  const day = 10 + ((revision * 2 + memoIndex) % 15);
  const mitigationDue = `2026-09-${String(day).padStart(2, "0")}`;
  const decisionDue = `2026-09-${String(day + 2).padStart(2, "0")}`;
  return {
    id,
    files: [
      file(
        `data/${unitId}/${id}/constraints.txt`,
        `Decision record ${id}: budget cap $${budget},000; delivery deadline ${deadlineWeeks} weeks; no budget waiver; both constraints are mandatory.\n`,
      ),
      file(
        `data/${unitId}/${id}/options.txt`,
        `Option A costs $${optionACost},000 and takes ${optionAWeeks} weeks. Option B costs $${optionBCost},000 and takes ${optionBWeeks} weeks. Scope and expected benefit are equivalent.\n`,
      ),
      file(
        `data/${unitId}/${id}/risk.txt`,
        `Option B carries supplier-delay exposure of ${riskDays} days. The exposure does not change the contractual ${deadlineWeeks}-week commitment unless the mitigation is missed.\n`,
      ),
      file(
        `data/${unitId}/${id}/actions.txt`,
        `${mitigationOwner} owns supplier mitigation due ${mitigationDue}. ${decisionOwner} owns the final go/no-go confirmation due ${decisionDue}. No other owner was assigned.\n`,
      ),
    ],
    criteria: [
      criterion(`${id}-decision`, `${id} makes the exact feasible decision`, itemMarker(id), {
        all: ["option b", `$${budget},000`, `$${optionBCost},000`, `${deadlineWeeks} weeks`],
        any: ["recommend", "select", "choose", "advance", "proceed"],
        regex: [
          `(?:remaining|headroom|under budget|(?:favorable|budget) margin|margin)[^0-9-]{0,16}(?<![-$0-9])(?:\\$)?9000(?![0-9])|(?:leaving|with)[^0-9-]{0,12}(?<![-$0-9])(?:\\$)?9000(?![0-9])[^0-9]{0,12}(?:available|(?:favorable |budget )?margin)|(?<![-$0-9])(?:\\$)?9000(?![0-9]).{0,16}(?:under|below).{0,40}(?:budget )?cap|(?<![-$0-9])(?:\\$)?9000(?![0-9]).{0,30}(?:available|remaining|headroom|under\\b|(?:favorable |budget )?margin)|(?:saves|cheaper|less than)[^0-9]{0,20}(?<![-$0-9])(?:\\$)?23000(?![0-9])|(?<![-$0-9])(?:\\$)?23000(?![0-9]).{0,24}(?:saves|cheaper|less than|more than)`,
        ],
      }),
      criterion(`${id}-rejection`, `${id} rejects Option A for the exact overage`, itemMarker(id), {
        all: ["option a", `$${optionACost},000`],
        regex: [
          `(?:over|exceed|above)[^0-9]{0,40}(?<![0-9])(?:\\$)?14000(?![0-9])|(?<![0-9])(?:\\$)?14000(?![0-9]).{0,24}(?:over|exceed|above)|margin[^0-9-]{0,8}-\\s*(?:\\$)?14000(?![0-9])`,
        ],
      }),
      criterion(`${id}-actions`, `${id} preserves risk and assigned actions`, itemMarker(id), {
        all: [mitigationOwner, mitigationDue, decisionOwner, decisionDue],
        allAny: [[`${riskDays} days`, `${SMALL_NUMBER_WORDS[riskDays]} days`]],
      }),
    ],
  };
}

function officeUnit(id: string, revision: number): IndependentUnit {
  const memos = Array.from({ length: 3 }, (_, index) => officeMemo(id, revision, index));
  return {
    id,
    instruction: [
      `Produce three complete operational decision memos from the memo directories under data/${id}/.`,
      "Each memo must include an executive decision, option arithmetic, residual risk, and every owner-tagged action with its exact deadline.",
      "Do not invent owners, waivers, or dates.",
      `Begin with ${unitMarker(id)} and use the supplied [item:...] marker before each standalone memo.`,
    ].join(" "),
    files: memos.flatMap((memo) => memo.files),
    criteria: memos.flatMap((memo) => memo.criteria),
  };
}

function officeInstances(): InstanceDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => ({
    familyId: "office-document" as const,
    instanceId: `office-economic-${String(instanceIndex + 1).padStart(2, "0")}`,
    seed: `three-leaves-nine-decision-memos-${instanceIndex + 1}`,
    title: "Prepare nine independent operational decision memos",
    citationPolicy: "none" as const,
    units: Array.from({ length: 3 }, (_, unitIndex) => {
      const id = `office-${instanceIndex + 1}${String.fromCharCode(97 + unitIndex)}`;
      return officeUnit(id, instanceIndex * 3 + unitIndex + 1);
    }),
  }));
}

function dossierCase(unitId: string, revision: number, caseIndex: number) {
  const id = `${unitId}-case-${String(caseIndex + 1).padStart(2, "0")}`;
  const minimumImpact = 880 + revision * 25 + caseIndex * 15;
  const minimumMatch = 70 + revision * 5 + caseIndex * 2;
  const maximumMonths = 24 + ((revision + caseIndex) % 2) * 6;
  const auroraImpact = minimumImpact + 170;
  const auroraMatch = minimumMatch + 12;
  const auroraMonths = maximumMonths - 3;
  const beaconImpact = minimumImpact + 250;
  const beaconMatch = minimumMatch - 10;
  const beaconMonths = maximumMonths - 5;
  const cascadeImpact = minimumImpact - 40;
  const cascadeMatch = minimumMatch + 15;
  const cascadeMonths = maximumMonths + 6;
  const prefix = id.toUpperCase();
  const req = `RULE-${prefix}`;
  const aurora = `APP-${prefix}-AURORA`;
  const beacon = `APP-${prefix}-BEACON`;
  const cascade = `APP-${prefix}-CASCADE`;
  return {
    id,
    files: [
      file(
        `data/${unitId}/${id}/rules.txt`,
        `[${req}]\nAward rules: verified impact >= ${minimumImpact} units/year; applicant match >= $${minimumMatch},000; duration <= ${maximumMonths} months; ethics status approved before award. All rules are mandatory.\n`,
      ),
      file(
        `data/${unitId}/${id}/aurora.txt`,
        `[${aurora}]\nAurora: verified impact ${auroraImpact}; match $${auroraMatch},000; duration ${auroraMonths} months; ethics approved.\n`,
      ),
      file(
        `data/${unitId}/${id}/beacon.txt`,
        `[${beacon}]\nBeacon: verified impact ${beaconImpact}; match $${beaconMatch},000; duration ${beaconMonths} months; ethics pending.\n`,
      ),
      file(
        `data/${unitId}/${id}/cascade.txt`,
        `[${cascade}]\nCascade: verified impact ${cascadeImpact}; match $${cascadeMatch},000; duration ${cascadeMonths} months; ethics approved.\n`,
      ),
    ],
    criteria: [
      criterion(`${id}-aurora`, `${id} exact eligible applicant`, itemMarker(id), {
        all: ["aurora", String(auroraImpact), `$${auroraMatch},000`, `[${aurora}]`],
        allAny: [
          [
            `${auroraMonths} months`,
            `duration ${auroraMonths} vs`,
            `duration ${auroraMonths} <=`,
            `duration is ${auroraMonths}`,
          ],
        ],
        any: ["eligible", "qualifies", "meets all"],
        regex: [
          `(?:only|sole).{0,30}aurora|aurora.{0,50}(?:only|sole|no other)|(?:eligible-applicant )?ranking\\s*:\\s*1\\.?\\s*aurora|rank(?:ing)?\\s+(?:among|of)?\\s*eligible applicants[^.;]{0,20}1|rank\\s*:\\s*1\\s+of\\s+1\\s+eligible|result\\s*:\\s*eligible\\.\\s*rank\\s*:\\s*#?1[^.;]{0,60}(?:only|sole)\\s+eligible`,
        ],
      }),
      criterion(`${id}-beacon`, `${id} exact Beacon failures`, itemMarker(id), {
        all: ["beacon", `$${minimumMatch},000`, "pending", `[${beacon}]`],
        regex: [
          `(?:short|below|gap|fail)[^.;]{0,90}(?:\\$)?10000|(?:\\$)?10000[^.;]{0,40}(?:short|below|gap|fail)|-\\s*\\$?10000`,
        ],
      }),
      criterion(`${id}-cascade`, `${id} exact Cascade failures`, itemMarker(id), {
        all: ["cascade", String(minimumImpact), `[${cascade}]`],
        allAny: [[`${maximumMonths} months`, `maximum ${maximumMonths}`, `${maximumMonths}-month`]],
        regex: [
          `(?:impact gap|below|short|fail)[^.;]{0,90}40|40[^.;]{0,35}(?:below|short|fail)|-\\s*40(?:\\s+units?)?`,
          `duration[^.]{0,160}(?:by\\s+6|6\\s+(?:months?\\s+)?(?:over|above)|(?:gap|over|exceed|excess)[^.]{0,30}6|-\\s*6(?:\\s+months?)?)`,
        ],
      }),
    ],
  };
}

function dossierUnit(id: string, revision: number): IndependentUnit {
  const cases = Array.from({ length: 3 }, (_, index) => dossierCase(id, revision, index));
  return {
    id,
    instruction: [
      `Build three complete frozen-source eligibility dossiers from the case directories under data/${id}/.`,
      "For every applicant and rule, state the exact observed value, governing threshold, and derived margin; for ethics state the exact status. Apply every mandatory rule, rank only eligible applicants, and give a verification checklist.",
      "Cite every factual claim with exact source IDs and use no outside facts.",
      `Begin with ${unitMarker(id)} and use the supplied [item:...] marker before each standalone dossier.`,
    ].join(" "),
    files: cases.flatMap((item) => item.files),
    criteria: cases.flatMap((item) => item.criteria),
  };
}

function dossierInstances(): InstanceDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => ({
    familyId: "auto-dossier" as const,
    instanceId: `auto-economic-${String(instanceIndex + 1).padStart(2, "0")}`,
    seed: `three-leaves-nine-frozen-dossiers-${instanceIndex + 1}`,
    title: "Build nine independent frozen-source eligibility dossiers",
    citationPolicy: "frozen-required" as const,
    units: Array.from({ length: 3 }, (_, unitIndex) => {
      const id = `dossier-${instanceIndex + 1}${String.fromCharCode(97 + unitIndex)}`;
      return dossierUnit(id, instanceIndex * 3 + unitIndex + 1);
    }),
  }));
}

const DEFINITIONS: readonly InstanceDefinition[] = [
  ...algorithmInstances(),
  ...researchInstances(),
  ...paperInstances(),
  ...officeInstances(),
  ...dossierInstances(),
];

function promptFor(definition: InstanceDefinition): string {
  const roots = definition.units.map((unit) => `data/${unit.id}/`).join(", ");
  return [
    `${definition.title}.`,
    `The three independent work roots, each with a distinct Luna ownedPath, are ${roots}.`,
    "Process the three roots independently and in parallel; no root depends on another.",
    "Return every complete labeled deliverable. Do not replace leaf output with a high-level synthesis.",
    "Each worker must put its complete user-visible work in summary and leave findings empty unless the supplied input itself is inconsistent.",
    ...definition.units.map((unit) => `${unitMarker(unit.id)} ${unit.instruction}`),
    "Do not modify files or request user input.",
    "",
  ].join("\n");
}

function workspaceFor(definition: InstanceDefinition): string {
  return `${JSON.stringify(
    {
      access: "readOnly",
      citationPolicy: definition.citationPolicy,
      decomposition: "independent",
      ownedPaths: definition.units.map((unit) => `data/${unit.id}/`),
      files: definition.units.flatMap((unit) => unit.files),
    },
    null,
    2,
  )}\n`;
}

function validatorFor(criteria: readonly Criterion[]): string {
  const validator = {
    schemaVersion: 1,
    runnerSandboxBoundary: { networkIsolation: "runner-controlled" },
    commandChecks: criteria.map((rule) => ({
      id: rule.id,
      argv: [
        "node",
        "-e",
        VALIDATOR_SOURCE,
        JSON.stringify({
          anchor: rule.anchor,
          all: rule.all ?? [],
          allAny: rule.allAny ?? [],
          any: rule.any,
          none: rule.none ?? [],
          noneUnlessNegated: rule.noneUnlessNegated ?? [],
          regex: rule.regex ?? [],
          noneRegex: rule.noneRegex ?? [],
          minWords: rule.minWords,
          maxWords: rule.maxWords,
        }),
      ],
      expectedExitCode: 0,
      timeoutMs: 5_000,
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

export function createEconomicCrossDomainCorpus(
  calibration?: Readonly<LoadedBenchmarkCalibration>,
): EconomicCrossDomainCorpus {
  const artifacts: Array<{ path: string; bytes: Uint8Array }> = [];
  const instances: BenchmarkManifestDraft["instances"] = [];
  for (const definition of DEFINITIONS) {
    const base = `instances/${definition.familyId}/${definition.instanceId}`;
    const criteria = definition.units.flatMap((unit) => unit.criteria);
    const artifactDefinitions: ReadonlyArray<[string, BenchmarkArtifactRole, string]> = [
      ["prompt.txt", "prompt", promptFor(definition)],
      ["workspace.json", "workspace_snapshot", workspaceFor(definition)],
      ["validator.json", "validator", validatorFor(criteria)],
      ["rubric.json", "quality_rubric", rubricFor(criteria)],
    ];
    const seals = artifactDefinitions.map(([name, role, content]) => {
      const bytes = new TextEncoder().encode(content);
      const path = `${base}/${name}`;
      artifacts.push({ path, bytes });
      return { path, role, sha256: hashBenchmarkBytes(bytes), sizeBytes: bytes.byteLength };
    });
    const workspace = seals.find((item) => item.role === "workspace_snapshot");
    if (workspace === undefined) {
      throw new Error(`missing workspace for ${definition.instanceId}`);
    }
    const eligibility = economicEligibilityFromCalibration(
      calibration,
      definition.familyId,
      definition.units.length,
    );
    instances.push({
      familyId: definition.familyId,
      instanceId: definition.instanceId,
      seed: definition.seed,
      sourceRevision: "generated economic cross-domain development v3",
      evaluationClass: "economic-decomposable",
      ...(eligibility === undefined ? {} : { eligibility }),
      initialStateSha256: workspace.sha256,
      artifacts: seals,
    });
  }
  return {
    manifest: sealBenchmarkManifest({
      schemaVersion: BENCHMARK_MANIFEST_VERSION,
      suiteId: "agent-trio-economic-cross-domain-development-v3",
      sealedAt: SEALED_AT,
      baseline: {
        model: "gpt-5.6-sol",
        modelRevision: `codex-cli-${CODEX_APP_SERVER_VERSION}`,
        effort: "ultra",
      },
      instances,
    }),
    artifacts,
  };
}

export async function generateEconomicCrossDomainCorpus(
  rootDirectory = DEFAULT_ROOT,
  calibrationPath?: string,
): Promise<string> {
  const root = resolve(rootDirectory);
  const calibration =
    calibrationPath === undefined
      ? undefined
      : await loadBenchmarkCalibrationTable(calibrationPath);
  const corpus = createEconomicCrossDomainCorpus(calibration);
  for (const artifact of corpus.artifacts) {
    const target = resolve(root, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.bytes);
  }
  const manifestPath = resolve(root, "manifest.json");
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(corpus.manifest, null, 2)}\n`, "utf8");
  await verifyBenchmarkCorpus(corpus.manifest, createFileBenchmarkArtifactReader(root));
  return manifestPath;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const { rootDirectory, calibrationPath } = generatorArguments(process.argv.slice(2));
  const manifestPath = await generateEconomicCrossDomainCorpus(rootDirectory, calibrationPath);
  process.stdout.write(`${manifestPath}\n`);
}

function generatorArguments(args: readonly string[]): {
  rootDirectory: string | undefined;
  calibrationPath: string | undefined;
} {
  const calibrationIndex = args.indexOf("--calibration");
  const calibrationPath = calibrationIndex < 0 ? undefined : args[calibrationIndex + 1];
  if (calibrationIndex >= 0 && calibrationPath === undefined) {
    throw new Error("--calibration requires a JSON file path");
  }
  const positional =
    calibrationIndex < 0
      ? [...args]
      : args.filter((_, index) => index !== calibrationIndex && index !== calibrationIndex + 1);
  if (positional.length > 1) {
    throw new Error(
      "usage: generate-economic-cross-domain-benchmark [root] [--calibration file.json]",
    );
  }
  return { rootDirectory: positional[0], calibrationPath };
}
