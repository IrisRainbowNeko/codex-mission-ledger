#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BENCHMARK_MANIFEST_VERSION,
  hashBenchmarkBytes,
  sealBenchmarkManifest,
  type BenchmarkArtifactRole,
  type BenchmarkManifestDraft,
} from "../src/benchmark.js";
import { CODEX_APP_SERVER_VERSION } from "../src/core/contracts.js";

const root = resolve(process.argv[2] ?? "/tmp/agent-trio-diagnostic-coding-v1");
const crossInstanceId = "coding-cross-module-diagnostic-01";
const crossBase = `instances/coding-cross-module/${crossInstanceId}`;
const diagnosticSetCount = 1;

const moduleTemplates = [
  {
    name: "auth.ts",
    criterion: { label: "auth assignment", any: ["===", "assignment"] },
    content: `export interface User { role: string }\n\n// Return true only when the existing role is exactly "admin".\nexport function isAdmin(user: User): boolean {\n  if ((user.role = "admin")) return true;\n  return false;\n}\n`,
  },
  {
    name: "cache.ts",
    criterion: { label: "cache units", any: ["1000", "milliseconds"] },
    content: `export interface Entry { createdAt: number; ttlSeconds: number }\n\n// ttlSeconds is expressed in seconds; timestamps are milliseconds.\nexport function isFresh(entry: Entry, now = Date.now()): boolean {\n  return now - entry.createdAt < entry.ttlSeconds;\n}\n`,
  },
  {
    name: "pagination.ts",
    criterion: {
      label: "pagination end index",
      any: ["offset + limit", "offset+limit"],
    },
    content: `// Return at most limit items beginning at offset.\nexport function page<T>(items: T[], offset: number, limit: number): T[] {\n  return items.slice(offset, limit);\n}\n`,
  },
  {
    name: "retry.ts",
    criterion: {
      label: "retry initial attempt",
      any: ["<= maxretries", "maxretries + 1", "maxretries+1"],
    },
    content: `// maxRetries is the number of retries after the initial attempt.\nexport async function retry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {\n  let last: unknown;\n  for (let attempt = 0; attempt < maxRetries; attempt += 1) {\n    try { return await fn(); } catch (error) { last = error; }\n  }\n  throw last;\n}\n`,
  },
  {
    name: "pricing.ts",
    criterion: { label: "discount percentage", any: ["/ 100", "/100"] },
    content: `// discountPercent ranges from 0 through 100.\nexport function discounted(priceCents: number, discountPercent: number): number {\n  return Math.round(priceCents * (1 - discountPercent));\n}\n`,
  },
  {
    name: "calendar.ts",
    criterion: { label: "calendar day", any: ["getdate", "day of the week"] },
    content: `// Return the day of the month in local time (1 through 31).\nexport function dayOfMonth(value: string): number {\n  return new Date(value).getDay();\n}\n`,
  },
  {
    name: "search.ts",
    criterion: {
      label: "search zero and minus one",
      any: [">= 0", "!== -1", "index === -1"],
    },
    content: `// Return the first matching index, including zero; return null when absent.\nexport function findName(names: string[], wanted: string): number | null {\n  const index = names.indexOf(wanted);\n  return index ? index : null;\n}\n`,
  },
  {
    name: "permissions.ts",
    criterion: { label: "permission any scope", any: [".some", "some("] },
    content: `// Access is allowed when the user owns at least one of the accepted scopes.\nexport function canAccess(userScopes: string[], acceptedScopes: string[]): boolean {\n  return acceptedScopes.every((scope) => userScopes.includes(scope));\n}\n`,
  },
  {
    name: "stats.ts",
    criterion: { label: "mean denominator", any: ["values.length", "array length"] },
    content: `// Return the arithmetic mean of a non-empty array.\nexport function mean(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0) / (values.length - 1);\n}\n`,
  },
  {
    name: "normalize.ts",
    criterion: { label: "global whitespace", any: ["/g", "global"] },
    content: `// Collapse every run of whitespace to one ASCII space.\nexport function normalizeSpaces(value: string): string {\n  return value.trim().replace(/\\s+/, " ");\n}\n`,
  },
  {
    name: "clamp.ts",
    criterion: {
      label: "clamp bound order",
      any: ["math.max(minimum", "math.min(maximum"],
    },
    content: `// Clamp value to the inclusive [minimum, maximum] interval.\nexport function clamp(value: number, minimum: number, maximum: number): number {\n  return Math.max(maximum, Math.min(minimum, value));\n}\n`,
  },
  {
    name: "parity.ts",
    criterion: { label: "even remainder", any: ["% 2 === 0", "%2===0"] },
    content: `// Return true exactly for even integers.\nexport function isEven(value: number): boolean {\n  return value % 2 === 1;\n}\n`,
  },
  {
    name: "sum.ts",
    criterion: { label: "sum zero seed", any: [", 0)", "initial value 0"] },
    content: `// Return the sum; an empty array sums to zero.\nexport function sum(values: number[]): number {\n  return values.reduce((total, value) => total + value, 1);\n}\n`,
  },
  {
    name: "maximum.ts",
    criterion: { label: "negative maximum", any: ["-infinity", "values[0]"] },
    content: `// Return the greatest value from a non-empty array, including all-negative arrays.\nexport function maximum(values: number[]): number {\n  return values.reduce((best, value) => Math.max(best, value), 0);\n}\n`,
  },
  {
    name: "minimum.ts",
    criterion: { label: "positive minimum", any: ["infinity", "values[0]"] },
    content: `// Return the least value from a non-empty array, including all-positive arrays.\nexport function minimum(values: number[]): number {\n  return values.reduce((best, value) => Math.min(best, value), 0);\n}\n`,
  },
  {
    name: "unique.ts",
    criterion: { label: "unique set", any: ["new set", "set("] },
    content: `// Preserve first-occurrence order while removing duplicate strings.\nexport function unique(values: string[]): string[] {\n  return [...values];\n}\n`,
  },
  {
    name: "intersection.ts",
    criterion: { label: "intersection membership", any: ["right.includes", "right.has"] },
    content: `// Return left-side values that are also present on the right.\nexport function intersection(left: string[], right: string[]): string[] {\n  return left.filter((value) => !right.includes(value));\n}\n`,
  },
  {
    name: "difference.ts",
    criterion: { label: "difference exclusion", any: ["!right.includes", "!right.has"] },
    content: `// Return left-side values that are absent from the right.\nexport function difference(left: string[], right: string[]): string[] {\n  return left.filter((value) => right.includes(value));\n}\n`,
  },
  {
    name: "prefix.ts",
    criterion: { label: "prefix startsWith", any: [".startswith"] },
    content: `// Test whether value begins with prefix, not whether it merely contains it.\nexport function hasPrefix(value: string, prefix: string): boolean {\n  return value.includes(prefix);\n}\n`,
  },
  {
    name: "suffix.ts",
    criterion: { label: "suffix endsWith", any: [".endswith"] },
    content: `// Test whether value ends with suffix.\nexport function hasSuffix(value: string, suffix: string): boolean {\n  return value.startsWith(suffix);\n}\n`,
  },
  {
    name: "truncate.ts",
    criterion: { label: "truncate exact limit", any: ["slice(0, maxlength)"] },
    content: `// Return at most maxLength characters without an off-by-one loss.\nexport function truncate(value: string, maxLength: number): string {\n  return value.slice(0, maxLength - 1);\n}\n`,
  },
  {
    name: "repeat.ts",
    criterion: { label: "repeat exact count", any: ["index < count", "i < count"] },
    content: `// Return exactly count copies of value; zero returns an empty array.\nexport function repeat<T>(value: T, count: number): T[] {\n  const result: T[] = [];\n  for (let index = 0; index <= count; index += 1) result.push(value);\n  return result;\n}\n`,
  },
  {
    name: "chunk.ts",
    criterion: { label: "chunk progress", any: ["index += size", "index = index + size"] },
    content: `// Split values into non-overlapping chunks of the positive size.\nexport function chunk<T>(values: T[], size: number): T[][] {\n  const result: T[][] = [];\n  for (let index = 0; index < values.length; index += size - 1) result.push(values.slice(index, index + size));\n  return result;\n}\n`,
  },
  {
    name: "flatten.ts",
    criterion: { label: "flatten one level", any: [".flat()", ".flat(1)"] },
    content: `// Flatten exactly one array nesting level.\nexport function flatten<T>(values: T[][]): T[] {\n  return values.flat(0) as T[];\n}\n`,
  },
  {
    name: "reverse.ts",
    criterion: { label: "non-mutating reverse", any: ["[...values].reverse", "slice().reverse"] },
    content: `// Return a reversed copy without mutating the input array.\nexport function reversed<T>(values: T[]): T[] {\n  return values.reverse();\n}\n`,
  },
  {
    name: "numeric-sort.ts",
    criterion: { label: "numeric comparator", any: ["a - b", "left - right"] },
    content: `// Return numbers in ascending numeric order.\nexport function sortNumbers(values: number[]): number[] {\n  return [...values].sort();\n}\n`,
  },
  {
    name: "last.ts",
    criterion: { label: "last valid index", any: ["length - 1"] },
    content: `// Return the final value from a non-empty array.\nexport function last<T>(values: T[]): T {\n  return values[values.length]!;\n}\n`,
  },
  {
    name: "first-defined.ts",
    criterion: { label: "defined zero", any: ["!== undefined", "typeof value"] },
    content: `// Return the first defined value, preserving false, zero, and empty string.\nexport function firstDefined<T>(values: Array<T | undefined>): T | undefined {\n  return values.find(Boolean);\n}\n`,
  },
  {
    name: "defaults.ts",
    criterion: { label: "nullish default", any: ["??"] },
    content: `// Use fallback only when value is null or undefined; preserve other falsy values.\nexport function withDefault<T>(value: T | null | undefined, fallback: T): T {\n  return value || fallback;\n}\n`,
  },
  {
    name: "queue.ts",
    criterion: { label: "fifo dequeue", any: [".shift()"] },
    content: `// Remove and return the oldest queued item (FIFO).\nexport function dequeue<T>(values: T[]): T | undefined {\n  return values.pop();\n}\n`,
  },
];

const files = Array.from({ length: diagnosticSetCount }, (_, setIndex) =>
  moduleTemplates.map((template) => ({
    path: `src/set-${String(setIndex + 1)}/${template.name}`,
    content: template.content,
  })),
).flat();

const prompt = [
  "Audit every TypeScript module under src/. Each module contains one independent correctness defect relative to its local contract comment.",
  "For every module provide: file and function, root cause, one concrete failing input or scenario, the corrected behavior, and a minimal corrected expression or code snippet.",
  "Cover all modules. Do not modify files. Keep the report precise but complete; a generic summary is not sufficient.",
  "",
].join("\n");
const workspace = JSON.stringify({ fixture: "diagnostic-coding-v4", files }, null, 2);
const validator = [
  "name: diagnostic-audit-validator",
  "kind: deterministic-output-rubric",
  `expected_findings: ${String(files.length)}`,
  "",
].join("\n");
const rubric = JSON.stringify(
  {
    version: 2,
    maximum: 100,
    criteria: Array.from({ length: diagnosticSetCount }, (_, setIndex) =>
      moduleTemplates.map((template) => ({
        label: `set ${String(setIndex + 1)} ${template.criterion.label}`,
        all: [`src/set-${String(setIndex + 1)}/${template.name}`],
        any: template.criterion.any,
      })),
    ).flat(),
  },
  null,
  2,
);

const definitions: Array<[string, BenchmarkArtifactRole, string]> = [
  ["prompt.txt", "prompt", prompt],
  ["workspace.json", "workspace_snapshot", workspace],
  ["validator.txt", "validator", validator],
  ["rubric.json", "quality_rubric", rubric],
];
const crossArtifacts = [];
for (const [name, role, content] of definitions) {
  const bytes = new TextEncoder().encode(content);
  const path = `${crossBase}/${name}`;
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  crossArtifacts.push({
    path,
    role,
    sha256: hashBenchmarkBytes(bytes),
    sizeBytes: bytes.byteLength,
  });
}
const crossWorkspaceSeal = crossArtifacts.find(
  (artifact) => artifact.role === "workspace_snapshot",
)!;

const localInstanceId = "coding-local-bugfix-diagnostic-01";
const localBase = `instances/coding-local-bugfix/${localInstanceId}`;
const localDefinitions: Array<[string, BenchmarkArtifactRole, string]> = [
  [
    "prompt.txt",
    "prompt",
    [
      "Diagnose the single correctness defect in src/clamp.ts relative to its contract comment.",
      "Report the root cause, one concrete failing input, the corrected behavior, and the minimal corrected return expression.",
      "Do not modify files.",
      "",
    ].join("\n"),
  ],
  [
    "workspace.json",
    "workspace_snapshot",
    JSON.stringify(
      {
        fixture: "diagnostic-coding-local-v1",
        files: [
          {
            path: "src/clamp.ts",
            content: [
              "// Clamp value to the inclusive [minimum, maximum] interval.",
              "export function clamp(value: number, minimum: number, maximum: number): number {",
              "  return Math.max(maximum, Math.min(minimum, value));",
              "}",
              "",
            ].join("\n"),
          },
        ],
      },
      null,
      2,
    ),
  ],
  [
    "validator.txt",
    "validator",
    "name: diagnostic-local-validator\nkind: deterministic-output-rubric\nexpected_findings: 1\n",
  ],
  [
    "rubric.json",
    "quality_rubric",
    JSON.stringify(
      {
        version: 2,
        maximum: 100,
        criteria: [
          {
            label: "clamp bound order",
            all: ["math.min(maximum", "math.max(minimum"],
            any: ["clamp(5", "failing input"],
          },
        ],
      },
      null,
      2,
    ),
  ],
];
const localArtifacts = [];
for (const [name, role, content] of localDefinitions) {
  const bytes = new TextEncoder().encode(content);
  const path = `${localBase}/${name}`;
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  localArtifacts.push({
    path,
    role,
    sha256: hashBenchmarkBytes(bytes),
    sizeBytes: bytes.byteLength,
  });
}
const localWorkspaceSeal = localArtifacts.find(
  (artifact) => artifact.role === "workspace_snapshot",
)!;
const draft: BenchmarkManifestDraft = {
  schemaVersion: BENCHMARK_MANIFEST_VERSION,
  suiteId: "agent-trio-diagnostic-coding-v1",
  sealedAt: "2026-08-30T00:00:00.000Z",
  baseline: {
    model: "gpt-5.6-sol",
    modelRevision: `codex-cli-${CODEX_APP_SERVER_VERSION}`,
    effort: "ultra",
  },
  instances: [
    {
      familyId: "coding-local-bugfix",
      instanceId: localInstanceId,
      seed: "reversed-clamp-bounds",
      sourceRevision: "diagnostic-coding-local-v1",
      evaluationClass: "direct-fast-path",
      initialStateSha256: localWorkspaceSeal.sha256,
      artifacts: localArtifacts,
    },
    {
      familyId: "coding-cross-module",
      instanceId: crossInstanceId,
      seed: "thirty-independent-defects",
      sourceRevision: "diagnostic-coding-v4",
      evaluationClass: "direct-fast-path",
      initialStateSha256: crossWorkspaceSeal.sha256,
      artifacts: crossArtifacts,
    },
  ],
};
const manifest = sealBenchmarkManifest(draft);
await mkdir(root, { recursive: true });
await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${resolve(root, "manifest.json")}\n`);
