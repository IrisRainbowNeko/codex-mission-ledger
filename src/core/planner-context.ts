import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  isRecursiveOrchestrationCapabilityName,
  isRecursiveOrchestrationCapabilityPath,
  type CapabilityCatalog,
  type PluginDescriptor,
  type SkillDescriptor,
} from "./capabilities.js";
import type { JobSnapshot, ModelTier, RunRequest } from "./contracts.js";
import type { JobStore } from "./job-store.js";
import type { PlannerContext, PlannerContextProvider, PlannerModelEconomics } from "./planner.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_EXCERPT_BYTES = 2_000;
const DEFAULT_MAX_HISTORY_JOBS = 128;
const DEFAULT_MAX_LATENCY_SAMPLES_PER_TIER = 128;
const MAX_HISTORY_JOBS = 1_024;
const MAX_LATENCY_SAMPLES_PER_TIER = 2_048;
const MODEL_TIERS = ["luna", "terra", "sol"] as const;
const KEY_FILE_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "readme.md",
]);

export interface WorkspacePlannerContextOptions {
  capabilities?: CapabilityCatalog;
  economics?: readonly PlannerModelEconomics[];
  historyStore?: Pick<JobStore, "readSnapshots">;
  historyMaxJobs?: number;
  historyMaxSamplesPerTier?: number;
  maxFiles?: number;
  maxExcerptBytes?: number;
}

export interface TierLatencySummary {
  tier: ModelTier;
  sampleCount: number;
  latencyP50Seconds: number;
  latencyP95Seconds: number;
}

/** Builds a bounded repository synopsis without asking a model to rescan the workspace. */
export class WorkspacePlannerContextProvider implements PlannerContextProvider {
  readonly #capabilities: CapabilityCatalog | undefined;
  readonly #economics: readonly PlannerModelEconomics[];
  readonly #historyStore: Pick<JobStore, "readSnapshots"> | undefined;
  readonly #historyMaxJobs: number;
  readonly #historyMaxSamplesPerTier: number;
  readonly #maxFiles: number;
  readonly #maxExcerptBytes: number;

  constructor(options: WorkspacePlannerContextOptions = {}) {
    this.#capabilities = options.capabilities;
    this.#economics = options.economics ?? [];
    this.#historyStore = options.historyStore;
    this.#historyMaxJobs = boundedPositiveInteger(
      options.historyMaxJobs ?? DEFAULT_MAX_HISTORY_JOBS,
      MAX_HISTORY_JOBS,
      "historyMaxJobs",
    );
    this.#historyMaxSamplesPerTier = boundedPositiveInteger(
      options.historyMaxSamplesPerTier ?? DEFAULT_MAX_LATENCY_SAMPLES_PER_TIER,
      MAX_LATENCY_SAMPLES_PER_TIER,
      "historyMaxSamplesPerTier",
    );
    this.#maxFiles = positiveInteger(options.maxFiles ?? DEFAULT_MAX_FILES, "maxFiles");
    this.#maxExcerptBytes = positiveInteger(
      options.maxExcerptBytes ?? DEFAULT_MAX_EXCERPT_BYTES,
      "maxExcerptBytes",
    );
  }

  async load(request: RunRequest): Promise<PlannerContext> {
    const cwd = realpathSync(request.cwd);
    const git = await inspectGit(cwd);
    const workspaceFiles = (await listWorkspaceFiles(cwd, this.#maxFiles)).sort();
    const keyFiles: Array<{ path: string; excerpt: string }> = [];
    let remainingBytes = this.#maxExcerptBytes;
    for (const path of workspaceFiles) {
      if (!isKeyFile(path) || remainingBytes <= 0) {
        continue;
      }
      const absolute = join(cwd, path);
      if (!isRegularFileWithoutSymlink(absolute)) {
        continue;
      }
      const excerpt = readFileSync(absolute, "utf8").slice(0, remainingBytes);
      remainingBytes -= Buffer.byteLength(excerpt, "utf8");
      keyFiles.push({ path, excerpt });
    }

    const [skills, plugins] =
      this.#capabilities === undefined
        ? [[], []]
        : await Promise.all([this.#capabilities.listSkills(cwd), this.#capabilities.listPlugins()]);
    return {
      workspaceKind: git.root === null ? "directory" : "git",
      workspaceDirty: git.dirty,
      workspaceFiles,
      keyFiles,
      capabilities: compactPlannerCapabilities(skills, plugins),
      economics: this.#loadEconomics(),
    };
  }

  #loadEconomics(): PlannerModelEconomics[] {
    if (this.#historyStore === undefined) {
      return structuredClone([...this.#economics]);
    }
    try {
      const history = summarizeHistoricalLeafLatencies(
        this.#historyStore.readSnapshots({ maxJobs: this.#historyMaxJobs }),
        this.#historyMaxSamplesPerTier,
      );
      return mergeHistoricalLatencies(this.#economics, history);
    } catch {
      return structuredClone([...this.#economics]);
    }
  }
}

function compactPlannerCapabilities(
  skills: readonly SkillDescriptor[],
  plugins: readonly PluginDescriptor[],
): PlannerContext["capabilities"] {
  const availableSkills = uniqueBy(
    skills.filter(
      (skill) =>
        skill.enabled &&
        !isRecursiveOrchestrationCapabilityName(skill.name) &&
        !isRecursiveOrchestrationCapabilityPath(skill.path) &&
        (skill.pluginId === null || !isRecursiveOrchestrationCapabilityName(skill.pluginId)),
    ),
    (skill) =>
      `${skill.name}\u0000${skill.path}\u0000${skill.source ?? ""}\u0000${skill.pluginId ?? ""}`,
  );
  const nameCounts = new Map<string, number>();
  for (const skill of availableSkills) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }

  return [
    ...availableSkills.map((skill) => ({
      kind: "skill" as const,
      name: skill.name,
      ...((nameCounts.get(skill.name) ?? 0) > 1 ? { path: skill.path } : {}),
      ...(skill.source === undefined ? {} : { source: skill.source }),
      ...(skill.pluginId === null ? {} : { pluginId: skill.pluginId }),
    })),
    ...uniqueBy(
      plugins.filter(
        (plugin) => plugin.enabled && !isRecursiveOrchestrationCapabilityName(plugin.id),
      ),
      (plugin) => plugin.id,
    ).map((plugin) => ({ kind: "plugin" as const, name: plugin.id })),
  ];
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

/** Builds tier-level nearest-rank percentiles from complete, successful leaf observations. */
export function summarizeHistoricalLeafLatencies(
  snapshots: readonly JobSnapshot[],
  maxSamplesPerTier = DEFAULT_MAX_LATENCY_SAMPLES_PER_TIER,
): TierLatencySummary[] {
  const sampleLimit = boundedPositiveInteger(
    maxSamplesPerTier,
    MAX_LATENCY_SAMPLES_PER_TIER,
    "maxSamplesPerTier",
  );
  const samples = new Map<ModelTier, number[]>(MODEL_TIERS.map((tier) => [tier, []]));

  for (const snapshot of snapshots) {
    const result = asRecord(snapshot)?.["result"];
    if (!isRecord(result)) {
      continue;
    }
    const plan = result["plan"];
    const leaves = result["leaves"];
    if (!isRecord(plan) || !Array.isArray(plan["tasks"]) || !Array.isArray(leaves)) {
      continue;
    }
    const tierByTaskId = new Map<string, ModelTier>();
    for (const candidate of plan["tasks"]) {
      if (
        isRecord(candidate) &&
        typeof candidate["id"] === "string" &&
        isModelTier(candidate["tier"])
      ) {
        tierByTaskId.set(candidate["id"], candidate["tier"]);
      }
    }
    const seenTaskIds = new Set<string>();
    for (const candidate of leaves) {
      if (
        !isRecord(candidate) ||
        candidate["status"] !== "completed" ||
        typeof candidate["taskId"] !== "string" ||
        seenTaskIds.has(candidate["taskId"])
      ) {
        continue;
      }
      seenTaskIds.add(candidate["taskId"]);
      const tier = tierByTaskId.get(candidate["taskId"]);
      if (tier === undefined) {
        continue;
      }
      const tierSamples = samples.get(tier);
      if (tierSamples === undefined || tierSamples.length >= sampleLimit) {
        continue;
      }
      const durationSeconds = leafDurationSeconds(candidate);
      if (durationSeconds !== null) {
        tierSamples.push(durationSeconds);
      }
    }
    if (MODEL_TIERS.every((tier) => (samples.get(tier)?.length ?? 0) >= sampleLimit)) {
      break;
    }
  }

  return MODEL_TIERS.flatMap((tier) => {
    const values = samples.get(tier) ?? [];
    if (values.length === 0) {
      return [];
    }
    values.sort((left, right) => left - right);
    return [
      {
        tier,
        sampleCount: values.length,
        latencyP50Seconds: nearestRankPercentile(values, 0.5),
        latencyP95Seconds: nearestRankPercentile(values, 0.95),
      },
    ];
  });
}

/** Adds observed latencies without discarding configured model names or prices. */
export function mergeHistoricalLatencies(
  economics: readonly PlannerModelEconomics[],
  history: readonly TierLatencySummary[],
): PlannerModelEconomics[] {
  const byTier = new Map(history.map((item) => [item.tier, item]));
  return economics.map((item) => {
    const latency = byTier.get(item.tier);
    return latency === undefined
      ? structuredClone(item)
      : {
          ...structuredClone(item),
          latencyP50Seconds: latency.latencyP50Seconds,
          latencyP95Seconds: latency.latencyP95Seconds,
        };
  });
}

async function inspectGit(cwd: string): Promise<{ root: string | null; dirty: boolean }> {
  try {
    const root = (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })
    ).stdout.trim();
    const status = (
      await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: root,
      })
    ).stdout;
    return { root: realpathSync(root), dirty: status.trim().length > 0 };
  } catch {
    return { root: null, dirty: true };
  }
}

async function listWorkspaceFiles(cwd: string, maxFiles: number): Promise<string[]> {
  try {
    const output = await execFileAsync(
      "rg",
      ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!dist"],
      { cwd, maxBuffer: 8 * 1024 * 1024 },
    );
    return output.stdout.split(/\r?\n/u).filter(Boolean).slice(0, maxFiles);
  } catch {
    return walkFiles(cwd, maxFiles);
  }
}

function walkFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < maxFiles) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).replaceAll("\\", "/"));
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }
  return files;
}

function isKeyFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return KEY_FILE_NAMES.has(name) || name.endsWith(".sln") || name.endsWith(".csproj");
}

function isRegularFileWithoutSymlink(path: string): boolean {
  try {
    return !lstatSync(path).isSymbolicLink() && statSync(path).isFile();
  } catch {
    return false;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {
  const integer = positiveInteger(value, name);
  if (integer > maximum) {
    throw new Error(`${name} cannot exceed ${String(maximum)}`);
  }
  return integer;
}

function leafDurationSeconds(leaf: Record<string, unknown>): number | null {
  if (typeof leaf["startedAt"] !== "string" || typeof leaf["completedAt"] !== "string") {
    return null;
  }
  const startedAt = Date.parse(leaf["startedAt"]);
  const completedAt = Date.parse(leaf["completedAt"]);
  const durationSeconds = (completedAt - startedAt) / 1_000;
  return Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
}

function nearestRankPercentile(sortedValues: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sortedValues.length) - 1);
  return sortedValues[index] as number;
}

function isModelTier(value: unknown): value is ModelTier {
  return value === "luna" || value === "terra" || value === "sol";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
