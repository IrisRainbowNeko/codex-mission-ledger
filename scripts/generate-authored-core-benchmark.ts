#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEconomicCodingCorpus } from "./generate-economic-coding-benchmark.js";
import { createEconomicCrossDomainCorpus } from "./generate-economic-cross-domain-benchmark.js";
import {
  BENCHMARK_MANIFEST_VERSION,
  BENCHMARK_FAMILIES,
  createFileBenchmarkArtifactReader,
  economicEligibilityFromCalibration,
  hashBenchmarkBytes,
  loadBenchmarkCalibrationTable,
  sealBenchmarkManifest,
  verifyBenchmarkCorpus,
  type BenchmarkArtifactRole,
  type BenchmarkCorpusInstance,
  type BenchmarkCorpusManifest,
  type BenchmarkEvaluationClass,
  type BenchmarkManifestDraft,
  type LoadedBenchmarkCalibration,
} from "../src/benchmark.js";
import {
  parseSealedBenchmarkValidatorV1,
  runSealedBenchmarkValidator,
  type SealedBenchmarkValidationResult,
} from "../src/benchmark-validator.js";
import { CODEX_APP_SERVER_VERSION } from "../src/core/contracts.js";

const DEFAULT_ROOT = "/tmp/agent-trio-authored-core-v1";
const SEALED_AT = "2026-08-31T00:00:00.000Z";
const SOURCE_REVISION = "agent-trio-authored-core-v1";
const COLLECTED_AT = "2026-08-31T00:00:00.000Z";

type AddedFamilyId =
  | "coding-local-bugfix"
  | "coding-review"
  | "algorithm-optimization"
  | "algorithm-numerical"
  | "research-live"
  | "research-conflict"
  | "paper-edit"
  | "paper-review"
  | "office-sheet"
  | "office-document"
  | "office-slides"
  | "auto-recovery"
  | "auto-pipeline";

interface WorkspaceFile {
  path: string;
  contentUtf8: string;
  mode?: number;
}

interface OutputRule {
  id: string;
  label: string;
  anchor: string;
  all?: readonly string[];
  allAny?: readonly (readonly string[])[];
  any?: readonly string[];
  none?: readonly string[];
  regex?: readonly string[];
  minWords?: number;
  maxWords?: number;
}

interface CommandCheck {
  id: string;
  argv: readonly string[];
  cwd?: string;
  expectedExitCode?: number;
  timeoutMs?: number;
  critical?: boolean;
}

interface Deliverable {
  id: string;
  path: string;
  critical?: boolean;
}

interface AddedDefinition {
  familyId: AddedFamilyId;
  instanceId: string;
  seed: string;
  access: "readOnly" | "workspaceWrite";
  decomposition: "independent" | "coupled";
  citationPolicy: "none" | "frozen-required";
  evaluationClass?: BenchmarkEvaluationClass;
  prompt: string;
  files: readonly WorkspaceFile[];
  outputRules?: readonly OutputRule[];
  commandChecks?: readonly CommandCheck[];
  deliverables?: readonly Deliverable[];
  externalSnapshot?: string;
}

interface QualificationWrite {
  path: string;
  contentUtf8: string;
  mode?: number;
}

interface QualificationCommand {
  argv: readonly string[];
  cwd?: string;
}

interface QualificationFixture {
  id: "gold" | "mutant-wrong" | "mutant-missing";
  output: string;
  writes: readonly QualificationWrite[];
  commands: readonly QualificationCommand[];
  deletes: readonly string[];
}

interface QualificationEvidence {
  schemaVersion: 1;
  identity: string;
  validatorSha256: string;
  fixture: QualificationFixture;
  result: {
    score: number;
    passedChecks: number;
    totalChecks: number;
    checks: Array<{
      id: string;
      kind: "command" | "deliverable";
      passed: boolean;
      summary: string;
    }>;
  };
}

export interface AuthoredCoreCorpus {
  manifest: BenchmarkCorpusManifest;
  artifacts: Array<{ path: string; bytes: Uint8Array }>;
}

const OUTPUT_VALIDATOR_SOURCE = [
  "const { readFileSync } = require('node:fs');",
  "const n = (v) => v.toLowerCase().replace(/[`*_]/gu, '').replace(/(?<=\\d),(?=\\d{3}\\b)/gu, '').replace(/\\s+/gu, ' ').trim();",
  "let source = readFileSync('.agent-trio-benchmark/model-output.txt', 'utf8');",
  "source = source.replace(/(^|\\n)(\\s*)(review-paper-\\d+[a-z])\\s*:\\s*([\\s\\S]*?)(?=(?:\\n\\s*review-paper-\\d+[a-z]\\s*:)|$)/giu, (_match, prefix, space, root, body) => `${prefix}${space}${root}:\\n${body.replace(/(^|\\n)(\\s*-\\s*)section-(\\d{2})\\s*:/giu, (_section, sectionPrefix, bullet, number) => `${sectionPrefix}${bullet}[item:${root}-section-${number}]`)}`);",
  "source = source.replace(/(?<!\\[item:)(review-paper-\\d+[a-z]-section-\\d{2})/giu, '[item:$1]');",
  "const raw = n(source);",
  "const rule = JSON.parse(process.argv[1]);",
  "const anchor = n(rule.anchor);",
  "const start = raw.indexOf(anchor);",
  "if (start < 0) process.exit(1);",
  "const after = start + anchor.length;",
  "const nextItem = raw.indexOf('[item:', after);",
  "const nextUnit = raw.indexOf('[unit:', after);",
  "const stops = [nextItem, nextUnit].filter((value) => value >= 0);",
  "const text = raw.slice(start, stops.length === 0 ? raw.length : Math.min(...stops));",
  "const includes = (value) => text.includes(n(value));",
  "const all = (rule.all ?? []).every(includes);",
  "const allAny = (rule.allAny ?? []).every((group) => group.some(includes));",
  "const any = !rule.any || rule.any.some(includes);",
  "const none = (rule.none ?? []).every((value) => !includes(value));",
  "const regex = (rule.regex ?? []).every((value) => new RegExp(value, 'iu').test(text));",
  "const words = text.replace(anchor, '').trim().split(/\\s+/u).filter(Boolean).length;",
  "const minWords = rule.minWords === undefined || words >= rule.minWords;",
  "const maxWords = rule.maxWords === undefined || words <= rule.maxWords;",
  "process.exit(all && allAny && any && none && regex && minWords && maxWords ? 0 : 1);",
].join("\n");

const FILE_VALIDATOR_SOURCE = [
  "const { readFileSync } = require('node:fs');",
  "const n = (v) => v.toLowerCase().replace(/(?<=\\d),(?=\\d{3}\\b)/gu, '').replace(/\\s+/gu, ' ').trim();",
  "const text = n(readFileSync(process.argv[1], 'utf8'));",
  "const expected = JSON.parse(process.argv[2]);",
  "process.exit(expected.every((value) => text.includes(n(value))) ? 0 : 1);",
].join("\n");

const OFFICE_ZIP_VALIDATOR_SOURCE = [
  "import json, re, sys, zipfile",
  "path = sys.argv[1]",
  "expected = json.loads(sys.argv[2])",
  "with zipfile.ZipFile(path) as archive:",
  "    names = archive.namelist()",
  "    if '[Content_Types].xml' not in names: raise SystemExit(1)",
  "    text = ' '.join(archive.read(name).decode('utf-8', 'ignore') for name in names if name.endswith('.xml'))",
  "normalized = re.sub(r'\\s+', ' ', text).lower().replace(',', '')",
  "raise SystemExit(0 if all(str(value).lower().replace(',', '') in normalized for value in expected) else 1)",
].join("\n");

const OFFICE_BUILDER_SOURCE = String.raw`#!/usr/bin/env python3
import csv
import html
import json
import shutil
import subprocess
import sys
from pathlib import Path

kind, spec_path, output_path = sys.argv[1:4]
spec_file = Path(spec_path).resolve()
target = Path(output_path).resolve()
target.parent.mkdir(parents=True, exist_ok=True)
spec = json.loads(spec_file.read_text(encoding="utf-8"))
profile = target.parent / (".lo-profile-" + target.stem)
profile.mkdir(exist_ok=True)

if kind == "xlsx":
    source = target.with_suffix(".csv")
    with source.open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle).writerows(spec["rows"])
    extension = "xlsx"
    export_filter = 'xlsx:Calc MS Excel 2007 XML'
elif kind == "docx":
    source = target.with_suffix(".html")
    body = "".join("<p>" + html.escape(str(value)) + "</p>" for value in spec["paragraphs"])
    source.write_text("<!doctype html><meta charset=utf-8><body>" + body + "</body>", encoding="utf-8")
    extension = "docx"
    export_filter = 'docx:Office Open XML Text'
elif kind == "pptx":
    source = target.with_suffix(".fodp")
    pages = []
    for index, slide in enumerate(spec["slides"], 1):
        title = html.escape(str(slide["title"]))
        bullets = "".join("<text:p>" + html.escape(str(value)) + "</text:p>" for value in slide["bullets"])
        pages.append(f'''<draw:page draw:name="page{index}" draw:style-name="dp1">
          <draw:frame draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="23cm" svg:height="2cm"><draw:text-box><text:p>{title}</text:p></draw:text-box></draw:frame>
          <draw:frame draw:style-name="gr1" svg:x="1cm" svg:y="4cm" svg:width="23cm" svg:height="12cm"><draw:text-box>{bullets}</draw:text-box></draw:frame>
        </draw:page>''')
    source.write_text('''<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:mimetype="application/vnd.oasis.opendocument.presentation" office:version="1.3">
<office:automatic-styles><style:style style:name="dp1" style:family="drawing-page"/><style:style style:name="gr1" style:family="graphic"/></office:automatic-styles>
<office:body><office:presentation>''' + ''.join(pages) + '''</office:presentation></office:body></office:document>''', encoding="utf-8")
    extension = "pptx"
    export_filter = 'pptx:Impress MS PowerPoint 2007 XML'
else:
    raise SystemExit("unsupported kind")

command = ["soffice", "--headless", "-env:UserInstallation=" + profile.as_uri(), "--convert-to", export_filter, "--outdir", str(target.parent), str(source)]
completed = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
converted = source.with_suffix("." + extension)
if completed.returncode != 0 or not converted.exists():
    raise SystemExit("office conversion failed: " + completed.stderr)
if converted != target:
    converted.replace(target)
source.unlink(missing_ok=True)
shutil.rmtree(profile, ignore_errors=True)
`;

function file(path: string, contentUtf8: string, mode?: number): WorkspaceFile {
  return { path, contentUtf8, ...(mode === undefined ? {} : { mode }) };
}

function itemMarker(id: string): string {
  return `[item:${id}]`;
}

function unitMarker(id: string): string {
  return `[unit:${id}]`;
}

function outputRule(
  id: string,
  label: string,
  options: Omit<OutputRule, "id" | "label" | "anchor"> = {},
): OutputRule {
  return { id, label, anchor: itemMarker(id), ...options };
}

function outputCheck(rule: OutputRule): CommandCheck {
  return {
    id: rule.id,
    argv: [
      "node",
      "-e",
      OUTPUT_VALIDATOR_SOURCE,
      JSON.stringify({
        anchor: rule.anchor,
        all: rule.all ?? [],
        allAny: rule.allAny ?? [],
        any: rule.any,
        none: rule.none ?? [],
        regex: rule.regex ?? [],
        minWords: rule.minWords,
        maxWords: rule.maxWords,
      }),
    ],
    expectedExitCode: 0,
    timeoutMs: 5_000,
  };
}

function fileCheck(id: string, path: string, expected: readonly string[]): CommandCheck {
  return {
    id,
    argv: ["node", "-e", FILE_VALIDATOR_SOURCE, path, JSON.stringify(expected)],
    expectedExitCode: 0,
    timeoutMs: 5_000,
  };
}

function officeCheck(id: string, path: string, expected: readonly string[]): CommandCheck {
  return {
    id,
    argv: ["python3", "-c", OFFICE_ZIP_VALIDATOR_SOURCE, path, JSON.stringify(expected)],
    expectedExitCode: 0,
    timeoutMs: 10_000,
  };
}

function workspaceFor(definition: AddedDefinition): string {
  return `${JSON.stringify(
    {
      access: definition.access,
      citationPolicy: definition.citationPolicy,
      decomposition: definition.decomposition,
      files: definition.files,
    },
    null,
    2,
  )}\n`;
}

function validatorFor(definition: AddedDefinition): string {
  const commandChecks = [
    ...(definition.outputRules ?? []).map(outputCheck),
    ...(definition.commandChecks ?? []),
  ].map((check) => ({
    id: check.id,
    argv: [...check.argv],
    ...(check.cwd === undefined ? {} : { cwd: check.cwd }),
    expectedExitCode: check.expectedExitCode ?? 0,
    timeoutMs: check.timeoutMs ?? 5_000,
    ...(check.critical === undefined ? {} : { critical: check.critical }),
  }));
  const validator = {
    schemaVersion: 1,
    runnerSandboxBoundary: { networkIsolation: "runner-controlled" },
    commandChecks,
    requiredDeliverables: (definition.deliverables ?? []).map((deliverable) => ({
      id: deliverable.id,
      path: deliverable.path,
      ...(deliverable.critical === undefined ? {} : { critical: deliverable.critical }),
    })),
  };
  parseSealedBenchmarkValidatorV1(validator);
  return `${JSON.stringify(validator, null, 2)}\n`;
}

function rubricFor(definition: AddedDefinition): string {
  const criteria = [
    ...(definition.outputRules ?? []).map((rule) => ({
      id: rule.id,
      label: rule.label,
      weight: 1,
    })),
    ...(definition.commandChecks ?? []).map((check) => ({
      id: check.id,
      label: `${check.id} deterministic validation passes`,
      weight: 1,
    })),
    ...(definition.deliverables ?? []).map((deliverable) => ({
      id: deliverable.id,
      label: `${deliverable.path} exists as a regular file`,
      weight: 1,
    })),
  ];
  return `${JSON.stringify({ mode: "sealed-v1", version: 1, maximum: 100, criteria }, null, 2)}\n`;
}

function releaseMetadata() {
  return {
    sourceRevision: SOURCE_REVISION,
    provenance: {
      origin: "authored-held-out" as const,
      source: "Agent Trio authored core benchmark",
      license: "CC0-1.0",
      collectedAt: COLLECTED_AT,
    },
  };
}

function localBugfixDefinitions(): AddedDefinition[] {
  const variants = [
    {
      name: "csv-record",
      contract:
        "parseRecord(line) returns CSV fields. Commas inside double quotes are data; doubled quotes decode to one quote; an unterminated quote throws TypeError.",
      implementation: `export function parseRecord(line) {
  if (typeof line !== "string") throw new TypeError("line");
  return line.split(",").map((value) => value.trim());
}
`,
      test: `import test from "node:test";
import assert from "node:assert/strict";
import { parseRecord } from "../src/index.mjs";
test("quoted CSV", () => {
  assert.deepEqual(parseRecord('alpha,"beta,gamma","said ""yes"""'), ["alpha", "beta,gamma", 'said "yes"']);
  assert.throws(() => parseRecord('alpha,"broken'), TypeError);
});
`,
    },
    {
      name: "ttl-cache",
      contract:
        "createCache(now) returns set/get. An entry is fresh while now() < storedAt + ttlMs. ttlMs must be a non-negative integer; ttlMs=0 expires immediately. get returns undefined for expired entries and deletes them.",
      implementation: `export function createCache(now = Date.now) {
  const entries = new Map();
  return {
    set(key, value, ttlMs) { entries.set(key, { value, expiresAt: now() + ttlMs }); },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() > entry.expiresAt) { entries.delete(key); return undefined; }
      return entry.value;
    },
  };
}
`,
      test: `import test from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../src/index.mjs";
test("boundary and validation", () => {
  let clock = 100;
  const cache = createCache(() => clock);
  cache.set("a", 1, 10); clock = 109; assert.equal(cache.get("a"), 1);
  clock = 110; assert.equal(cache.get("a"), undefined);
  cache.set("b", 2, 0); assert.equal(cache.get("b"), undefined);
  assert.throws(() => cache.set("c", 3, -1), TypeError);
  assert.throws(() => cache.set("c", 3, 1.5), TypeError);
});
`,
    },
    {
      name: "largest-remainder",
      contract:
        "allocate(total, weights) returns non-negative integer allocations summing to total. Use largest remainder apportionment; ties go to the lower input index. Reject invalid totals, empty weights, negative weights, and an all-zero weight vector with TypeError.",
      implementation: `export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((weight) => Math.round(total * weight / sum));
}
`,
      test: `import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/index.mjs";
test("largest remainder and ties", () => {
  assert.deepEqual(allocate(7, [1, 1, 1]), [3, 2, 2]);
  assert.deepEqual(allocate(11, [5, 3, 2]), [6, 3, 2]);
  assert.equal(allocate(101, [3, 2, 1]).reduce((a, b) => a + b, 0), 101);
  for (const bad of [[-1, [1]], [1.2, [1]], [1, []], [1, [0, 0]], [1, [1, -1]]]) {
    assert.throws(() => allocate(bad[0], bad[1]), TypeError);
  }
});
`,
    },
  ] as const;
  return variants.map((variant, index) => {
    const instance = String(index + 1).padStart(2, "0");
    return {
      familyId: "coding-local-bugfix",
      instanceId: `coding-local-authored-${instance}`,
      seed: `local-${variant.name}-${instance}`,
      access: "workspaceWrite",
      decomposition: "coupled",
      citationPolicy: "none",
      prompt: [
        `Fix the single local defect in src/index.mjs for the ${variant.name} contract.`,
        "Keep the public API unchanged, modify only src/index.mjs, run the supplied test, and report the result.",
      ].join("\n"),
      files: [
        file("package.json", '{"private":true,"type":"module"}\n'),
        file("CONTRACT.md", `${variant.contract}\n`),
        file("src/index.mjs", variant.implementation),
        file("validation/behavior.test.mjs", variant.test),
      ],
      commandChecks: [
        {
          id: `${variant.name}-tests`,
          argv: ["node", "--test", "validation/behavior.test.mjs"],
          timeoutMs: 20_000,
        },
      ],
    } satisfies AddedDefinition;
  });
}

function codingReviewDefinitions(): AddedDefinition[] {
  const defects = [
    {
      file: "src/rate-limit.mjs",
      code: "export const allow = (count, limit) => count <= limit;\n",
      contract: "allow must be false once count is equal to the exclusive limit.",
      cause: "count <= limit",
      fix: "count < limit",
      consequences: ["one extra request", "exclusive limit"],
    },
    {
      file: "src/page.mjs",
      code: "export const pageCount = (total, size) => Math.floor(total / size);\n",
      contract: "pageCount includes a final partial page.",
      cause: "Math.floor",
      fix: "Math.ceil",
      consequences: ["partial page", "omitted"],
    },
    {
      file: "src/sort.mjs",
      code: "export const byScore = (a, b) => a.score > b.score;\n",
      contract:
        "byScore is a numeric ascending comparator returning a negative, zero, or positive number.",
      cause: "a.score > b.score",
      fix: "a.score - b.score",
      consequences: ["ordering", "comparator"],
    },
  ] as const;
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `review-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const cases = Array.from({ length: 3 }, (_, caseIndex) => ({
        id: `${id}-case-${String(caseIndex + 1).padStart(2, "0")}`,
        defect: defects[(instanceIndex + rootIndex + caseIndex) % defects.length]!,
      }));
      return { id, cases };
    });
    return {
      familyId: "coding-review",
      evaluationClass: "direct-fast-path",
      instanceId: `coding-review-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `three-independent-code-reviews-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Review three independent modules without modifying files.",
        `The independent roots are ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each of the nine cases, identify the exact defective expression, user-visible consequence, and minimal correction. Return every item marker.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Review all three case directories under data/${id}/. Each case is a separate required deliverable.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, cases }) =>
        cases.flatMap(({ id: caseId, defect }) => [
          file(`data/${id}/${caseId}/contract.txt`, `${defect.contract}\n`),
          file(`data/${id}/${caseId}/${defect.file}`, defect.code),
          file(
            `data/${id}/${caseId}/context.txt`,
            `No caller compensates for this behavior. Item marker: ${itemMarker(caseId)}.\n`,
          ),
        ]),
      ),
      outputRules: roots.flatMap(({ cases }) =>
        cases.map(({ id, defect }) =>
          outputRule(id, `${id} reports the exact defect and fix`, {
            all: [defect.cause, defect.fix],
            any: defect.consequences,
          }),
        ),
      ),
    } satisfies AddedDefinition;
  });
}

interface KnapsackItem {
  id: string;
  weight: number;
  value: number;
}

function solveKnapsack(
  items: readonly KnapsackItem[],
  capacity: number,
): {
  ids: string[];
  weight: number;
  value: number;
} {
  let best = { ids: [] as string[], weight: 0, value: 0 };
  for (let mask = 0; mask < 1 << items.length; mask += 1) {
    const selected = items.filter((_item, index) => (mask & (1 << index)) !== 0);
    const weight = selected.reduce((sum, item) => sum + item.weight, 0);
    const value = selected.reduce((sum, item) => sum + item.value, 0);
    const ids = selected.map((item) => item.id);
    const lexical = ids.join(",");
    const bestLexical = best.ids.join(",");
    if (
      weight <= capacity &&
      (value > best.value ||
        (value === best.value &&
          (weight < best.weight || (weight === best.weight && lexical < bestLexical))))
    ) {
      best = { ids, weight, value };
    }
  }
  return best;
}

function optimizationDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `opt-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const cases = Array.from({ length: 4 }, (_, caseIndex) => {
        const shift = instanceIndex + rootIndex + caseIndex;
        const items: KnapsackItem[] = [
          { id: "A", weight: 2 + (shift % 2), value: 5 + (shift % 3) },
          { id: "B", weight: 3, value: 7 + ((shift + 1) % 3) },
          { id: "C", weight: 4, value: 8 + ((shift + 2) % 4) },
          { id: "D", weight: 5, value: 10 + (shift % 4) },
          { id: "E", weight: 1 + ((shift + 1) % 2), value: 3 + (shift % 2) },
        ];
        const capacity = 7 + (shift % 3);
        return {
          id: `${id}-case-${String(caseIndex + 1).padStart(2, "0")}`,
          items,
          capacity,
          answer: solveKnapsack(items, capacity),
        };
      });
      return { id, cases };
    });
    return {
      familyId: "algorithm-optimization",
      evaluationClass: "direct-fast-path",
      instanceId: `algorithm-optimization-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `twelve-exact-knapsack-cases-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Solve twelve exact independent 0/1 knapsack cases in three parallel roots.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For every case state the selected IDs in ascending order, total weight, total value, and an exhaustive or dynamic-programming optimality check. Break value ties by lower weight, then lexicographically smaller ID list.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Solve all four cases under data/${id}/ and preserve every item marker.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, cases }) =>
        cases.map((item) =>
          file(
            `data/${id}/${item.id}.json`,
            `${JSON.stringify({ marker: itemMarker(item.id), capacity: item.capacity, items: item.items }, null, 2)}\n`,
          ),
        ),
      ),
      outputRules: roots.flatMap(({ cases }) =>
        cases.map((item) =>
          outputRule(item.id, `${item.id} exact optimum`, {
            allAny: [
              [
                `selected ${item.answer.ids.join(",")}`,
                `selected [${item.answer.ids.join(",")}]`,
                `ids [${item.answer.ids.join(",")}]`,
                `ids=[${item.answer.ids.join(",")}]`,
                `ids: [${item.answer.ids.join(",")}]`,
                `selected ids ${item.answer.ids.join(",")}`,
                `selected ids ${item.answer.ids.join(", ")}`,
                `selected ids: ${item.answer.ids.join(", ")}`,
                `[${item.answer.ids.join(", ")}]`,
                `selected ids [${item.answer.ids.map((id) => JSON.stringify(id)).join(",")}]`,
              ],
              [
                `weight ${item.answer.weight}`,
                `total weight ${item.answer.weight}`,
                `total weight: ${item.answer.weight}`,
                `=${item.answer.weight}`,
                `| ${item.answer.weight} |`,
              ],
              [
                `value ${item.answer.value}`,
                `total value ${item.answer.value}`,
                `total value: ${item.answer.value}`,
                `=${item.answer.value}`,
                `| ${item.answer.value} |`,
              ],
            ],
            any: [
              "exhaustive",
              "dynamic programming",
              "dp check",
              "dp 0..",
              "f=",
              "feasible subsets",
            ],
          }),
        ),
      ),
    } satisfies AddedDefinition;
  });
}

function numericalDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `num-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const cases = Array.from({ length: 4 }, (_, caseIndex) => {
        const offset = instanceIndex * 2 + rootIndex + caseIndex;
        const values = [2 + offset, 5 + offset, 7 + offset, 10 + offset];
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance =
          values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
        const trapezoid = values
          .slice(0, -1)
          .reduce((sum, value, index) => sum + (value + values[index + 1]!) / 2, 0);
        return {
          id: `${id}-case-${String(caseIndex + 1).padStart(2, "0")}`,
          values,
          mean: mean.toFixed(3),
          variance: variance.toFixed(3),
          trapezoid: trapezoid.toFixed(3),
        };
      });
      return { id, cases };
    });
    return {
      familyId: "algorithm-numerical",
      evaluationClass: "direct-fast-path",
      instanceId: `algorithm-numerical-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `twelve-statistical-integral-cases-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Compute twelve independent numerical cases in three parallel roots.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For every vector report the population mean, population variance, and unit-spacing trapezoidal integral to exactly three decimals. Include the substitution or intermediate sums and preserve every item marker.",
        `Required output markers, each exactly once: ${roots.flatMap((root) => root.cases.map((item) => itemMarker(item.id))).join(", ")}.`,
        ...roots.map(({ id }) => `${unitMarker(id)} Complete all four vectors under data/${id}/.`),
      ].join("\n"),
      files: roots.flatMap(({ id, cases }) =>
        cases.map((item) =>
          file(
            `data/${id}/${item.id}.txt`,
            `${itemMarker(item.id)}\nvalues=${item.values.join(",")}\nspacing=1\n`,
          ),
        ),
      ),
      outputRules: roots.flatMap(({ cases }) =>
        cases.map((item) =>
          outputRule(item.id, `${item.id} exact numerical results`, {
            all: [`mean ${item.mean}`, `variance ${item.variance}`, `trapezoid ${item.trapezoid}`],
            any: ["sum", "substitution", "intermediate", "s="],
          }),
        ),
      ),
    } satisfies AddedDefinition;
  });
}

function researchLiveDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const captured = `2026-08-${String(20 + instanceIndex).padStart(2, "0")}T12:00:00Z`;
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `live-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const base = 90 + instanceIndex * 7 + rootIndex * 5;
      const sources = [
        {
          sourceId: `WEB-${id.toUpperCase()}-A`,
          vendor: "Atlas",
          price: base + 20,
          latency: 85 - rootIndex * 3,
          status: "available",
          observedAt: captured,
        },
        {
          sourceId: `WEB-${id.toUpperCase()}-B`,
          vendor: "Beacon",
          price: base,
          latency: 92 - rootIndex * 2,
          status: "available",
          observedAt: captured,
        },
        {
          sourceId: `WEB-${id.toUpperCase()}-C`,
          vendor: "Cascade",
          price: base - 8,
          latency: 70,
          status: "waitlist",
          observedAt: captured,
        },
      ];
      return { id, sources, winner: sources[1]! };
    });
    const externalSnapshot = `${JSON.stringify(
      {
        capturedAt: captured,
        replayPolicy: "No network access; these bytes are the authoritative captured web state.",
        roots: roots.map(({ id, sources }) => ({ id, sources })),
      },
      null,
      2,
    )}\n`;
    return {
      familyId: "research-live",
      evaluationClass: "direct-fast-path",
      instanceId: `research-live-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `frozen-web-replay-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "frozen-required",
      externalSnapshot,
      prompt: [
        `Answer from the frozen web replay captured at ${captured}; do not use current network state.`,
        `Independent roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each request choose the lowest-price currently available vendor with latency at most 95 ms. State price, latency, availability, capture time, and cite the exact source ID for every factual claim. A waitlist is not available.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Analyze the captured listings under data/${id}/ and return ${itemMarker(id)}.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, sources }) =>
        sources.map((source) =>
          file(
            `data/${id}/${source.vendor.toLowerCase()}.json`,
            `${JSON.stringify(source, null, 2)}\n`,
          ),
        ),
      ),
      outputRules: roots.map(({ id, winner }) =>
        outputRule(id, `${id} uses the exact captured winner`, {
          allAny: [[`$${winner.price}`, `price ${winner.price}`]],
          all: [
            winner.vendor,
            `${winner.latency} ms`,
            winner.status,
            winner.observedAt,
            `[${winner.sourceId}]`,
          ],
          none: ["current live web"],
        }),
      ),
    } satisfies AddedDefinition;
  });
}

function researchConflictDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `conflict-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const cases = Array.from({ length: 3 }, (_, caseIndex) => {
        const caseId = `${id}-claim-${String(caseIndex + 1).padStart(2, "0")}`;
        const audited = 72 + instanceIndex * 3 + rootIndex * 2 + caseIndex;
        const press = audited + 8;
        const sourceA = `AUDIT-${caseId.toUpperCase()}`;
        const sourceB = `PRESS-${caseId.toUpperCase()}`;
        const sourceC = `BLOG-${caseId.toUpperCase()}`;
        return { caseId, audited, press, sourceA, sourceB, sourceC };
      });
      return { id, cases };
    });
    return {
      familyId: "research-conflict",
      instanceId: `research-conflict-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `nine-conflicting-evidence-packs-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "frozen-required",
      prompt: [
        "Adjudicate nine independent conflicting-evidence claims from frozen sources.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each claim, prefer the signed primary audit over an earlier press release or anonymous blog. State the supported exact value, rejected conflicting value, provenance reason, and all three exact source IDs. Do not average incompatible claims.",
        ...roots.map(
          ({ id }) => `${unitMarker(id)} Resolve all three claim packs under data/${id}/.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, cases }) =>
        cases.flatMap((item) => [
          file(
            `data/${id}/${item.caseId}-audit.txt`,
            `${itemMarker(item.caseId)} [${item.sourceA}] Signed final audit, issued 2026-07-31: verified completion rate ${item.audited}%. Scope: all sites.\n`,
          ),
          file(
            `data/${id}/${item.caseId}-press.txt`,
            `[${item.sourceB}] Preliminary press release, issued 2026-06-10: projected completion rate ${item.press}%. Scope not stated.\n`,
          ),
          file(
            `data/${id}/${item.caseId}-blog.txt`,
            `[${item.sourceC}] Anonymous repost: repeats ${item.press}% without underlying records.\n`,
          ),
        ]),
      ),
      outputRules: roots.flatMap(({ cases }) =>
        cases.map((item) =>
          outputRule(item.caseId, `${item.caseId} resolves the source conflict`, {
            all: [
              `${item.audited}%`,
              `${item.press}%`,
              `[${item.sourceA}]`,
              `[${item.sourceB}]`,
              `[${item.sourceC}]`,
            ],
            any: ["signed final audit", "primary audit", "audited source"],
            none: ["average"],
          }),
        ),
      ),
    } satisfies AddedDefinition;
  });
}

function paperEditDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const participants = 184 + instanceIndex * 37;
    const estimate = (3.2 + instanceIndex * 0.7).toFixed(1);
    const lower = (0.8 + instanceIndex * 0.2).toFixed(1);
    const upper = (5.6 + instanceIndex * 1.2).toFixed(1);
    const id = `paper-edit-${instanceIndex + 1}`;
    return {
      familyId: "paper-edit",
      instanceId: `paper-edit-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `targeted-paragraph-edit-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "coupled",
      citationPolicy: "none",
      prompt: [
        "Rewrite the supplied results paragraph as one precise 90-125 word paragraph.",
        `Begin with ${itemMarker(id)}. Preserve n=${participants}, the ${estimate}-point estimate, and 95% CI ${lower} to ${upper}.`,
        "State that assignment was observational and the outcome was self-reported. Do not claim causality, proof, guarantees, or invent citations. Return only the revised paragraph.",
      ].join("\n"),
      files: [
        file(
          "manuscript/paragraph.txt",
          `We studied ${participants} participants. The exposed group reported an outcome ${estimate} points higher (95% CI ${lower} to ${upper}). Exposure was observed rather than randomized, and the outcome was self-reported. The draft currently says the exposure caused improvement.\n`,
        ),
      ],
      outputRules: [
        outputRule(id, `${id} preserves evidence and calibrates the claim`, {
          all: [String(participants), lower, upper, "observational", "self-reported"],
          allAny: [[`${estimate}-point`, `${estimate} point`, `${estimate} points`]],
          none: ["caused improvement", "proves", "guarantees"],
          minWords: 90,
          maxWords: 125,
        }),
      ],
    } satisfies AddedDefinition;
  });
}

function paperReviewDefinitions(): AddedDefinition[] {
  const issueKinds = [
    {
      issue: "test-set leakage",
      evidence: "Hyperparameters were selected on the final test set before the reported score.",
      required: "separate validation set",
      severity: "major",
    },
    {
      issue: "unit-of-analysis error",
      evidence:
        "The analysis treats 480 repeated observations from 24 participants as independent.",
      required: "participant-level or mixed-effects analysis",
      severity: "major",
    },
    {
      issue: "unsupported causal claim",
      evidence:
        "The study is retrospective with no random assignment, but the conclusion says the intervention caused the outcome.",
      required: "associational wording",
      severity: "major",
    },
  ] as const;
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `review-paper-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const issues = Array.from({ length: 3 }, (_, issueIndex) => {
        const issue = issueKinds[(instanceIndex + rootIndex + issueIndex) % issueKinds.length]!;
        return { ...issue, id: `${id}-section-${String(issueIndex + 1).padStart(2, "0")}` };
      });
      return { id, issues };
    });
    return {
      familyId: "paper-review",
      evaluationClass: "direct-fast-path",
      instanceId: `paper-review-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `nine-independent-method-reviews-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Review three independent manuscript packets in parallel.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For every marked section state the exact methodological issue, severity, why it invalidates or weakens the claim, and the required bounded correction. Do not invent experiments or citations.",
        ...roots.map(
          ({ id }) => `${unitMarker(id)} Review all three marked sections under data/${id}/.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, issues }) =>
        issues.map((issue) =>
          file(
            `data/${id}/${issue.id}.txt`,
            `${itemMarker(issue.id)}\n${issue.evidence}\nThe rest of the section is internally consistent.\n`,
          ),
        ),
      ),
      outputRules: roots.flatMap(({ issues }) =>
        issues.map((issue) =>
          outputRule(issue.id, `${issue.id} identifies the exact review issue`, {
            allAny: paperReviewSemanticGroups(issue.issue),
            any: [
              "weakens",
              "invalidates",
              "bias",
              "confound",
              "standard error",
              "uncertainty",
              "not independent",
              "not establish",
              "does not identify",
              "contaminat",
              "inflate",
              "cannot support",
            ],
          }),
        ),
      ),
    } satisfies AddedDefinition;
  });
}

function paperReviewSemanticGroups(issue: string): readonly (readonly string[])[] {
  const severity = ["severity: major", "severity: critical", "major.", "critical."];
  if (issue === "test-set leakage") {
    return [
      ["test-set leakage", "test set before", "final test set", "test-set reuse"],
      severity,
      [
        "separate validation set",
        "training/validation data",
        "training/development data",
        "untouched test set",
        "nested cross-validation",
      ],
    ];
  }
  if (issue === "unit-of-analysis error") {
    return [
      ["unit-of-analysis error", "pseudoreplication", "repeated observations", "independent units"],
      severity,
      [
        "participant-level or mixed-effects analysis",
        "participant-level dependence",
        "participant-level clustering",
        "participant clustering",
        "participant level",
        "mixed-effects model",
        "repeated-measures",
        "repeated measures",
        "cluster-aware analysis",
      ],
    ];
  }
  if (issue === "unsupported causal claim") {
    return [
      [
        "unsupported causal claim",
        "unsupported causal inference",
        "causal overstatement",
        "retrospective",
      ],
      severity,
      [
        "associational wording",
        "association claim",
        "association statement",
        "as an association",
        "associative language",
        "qualified associational language",
      ],
    ];
  }
  throw new Error(`unknown paper-review issue ${issue}`);
}

function sheetDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `sheet-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const rows = [
        { product: "Atlas", units: 12 + instanceIndex + rootIndex, price: 18 },
        { product: "Beacon", units: 8 + instanceIndex * 2 + rootIndex, price: 27 },
        { product: "Cascade", units: 15 + instanceIndex + rootIndex * 2, price: 14 },
      ];
      const revenue = rows.map((row) => ({ ...row, revenue: row.units * row.price }));
      const total = revenue.reduce((sum, row) => sum + row.revenue, 0);
      const units = revenue.reduce((sum, row) => sum + row.units, 0);
      const top = [...revenue].sort((left, right) => right.revenue - left.revenue)[0]!;
      const output = `data/${id}/analysis.xlsx`;
      const result = `data/${id}/result.json`;
      return { id, rows, revenue, total, units, top, output, result };
    });
    return {
      familyId: "office-sheet",
      instanceId: `office-sheet-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `three-independent-workbooks-${instanceIndex + 1}`,
      access: "workspaceWrite",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Create three independent editable XLSX analysis workbooks in parallel.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each root, read sales.csv, calculate revenue per product, total units, total revenue, and the top product by revenue.",
        "Write result.json with {rows:[[...]]}; its first row must be Product, Units, Unit Price, Revenue, followed by the three products and summary rows Total Units, Total Revenue, Top Product.",
        "Then run exactly: python3 build_office.py xlsx result.json analysis.xlsx from that root. Preserve exact numbers; do not replace the workbook with prose.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Own and complete only data/${id}/ including data/${id}/analysis.xlsx.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, rows }) => [
        file(
          `data/${id}/sales.csv`,
          `Product,Units,Unit Price\n${rows.map((row) => `${row.product},${row.units},${row.price}`).join("\n")}\n`,
        ),
        file(`data/${id}/build_office.py`, OFFICE_BUILDER_SOURCE, 0o755),
        file(
          `data/${id}/README.txt`,
          "Build result.json, then run: python3 build_office.py xlsx result.json analysis.xlsx\n",
        ),
      ]),
      commandChecks: roots.flatMap(({ id, revenue, total, units, top, output, result }) => [
        fileCheck(`${id}-json`, result, [
          "Product",
          "Total Units",
          String(units),
          "Total Revenue",
          String(total),
          "Top Product",
          top.product,
          ...revenue.flatMap((row) => [row.product, String(row.revenue)]),
        ]),
        officeCheck(`${id}-xlsx-content`, output, [
          "Product",
          "Total Units",
          String(units),
          "Total Revenue",
          String(total),
          "Top Product",
          top.product,
        ]),
      ]),
      deliverables: roots.map(({ id, output }) => ({ id: `${id}-workbook`, path: output })),
    } satisfies AddedDefinition;
  });
}

function documentDefinitions(): AddedDefinition[] {
  const owners = ["Mina", "Owen", "Ravi", "Inez", "Chen", "Sal"] as const;
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `document-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const cap = 180 + instanceIndex * 12 + rootIndex * 7;
      const selected = cap - 11;
      const rejected = cap + 16;
      const weeks = 8 + ((instanceIndex + rootIndex) % 3);
      const owner = owners[(instanceIndex * 2 + rootIndex) % owners.length]!;
      const due = `2026-10-${String(12 + instanceIndex * 3 + rootIndex).padStart(2, "0")}`;
      const output = `data/${id}/decision.docx`;
      const result = `data/${id}/result.json`;
      const expected = [
        "Select Option B",
        "Option A",
        "Option B",
        `$${cap},000`,
        `$${selected},000`,
        "$11,000",
        `$${rejected},000`,
        "$16,000",
        `${weeks} weeks`,
        owner,
        due,
      ];
      return { id, cap, selected, rejected, weeks, owner, due, output, result, expected };
    });
    return {
      familyId: "office-document",
      instanceId: `office-document-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `three-independent-docx-decisions-${instanceIndex + 1}`,
      access: "workspaceWrite",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Create three independent editable DOCX decision records in parallel.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each root, apply every mandatory constraint. Write result.json as {paragraphs:[...]}, preserving the exact decision, both option costs, cap, margin/overage, deadline, owner, and due date from brief.txt.",
        "Then run exactly: python3 build_office.py docx result.json decision.docx from that root. Do not replace the DOCX with prose.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Own and complete only data/${id}/ including data/${id}/decision.docx.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, cap, selected, rejected, weeks, owner, due }) => [
        file(
          `data/${id}/brief.txt`,
          [
            `Mandatory budget cap: $${cap},000. Mandatory deadline: ${weeks} weeks. No waiver.`,
            `Option A: $${rejected},000 and ${weeks - 1} weeks. Option B: $${selected},000 and ${weeks} weeks. Benefits are equivalent.`,
            `${owner} owns final confirmation due ${due}.`,
          ].join("\n") + "\n",
        ),
        file(`data/${id}/build_office.py`, OFFICE_BUILDER_SOURCE, 0o755),
        file(
          `data/${id}/README.txt`,
          "Build result.json, then run: python3 build_office.py docx result.json decision.docx\n",
        ),
      ]),
      commandChecks: roots.flatMap(({ id, output, result, expected }) => [
        fileCheck(`${id}-json`, result, expected),
        officeCheck(`${id}-docx-content`, output, expected),
      ]),
      deliverables: roots.map(({ id, output }) => ({ id: `${id}-document`, path: output })),
    } satisfies AddedDefinition;
  });
}

function slideDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `slides-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const completion = 62 + instanceIndex * 5 + rootIndex * 4;
      const budget = 420 + instanceIndex * 35 + rootIndex * 20;
      const spent = budget - (55 + rootIndex * 4);
      const owner = ["Mina", "Owen", "Ravi"][(instanceIndex + rootIndex) % 3]!;
      const output = `data/${id}/update.pptx`;
      const result = `data/${id}/result.json`;
      const expected = [
        id,
        `${completion}%`,
        `$${budget},000`,
        `$${spent},000`,
        "supplier delay",
        owner,
        "2026-11-15",
      ];
      return { id, completion, budget, spent, owner, output, result, expected };
    });
    return {
      familyId: "office-slides",
      instanceId: `office-slides-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `three-independent-pptx-updates-${instanceIndex + 1}`,
      access: "workspaceWrite",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Create three independent editable PPTX program updates in parallel.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each root write result.json as {slides:[{title,bullets}]}. Create exactly three slides: Executive Status, Budget and Delivery, Risks and Actions. Preserve every exact measurement, owner, risk, and date.",
        "Then run exactly: python3 build_office.py pptx result.json update.pptx from that root. Do not return a slide outline instead of the PPTX.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Own and complete only data/${id}/ including data/${id}/update.pptx.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, completion, budget, spent, owner }) => [
        file(
          `data/${id}/brief.txt`,
          [
            `Program ${id}. Completion ${completion}%.`,
            `Approved budget $${budget},000; spent $${spent},000. Next gate 2026-11-15.`,
            `Primary risk: supplier delay. ${owner} owns mitigation.`,
          ].join("\n") + "\n",
        ),
        file(`data/${id}/build_office.py`, OFFICE_BUILDER_SOURCE, 0o755),
        file(
          `data/${id}/README.txt`,
          "Build result.json, then run: python3 build_office.py pptx result.json update.pptx\n",
        ),
      ]),
      commandChecks: roots.flatMap(({ id, output, result, expected }) => [
        fileCheck(`${id}-json`, result, [
          "Executive Status",
          "Budget and Delivery",
          "Risks and Actions",
          ...expected,
        ]),
        officeCheck(`${id}-pptx-content`, output, [
          "Executive Status",
          "Budget and Delivery",
          "Risks and Actions",
          ...expected,
        ]),
      ]),
      deliverables: roots.map(({ id, output }) => ({ id: `${id}-deck`, path: output })),
    } satisfies AddedDefinition;
  });
}

function recoveryDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `recovery-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const jobs = Array.from({ length: 5 }, (_, jobIndex) => ({
        id: `${id}-job-${jobIndex + 1}`,
        amount: 40 + instanceIndex * 7 + rootIndex * 5 + jobIndex * 3,
        state: jobIndex < 2 ? "committed" : jobIndex === 2 ? "started" : "pending",
      }));
      const remaining = jobs.filter((job) => job.state !== "committed");
      const total = remaining.reduce((sum, job) => sum + job.amount, 0);
      return { id, jobs, remaining, total };
    });
    return {
      familyId: "auto-recovery",
      evaluationClass: "direct-fast-path",
      instanceId: `auto-recovery-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `three-idempotent-resume-ledgers-${instanceIndex + 1}`,
      access: "readOnly",
      decomposition: "independent",
      citationPolicy: "none",
      prompt: [
        "Resume three independent interrupted ledgers from their durable checkpoints without repeating committed side effects.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each ledger list committed IDs that must be skipped, remaining IDs in execution order, exact remaining amount, and the idempotency key for every remaining job. A started but uncommitted job must be resumed, not skipped. Preserve every item marker.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Recover only the ledger under data/${id}/ and return ${itemMarker(id)}.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, jobs }) => [
        file(
          `data/${id}/checkpoint.json`,
          `${JSON.stringify(
            {
              marker: itemMarker(id),
              crashAfter: jobs[2]!.id,
              jobs: jobs.map((job) => ({ ...job, idempotencyKey: `idem:${job.id}` })),
            },
            null,
            2,
          )}\n`,
        ),
        file(
          `data/${id}/policy.txt`,
          "Committed jobs are durable and must never be replayed. Started without commit is incomplete and must resume. Pending jobs follow in input order.\n",
        ),
      ]),
      outputRules: roots.map(({ id, jobs, remaining, total }) =>
        outputRule(id, `${id} resumes without duplicate side effects`, {
          allAny: [
            ["committed ids to skip", "skip committed", "committed jobs must be skipped"],
            ["remaining execution order", "remaining ids in execution order"],
            [
              `remaining amount ${total}`,
              `remaining amount: ${total}`,
              `remaining amount: ${remaining.map((job) => job.amount).join(" + ")} = ${total}`,
            ],
          ],
          all: [
            ...jobs.slice(0, 2).map((job) => job.id),
            ...remaining.flatMap((job) => [job.id, `idem:${job.id}`]),
          ],
          none: jobs.slice(0, 2).map((job) => `execute ${job.id}`),
        }),
      ),
    } satisfies AddedDefinition;
  });
}

function pipelineDefinitions(): AddedDefinition[] {
  return Array.from({ length: 3 }, (_, instanceIndex) => {
    const roots = Array.from({ length: 3 }, (_, rootIndex) => {
      const id = `pipeline-${instanceIndex + 1}${String.fromCharCode(97 + rootIndex)}`;
      const values = [
        18 + instanceIndex + rootIndex,
        24 + instanceIndex * 2 + rootIndex,
        31 + instanceIndex + rootIndex * 2,
        27 + instanceIndex * 2 + rootIndex * 2,
      ];
      const total = values.reduce((sum, value) => sum + value, 0);
      const average = (total / values.length).toFixed(2);
      const maximum = Math.max(...values);
      const outputJson = `data/${id}/metrics.json`;
      const outputMarkdown = `data/${id}/summary.md`;
      return { id, values, total, average, maximum, outputJson, outputMarkdown };
    });
    return {
      familyId: "auto-pipeline",
      evaluationClass: "direct-fast-path",
      instanceId: `auto-pipeline-authored-${String(instanceIndex + 1).padStart(2, "0")}`,
      seed: `three-cross-artifact-pipelines-${instanceIndex + 1}`,
      access: "workspaceWrite",
      decomposition: "independent",
      citationPolicy: "frozen-required",
      prompt: [
        "Run three independent frozen-source pipelines in parallel.",
        `Roots: ${roots.map((root) => `data/${root.id}/`).join(", ")}.`,
        "For each root, read observations.csv and source.txt. Write metrics.json containing exact total, average to two decimals, maximum, and sourceId. Write summary.md containing the same values, the exact source citation in brackets, and one sentence comparing maximum with average. Do not modify inputs.",
        ...roots.map(
          ({ id }) =>
            `${unitMarker(id)} Own only data/${id}/ and create metrics.json plus summary.md there.`,
        ),
      ].join("\n"),
      files: roots.flatMap(({ id, values }) => [
        file(
          `data/${id}/observations.csv`,
          `period,value\n${values.map((value, index) => `P${index + 1},${value}`).join("\n")}\n`,
        ),
        file(
          `data/${id}/source.txt`,
          `[SRC-${id.toUpperCase()}] Frozen operational export captured 2026-08-30.\n`,
        ),
      ]),
      commandChecks: roots.flatMap(
        ({ id, total, average, maximum, outputJson, outputMarkdown }) => [
          fileCheck(`${id}-json`, outputJson, [
            String(total),
            average,
            String(maximum),
            `SRC-${id.toUpperCase()}`,
          ]),
          fileCheck(`${id}-markdown`, outputMarkdown, [
            "total",
            String(total),
            "average",
            average,
            "maximum",
            String(maximum),
            `[SRC-${id.toUpperCase()}]`,
          ]),
        ],
      ),
      deliverables: roots.flatMap(({ id, outputJson, outputMarkdown }) => [
        { id: `${id}-metrics`, path: outputJson },
        { id: `${id}-summary`, path: outputMarkdown },
      ]),
    } satisfies AddedDefinition;
  });
}

const GOLD_IMPLEMENTATIONS: Readonly<Record<string, string>> = {
  "coding-local-authored-01": String.raw`export function parseRecord(line) {
  if (typeof line !== "string") throw new TypeError("line");
  const fields = []; let field = ""; let quoted = false; let afterQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') { quoted = false; afterQuote = true; }
      else field += character;
    } else if (afterQuote) {
      if (character === ',') { fields.push(field); field = ""; afterQuote = false; }
      else if (!/\s/u.test(character)) throw new TypeError("characters after closing quote");
    } else if (character === ',' ) { fields.push(field.trim()); field = ""; }
    else if (character === '"' && field.trim() === "") { field = ""; quoted = true; }
    else field += character;
  }
  if (quoted) throw new TypeError("unterminated quote");
  fields.push(afterQuote ? field : field.trim());
  return fields;
}
`,
  "coding-local-authored-02": String.raw`export function createCache(now = Date.now) {
  const entries = new Map();
  return {
    set(key, value, ttlMs) {
      if (!Number.isInteger(ttlMs) || ttlMs < 0) throw new TypeError("ttlMs");
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) { entries.delete(key); return undefined; }
      return entry.value;
    },
  };
}
`,
  "coding-local-authored-03": String.raw`export function allocate(total, weights) {
  if (!Number.isInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0 ||
      weights.some((value) => !Number.isFinite(value) || value < 0)) throw new TypeError("invalid allocation");
  const sum = weights.reduce((left, right) => left + right, 0);
  if (sum === 0) throw new TypeError("zero weights");
  const quotas = weights.map((weight) => total * weight / sum);
  const result = quotas.map(Math.floor);
  const order = quotas.map((quota, index) => ({ index, remainder: quota - result[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = result.reduce((left, right) => left + right, 0); index < total; index += 1) result[order[index - result.reduce((left, right) => left + right, 0)]?.index ?? order[0].index] += 1;
  return result;
}
`,
  ledger: String.raw`export function postTransactions(openingBalances, transactions) {
  const balances = { ...openingBalances }; const seen = new Set(); const acceptedIds = []; const rejected = [];
  for (const transaction of transactions) {
    let reason;
    if (seen.has(transaction.id)) reason = "duplicate";
    else { seen.add(transaction.id); if (!(transaction.from in balances) || !(transaction.to in balances)) reason = "account";
      else if (!Number.isInteger(transaction.amountCents) || transaction.amountCents <= 0) reason = "amount";
      else if (transaction.from === transaction.to) reason = "same_account";
      else if (balances[transaction.from] < transaction.amountCents) reason = "insufficient"; }
    if (reason) { rejected.push({ id: transaction.id, reason }); continue; }
    balances[transaction.from] -= transaction.amountCents; balances[transaction.to] += transaction.amountCents; acceptedIds.push(transaction.id);
  }
  return { balances, acceptedIds, rejected };
}
`,
  "time-slots": String.raw`const parse = (value) => { const time = Date.parse(value); if (!Number.isFinite(time)) throw new TypeError("date"); return time; };
const iso = (value) => new Date(value).toISOString();
export function mergeBusy(intervals) {
  const sorted = intervals.map(({ start, end }) => ({ start: parse(start), end: parse(end) })).map((item) => { if (item.end < item.start) throw new TypeError("interval"); return item; }).sort((a,b) => a.start-b.start || a.end-b.end);
  const merged = []; for (const item of sorted) { const last = merged.at(-1); if (last && item.start <= last.end) last.end = Math.max(last.end, item.end); else merged.push({ ...item }); }
  return merged.map(({ start, end }) => ({ start: iso(start), end: iso(end) }));
}
export function findFree(intervals, rangeStart, rangeEnd, durationMinutes) {
  const start = parse(rangeStart), end = parse(rangeEnd); if (end < start || !Number.isInteger(durationMinutes) || durationMinutes <= 0) throw new TypeError("range");
  const duration = durationMinutes * 60000; const busy = mergeBusy(intervals).map((item) => ({ start: Math.max(start, parse(item.start)), end: Math.min(end, parse(item.end)) })).filter((item) => item.end > start && item.start < end);
  const result = []; let cursor = start; for (const item of busy) { while (cursor + duration <= item.start) { result.push({ start: iso(cursor), end: iso(cursor + duration) }); cursor += duration; } cursor = Math.max(cursor, item.end); }
  while (cursor + duration <= end) { result.push({ start: iso(cursor), end: iso(cursor + duration) }); cursor += duration; } return result;
}
`,
  "query-engine": String.raw`const get = (row, field) => Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined;
function matches(row, expression) { if (!expression) return true; if (expression.and) return expression.and.every((item) => matches(row,item)); if (expression.or) return expression.or.some((item) => matches(row,item)); if (expression.not) return !matches(row,expression.not); const present = Object.prototype.hasOwnProperty.call(row, expression.field); const actual = get(row, expression.field), expected = expression.value; if (!present) return expression.op === "ne"; switch(expression.op) { case "eq": return actual === expected; case "ne": return actual !== expected; case "gt": return actual > expected; case "gte": return actual >= expected; case "lt": return actual < expected; case "lte": return actual <= expected; case "in": return Array.isArray(expected) && expected.includes(actual); case "contains": return typeof actual === "string" ? actual.includes(expected) : Array.isArray(actual) && actual.includes(expected); default: throw new TypeError("operator"); } }
export function applyQuery(rows, query = {}) { const offset = query.offset ?? 0, limit = query.limit ?? Infinity; if (!Number.isInteger(offset) || offset < 0 || !(limit === Infinity || Number.isInteger(limit) && limit >= 0)) throw new TypeError("range"); let result = rows.filter((row) => matches(row, query.where)).map((row,index)=>({row,index})); if (query.sort) result.sort((left,right)=>{ for(const spec of query.sort){ const a=get(left.row,spec.field), b=get(right.row,spec.field); const an=a==null,bn=b==null; if(an||bn){if(an!==bn)return an?1:-1; continue;} if(a<b)return spec.direction==="desc"?1:-1; if(a>b)return spec.direction==="desc"?-1:1;} return left.index-right.index; }); return result.slice(offset, offset + limit).map((item)=>item.row); }
`,
  inventory: String.raw`export function createInventory(initial) { const stock={...initial};if(Object.entries(stock).some(([sku,value])=>!sku||!Number.isInteger(value)||value<0))throw new TypeError("initial");const reservations=new Map();const normalize=(lines)=>{if(!Array.isArray(lines)||lines.length===0)return null;const result={};for(const line of lines){if(!line||typeof line.sku!=="string"||!Number.isInteger(line.quantity)||line.quantity<=0)return null;result[line.sku]=(result[line.sku]??0)+line.quantity;}return Object.entries(result).sort(([a],[b])=>a.localeCompare(b)).map(([sku,quantity])=>({sku,quantity}));};const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);return{reserve(orderId,lines){const normalized=normalize(lines);if(!normalized)return{ok:false,reason:"invalid"};const existing=reservations.get(orderId);if(existing)return same(existing.lines,normalized)?{ok:true,repeated:true}:{ok:false,reason:"invalid"};if(normalized.some(line=>!(line.sku in stock)))return{ok:false,reason:"unknown_sku"};if(normalized.some(line=>stock[line.sku]<line.quantity))return{ok:false,reason:"insufficient"};for(const line of normalized)stock[line.sku]-=line.quantity;reservations.set(orderId,{lines:normalized});return{ok:true,repeated:false};},release(orderId){const item=reservations.get(orderId);if(!item)return false;for(const line of item.lines)stock[line.sku]+=line.quantity;reservations.delete(orderId);return true;},commit(orderId){if(!reservations.has(orderId))return false;reservations.delete(orderId);return true;},available(sku){return stock[sku];},snapshot(){return{stock:Object.fromEntries(Object.entries(stock).sort(([a],[b])=>a.localeCompare(b))),reservations:[...reservations].sort(([a],[b])=>a.localeCompare(b)).map(([orderId,item])=>({orderId,lines:item.lines.map(line=>({...line}))}))};}};}
`,
  csv: String.raw`export function parseCsv(text) { if (text === "") return []; const rows=[], row=[]; let field="", quoted=false, after=false; const pushField=()=>{row.push(field);field="";after=false;}; const pushRow=()=>{rows.push(row.splice(0));}; for(let i=0;i<text.length;i+=1){const c=text[i]; if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i+=1;}else if(c==='"'){quoted=false;after=true;}else field+=c;}else if(after){if(c===',')pushField();else if(c==='\n'){pushField();pushRow();}else if(c==='\r'&&text[i+1]==='\n'){i+=1;pushField();pushRow();}else throw new SyntaxError("quote");}else if(c===',')pushField();else if(c==='\n'){pushField();pushRow();}else if(c==='\r'&&text[i+1]==='\n'){i+=1;pushField();pushRow();}else if(c==='"'){if(field!=="")throw new SyntaxError("quote");quoted=true;}else field+=c;} if(quoted)throw new SyntaxError("quote"); if(field!==""||row.length>0||after){pushField();pushRow();} return rows; }
export function stringifyCsv(rows){return rows.map(row=>row.map(value=>{const text=value==null?"":String(value);return /[,"\r\n]/u.test(text)?'"'+text.replaceAll('"','""')+'"':text;}).join(',')).join('\n');}
`,
  "dependency-graph": String.raw`export function analyzeGraph(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges) || new Set(nodes).size !== nodes.length || nodes.some((node) => typeof node !== "string")) throw new TypeError("nodes");
  const nodeSet = new Set(nodes);
  const outgoing = Object.fromEntries(nodes.map((node) => [node, new Set()]));
  const incoming = Object.fromEntries(nodes.map((node) => [node, new Set()]));
  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length !== 2 || !nodeSet.has(edge[0]) || !nodeSet.has(edge[1]) || edge[0] === edge[1]) throw new TypeError("edge");
    outgoing[edge[0]].add(edge[1]);
    incoming[edge[1]].add(edge[0]);
  }

  const remaining = new Set(nodes);
  const layers = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((node) => [...incoming[node]].every((parent) => !remaining.has(parent))).sort();
    if (ready.length === 0) {
      const visited = new Set();
      const visiting = new Set();
      const path = [];
      const visit = (node) => {
        visited.add(node); visiting.add(node); path.push(node);
        for (const next of [...outgoing[node]].filter((candidate) => remaining.has(candidate)).sort()) {
          if (visiting.has(next)) {
            const body = path.slice(path.indexOf(next));
            const minimum = [...body].sort()[0];
            const index = body.indexOf(minimum);
            return body.slice(index).concat(body.slice(0, index), minimum);
          }
          if (!visited.has(next)) {
            const cycle = visit(next);
            if (cycle !== undefined) return cycle;
          }
        }
        path.pop(); visiting.delete(node);
        return undefined;
      };
      for (const node of [...remaining].sort()) {
        if (visited.has(node)) continue;
        const cycle = visit(node);
        if (cycle !== undefined) return { cycle };
      }
      throw new Error("cycle expected");
    }
    layers.push(ready);
    for (const node of ready) remaining.delete(node);
  }

  const order = [];
  const unordered = new Set(nodes);
  while (unordered.size > 0) {
    const next = [...unordered].filter((node) => [...incoming[node]].every((parent) => !unordered.has(parent))).sort()[0];
    order.push(next); unordered.delete(next);
  }
  const ancestors = {};
  const collect = (node, seen = new Set()) => {
    for (const parent of incoming[node]) if (!seen.has(parent)) { seen.add(parent); collect(parent, seen); }
    return seen;
  };
  for (const node of nodes) ancestors[node] = [...collect(node)].sort();
  return { order, layers, ancestors };
}
`,
  "event-windows": String.raw`export function aggregateWindows(events, options) { const size=options?.sizeMinutes;if(!Number.isInteger(size)||size<=0)throw new TypeError("size");const reducer=options.reducer??"sum",origin=options.origin===undefined?0:Date.parse(options.origin);if(!Number.isFinite(origin)||!["sum","count","min","max","avg"].includes(reducer))throw new TypeError("options");const groups=new Map();for(const event of events){const time=Date.parse(event.timestamp);if(!Number.isFinite(time)||typeof event.key!=="string"||!Number.isFinite(event.value))throw new TypeError("event");const span=size*60000,start=origin+Math.floor((time-origin)/span)*span,key=start+"\0"+event.key,list=groups.get(key)??[];list.push(event.value);groups.set(key,list);}return [...groups].map(([key,values])=>{const [startText,name]=key.split("\0"),start=Number(startText),sum=values.reduce((a,b)=>a+b,0);const value=reducer==="sum"?sum:reducer==="count"?values.length:reducer==="min"?Math.min(...values):reducer==="max"?Math.max(...values):sum/values.length;return {key:name,start:new Date(start).toISOString(),end:new Date(start+size*60000).toISOString(),value,count:values.length};}).sort((a,b)=>a.start.localeCompare(b.start)||a.key.localeCompare(b.key)); }
`,
  router: String.raw`export function createRouter(routes){const seen=new Set();const compiled=routes.map((route,index)=>{if(typeof route.pattern!=="string"||!route.pattern.startsWith("/"))throw new TypeError("pattern");const key=route.method.toLowerCase()+"\0"+route.pattern;if(seen.has(key))throw new TypeError("duplicate");seen.add(key);const segments=route.pattern.split("/").slice(1),names=[];segments.forEach((part,i)=>{if(part.startsWith(":" )||part.startsWith("*")){const name=part.slice(1);if(!name||names.includes(name)||part.startsWith("*")&&i!==segments.length-1)throw new TypeError("parameter");names.push(name);}});return {...route,index,method:route.method.toLowerCase(),segments,literals:segments.filter(x=>!x.startsWith(":")&&!x.startsWith("*")).length,wildcards:segments.filter(x=>x.startsWith("*")).length,parameters:segments.filter(x=>x.startsWith(":")).length};}).sort((a,b)=>b.literals-a.literals||a.wildcards-b.wildcards||a.parameters-b.parameters||a.index-b.index);return{match(method,url){let parts;try{parts=url.split(/[?#]/u)[0].split("/").slice(1).map(decodeURIComponent);}catch{return null;}for(const route of compiled){if(route.method!==method.toLowerCase())continue;const params={};let ok=true,index=0;for(;index<route.segments.length;index+=1){const segment=route.segments[index];if(segment.startsWith("*")){params[segment.slice(1)]=parts.slice(index).join("/");index=parts.length;break;}if(index>=parts.length){ok=false;break;}if(segment.startsWith(":"))params[segment.slice(1)]=parts[index];else if(segment!==parts[index]){ok=false;break;}}if(ok&&index===parts.length)return{value:route.value,params};}return null;}};}
`,
  "lru-cache": String.raw`export function createLruCache({capacity,ttlMs,now=Date.now}){if(!Number.isInteger(capacity)||capacity<=0||!Number.isFinite(ttlMs)||ttlMs<=0)throw new TypeError("options");const entries=new Map(),purge=()=>{for(const [key,item] of entries)if(now()>=item.expires)entries.delete(key);},touch=(key,item)=>{entries.delete(key);entries.set(key,item);};return{set(key,value,ttl=ttlMs){if(!Number.isFinite(ttl)||ttl<=0)throw new TypeError("ttl");purge();touch(key,{value,expires:now()+ttl});while(entries.size>capacity)entries.delete(entries.keys().next().value);return this;},get(key){purge();if(!entries.has(key))return undefined;const item=entries.get(key);touch(key,item);return item.value;},has(key){purge();if(!entries.has(key))return false;touch(key,entries.get(key));return true;},delete:key=>entries.delete(key),clear:()=>entries.clear(),get size(){purge();return entries.size;},keys(){purge();return [...entries.keys()].reverse();}};}
`,
  retry: String.raw`export async function retry(operation,options={}){const retries=options.retries??0,base=options.baseDelayMs??0,max=options.maxDelayMs??Infinity,factor=options.factor??1,jitter=options.jitter??0,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),random=options.random??Math.random,should=options.shouldRetry??(()=>true);if(!Number.isInteger(retries)||retries<0||!Number.isFinite(base)||base<0||!(max===Infinity||Number.isFinite(max)&&max>=0)||!Number.isFinite(factor)||factor<1||!Number.isFinite(jitter)||jitter<0||jitter>1)throw new TypeError("options");let last;for(let attempt=0;attempt<=retries;attempt+=1){try{return{value:await operation(attempt),attempts:attempt+1};}catch(error){last=error;if(attempt===retries||!should(error,attempt)){Object.defineProperty(error,"attempts",{value:attempt+1,configurable:true});throw error;}const raw=Math.min(max,base*factor**attempt),delay=raw*(1-jitter+2*jitter*random());await sleep(delay);}}throw last;}
`,
};

function regexWitness(pattern: string): string {
  const cost = pattern.match(/\{0,12\}(\d+)\\b/u)?.[1];
  if (cost !== undefined) return `minimum cost ${cost}`;
  if (pattern.includes("a\\s*(?:->")) return "A -> B -> C -> F";
  if (pattern === "(?:edge|sum|check)") return "edge sum check";
  if (pattern.includes("beta") && pattern.includes("only|sole")) return "only beta";
  if (pattern.startsWith("alpha")) return "alpha fails by 2 percentage points";
  if (pattern.startsWith("(?:score|evaluation)")) return "score shortfall 2 points";
  if (pattern.startsWith("deploy")) return "deployment exceeds by 2 weeks";
  if (pattern.includes("aurora") && pattern.includes("only|sole")) return "only aurora";
  if (pattern.includes("10000")) return "short by $10000";
  if (pattern.includes("impact gap")) return "impact gap 40";
  if (pattern.startsWith("duration")) return "duration exceeds by 6 months";
  throw new Error(`no authored qualification witness for regex ${pattern}`);
}

function outputFixtureFromValidator(
  validator: ReturnType<typeof parseSealedBenchmarkValidatorV1>,
): string {
  const groups = new Map<string, { text: string[]; minWords: number; forbidden: Set<string> }>();
  for (const check of validator.commandChecks) {
    if (check.argv[0] !== "node" || check.argv[1] !== "-e" || check.argv.length < 4) continue;
    let rule: Record<string, unknown>;
    try {
      rule = JSON.parse(check.argv[3]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rule["anchor"] !== "string") continue;
    const anchor = rule["anchor"];
    const group = groups.get(anchor) ?? { text: [], minWords: 0, forbidden: new Set<string>() };
    for (const value of stringArray(rule["all"])) group.text.push(value);
    for (const alternatives of nestedStringArray(rule["allAny"])) {
      if (alternatives[0] !== undefined) group.text.push(alternatives[0]);
    }
    const any = stringArray(rule["any"]);
    if (any[0] !== undefined) group.text.push(any[0]);
    for (const pattern of stringArray(rule["regex"])) group.text.push(regexWitness(pattern));
    for (const value of [...stringArray(rule["none"]), ...stringArray(rule["noneUnlessNegated"])]) {
      group.forbidden.add(value.toLowerCase());
    }
    if (typeof rule["minWords"] === "number")
      group.minWords = Math.max(group.minWords, rule["minWords"]);
    groups.set(anchor, group);
  }
  return [...groups]
    .map(([anchor, group]) => {
      const parts = [anchor, ...group.text];
      while (parts.slice(1).join(" ").split(/\s+/u).filter(Boolean).length < group.minWords) {
        parts.push("careful bounded evidence statement");
      }
      const section = parts.join(" ");
      for (const forbidden of group.forbidden) {
        if (section.toLowerCase().includes(forbidden)) {
          throw new Error(`gold fixture accidentally contains forbidden phrase ${forbidden}`);
        }
      }
      return section;
    })
    .join("\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function nestedStringArray(value: unknown): string[][] {
  return Array.isArray(value) ? value.map(stringArray).filter((item) => item.length > 0) : [];
}

function goldFixtureFor(
  instance: Readonly<BenchmarkCorpusInstance>,
  snapshot: Readonly<{ files: readonly WorkspaceFile[] }>,
  validator: ReturnType<typeof parseSealedBenchmarkValidatorV1>,
): QualificationFixture {
  const output = outputFixtureFromValidator(validator);
  const writes: QualificationWrite[] = [];
  const commands: QualificationCommand[] = [];
  if (instance.familyId === "coding-local-bugfix") {
    const implementation = GOLD_IMPLEMENTATIONS[instance.instanceId];
    if (implementation === undefined)
      throw new Error(`missing gold implementation for ${instance.instanceId}`);
    writes.push({ path: "src/index.mjs", contentUtf8: implementation });
  } else if (instance.familyId === "coding-cross-module") {
    for (const file of snapshot.files.filter((candidate) =>
      candidate.path.endsWith("/index.mjs"),
    )) {
      const moduleName = file.path.split("/").at(-2)!;
      const implementation = GOLD_IMPLEMENTATIONS[moduleName];
      if (implementation === undefined)
        throw new Error(`missing gold implementation for ${moduleName}`);
      writes.push({ path: file.path, contentUtf8: implementation });
    }
  } else if (
    instance.familyId === "office-sheet" ||
    instance.familyId === "office-document" ||
    instance.familyId === "office-slides"
  ) {
    const kind =
      instance.familyId === "office-sheet"
        ? "xlsx"
        : instance.familyId === "office-document"
          ? "docx"
          : "pptx";
    for (const deliverable of validator.requiredDeliverables) {
      const root = dirname(deliverable.path);
      const resultPath = join(root, "result.json");
      const expected = expectedForFileCheck(validator, resultPath);
      const spec =
        kind === "xlsx"
          ? { rows: expected.map((value) => [value]) }
          : kind === "docx"
            ? { paragraphs: expected }
            : {
                slides: [
                  { title: "Executive Status", bullets: expected },
                  { title: "Budget and Delivery", bullets: expected },
                  { title: "Risks and Actions", bullets: expected },
                ],
              };
      writes.push({ path: resultPath, contentUtf8: `${JSON.stringify(spec, null, 2)}\n` });
      commands.push({
        cwd: root,
        argv: [
          "python3",
          "build_office.py",
          kind,
          "result.json",
          deliverable.path.slice(root.length + 1),
        ],
      });
    }
  } else if (instance.familyId === "auto-pipeline") {
    for (const check of validator.commandChecks) {
      if (check.argv[0] !== "node" || check.argv[1] !== "-e" || check.argv.length < 5) continue;
      const path = check.argv[3]!;
      const expected = parseExpectedValues(check.argv[4]!);
      writes.push({
        path,
        contentUtf8: path.endsWith(".json")
          ? `${JSON.stringify({ qualification: expected }, null, 2)}\n`
          : `${expected.join("\n")}\n`,
      });
    }
  }
  return { id: "gold", output, writes, commands, deletes: [] };
}

function expectedForFileCheck(
  validator: ReturnType<typeof parseSealedBenchmarkValidatorV1>,
  path: string,
): string[] {
  const check = validator.commandChecks.find(
    (candidate) =>
      candidate.argv[0] === "node" && candidate.argv[1] === "-e" && candidate.argv[3] === path,
  );
  if (check?.argv[4] === undefined) throw new Error(`missing file qualification check for ${path}`);
  return parseExpectedValues(check.argv[4]);
}

function parseExpectedValues(source: string): string[] {
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("qualification expected values must be strings");
  }
  return parsed as string[];
}

function mutantFixturesFor(
  gold: Readonly<QualificationFixture>,
  snapshot: Readonly<{ files: readonly WorkspaceFile[] }>,
  validator: ReturnType<typeof parseSealedBenchmarkValidatorV1>,
): [QualificationFixture, QualificationFixture] {
  if (gold.writes.length === 0 && gold.commands.length === 0) {
    const anchors = validator.commandChecks.flatMap((check) => {
      try {
        const rule = JSON.parse(check.argv[3] ?? "null") as Record<string, unknown> | null;
        return rule !== null && typeof rule["anchor"] === "string" ? [rule["anchor"]] : [];
      } catch {
        return [];
      }
    });
    const uniqueAnchors = [...new Set(anchors)];
    const firstOutput = removeToken(gold.output, uniqueAnchors[0] ?? "[item:");
    const secondOutput =
      uniqueAnchors[1] === undefined
        ? `${uniqueAnchors[0] ?? "[item:mutant]"} intentionally incomplete`
        : removeToken(gold.output, uniqueAnchors[1]);
    return [
      { id: "mutant-wrong", output: firstOutput, writes: [], commands: [], deletes: [] },
      { id: "mutant-missing", output: secondOutput, writes: [], commands: [], deletes: [] },
    ];
  }
  if (gold.commands.length === 0) {
    const first = gold.writes[0]!;
    const original =
      snapshot.files.find((file) => file.path === first.path)?.contentUtf8 ?? "export {};\n";
    const second = gold.writes[1];
    return [
      {
        ...gold,
        id: "mutant-wrong",
        writes: gold.writes.map((write) =>
          write.path === first.path ? { ...write, contentUtf8: original } : write,
        ),
      },
      {
        ...gold,
        id: "mutant-missing",
        writes:
          second === undefined
            ? gold.writes.map((write) =>
                write.path === first.path ? { ...write, contentUtf8: "export {};\n" } : write,
              )
            : gold.writes.map((write) =>
                write.path === second.path ? { ...write, contentUtf8: "export {};\n" } : write,
              ),
      },
    ];
  }
  const firstDeliverable = validator.requiredDeliverables[0]?.path;
  const firstWrite = gold.writes[0]?.path;
  if (firstDeliverable === undefined || firstWrite === undefined) {
    throw new Error("command qualification requires a deliverable and result write");
  }
  return [
    {
      ...gold,
      id: "mutant-wrong",
      writes: gold.writes.map((write) =>
        write.path === firstWrite
          ? { ...write, contentUtf8: corruptStructuredQualification(write.contentUtf8) }
          : write,
      ),
    },
    { ...gold, id: "mutant-missing", deletes: [firstDeliverable] },
  ];
}

function corruptStructuredQualification(source: string): string {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  if (Array.isArray(parsed["rows"])) {
    parsed["rows"] = [["QUALIFICATION-WRONG"]];
  } else if (Array.isArray(parsed["paragraphs"])) {
    parsed["paragraphs"] = ["QUALIFICATION-WRONG"];
  } else if (Array.isArray(parsed["slides"])) {
    for (const slide of parsed["slides"]) {
      if (
        typeof slide === "object" &&
        slide !== null &&
        Array.isArray((slide as Record<string, unknown>)["bullets"])
      ) {
        (slide as Record<string, unknown>)["bullets"] = ["QUALIFICATION-WRONG"];
      }
    }
  } else {
    parsed["qualification"] = ["QUALIFICATION-WRONG"];
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function removeToken(source: string, token: string): string {
  const index = source.indexOf(token);
  return index < 0
    ? `${source}\nmutated`
    : `${source.slice(0, index)}[removed]${source.slice(index + token.length)}`;
}

async function qualifyInstances(
  instances: readonly BenchmarkCorpusInstance[],
  artifacts: Array<{ path: string; bytes: Uint8Array }>,
): Promise<BenchmarkCorpusInstance[]> {
  const artifactBytes = new Map(artifacts.map((artifact) => [artifact.path, artifact.bytes]));
  const qualified: BenchmarkCorpusInstance[] = [];
  // Office qualification can launch LibreOffice, whose resident set is several GiB. One instance
  // at a time keeps corpus generation below desktop memory limits; this is outside measured runs.
  const qualificationConcurrency = 1;
  for (let offset = 0; offset < instances.length; offset += qualificationConcurrency) {
    const batch = instances.slice(offset, offset + qualificationConcurrency);
    const results = await Promise.all(
      batch.map(async (instance) => {
        const workspaceSeal = instance.artifacts.find(
          (artifact) => artifact.role === "workspace_snapshot",
        )!;
        const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
        const workspaceBytes = artifactBytes.get(workspaceSeal.path);
        const validatorBytes = artifactBytes.get(validatorSeal.path);
        if (workspaceBytes === undefined || validatorBytes === undefined)
          throw new Error(`missing qualification inputs for ${instance.instanceId}`);
        const snapshot = JSON.parse(new TextDecoder().decode(workspaceBytes)) as {
          files: WorkspaceFile[];
        };
        const validatorValue = JSON.parse(new TextDecoder().decode(validatorBytes)) as unknown;
        const validator = parseSealedBenchmarkValidatorV1(validatorValue);
        const gold = goldFixtureFor(instance, snapshot, validator);
        const [wrong, missing] = mutantFixturesFor(gold, snapshot, validator);
        const evidence: QualificationEvidence[] = [];
        for (const fixture of [gold, wrong, missing]) {
          evidence.push(
            await executeQualification(
              instance,
              snapshot,
              validatorValue,
              validatorSeal.sha256,
              fixture,
            ),
          );
        }
        if (evidence[0]!.result.score !== 100) {
          const failures = evidence[0]!.result.checks
            .filter((check) => !check.passed)
            .map((check) => `${check.id}: ${check.summary}`)
            .join("; ");
          throw new Error(
            `${instance.familyId}/${instance.instanceId} gold qualification scored ${String(evidence[0]!.result.score)} (${failures})`,
          );
        }
        for (const mutant of evidence.slice(1)) {
          if (mutant.result.score >= 100)
            throw new Error(
              `${instance.familyId}/${instance.instanceId} ${mutant.fixture.id} was not rejected`,
            );
        }
        const base = `instances/${instance.familyId}/${instance.instanceId}/qualification`;
        const qualificationArtifacts: Array<{ path: string; bytes: Uint8Array }> = [];
        const seals = evidence.map((item) => {
          const bytes = new TextEncoder().encode(`${JSON.stringify(item, null, 2)}\n`);
          const path = `${base}/${item.fixture.id}.json`;
          qualificationArtifacts.push({ path, bytes });
          return {
            path,
            role: "input" as const,
            sha256: hashBenchmarkBytes(bytes),
            sizeBytes: bytes.byteLength,
          };
        });
        return {
          qualificationArtifacts,
          instance: {
            ...instance,
            validatorQualification: {
              goldSha256: seals[0]!.sha256,
              mutantSha256: [seals[1]!.sha256, seals[2]!.sha256],
            },
            artifacts: [...instance.artifacts, ...seals],
          },
        };
      }),
    );
    // Promise.all preserves batch order, so artifact and manifest output remain reproducible.
    for (const result of results) {
      artifacts.push(...result.qualificationArtifacts);
      qualified.push(result.instance);
    }
  }
  return qualified;
}

async function executeQualification(
  instance: Readonly<BenchmarkCorpusInstance>,
  snapshot: Readonly<{ files: readonly WorkspaceFile[] }>,
  validatorValue: unknown,
  validatorSha256: string,
  fixture: QualificationFixture,
): Promise<QualificationEvidence> {
  const workspace = await mkdtemp(join(tmpdir(), "agent-trio-authored-qualification-"));
  try {
    await materializeQualificationFiles(workspace, snapshot.files);
    await materializeQualificationFiles(workspace, fixture.writes);
    const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, fixture.output, "utf8");
    for (const command of fixture.commands) await runQualificationCommand(workspace, command);
    for (const path of fixture.deletes)
      await rm(resolveQualificationPath(workspace, path), { recursive: true, force: true });
    const result = await runSealedBenchmarkValidator(validatorValue, { workspace });
    return qualificationEvidence(
      `${instance.familyId}/${instance.instanceId}`,
      validatorSha256,
      fixture,
      result,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function materializeQualificationFiles(
  workspace: string,
  files: readonly QualificationWrite[],
): Promise<void> {
  for (const file of files) {
    const path = resolveQualificationPath(workspace, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contentUtf8, "utf8");
    if (file.mode !== undefined) await chmod(path, file.mode);
  }
}

function resolveQualificationPath(workspace: string, path: string): string {
  if (path.split("/").some((part) => part === "" || part === "." || part === ".."))
    throw new Error(`unsafe qualification path ${path}`);
  return resolve(workspace, path);
}

async function runQualificationCommand(
  workspace: string,
  command: QualificationCommand,
): Promise<void> {
  const cwd =
    command.cwd === undefined ? workspace : resolveQualificationPath(workspace, command.cwd);
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16_384);
    });
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      if (code === 0) resolveCommand();
      else
        rejectCommand(
          new Error(`qualification command failed (${String(code ?? signal)}): ${stderr.trim()}`),
        );
    });
  });
}

function qualificationEvidence(
  identity: string,
  validatorSha256: string,
  fixture: QualificationFixture,
  result: SealedBenchmarkValidationResult,
): QualificationEvidence {
  return {
    schemaVersion: 1,
    identity,
    validatorSha256,
    fixture,
    result: {
      score: result.score,
      passedChecks: result.passedChecks,
      totalChecks: result.totalChecks,
      checks: result.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        passed: item.passed,
        summary: item.summary,
      })),
    },
  };
}

const ADDED_DEFINITIONS: readonly AddedDefinition[] = [
  ...localBugfixDefinitions(),
  ...codingReviewDefinitions(),
  ...optimizationDefinitions(),
  ...numericalDefinitions(),
  ...researchLiveDefinitions(),
  ...researchConflictDefinitions(),
  ...paperEditDefinitions(),
  ...paperReviewDefinitions(),
  ...sheetDefinitions(),
  ...documentDefinitions(),
  ...slideDefinitions(),
  ...recoveryDefinitions(),
  ...pipelineDefinitions(),
];

function addArtifact(
  artifacts: Array<{ path: string; bytes: Uint8Array }>,
  path: string,
  role: BenchmarkArtifactRole,
  content: string,
) {
  const bytes = new TextEncoder().encode(content);
  artifacts.push({ path, bytes });
  return { path, role, sha256: hashBenchmarkBytes(bytes), sizeBytes: bytes.byteLength };
}

function addDefinition(
  definition: AddedDefinition,
  artifacts: Array<{ path: string; bytes: Uint8Array }>,
  calibration?: Readonly<LoadedBenchmarkCalibration>,
): BenchmarkCorpusInstance {
  const base = `instances/${definition.familyId}/${definition.instanceId}`;
  const seals = [
    addArtifact(artifacts, `${base}/prompt.txt`, "prompt", `${definition.prompt.trim()}\n`),
    addArtifact(
      artifacts,
      `${base}/workspace.json`,
      "workspace_snapshot",
      workspaceFor(definition),
    ),
    addArtifact(artifacts, `${base}/validator.json`, "validator", validatorFor(definition)),
    addArtifact(artifacts, `${base}/rubric.json`, "quality_rubric", rubricFor(definition)),
  ];
  if (definition.externalSnapshot !== undefined) {
    seals.push(
      addArtifact(
        artifacts,
        `${base}/external-snapshot.json`,
        "external_snapshot",
        definition.externalSnapshot,
      ),
    );
  }
  const workspace = seals.find((seal) => seal.role === "workspace_snapshot")!;
  const family = BENCHMARK_FAMILIES.find((candidate) => candidate.id === definition.familyId)!;
  const evaluationClass =
    definition.evaluationClass ??
    (family.decomposable ? "economic-decomposable" : "direct-fast-path");
  const eligibility =
    evaluationClass === "economic-decomposable"
      ? economicEligibilityFromCalibration(calibration, definition.familyId, 3)
      : undefined;
  return {
    familyId: definition.familyId,
    instanceId: definition.instanceId,
    seed: definition.seed,
    ...releaseMetadata(),
    evaluationClass,
    ...(eligibility === undefined ? {} : { eligibility }),
    initialStateSha256: workspace.sha256,
    artifacts: seals,
  };
}

function importReusedInstances(
  artifacts: Array<{ path: string; bytes: Uint8Array }>,
  calibration?: Readonly<LoadedBenchmarkCalibration>,
): BenchmarkCorpusInstance[] {
  const coding = createEconomicCodingCorpus(calibration);
  const crossDomain = createEconomicCrossDomainCorpus(calibration);
  const selectedCrossDomain = crossDomain.manifest.instances.filter(
    (instance) => instance.familyId !== "office-document",
  );
  const selectedPaths = new Set(
    [...coding.manifest.instances, ...selectedCrossDomain].flatMap((instance) =>
      instance.artifacts.map((artifact) => artifact.path),
    ),
  );
  for (const artifact of [...coding.artifacts, ...crossDomain.artifacts]) {
    if (selectedPaths.has(artifact.path)) {
      artifacts.push({ path: artifact.path, bytes: artifact.bytes });
    }
  }
  return [...coding.manifest.instances, ...selectedCrossDomain].map((instance) => {
    return {
      ...instance,
      ...releaseMetadata(),
      evaluationClass: "economic-decomposable",
    };
  });
}

let authoredCoreCorpus: Promise<AuthoredCoreCorpus> | undefined;
let authoredCoreRoutingCorpus: Promise<AuthoredCoreCorpus> | undefined;

export function createAuthoredCoreCorpus(
  calibration?: Readonly<LoadedBenchmarkCalibration>,
): Promise<AuthoredCoreCorpus> {
  if (calibration !== undefined) {
    return buildAuthoredCoreCorpus(true, calibration).then((corpus) => structuredClone(corpus));
  }
  authoredCoreCorpus ??= buildAuthoredCoreCorpus(true);
  return authoredCoreCorpus.then((corpus) => structuredClone(corpus));
}

/** Build the same sealed task inputs without running Office-heavy validator qualification. */
export function createAuthoredCoreRoutingCorpus(
  calibration?: Readonly<LoadedBenchmarkCalibration>,
): Promise<AuthoredCoreCorpus> {
  if (calibration !== undefined) {
    return buildAuthoredCoreCorpus(false, calibration).then((corpus) => structuredClone(corpus));
  }
  authoredCoreRoutingCorpus ??= buildAuthoredCoreCorpus(false);
  return authoredCoreRoutingCorpus.then((corpus) => structuredClone(corpus));
}

async function buildAuthoredCoreCorpus(
  qualify: boolean,
  calibration?: Readonly<LoadedBenchmarkCalibration>,
): Promise<AuthoredCoreCorpus> {
  const artifacts: Array<{ path: string; bytes: Uint8Array }> = [];
  const unqualifiedInstances: BenchmarkManifestDraft["instances"] = [
    ...importReusedInstances(artifacts, calibration),
    ...ADDED_DEFINITIONS.map((definition) => addDefinition(definition, artifacts, calibration)),
  ];
  const instances = qualify
    ? await qualifyInstances(unqualifiedInstances, artifacts)
    : unqualifiedInstances;
  return {
    manifest: sealBenchmarkManifest({
      schemaVersion: BENCHMARK_MANIFEST_VERSION,
      suiteId: "agent-trio-authored-core-v1",
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

export async function generateAuthoredCoreCorpus(
  rootDirectory = DEFAULT_ROOT,
  calibrationPath?: string,
): Promise<string> {
  const root = resolve(rootDirectory);
  const calibration =
    calibrationPath === undefined
      ? undefined
      : await loadBenchmarkCalibrationTable(calibrationPath);
  const corpus = await createAuthoredCoreCorpus(calibration);
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

const entryPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  const { rootDirectory, calibrationPath } = generatorArguments(process.argv.slice(2));
  const path = await generateAuthoredCoreCorpus(rootDirectory, calibrationPath);
  process.stdout.write(`${path}\n`);
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
    throw new Error("usage: generate-authored-core-benchmark [root] [--calibration file.json]");
  }
  return { rootDirectory: positional[0], calibrationPath };
}
