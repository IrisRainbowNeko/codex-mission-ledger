#!/usr/bin/env node

/**
 * Execute a real, paired App Server benchmark run.
 *
 * This script is deliberately separate from the observation-only CLI command. It is an
 * experiment runner: it materializes a sealed instance into a disposable read-only workspace,
 * runs direct Sol and V3 from the same root thread, and writes the complete evidence needed by the paired
 * harness. The default scope is one decomposable instance; pass --full only after that smoke
 * pair is healthy.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BENCHMARK_FAMILIES,
  assertBenchmarkManifestCoverage,
  assertBenchmarkManifest,
  benchmarkInstanceSha256,
  createFileBenchmarkArtifactReader,
  createFileBenchmarkRunArtifactReader,
  hashBenchmarkBytes,
  runPairedBenchmark,
  sealBenchmarkManifest,
  verifyBenchmarkCorpus,
  type BenchmarkEnvironmentEvidence,
  type BenchmarkArtifactReader,
  type BenchmarkExecutionRequest,
  type BenchmarkModelUsageEvidence,
  type BenchmarkRunRecord,
  type BenchmarkUsageByStage,
  type BenchmarkUsageStage,
  type BenchmarkCorpusManifest,
  type BenchmarkObservation,
} from "../src/benchmark.js";
import { createDefaultRuntime, type DefaultRuntime } from "../src/runtime.js";
import {
  CodexAppServerClient,
  createCodexAppServerConnectionFactory,
} from "../src/app-server/index.js";
import {
  AppServerAdapterError,
  childThreadConfig,
  captureTurnUsage,
  jsonValue,
  runtimeFor,
} from "../src/app-server/adapters/runtime.js";
import { textInput } from "../src/app-server/client.js";
import type { AppServer, JsonObject, TurnStartParams } from "../src/app-server/types.js";
import type {
  AgentTrioRequest,
  BatchResult,
  HostSemanticPlan,
  JobSnapshot,
  ModelUsage,
  RunRequest,
} from "../src/core/contracts.js";
import type {
  AdmissionController,
  DirectExecutor,
  RecoveryAdapter,
  ResultIntegrator,
} from "../src/core/integration.js";
import { JobStore } from "../src/core/job-store.js";
import { hostSemanticPlanJsonSchemaForRoute, parseHostSemanticPlan } from "../src/core/planner.js";
import { FANOUT_MIN_TASK_SECONDS } from "../src/core/policy.js";
import {
  LocalRouteOptimizer,
  MCP_ROOT_DISPATCH_CONSTRAINT,
  recommendDirectTier,
} from "../src/core/router.js";
import { AgentTrioService } from "../src/core/service.js";
import { parseAgentTrioRequest } from "../src/mcp/protocol.js";
import { markInternalPlannerDispatch } from "../src/mcp/server.js";
import { resolvePlannerTransport } from "../src/planner-transport-config.js";
import {
  parseSealedBenchmarkValidatorV1,
  runSealedBenchmarkValidator,
} from "../src/benchmark-validator.js";

const DEFAULT_CORPUS = "/tmp/agent-trio-development-v1-final";
const DEFAULT_OUTPUT = "/tmp/agent-trio-real-benchmark.json";
const DEFAULT_EVIDENCE = "/tmp/agent-trio-real-benchmark-evidence";
const PRICE_TABLE_PATH = resolve("config/openai-prices.standard.json");
const CODEX_VERSION = "0.151.0";
const HOST_SOL_ADMISSION_EFFORT = "low" as const;
const HOST_SOL_PLANNER_EFFORT = "medium" as const;
const CHEAP_ROOT_EFFORT = "low" as const;
const CHEAP_ROOT_MODELS = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
} as const;
const ROOT_BENCHMARK_INSTRUCTIONS = [
  "Act as the current root model in a paired Agent Trio benchmark.",
  "The user message selects DIRECT, ROUTE, or TOOL mode; follow only that mode. TOOL mode may invoke the advertised agent_trio function once. A diagnostic route requirement in TOOL mode is mandatory and overrides the tool's normal economic admission advice. Follow the turn's explicit instruction on whether the host or the runtime's internal Sol supplies the semantic plan.",
  "Never read, invoke, or follow an agent-trio skill. The advertised MCP tool is the complete standalone V3 interface.",
  "Do not spawn native agents. Do not invoke any external orchestration tool except the advertised agent_trio function once in TOOL mode.",
].join(" ");
const ROOT_THREAD_SOURCE = "agent-trio-benchmark-root";
const ROOT_SOL_OUTPUT_SCHEMA = rootSolOutputSchema();
const TSX_CLI_PATH = fileURLToPath(import.meta.resolve("tsx/cli"));
const BENCHMARK_MCP_BRIDGE_PATH = fileURLToPath(
  new URL("./benchmark-mcp-bridge.ts", import.meta.url),
);
const BENCHMARK_RUN_DEADLINE_MS = 10 * 60 * 1_000;
// A paired arm may legitimately use the complete run budget. Keeping root turns at five minutes
// caused complex direct Sol baselines to fail before the already-advertised ten-minute deadline.
const BENCHMARK_TURN_TIMEOUT_MS = BENCHMARK_RUN_DEADLINE_MS;
const BENCHMARK_INTERRUPT_TIMEOUT_MS = 30_000;
const RECOVERY_PROFILE_VERSION = 1 as const;
const RECOVERY_PROFILE_TIMEOUT_MS = 10 * 60 * 1_000;
const RECOVERY_WORKER_FLAG = "--agent-trio-recovery-worker";
const RECOVERY_CONTINUE_INPUT = "RECOVERY_CONTINUE";

export interface RunnerOptions {
  corpus: string;
  output: string;
  evidence: string;
  family: string | null;
  instance: string | null;
  limit: number | null;
  full: boolean;
  forceFanout: boolean;
  forceDelegated: boolean;
  release: boolean;
  recoveryProfile: boolean;
  dynamicTool: boolean;
  v3Only: boolean;
  resume: boolean;
  planningMode: "host-sol" | "internal-sol" | "diagnostic-host";
}

type RecoveryWorkerMode = "start" | "resume";
type RecoveryWorkerImplementation = "production" | "fixture";

interface RecoveryWorkerOptions {
  mode: RecoveryWorkerMode;
  implementation: RecoveryWorkerImplementation;
  runId: string;
  workspace: string;
  jobRoot: string;
  nonce: string;
  serviceTier: string;
}

interface RecoveryWorkerState {
  workerPid: number;
  serverPid: number;
  threadId: string;
  previousTurnId: string;
  resumedTurnId?: string;
  status: "waiting_input" | "completed";
  invocationCount: 0 | 1;
  sideEffectSha256?: string;
}

interface RecoveryCheckpoint {
  kind: "direct";
  threadId: string;
  turnId: string;
  snapshotSha256: string;
  snapshotUpdatedAt: string;
}

interface RecoveryProcessMember {
  pid: number;
  parentPid: number;
  role: "worker" | "app_server" | "child";
}

interface RecoveryProcessEvidence {
  workerPid: number;
  processGroupId: number;
  members: RecoveryProcessMember[];
}

export type RecoveryFaultEvent =
  | {
      type: "worker_started" | "worker_restarted";
      at: string;
      runId: string;
      workerPid: number;
      processGroupId: number;
    }
  | {
      type: "checkpoint_observed";
      at: string;
      runId: string;
      checkpointKind: "direct";
      threadId: string;
      turnId: string;
      snapshotSha256: string;
      snapshotUpdatedAt: string;
    }
  | {
      type: "fault_injected";
      at: string;
      runId: string;
      workerPid: number;
      processGroupId: number;
      signal: "SIGKILL";
      terminatedProcessIds: number[];
    }
  | {
      type: "resume_completed";
      at: string;
      runId: string;
      threadId: string;
      previousTurnId: string;
      resumedTurnId: string;
      status: "completed";
      snapshotSha256: string;
    }
  | {
      type: "side_effect_verified";
      at: string;
      runId: string;
      invocationCount: 1;
      sha256: string;
    };

export interface RecoveryProfileEvidence {
  schemaVersion: typeof RECOVERY_PROFILE_VERSION;
  status: "passed";
  runId: string;
  implementation: RecoveryWorkerImplementation;
  initialProcess: RecoveryProcessEvidence;
  resumedProcess: RecoveryProcessEvidence;
  checkpoint: RecoveryCheckpoint;
  resumedTurnId: string;
  sideEffect: {
    invocationCount: 1;
    sha256: string;
  };
  events: RecoveryFaultEvent[];
  completedAt: string;
}

export interface RecoveryProfileArtifact {
  evidence: RecoveryProfileEvidence;
  path: string;
  sha256: string;
  sizeBytes: number;
  temporaryRoot: string;
}

export interface RunRecoveryProfileOptions {
  evidenceRoot: string;
  serviceTier?: string;
  timeoutMs?: number;
  /** Test-only process fixture. Release execution always selects production explicitly. */
  implementation?: RecoveryWorkerImplementation;
}

interface PriceEntry {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  cacheWriteInputPerMillionUsd?: number;
  outputPerMillionUsd: number;
}

interface PairRuntime {
  key: string;
  workspace: string;
  runtimeRoot: string;
  runtime: DefaultRuntime;
  hostAppServer: AppServer;
  closeHostAppServer: () => Promise<void>;
  sourceThreadId: string;
  workspaceConfig: BenchmarkWorkspaceConfig;
  toolState: BenchmarkToolState;
  closeMcpBridge: () => Promise<void>;
}

interface BenchmarkToolState {
  phase: "probe" | "warmup" | "idle" | "direct" | "v3" | "v3-direct";
  runs: Array<{ request: AgentTrioRequest; batch: BatchResult }>;
  protocolErrors: number;
  diagnosticBuffer: string;
}

export interface PairStorage {
  workspace: string;
  runtimeRoot: string;
  jobRoot: string;
}

export interface BenchmarkWorkspaceFile {
  path: string;
  content?: string;
  contentUtf8?: string;
  contentBase64?: string;
  mode?: number;
}

export interface BenchmarkWorkspaceConfig {
  access: "readOnly" | "workspaceWrite";
  citationPolicy: "none" | "frozen-required" | "live-required";
  decomposition: "independent" | "coupled";
  files: BenchmarkWorkspaceFile[];
}

const priceTable = JSON.parse(await readFile(PRICE_TABLE_PATH, "utf8")) as {
  models: Record<string, PriceEntry>;
};
const prices = priceTable.models;
const pricingSha256 = hashBenchmarkBytes(JSON.stringify(priceTable));
const benchmarkPlannerTransport = resolvePlannerTransport({
  env: process.env,
  serviceTier: process.env["AGENT_TRIO_SERVICE_TIER"] ?? "default",
});
const benchmarkRouteOptimizer = new LocalRouteOptimizer({
  modelMap: {
    luna: "gpt-5.6-luna",
    terra: "gpt-5.6-terra",
    sol: "gpt-5.6-sol",
  },
  priceTable: prices,
  plannerTransport: benchmarkPlannerTransport.kind,
});

let options = parseOptions([]);
const pairRuntimes = new Map<string, PairRuntime>();
let activeReleaseRecoveryProfile: RecoveryProfileArtifact | null = null;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  options = parseOptions(argv);
  activeReleaseRecoveryProfile = null;
  if (options.release) {
    assertReleaseRecoveryProfileRequested(options);
  }
  const corpusRoot = resolve(options.corpus);
  const outputPath = resolve(options.output);
  const partialPath = outputPath.endsWith(".json")
    ? outputPath.replace(/\.json$/u, ".records.jsonl")
    : `${outputPath}.records.jsonl`;
  const evidenceRoot = resolve(options.evidence);
  const manifest = JSON.parse(await readFile(join(corpusRoot, "manifest.json"), "utf8")) as unknown;
  assertBenchmarkManifest(manifest);
  const selectedManifest = selectManifest(manifest, options);
  const artifactReader = createFileBenchmarkArtifactReader(corpusRoot);
  if (options.release) {
    await assertReleaseBenchmarkCorpus(selectedManifest, artifactReader, options);
  }
  const runArtifactReader = createFileBenchmarkRunArtifactReader(evidenceRoot);
  const environment = await benchmarkEnvironment();

  await Promise.all([
    mkdir(evidenceRoot, { recursive: true }),
    mkdir(dirname(outputPath), { recursive: true }),
  ]);
  const completedRecords = options.resume
    ? await loadPartialBenchmarkRecords(partialPath)
    : new Map<string, BenchmarkRunRecord>();
  if (!options.resume || !existsSync(partialPath)) {
    await writeFile(partialPath, "", "utf8");
  } else {
    process.stderr.write(
      `resuming with ${String(completedRecords.size)} completed benchmark arms\n`,
    );
  }
  if (options.release) {
    activeReleaseRecoveryProfile = await runRecoveryFaultInjectionProfile({
      evidenceRoot,
      serviceTier: environment.serviceTier,
      implementation: "production",
    });
  }
  if (options.v3Only) {
    await runV3OnlyDiagnostic(
      selectedManifest,
      artifactReader,
      environment,
      evidenceRoot,
      outputPath,
      partialPath,
    );
    return;
  }
  let result: Awaited<ReturnType<typeof runPairedBenchmark>>;
  try {
    result = await runPairedBenchmark(
      selectedManifest,
      {
        direct_sol: (request) =>
          executeOrReuseBenchmarkArm(completedRecords, request, () =>
            executeDirect(request, environment, evidenceRoot),
          ),
        v3: (request) =>
          executeOrReuseBenchmarkArm(completedRecords, request, () =>
            executeV3(request, environment, evidenceRoot),
          ),
      },
      {
        artifactReader,
        runArtifactReader,
        environment,
        evaluation: options.release
          ? { minimumInstancesPerFamily: 3, requireAllFamilies: true }
          : { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        onRecord: async (record) => {
          const key = benchmarkRecordKey(record.observation);
          if (!completedRecords.has(key)) {
            await appendFile(partialPath, `${JSON.stringify(record)}\n`, "utf8");
            completedRecords.set(key, structuredClone(record));
          }
          process.stderr.write(
            `completed ${record.observation.familyId}/${record.observation.instanceId}/${record.observation.arm} ` +
              `cost=${String(record.observation.costUsd)} elapsed=${String(record.observation.elapsedMs)}ms\n`,
          );
        },
      },
    );
  } finally {
    await disposeAllPairRuntimes();
  }

  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        ...result,
        records: result.records,
        ...(activeReleaseRecoveryProfile === null
          ? {}
          : {
              recoveryProfile: {
                path: activeReleaseRecoveryProfile.path,
                sha256: activeReleaseRecoveryProfile.sha256,
                sizeBytes: activeReleaseRecoveryProfile.sizeBytes,
              },
            }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const observationPath = outputPath.replace(/\.json$/u, ".observations.json");
  await writeFile(
    observationPath,
    `${JSON.stringify({ observations: result.observations }, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      output: outputPath,
      observations: observationPath,
      pairCount: result.evaluation.pairCount,
      evaluation: result.evaluation,
      ...(activeReleaseRecoveryProfile === null
        ? {}
        : { recoveryProfile: activeReleaseRecoveryProfile.path }),
    })}\n`,
  );
}

async function executeOrReuseBenchmarkArm(
  completedRecords: ReadonlyMap<string, BenchmarkRunRecord>,
  request: Readonly<BenchmarkExecutionRequest>,
  execute: () => Promise<BenchmarkRunRecord>,
): Promise<BenchmarkRunRecord> {
  const key = benchmarkRecordKey({
    familyId: request.instance.familyId,
    instanceId: request.instance.instanceId,
    seed: request.instance.seed,
    arm: request.arm,
  });
  const completed = completedRecords.get(key);
  if (completed === undefined) {
    return executeLoggedArm(request, execute);
  }
  process.stderr.write(
    `reusing ${request.instance.familyId}/${request.instance.instanceId}/${request.arm}\n`,
  );
  if (request.orderInPair === 1) {
    await disposePairRuntime(request);
  }
  return structuredClone(completed);
}

function benchmarkRecordKey(
  value: Readonly<{
    familyId: string;
    instanceId: string;
    seed: string;
    arm: "direct_sol" | "v3";
  }>,
): string {
  return [value.familyId, value.instanceId, value.seed, value.arm].join("\0");
}

export async function loadPartialBenchmarkRecords(
  path: string,
): Promise<Map<string, BenchmarkRunRecord>> {
  if (!existsSync(path)) {
    return new Map();
  }
  const source = await readFile(path, "utf8");
  const lines = source.split("\n");
  const records = new Map<string, BenchmarkRunRecord>();
  const validLines: string[] = [];
  let discardedTruncatedTail = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const isTruncatedTail = index === lines.length - 1 && !source.endsWith("\n");
      if (isTruncatedTail) {
        discardedTruncatedTail = true;
        break;
      }
      throw new Error(`invalid benchmark resume record at line ${String(index + 1)}`, {
        cause: error,
      });
    }
    const record = partialBenchmarkRecord(parsed, index + 1);
    const key = benchmarkRecordKey(record.observation);
    if (records.has(key)) {
      throw new Error(`duplicate benchmark resume record at line ${String(index + 1)}`);
    }
    records.set(key, record);
    validLines.push(line);
  }
  if (discardedTruncatedTail) {
    await writeFile(path, validLines.length === 0 ? "" : `${validLines.join("\n")}\n`, "utf8");
  }
  return records;
}

function partialBenchmarkRecord(value: unknown, line: number): BenchmarkRunRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`benchmark resume record at line ${String(line)} must be an object`);
  }
  const observation = (value as { observation?: unknown }).observation;
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
    throw new Error(`benchmark resume record at line ${String(line)} is missing observation`);
  }
  const fields = observation as Record<string, unknown>;
  for (const key of ["familyId", "instanceId", "seed"] as const) {
    if (typeof fields[key] !== "string" || fields[key].length === 0) {
      throw new Error(
        `benchmark resume record at line ${String(line)} has invalid observation.${key}`,
      );
    }
  }
  if (fields["arm"] !== "direct_sol" && fields["arm"] !== "v3") {
    throw new Error(`benchmark resume record at line ${String(line)} has invalid observation.arm`);
  }
  return value as BenchmarkRunRecord;
}

async function runV3OnlyDiagnostic(
  manifest: Readonly<BenchmarkCorpusManifest>,
  artifactReader: BenchmarkArtifactReader,
  environment: BenchmarkEnvironmentEvidence,
  evidenceRoot: string,
  outputPath: string,
  partialPath: string,
): Promise<void> {
  if (manifest.instances.length !== 1) {
    throw new Error("--v3-only requires a selection containing exactly one instance");
  }
  await verifyBenchmarkCorpus(manifest, artifactReader);
  const instance = manifest.instances[0]!;
  const artifacts = await Promise.all(
    instance.artifacts.map(async (seal) => ({
      seal,
      bytes: await artifactReader(seal, instance),
    })),
  );
  const request: BenchmarkExecutionRequest = {
    arm: "v3",
    pairIndex: 0,
    orderInPair: 1,
    suiteId: manifest.suiteId,
    manifestSha256: manifest.manifestSha256,
    instanceSha256: benchmarkInstanceSha256(instance),
    baseline: manifest.baseline,
    environment,
    instance,
    artifacts,
  };
  try {
    const record = await executeLoggedArm(request, () =>
      executeV3(request, environment, evidenceRoot),
    );
    await appendFile(partialPath, `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(
      outputPath,
      `${JSON.stringify({ diagnostic: "v3-only", releaseEvidence: false, record }, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({ output: outputPath, observation: record.observation })}\n`,
    );
  } finally {
    await disposeAllPairRuntimes();
  }
}

async function executeLoggedArm(
  request: Readonly<BenchmarkExecutionRequest>,
  execute: () => Promise<BenchmarkRunRecord>,
): Promise<BenchmarkRunRecord> {
  const identity = `${request.instance.familyId}/${request.instance.instanceId}/${request.arm}`;
  process.stderr.write(`starting ${identity}\n`);
  try {
    return await execute();
  } catch (error) {
    process.stderr.write(`failed ${identity}: ${formatError(error)}\n`);
    throw error;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function isBenchmarkTurnTimeout(error: unknown): boolean {
  return error instanceof AppServerAdapterError && error.code === "turn_timeout";
}

export function parseOptions(argv: readonly string[]): RunnerOptions {
  const value = (index: number, name: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return next;
  };
  let corpus = DEFAULT_CORPUS;
  let output = DEFAULT_OUTPUT;
  let evidence = DEFAULT_EVIDENCE;
  let family: string | null = null;
  let instance: string | null = null;
  let limit: number | null = null;
  let full = false;
  let forceFanout = false;
  let forceDelegated = false;
  let release = false;
  let recoveryProfile = false;
  let dynamicTool = false;
  let v3Only = false;
  let resume = false;
  let planningMode: RunnerOptions["planningMode"] = "internal-sol";
  const planningFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--full") {
      full = true;
    } else if (argument === "--release") {
      release = true;
    } else if (argument === "--recovery-profile") {
      recoveryProfile = true;
    } else if (argument === "--dynamic-tool") {
      dynamicTool = true;
    } else if (argument === "--v3-only") {
      v3Only = true;
    } else if (argument === "--resume") {
      resume = true;
    } else if (argument === "--force-fanout") {
      forceFanout = true;
    } else if (argument === "--force-delegated") {
      forceDelegated = true;
    } else if (argument === "--host-plan") {
      planningFlags.add(argument);
      planningMode = "diagnostic-host";
    } else if (argument === "--host-sol-plan") {
      planningFlags.add(argument);
      planningMode = "host-sol";
    } else if (argument === "--internal-sol-plan") {
      planningFlags.add(argument);
      planningMode = "internal-sol";
    } else if (argument === "--corpus") {
      corpus = value(index, argument);
      index += 1;
    } else if (argument === "--output") {
      output = value(index, argument);
      index += 1;
    } else if (argument === "--evidence") {
      evidence = value(index, argument);
      index += 1;
    } else if (argument === "--family") {
      family = value(index, argument);
      index += 1;
    } else if (argument === "--instance") {
      instance = value(index, argument);
      index += 1;
    } else if (argument === "--limit") {
      const parsed = Number(value(index, argument));
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = parsed;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "usage: tsx scripts/run-real-benchmark.ts [--full] [--release --recovery-profile] [--dynamic-tool] [--resume] [--v3-only] [--force-delegated|--force-fanout] [--internal-sol-plan|--host-sol-plan|--host-plan] [--family ID] [--instance ID] [--limit N] [--corpus DIR] [--evidence DIR] [--output FILE]\n\nThe default measures a cheap root that completes one-turn work directly and calls strategy=auto only when fanout or stronger planning is warranted. The runtime then performs deterministic economic admission and invokes its internal Sol planner only for admitted fanout. --host-sol-plan measures the optional host-Sol semantic-plan path, and --host-plan injects a fixed diagnostic plan. --resume reuses verified completed arms from the output .records.jsonl after an interrupted paired run; use it only with unchanged code, corpus, provider, and evidence paths. --v3-only is an unpaired transport diagnostic and is never release evidence for the full suite. --force-delegated and --force-fanout are diagnostic route probes. --release requires --recovery-profile, --dynamic-tool, a complete release-qualified corpus, and natural runtime routing.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  if (planningFlags.size > 1) {
    throw new Error("planning mode flags are mutually exclusive");
  }
  if (forceDelegated && forceFanout) {
    throw new Error("--force-delegated and --force-fanout are mutually exclusive");
  }
  if (forceDelegated && !dynamicTool) {
    throw new Error("--force-delegated requires --dynamic-tool");
  }
  if (release && v3Only) {
    throw new Error("--release forbids --v3-only");
  }
  if (resume && v3Only) {
    throw new Error("--resume is only supported for paired benchmark runs");
  }
  if (recoveryProfile && !release) {
    throw new Error("--recovery-profile is only valid with --release");
  }
  return {
    corpus,
    output,
    evidence,
    family,
    instance,
    limit,
    full,
    forceFanout,
    forceDelegated,
    release,
    recoveryProfile,
    dynamicTool,
    v3Only,
    resume,
    planningMode,
  };
}

export function assertReleaseRecoveryProfileRequested(config: Readonly<RunnerOptions>): void {
  if (!config.release) {
    return;
  }
  if (!config.recoveryProfile) {
    throw new Error(
      "release benchmark preflight failed: --release requires --recovery-profile before any benchmark arm starts",
    );
  }
}

export async function runRecoveryFaultInjectionProfile(
  input: Readonly<RunRecoveryProfileOptions>,
): Promise<RecoveryProfileArtifact> {
  const evidenceRoot = resolve(input.evidenceRoot);
  const implementation = input.implementation ?? "production";
  const timeoutMs = input.timeoutMs ?? RECOVERY_PROFILE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("recovery profile timeoutMs must be a positive finite number");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-trio-recovery-profile-"));
  const workspace = join(temporaryRoot, "workspace");
  const jobRoot = join(temporaryRoot, "jobs");
  const statePath = join(temporaryRoot, "worker-state.json");
  const runId = `recovery-${randomUUID()}`;
  const nonce = randomUUID();
  const serviceTier = input.serviceTier ?? "default";
  const events: RecoveryFaultEvent[] = [];
  let initialWorker: SpawnedRecoveryWorker | null = null;
  let resumedWorker: SpawnedRecoveryWorker | null = null;
  try {
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(jobRoot, { recursive: true })]);
    initialWorker = spawnRecoveryWorker({
      mode: "start",
      implementation,
      runId,
      workspace,
      jobRoot,
      nonce,
      serviceTier,
    });
    events.push(workerEvent("worker_started", runId, initialWorker));
    const initialState = await waitForRecoveryWorkerState(
      statePath,
      initialWorker,
      "waiting_input",
      timeoutMs,
    );
    const initialProcess = await recoveryProcessEvidence(initialWorker, initialState.serverPid);
    const checkpoint = await readRecoveryCheckpoint(jobRoot, runId);
    events.push({
      type: "checkpoint_observed",
      at: new Date().toISOString(),
      runId,
      checkpointKind: checkpoint.kind,
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
      snapshotSha256: checkpoint.snapshotSha256,
      snapshotUpdatedAt: checkpoint.snapshotUpdatedAt,
    });
    if (
      checkpoint.threadId !== initialState.threadId ||
      checkpoint.turnId !== initialState.previousTurnId
    ) {
      throw new Error("recovery worker state does not match the durable waiting checkpoint");
    }
    const terminatedProcessIds = initialProcess.members.map((member) => member.pid);
    await killRecoveryProcessGroup(initialWorker, "SIGKILL");
    events.push({
      type: "fault_injected",
      at: new Date().toISOString(),
      runId,
      workerPid: initialWorker.pid,
      processGroupId: initialWorker.pid,
      signal: "SIGKILL",
      terminatedProcessIds,
    });
    initialWorker = null;

    await rm(statePath, { force: true });
    resumedWorker = spawnRecoveryWorker({
      mode: "resume",
      implementation,
      runId,
      workspace,
      jobRoot,
      nonce,
      serviceTier,
    });
    events.push(workerEvent("worker_restarted", runId, resumedWorker));
    const resumedState = await waitForRecoveryWorkerState(
      statePath,
      resumedWorker,
      "completed",
      timeoutMs,
    );
    const resumedProcess = await recoveryProcessEvidence(resumedWorker, resumedState.serverPid);
    if (
      resumedState.invocationCount !== 1 ||
      resumedState.sideEffectSha256 === undefined ||
      resumedState.resumedTurnId === undefined
    ) {
      throw new Error("recovery resume did not prove exactly one committed side effect");
    }
    events.push({
      type: "resume_completed",
      at: new Date().toISOString(),
      runId,
      threadId: resumedState.threadId,
      previousTurnId: resumedState.previousTurnId,
      resumedTurnId: resumedState.resumedTurnId,
      status: "completed",
      snapshotSha256: (await readRecoveryCheckpointSnapshot(jobRoot, runId)).sha256,
    });
    events.push({
      type: "side_effect_verified",
      at: new Date().toISOString(),
      runId,
      invocationCount: 1,
      sha256: resumedState.sideEffectSha256,
    });
    const evidence: RecoveryProfileEvidence = {
      schemaVersion: RECOVERY_PROFILE_VERSION,
      status: "passed",
      runId,
      implementation,
      initialProcess,
      resumedProcess,
      checkpoint,
      resumedTurnId: resumedState.resumedTurnId,
      sideEffect: { invocationCount: 1, sha256: resumedState.sideEffectSha256 },
      events,
      completedAt: new Date().toISOString(),
    };
    const path = join(evidenceRoot, "recovery", `${runId}.json`);
    const bytes = new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await killRecoveryProcessGroup(resumedWorker, "SIGTERM");
    resumedWorker = null;
    await rm(temporaryRoot, { recursive: true, force: true });
    return {
      evidence,
      path,
      sha256: hashBenchmarkBytes(bytes),
      sizeBytes: bytes.byteLength,
      temporaryRoot,
    };
  } catch (error) {
    if (initialWorker !== null) await killRecoveryProcessGroup(initialWorker, "SIGKILL");
    if (resumedWorker !== null) await killRecoveryProcessGroup(resumedWorker, "SIGKILL");
    throw error;
  }
}

interface SpawnedRecoveryWorker {
  child: ChildProcess;
  pid: number;
  stderr: string;
}

function spawnRecoveryWorker(options: Readonly<RecoveryWorkerOptions>): SpawnedRecoveryWorker {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      RECOVERY_WORKER_FLAG,
      "--mode",
      options.mode,
      "--implementation",
      options.implementation,
      "--run-id",
      options.runId,
      "--workspace",
      options.workspace,
      "--job-root",
      options.jobRoot,
      "--nonce",
      options.nonce,
      "--service-tier",
      options.serviceTier,
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("recovery worker did not receive a pid");
  const worker = { child, pid: child.pid, stderr: "" };
  child.stderr?.on("data", (chunk) => {
    worker.stderr = `${worker.stderr}${String(chunk)}`.slice(-32_768);
  });
  return worker;
}

function workerEvent(
  type: "worker_started" | "worker_restarted",
  runId: string,
  worker: Readonly<SpawnedRecoveryWorker>,
): RecoveryFaultEvent {
  return {
    type,
    at: new Date().toISOString(),
    runId,
    workerPid: worker.pid,
    processGroupId: worker.pid,
  };
}

async function waitForRecoveryWorkerState(
  path: string,
  worker: Readonly<SpawnedRecoveryWorker>,
  status: RecoveryWorkerState["status"],
  timeoutMs: number,
): Promise<RecoveryWorkerState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        const state = JSON.parse(await readFile(path, "utf8")) as RecoveryWorkerState;
        if (state.status === status) return state;
      } catch {
        // Atomic rename is unnecessary for this diagnostic; retry a partially observed write.
      }
    }
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`recovery worker exited before ${status}: ${worker.stderr.trim()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`recovery worker timed out waiting for ${status}: ${worker.stderr.trim()}`);
    }
    await delay(50);
  }
}

async function readRecoveryCheckpoint(jobRoot: string, runId: string): Promise<RecoveryCheckpoint> {
  const snapshot = await readRecoveryCheckpointSnapshot(jobRoot, runId);
  const value = JSON.parse(new TextDecoder().decode(snapshot.bytes)) as JobSnapshot;
  const checkpoint = value.waitingInputCheckpoint;
  if (value.result.status !== "waiting_input" || checkpoint?.kind !== "direct") {
    throw new Error("recovery worker did not persist a direct waiting_input checkpoint");
  }
  return {
    kind: "direct",
    threadId: checkpoint.turn.threadId,
    turnId: checkpoint.turn.previousTurnId,
    snapshotSha256: snapshot.sha256,
    snapshotUpdatedAt: value.updatedAt,
  };
}

async function readRecoveryCheckpointSnapshot(
  jobRoot: string,
  runId: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = await readFile(join(jobRoot, runId, "job.json"));
  return { bytes, sha256: hashBenchmarkBytes(bytes) };
}

async function recoveryProcessEvidence(
  worker: Readonly<SpawnedRecoveryWorker>,
  serverPid: number,
): Promise<RecoveryProcessEvidence> {
  const members = await processGroupMembers(worker.pid, serverPid);
  if (!members.some((member) => member.pid === worker.pid && member.role === "worker")) {
    throw new Error("recovery process group is missing its worker");
  }
  if (!members.some((member) => member.pid === serverPid && member.role === "app_server")) {
    throw new Error("recovery process group is missing its App Server child");
  }
  return { workerPid: worker.pid, processGroupId: worker.pid, members };
}

async function processGroupMembers(
  processGroupId: number,
  serverPid: number,
): Promise<RecoveryProcessMember[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const members: RecoveryProcessMember[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
      const tail = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const parentPid = Number(tail[1]);
      const group = Number(tail[2]);
      if (group !== processGroupId) continue;
      members.push({
        pid,
        parentPid,
        role: pid === processGroupId ? "worker" : pid === serverPid ? "app_server" : "child",
      });
    } catch {
      // Processes may terminate while /proc is being enumerated.
    }
  }
  return members.sort((left, right) => left.pid - right.pid);
}

async function killRecoveryProcessGroup(
  worker: Readonly<SpawnedRecoveryWorker>,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  try {
    process.kill(-worker.pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  await Promise.race([
    new Promise<void>((resolveExit) => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) resolveExit();
      else worker.child.once("exit", () => resolveExit());
    }),
    delay(5_000),
  ]);
  if (processIsAlive(worker.pid)) {
    try {
      process.kill(-worker.pid, "SIGKILL");
    } catch (error) {
      if (!isMissingProcessError(error)) throw error;
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function assertReleaseBenchmarkCorpus(
  manifest: Readonly<BenchmarkCorpusManifest>,
  artifactReader: BenchmarkArtifactReader,
  config: Readonly<RunnerOptions>,
): Promise<void> {
  const errors: string[] = [];
  if (!config.full || config.family !== null || config.instance !== null || config.limit !== null) {
    errors.push("release benchmark must run the full unfiltered corpus");
  }
  if (config.planningMode !== "internal-sol" || config.forceFanout || config.forceDelegated) {
    errors.push("release benchmark must use natural cheap-root routing without forced delegation");
  }
  if (!config.dynamicTool) {
    errors.push("release benchmark must include the complete cheap-root dynamic tool turn");
  }
  if (/diagnostic|development|synthetic|training/iu.test(manifest.suiteId)) {
    errors.push(
      "release suiteId must not identify a diagnostic, development, synthetic, or training corpus",
    );
  }

  const familyCounts = new Map<string, number>();
  let economicInstanceCount = 0;
  let directInstanceCount = 0;
  const promptHashes = new Set<string>();
  const workspaceHashes = new Set<string>();
  for (const instance of manifest.instances) {
    const identity = `${instance.familyId}/${instance.instanceId}`;
    familyCounts.set(instance.familyId, (familyCounts.get(instance.familyId) ?? 0) + 1);
    if (instance.evaluationClass === "economic-decomposable") {
      economicInstanceCount += 1;
    } else if (instance.evaluationClass === "direct-fast-path") {
      directInstanceCount += 1;
    } else {
      errors.push(`${identity} is missing a sealed evaluationClass`);
    }
    if (/diagnostic|development|synthetic|training|generated/iu.test(instance.sourceRevision)) {
      errors.push(`${identity} has a non-release sourceRevision`);
    }
    if (instance.provenance === undefined) {
      errors.push(`${identity} is missing release provenance`);
    }
    if (instance.validatorQualification === undefined) {
      errors.push(`${identity} is missing gold/mutant validator qualification`);
    }
    if (workspaceHashes.has(instance.initialStateSha256)) {
      errors.push(`${identity} duplicates another initial workspace`);
    }
    workspaceHashes.add(instance.initialStateSha256);

    const prompt = instance.artifacts.find((artifact) => artifact.role === "prompt");
    if (prompt !== undefined) {
      if (promptHashes.has(prompt.sha256)) {
        errors.push(`${identity} duplicates another prompt`);
      }
      promptHashes.add(prompt.sha256);
    }
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator");
    if (validatorSeal === undefined) {
      errors.push(`${identity} is missing a validator`);
      continue;
    }
    try {
      const validatorBytes = await artifactReader(validatorSeal, instance);
      const source = new TextDecoder().decode(validatorBytes).trim();
      if (!source.startsWith("{")) {
        throw new Error("legacy validator is not release-qualified");
      }
      const validator = parseSealedBenchmarkValidatorV1(JSON.parse(source) as unknown);
      validateReleaseFamilyDeliverables(
        instance.familyId,
        validator.requiredDeliverables,
        identity,
      );
    } catch (error) {
      errors.push(
        `${identity} validator: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const rubricSeal = instance.artifacts.find((artifact) => artifact.role === "quality_rubric");
    if (rubricSeal === undefined) {
      errors.push(`${identity} is missing a quality rubric`);
      continue;
    }
    try {
      const rubricBytes = await artifactReader(rubricSeal, instance);
      const rubric = JSON.parse(new TextDecoder().decode(rubricBytes)) as unknown;
      if (!isNonEmptyReleaseRubric(rubric)) {
        throw new Error("quality rubric has no scored dimensions or criteria");
      }
    } catch (error) {
      errors.push(`${identity} rubric: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      instance.familyId === "research-live" &&
      !instance.artifacts.some((artifact) => artifact.role === "external_snapshot")
    ) {
      errors.push(`${identity} is missing a frozen external replay snapshot`);
    }
  }

  for (const family of BENCHMARK_FAMILIES) {
    const count = familyCounts.get(family.id) ?? 0;
    if (count < 3) {
      errors.push(`${family.id} has ${String(count)} release instances; requires at least 3`);
    }
  }
  if (economicInstanceCount < 3) {
    errors.push(
      `release corpus has ${String(economicInstanceCount)} economic-decomposable instances; requires at least 3`,
    );
  }
  if (directInstanceCount < 3) {
    errors.push(
      `release corpus has ${String(directInstanceCount)} direct-fast-path instances; requires at least 3`,
    );
  }
  try {
    assertBenchmarkManifestCoverage(manifest, {
      minimumInstancesPerFamily: 3,
      requireAllFamilies: true,
      requireSealedEvaluationClass: true,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    throw new Error(`release corpus preflight failed:\n- ${errors.join("\n- ")}`);
  }
}

function validateReleaseFamilyDeliverables(
  familyId: string,
  deliverables: readonly { path: string }[],
  identity: string,
): void {
  const requiredExtension =
    familyId === "office-sheet"
      ? ".xlsx"
      : familyId === "office-document"
        ? ".docx"
        : familyId === "office-slides"
          ? ".pptx"
          : null;
  if (
    requiredExtension !== null &&
    !deliverables.some((deliverable) => deliverable.path.toLowerCase().endsWith(requiredExtension))
  ) {
    throw new Error(`${identity} must validate a real ${requiredExtension} deliverable`);
  }
  if (familyId === "auto-pipeline") {
    const extensions = new Set(
      deliverables.map((deliverable) => deliverable.path.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0]),
    );
    extensions.delete(undefined);
    if (extensions.size < 2) {
      throw new Error(`${identity} must validate at least two artifact formats`);
    }
  }
}

function isNonEmptyReleaseRubric(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const rubric = value as Record<string, unknown>;
  return (
    (Array.isArray(rubric["criteria"]) && rubric["criteria"].length > 0) ||
    (Array.isArray(rubric["dimensions"]) && rubric["dimensions"].length > 0)
  );
}

function selectManifest(
  source: BenchmarkCorpusManifest,
  config: RunnerOptions,
): BenchmarkCorpusManifest {
  let instances = source.instances;
  if (config.family !== null) {
    instances = instances.filter((instance) => instance.familyId === config.family);
    if (instances.length === 0) {
      throw new Error(`no instances found for family ${config.family}`);
    }
  } else if (!config.full && config.instance === null) {
    instances = instances.filter((instance) => instance.familyId === "coding-cross-module");
  }
  if (config.instance !== null) {
    instances = instances.filter((candidate) => candidate.instanceId === config.instance);
    if (instances.length === 0) {
      throw new Error(`no instances found for id ${config.instance}`);
    }
  }
  if (config.limit !== null) {
    instances = instances.slice(0, config.limit);
  } else if (!config.full && config.family === null) {
    instances = instances.slice(0, 1);
  }
  if (instances.length === 0) {
    throw new Error("benchmark selection is empty");
  }
  return sealBenchmarkManifest({
    schemaVersion: source.schemaVersion,
    suiteId: source.suiteId,
    sealedAt: source.sealedAt,
    baseline: source.baseline,
    instances,
  });
}

async function benchmarkEnvironment(): Promise<BenchmarkEnvironmentEvidence> {
  const bubblewrapVersion = await requireBubblewrapVersion();
  const provider = process.env["AGENT_TRIO_MODEL_PROVIDER"] ?? "openai";
  const serviceTier = process.env["AGENT_TRIO_SERVICE_TIER"] ?? "default";
  const plannerConfiguration = {
    transport: benchmarkPlannerTransport.kind,
    source: benchmarkPlannerTransport.source,
    model:
      benchmarkPlannerTransport.kind === "responses"
        ? benchmarkPlannerTransport.model
        : process.env["AGENT_TRIO_PLANNER_MODEL"]?.trim() || "gpt-5.6-sol",
    serviceTier:
      benchmarkPlannerTransport.kind === "responses"
        ? (benchmarkPlannerTransport.serviceTier ?? serviceTier)
        : process.env["AGENT_TRIO_PLANNER_SERVICE_TIER"]?.trim() || serviceTier,
    baseUrl:
      benchmarkPlannerTransport.kind === "responses" ? benchmarkPlannerTransport.baseUrl : null,
    provider:
      benchmarkPlannerTransport.kind === "responses"
        ? (benchmarkPlannerTransport.provider ?? null)
        : null,
  };
  const providerConfigurationSha256 = hashBenchmarkBytes(
    JSON.stringify({
      provider,
      serviceTier,
      codexVersion: CODEX_VERSION,
      priceTable: pricingSha256,
      rootContext: "warm-root-paired-same-thread-revert",
      sealedValidatorSandbox: bubblewrapVersion,
      plannerConfiguration,
    }),
  );
  return {
    provider,
    providerConfigurationSha256,
    serviceTier,
    permissions: {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccess: "restricted",
    },
    tools: [
      {
        id: "codex-app-server",
        version: CODEX_VERSION,
        configurationSha256: hashBenchmarkBytes(
          "command/exec;workspace-write;network=restricted;sealed-validator-v1",
        ),
      },
      {
        id: "bubblewrap",
        version: bubblewrapVersion,
        configurationSha256: hashBenchmarkBytes(
          "unshare-net;read-only-root;private-tmp;read-only-workspace",
        ),
      },
      {
        id: "agent-trio-sol-planner",
        version: benchmarkPlannerTransport.kind === "responses" ? "responses-v1" : CODEX_VERSION,
        configurationSha256: hashBenchmarkBytes(JSON.stringify(plannerConfiguration)),
      },
    ],
  };
}

function pairKey(request: Readonly<BenchmarkExecutionRequest>): string {
  return [
    request.suiteId,
    request.instance.familyId,
    request.instance.instanceId,
    request.instance.seed,
  ].join("\0");
}

async function createBenchmarkHostAppServer(
  workspace: string,
  runtimeRoot: string,
  socketPath: string,
  onDiagnostic: (chunk: string) => void,
): Promise<{ appServer: AppServer; close: () => Promise<void> }> {
  const sourceHome = resolve(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"));
  const files = (["auth.json", "config.toml"] as const).filter((file) =>
    existsSync(join(sourceHome, file)),
  );
  const projectedParent = join(runtimeRoot, "host-codex-homes");
  await mkdir(projectedParent, { recursive: true, mode: 0o700 });
  const connectionFactory = createCodexAppServerConnectionFactory({
    cwd: workspace,
    env: process.env,
    extraArgs: ["--disable", "plugins"],
    codexHomeIsolation: {
      mode: "projected",
      sourceHome,
      parentDirectory: projectedParent,
      files,
    },
    isolatedAgentTrioMcpServer: {
      command: process.execPath,
      args: [TSX_CLI_PATH, BENCHMARK_MCP_BRIDGE_PATH],
      env: {
        AGENT_TRIO_BENCHMARK_SOCKET: socketPath,
        AGENT_TRIO_BENCHMARK_ROOT: workspace,
      },
      startupTimeoutSec: 20,
      toolTimeoutSec: Math.ceil(BENCHMARK_RUN_DEADLINE_MS / 1_000),
    },
    onStderr: (chunk) => {
      process.stderr.write(chunk);
      onDiagnostic(chunk);
    },
  });
  const appServer = new CodexAppServerClient({ connectionFactory });
  return {
    appServer,
    close: async () => {
      try {
        await appServer.close();
      } finally {
        await connectionFactory.dispose();
      }
    },
  };
}

export function benchmarkRootThreadConfig(socketPath: string, workspace: string): JsonObject {
  const disabledRecursiveMcp = { command: "agent-trio-disabled", enabled: false };
  return {
    agents: { enabled: false },
    features: { multi_agent: false },
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    mcp_servers: {
      agent_trio: {
        command: process.execPath,
        args: [TSX_CLI_PATH, BENCHMARK_MCP_BRIDGE_PATH],
        env: {
          AGENT_TRIO_BENCHMARK_SOCKET: socketPath,
          AGENT_TRIO_BENCHMARK_ROOT: workspace,
        },
        enabled: true,
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 20,
        tool_timeout_sec: Math.ceil(BENCHMARK_RUN_DEADLINE_MS / 1_000),
      },
      hierarchical_codex: disabledRecursiveMcp,
      codex_mission_ledger: disabledRecursiveMcp,
      openaiDeveloperDocs: { enabled: false },
    },
  };
}

export function benchmarkDirectRootThreadConfig(): JsonObject {
  const disabledMcp = { command: "agent-trio-disabled", enabled: false };
  return {
    agents: { enabled: false },
    features: { multi_agent: false },
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    mcp_servers: {
      agent_trio: disabledMcp,
      hierarchical_codex: disabledMcp,
      codex_mission_ledger: disabledMcp,
      openaiDeveloperDocs: { enabled: false },
    },
  };
}

function rootApprovalPolicy(): "never" {
  return "never";
}

function recordHostDiagnostic(state: BenchmarkToolState, chunk: string): void {
  state.diagnosticBuffer += chunk;
  let newline = state.diagnosticBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = state.diagnosticBuffer.slice(0, newline);
    state.diagnosticBuffer = state.diagnosticBuffer.slice(newline + 1);
    if (
      state.phase === "v3" &&
      line.includes("MCP tool call error") &&
      line.includes("agent_trio/agent_trio")
    ) {
      state.protocolErrors += 1;
    }
    newline = state.diagnosticBuffer.indexOf("\n");
  }
  if (state.diagnosticBuffer.length > 64 * 1024) {
    state.diagnosticBuffer = state.diagnosticBuffer.slice(-64 * 1024);
  }
}

async function startBenchmarkMcpBridge(
  socketPath: string,
  handle: (request: AgentTrioRequest) => Promise<BatchResult>,
): Promise<() => Promise<void>> {
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 512 * 1024) {
        handled = true;
        socket.end(`${JSON.stringify({ id: "unknown", error: "bridge request too large" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      void (async () => {
        let id = "unknown";
        try {
          const envelope = JSON.parse(buffer.slice(0, newline)) as unknown;
          if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
            throw new Error("bridge request must be an object");
          }
          const record = envelope as Record<string, unknown>;
          if (typeof record["id"] !== "string" || record["id"].length === 0) {
            throw new Error("bridge request id must be a non-empty string");
          }
          id = record["id"];
          const request = parseAgentTrioRequest(record["request"]);
          const result = await handle(request);
          socket.end(`${JSON.stringify({ id, result })}\n`);
        } catch (error) {
          socket.end(
            `${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`,
          );
        }
      })();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o600);
  let closed = false;
  return async () => {
    if (closed) {
      return;
    }
    closed = true;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
    await rm(socketPath, { force: true });
  };
}

async function pairRuntimeFor(
  request: Readonly<BenchmarkExecutionRequest>,
  environment: BenchmarkEnvironmentEvidence,
): Promise<PairRuntime> {
  const key = pairKey(request);
  const existing = pairRuntimes.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const workspaceConfig = workspaceConfigFor(request);
  const workspace = await materializeWorkspace(request, workspaceConfig);
  let storage: PairStorage | undefined;
  let runtime: DefaultRuntime | undefined;
  let hostAppServer: AppServer | undefined;
  let closeHostAppServer = async (): Promise<void> => undefined;
  let closeMcpBridge = async (): Promise<void> => undefined;
  const toolState: BenchmarkToolState = {
    phase: "warmup",
    runs: [],
    protocolErrors: 0,
    diagnosticBuffer: "",
  };

  try {
    storage = await allocatePairStorage(workspace);
    const bridgeSocketPath = join(storage.runtimeRoot, "root-agent-trio.sock");
    runtime = createDefaultRuntime({
      cwd: workspace,
      jobRoot: storage.jobRoot,
      modelMap: { sol: request.baseline.model },
      ...(environment.serviceTier === "default" ? {} : { serviceTier: environment.serviceTier }),
      env: {
        ...process.env,
        AGENT_TRIO_PRICE_TABLE: PRICE_TABLE_PATH,
        AGENT_TRIO_CODEX_HOME_MODE: "projected",
      },
      turnTimeoutMs: BENCHMARK_TURN_TIMEOUT_MS,
    });
    if (options.dynamicTool) {
      const activeRuntime = runtime;
      closeMcpBridge = await startBenchmarkMcpBridge(bridgeSocketPath, async (parsed) => {
        if (
          toolState.phase === "probe" &&
          parsed.action === "status" &&
          parsed.runId === "transport-probe"
        ) {
          return {
            protocolVersion: 1,
            runId: parsed.runId,
            status: "completed",
            plan: null,
            patch: null,
            leaves: [],
            finalResponse: "transport-ready",
            metrics: null,
          };
        }
        if (toolState.phase !== "v3") {
          throw new Error(`agent_trio is forbidden during the ${toolState.phase} benchmark phase`);
        }
        if (toolState.runs.length > 0) {
          throw new Error("the benchmark permits at most one agent_trio call per root turn");
        }
        if (parsed.action !== "run") {
          throw new Error("the foreground paired benchmark permits only action=run");
        }
        if (resolve(parsed.cwd) !== workspace) {
          throw new Error("agent_trio cwd does not match the sealed paired workspace");
        }
        // The paired task text is already sealed. Root models sometimes normalize whitespace or
        // append a visible file index while constructing tool arguments; execute the canonical
        // objective so both arms still receive byte-identical task text.
        const canonicalRequest = markInternalPlannerDispatch({
          ...parsed,
          objective: promptFor(request),
        });
        const batch = await activeRuntime.service.handle(canonicalRequest);
        toolState.runs.push({ request: canonicalRequest, batch });
        return batch;
      });
      const host = await createBenchmarkHostAppServer(
        workspace,
        storage.runtimeRoot,
        bridgeSocketPath,
        (chunk) => recordHostDiagnostic(toolState, chunk),
      );
      hostAppServer = host.appServer;
      closeHostAppServer = host.close;
    } else {
      hostAppServer = runtime.appServer;
    }
    await hostAppServer.connect();
    const source = await hostAppServer.threadStart({
      model: request.baseline.model,
      ...(environment.serviceTier === "default" ? {} : { serviceTier: environment.serviceTier }),
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: rootApprovalPolicy(),
      sandbox: "workspace-write",
      config: options.dynamicTool
        ? benchmarkRootThreadConfig(bridgeSocketPath, workspace)
        : childThreadConfig(),
      developerInstructions: ROOT_BENCHMARK_INSTRUCTIONS,
      personality: "pragmatic",
      ephemeral: false,
      historyMode: "paginated",
      sessionStartSource: "startup",
      threadSource: ROOT_THREAD_SOURCE,
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    });
    const sourceThreadId = requireId(source.thread, "paired source thread/start");
    if (options.dynamicTool) {
      await assertBenchmarkMcpAvailable(hostAppServer, sourceThreadId);
      toolState.phase = "probe";
      const probe = await hostAppServer.request<{
        content: unknown[];
        isError?: boolean | null;
        structuredContent?: unknown;
      }>("mcpServer/tool/call", {
        server: "agent_trio",
        threadId: sourceThreadId,
        tool: "agent_trio",
        arguments: { action: "status", runId: "transport-probe" },
      });
      if (probe.isError === true || JSON.stringify(probe).includes("transport-ready") === false) {
        throw new Error(`benchmark root MCP transport probe failed: ${JSON.stringify(probe)}`);
      }
      toolState.phase = "warmup";
    }
    for (const [model, effort] of [[request.baseline.model, request.baseline.effort]] as const) {
      const warmup = await hostAppServer.turnStart({
        threadId: sourceThreadId,
        input: [
          textInput(
            'MODE: DIRECT. This is benchmark setup only. Return mode=direct, answer="ready", access=null, merge=null, risk=null, and tasks=[]. Do not inspect files or use tools.',
          ),
        ],
        cwd: workspace,
        runtimeWorkspaceRoots: [workspace],
        approvalPolicy: rootApprovalPolicy(),
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        model,
        ...(environment.serviceTier === "default" ? {} : { serviceTier: environment.serviceTier }),
        effort,
        summary: "none",
        personality: "pragmatic",
        outputSchema: jsonValue(ROOT_SOL_OUTPUT_SCHEMA),
      } satisfies TurnStartParams);
      const warmupTurnId = requireId(warmup.turn, `paired source ${model} warmup turn/start`);
      const warmed = await runtimeFor(hostAppServer).waitForTurn(sourceThreadId, warmupTurnId, {
        timeoutMs: BENCHMARK_TURN_TIMEOUT_MS,
      });
      if (parseRootSolDirectOutput(finalMessage(warmed.items)).trim() !== "ready") {
        throw new Error(`paired source ${model} warmup did not return the expected ready marker`);
      }
    }
    toolState.phase = "idle";
    const inject = requireThreadInjectItems(hostAppServer);
    await inject({
      threadId: sourceThreadId,
      items: [
        jsonValue({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                promptFor(request),
                `Workspace file index: ${JSON.stringify(workspaceFilePaths(request))}`,
              ].join("\n\n"),
            },
          ],
        }),
      ],
    });
    const pair = {
      key,
      workspace,
      runtimeRoot: storage.runtimeRoot,
      runtime,
      hostAppServer,
      closeHostAppServer,
      sourceThreadId,
      workspaceConfig,
      toolState,
      closeMcpBridge,
    } satisfies PairRuntime;
    pairRuntimes.set(key, pair);
    return pair;
  } catch (error) {
    await closeHostAppServer().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await closeMcpBridge().catch(() => undefined);
    if (storage === undefined) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      await disposePairStorage(storage);
    }
    throw error;
  }
}

async function assertBenchmarkMcpAvailable(appServer: AppServer, threadId: string): Promise<void> {
  const response = await appServer.request<{
    data: Array<{
      name: string;
      runtimeStatus?: unknown;
      tools?: Record<string, unknown>;
    }>;
  }>("mcpServerStatus/list", {
    threadId,
    detail: "full",
    cursor: null,
    limit: 100,
  });
  const server = Array.isArray(response.data)
    ? response.data.find((candidate) => candidate.name === "agent_trio")
    : undefined;
  const tools = server?.tools === undefined ? [] : Object.keys(server.tools);
  if (server === undefined || !tools.includes("agent_trio")) {
    const status = server === undefined ? "server absent" : JSON.stringify(server.runtimeStatus);
    throw new Error(
      `benchmark root MCP inventory is missing agent_trio/agent_trio (${status}; tools=${tools.join(",") || "none"})`,
    );
  }
}

export async function allocatePairStorage(workspace: string): Promise<PairStorage> {
  const runtimeRoot = await mkdirPairRuntimeRoot();
  return { workspace, runtimeRoot, jobRoot: join(runtimeRoot, "jobs") };
}

async function mkdirPairRuntimeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-trio-benchmark-runtime-"));
}

export async function disposePairStorage(
  storage: Readonly<Pick<PairStorage, "workspace" | "runtimeRoot">>,
): Promise<void> {
  await Promise.all([
    rm(storage.workspace, { recursive: true, force: true }),
    rm(storage.runtimeRoot, { recursive: true, force: true }),
  ]);
}

function requireThreadInjectItems(server: AppServer): NonNullable<AppServer["threadInjectItems"]> {
  if (server.threadInjectItems === undefined) {
    throw new Error("codex app-server 0.151.0 does not expose thread/inject_items");
  }
  return server.threadInjectItems.bind(server);
}

function requireThreadRevert(server: AppServer): NonNullable<AppServer["threadRevert"]> {
  if (server.threadRevert === undefined) {
    throw new Error("codex app-server 0.151.0 does not expose thread/revert");
  }
  return server.threadRevert.bind(server);
}

function requireThreadFork(server: AppServer): NonNullable<AppServer["threadFork"]> {
  if (server.threadFork === undefined) {
    throw new Error("codex app-server 0.151.0 does not expose thread/fork");
  }
  return server.threadFork.bind(server);
}

async function restoreRootAfterFirstArm(
  request: Readonly<BenchmarkExecutionRequest>,
  pair: Readonly<PairRuntime>,
  turnId: string | null,
): Promise<void> {
  if (request.orderInPair !== 0) {
    return;
  }
  if (turnId !== null) {
    await requireThreadRevert(pair.hostAppServer)({
      threadId: pair.sourceThreadId,
      beforeTurnId: turnId,
    });
  }
  await resetMaterializedWorkspace(pair.workspace, pair.workspaceConfig);
}

async function disposePairRuntime(request: Readonly<BenchmarkExecutionRequest>): Promise<void> {
  if (request.orderInPair !== 1) {
    return;
  }
  const key = pairKey(request);
  const pair = pairRuntimes.get(key);
  if (pair === undefined) {
    return;
  }
  pairRuntimes.delete(key);
  try {
    await pair.closeHostAppServer();
    await pair.runtime.close();
  } finally {
    await pair.closeMcpBridge().catch(() => undefined);
    await disposePairStorage(pair);
  }
}

async function disposeAllPairRuntimes(): Promise<void> {
  const pairs = [...pairRuntimes.values()];
  pairRuntimes.clear();
  await Promise.all(
    pairs.map(async (pair) => {
      await pair.closeHostAppServer().catch(() => undefined);
      await pair.runtime.close().catch(() => undefined);
      await pair.closeMcpBridge().catch(() => undefined);
      await disposePairStorage(pair);
    }),
  );
}

async function executeDirect(
  request: Readonly<BenchmarkExecutionRequest>,
  environment: BenchmarkEnvironmentEvidence,
  evidenceRoot: string,
): Promise<BenchmarkRunRecord> {
  const pair = await pairRuntimeFor(request, environment);
  const startedAt = new Date();
  let threadId!: string;
  let turnId!: string;
  let output!: string;
  let usage!: ModelUsage[];
  let transportItems!: readonly unknown[];
  let completedNormally = true;
  try {
    pair.toolState.phase = "direct";
    pair.toolState.runs.length = 0;
    threadId = pair.sourceThreadId;
    const turn = await pair.hostAppServer.turnStart({
      threadId,
      input: [
        textInput(
          options.dynamicTool
            ? "MODE: DIRECT. Complete the task already supplied and return only the final answer. Do not call agent_trio."
            : "MODE: DIRECT. Complete the task already supplied. Set mode=direct, put the complete final answer in answer, set access=null, merge=null, risk=null, and return tasks=[].",
        ),
      ],
      cwd: pair.workspace,
      runtimeWorkspaceRoots: [pair.workspace],
      approvalPolicy: rootApprovalPolicy(),
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [pair.workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: request.baseline.model,
      ...(environment.serviceTier === "default" ? {} : { serviceTier: environment.serviceTier }),
      effort: request.baseline.effort,
      summary: "none",
      personality: "pragmatic",
      ...(options.dynamicTool ? {} : { outputSchema: jsonValue(ROOT_SOL_OUTPUT_SCHEMA) }),
    } satisfies TurnStartParams);
    turnId = requireId(turn.turn, "turn/start");
    try {
      const runtime = runtimeFor(pair.hostAppServer);
      const eventCompleted = await runtime.waitForTurn(threadId, turnId, {
        timeoutMs: BENCHMARK_TURN_TIMEOUT_MS,
      });
      const completed = (await runtime.readCompletedTurn(threadId, turnId)) ?? eventCompleted;
      transportItems = completed.items;
      assertNoSubAgentActivity(transportItems, "direct Sol baseline");
      output = options.dynamicTool
        ? finalMessage(completed.items)
        : parseRootSolDirectOutput(finalMessage(completed.items));
    } catch (error) {
      if (!isBenchmarkTurnTimeout(error)) throw error;
      completedNormally = false;
      process.stderr.write(
        `direct Sol timed out after ${String(BENCHMARK_TURN_TIMEOUT_MS)}ms; interrupting and continuing the pair\n`,
      );
      await pair.hostAppServer.turnInterrupt({ threadId, turnId });
      const interrupted = await runtimeFor(pair.hostAppServer).waitForTurn(threadId, turnId, {
        timeoutMs: BENCHMARK_INTERRUPT_TIMEOUT_MS,
      });
      transportItems = interrupted.items;
      assertNoSubAgentActivity(transportItems, "interrupted direct Sol baseline");
      output = finalMessage(interrupted.items);
      if (output.trim().length === 0) {
        output = `Benchmark direct Sol turn timed out after ${String(BENCHMARK_TURN_TIMEOUT_MS)}ms.`;
      }
    }
    usage = await captureTurnUsage({
      server: pair.hostAppServer,
      threadId,
      turnId,
      model: request.baseline.model,
      tier: "sol",
      effort: request.baseline.effort as never,
      priceTable: prices,
    });
    const completedAt = new Date();
    const record = await buildRecord({
      request,
      arm: "direct_sol",
      environment,
      startedAt,
      completedAt,
      output,
      usageByStage: { direct: usage },
      route: "direct",
      plannerTurns: 0,
      hostPlanned: false,
      replanCount: 0,
      promotionCount: 0,
      finalReviewTurns: 0,
      leafCount: 0,
      launchSkewMs: null,
      batch: null,
      transportItems,
      evidenceRoot,
      threadId,
      turnId,
      workspace: pair.workspace,
      completed: completedNormally,
    });
    await restoreRootAfterFirstArm(request, pair, turnId);
    return record;
  } finally {
    pair.toolState.phase = "idle";
    await disposePairRuntime(request);
  }
}

async function executeV3(
  request: Readonly<BenchmarkExecutionRequest>,
  environment: BenchmarkEnvironmentEvidence,
  evidenceRoot: string,
): Promise<BenchmarkRunRecord> {
  const pair = await pairRuntimeFor(request, environment);
  const startedAt = new Date();
  if (options.dynamicTool) {
    return executeDynamicToolV3(request, environment, evidenceRoot, pair, startedAt);
  }
  let batch: BatchResult;
  const familyDecomposable = isDecomposableFamily(request.instance.familyId);
  const decomposable = familyDecomposable && pair.workspaceConfig.decomposition === "independent";
  const routeRequest: RunRequest = {
    objective: promptFor(request),
    cwd: pair.workspace,
    domain: domainForFamily(request.instance.familyId),
    constraints: [
      pair.workspaceConfig.access === "readOnly"
        ? "read-only benchmark: do not modify files"
        : "workspace-write benchmark: modify only files required by the sealed task",
    ],
  };
  let hostPlanningUsage: ModelUsage[] = [];
  let hostPlanningTurnId: string | null = null;
  let delegatedTier: "luna" | "terra" | null =
    familyDecomposable && !decomposable ? recommendDirectTier(routeRequest) : null;
  let semanticPlan: HostSemanticPlan | undefined =
    decomposable && options.planningMode === "diagnostic-host"
      ? diagnosticHostPlan(pair.workspaceConfig.access)
      : undefined;
  const localRoute =
    decomposable && options.planningMode === "host-sol" && !options.forceFanout
      ? localBenchmarkRoute(routeRequest)
      : null;
  try {
    if (localRoute?.route === "direct") {
      delegatedTier = recommendDirectTier(routeRequest);
      const base = benchmarkEvidenceBase(evidenceRoot, request, "v3");
      await mkdir(base, { recursive: true });
      await writeFile(
        join(base, "local-route.json"),
        `${JSON.stringify({ decision: localRoute, tier: delegatedTier }, null, 2)}\n`,
        "utf8",
      );
    } else if (decomposable && options.planningMode === "host-sol") {
      const routed = await generateHostSolRouteDecision(pair, request, environment);
      if (routed.decision.mode === "plan") {
        semanticPlan = routed.decision.plan;
      } else if (routed.decision.mode === "delegate") {
        delegatedTier = routed.decision.tier;
      }
      hostPlanningTurnId = routed.turnId;
      const base = benchmarkEvidenceBase(evidenceRoot, request, "v3");
      await mkdir(base, { recursive: true });
      await writeFile(
        join(base, "host-route.json"),
        `${JSON.stringify({ decision: routed.decision, usage: routed.usage }, null, 2)}\n`,
        "utf8",
      );
      if (routed.decision.mode === "self") {
        const record = await buildRecord({
          request,
          arm: "v3",
          environment,
          startedAt,
          completedAt: new Date(),
          output: routed.decision.answer,
          usageByStage: { direct: routed.usage },
          route: "direct",
          plannerTurns: 0,
          hostPlanned: false,
          replanCount: 0,
          promotionCount: 0,
          finalReviewTurns: 0,
          leafCount: 0,
          launchSkewMs: null,
          batch: null,
          evidenceRoot,
          threadId: pair.sourceThreadId,
          turnId: routed.turnId,
          workspace: pair.workspace,
        });
        await restoreRootAfterFirstArm(request, pair, hostPlanningTurnId);
        return record;
      }
      hostPlanningUsage = routed.usage;
    }
    batch = await pair.runtime.service.run({
      ...routeRequest,
      ...(delegatedTier === null
        ? familyDecomposable && !decomposable
          ? { strategy: "direct" as const }
          : {}
        : { strategy: "direct" as const, directTier: delegatedTier }),
      constraints: [
        ...routeRequest.constraints!,
        ...(decomposable && options.forceFanout ? ["agent-trio-benchmark:force-fanout"] : []),
      ],
      ...(semanticPlan === undefined ? {} : { semanticPlan }),
      integrate: true,
      limits: {
        maxConcurrent: 5,
        maxLeaves: 8,
        maxWaves: 3,
        maxSolLeaves: 1,
        maxReplans: semanticPlan === undefined ? 1 : 0,
        deadlineMs: BENCHMARK_RUN_DEADLINE_MS,
      },
    });
    const completedAt = new Date();
    const output = batch.finalResponse ?? batch.error ?? batch.needsAction ?? "";
    const actualRoute =
      batch.plan === null ? (delegatedTier === null ? "direct" : "delegated") : "fanout";
    const usageByStage =
      batch.metrics?.usageByStage === undefined
        ? emptyUsageByStage()
        : (Object.fromEntries(
            (Object.keys(batch.metrics.usageByStage) as BenchmarkUsageStage[]).map((stage) => [
              stage,
              batch.metrics!.usageByStage![stage].usage,
            ]),
          ) as Partial<Record<BenchmarkUsageStage, readonly ModelUsage[]>>);
    usageByStage.planning = [...hostPlanningUsage, ...(usageByStage.planning ?? [])];
    const record = await buildRecord({
      request,
      arm: "v3",
      environment,
      startedAt,
      completedAt,
      output,
      usageByStage,
      route: actualRoute,
      plannerTurns: (usageByStage.planning ?? []).length > 0 ? 1 : 0,
      hostPlanned: batch.plan !== null && batch.metrics?.plannerSkipped === true,
      replanCount: batch.metrics?.replanCount ?? 0,
      promotionCount: batch.leaves.filter((leaf) => leaf.taskId.includes("promotion")).length,
      finalReviewTurns: batch.metrics?.usageByStage?.finalReview.usage.length ?? 0,
      leafCount: batch.leaves.length,
      launchSkewMs: actualRoute === "fanout" ? (batch.metrics?.launchSkewMs ?? 0) : null,
      batch,
      evidenceRoot,
      threadId: null,
      turnId: null,
      workspace: pair.workspace,
    });
    await restoreRootAfterFirstArm(request, pair, hostPlanningTurnId);
    return record;
  } finally {
    await disposePairRuntime(request);
  }
}

async function executeDynamicToolV3(
  request: Readonly<BenchmarkExecutionRequest>,
  environment: BenchmarkEnvironmentEvidence,
  evidenceRoot: string,
  pair: Readonly<PairRuntime>,
  startedAt: Date,
): Promise<BenchmarkRunRecord> {
  try {
    pair.toolState.runs.length = 0;
    pair.toolState.protocolErrors = 0;
    pair.toolState.diagnosticBuffer = "";
    const hostSolMode = options.planningMode === "host-sol";
    const diagnosticHostMode = options.planningMode === "diagnostic-host";
    const rootUsesSol = hostSolMode || diagnosticHostMode;
    const routeRequest: RunRequest = {
      objective: promptFor(request),
      cwd: pair.workspace,
      domain: domainForFamily(request.instance.familyId),
      constraints: [
        MCP_ROOT_DISPATCH_CONSTRAINT,
        pair.workspaceConfig.access === "readOnly"
          ? "read-only benchmark: do not modify files"
          : "workspace-write benchmark: modify only files required by the sealed task",
      ],
    };
    const localRoute =
      !rootUsesSol && !options.forceDelegated && !options.forceFanout
        ? localBenchmarkRoute(routeRequest)
        : null;
    const rootMustAnswerDirectly = localRoute?.route === "direct";
    pair.toolState.phase = rootMustAnswerDirectly ? "v3-direct" : "v3";
    if (localRoute !== null) {
      const base = benchmarkEvidenceBase(evidenceRoot, request, "v3");
      await mkdir(base, { recursive: true });
      await writeFile(
        join(base, "local-route.json"),
        `${JSON.stringify({ decision: localRoute }, null, 2)}\n`,
        "utf8",
      );
    }
    const cheapRootTier = benchmarkCheapRootTier(routeRequest, {
      dispatchOnly:
        !rootUsesSol &&
        (options.forceDelegated || options.forceFanout || localRouteRequiresTool(localRoute)),
    });
    const rootModel = rootUsesSol ? request.baseline.model : CHEAP_ROOT_MODELS[cheapRootTier];
    const rootTier = rootUsesSol ? ("sol" as const) : cheapRootTier;
    const rootEffort = diagnosticHostMode
      ? HOST_SOL_ADMISSION_EFFORT
      : hostSolMode
        ? options.forceDelegated
          ? HOST_SOL_ADMISSION_EFFORT
          : HOST_SOL_PLANNER_EFFORT
        : CHEAP_ROOT_EFFORT;
    const rootInstruction = diagnosticHostMode
      ? [
          "MODE: TOOL. This is a deterministic host-plan transport diagnostic. Do not solve or revise the supplied plan.",
          "Call mcp__agent_trio__agent_trio exactly once now with these exact arguments:",
          JSON.stringify({
            action: "run",
            objective: promptFor(request),
            cwd: pair.workspace,
            strategy: "fanout",
            domain: domainForFamily(request.instance.familyId),
            semanticPlan: diagnosticPathPlan(request, pair.workspaceConfig.access),
            integrate: true,
          }),
          "The complete tool result is user-visible. After it returns, reply only: Agent Trio completed. Do not repeat finalResponse.",
        ].join("\n\n")
      : !hostSolMode
        ? cheapRootInstruction(request, pair, localRoute)
        : options.forceDelegated
          ? [
              "MODE: TOOL. This is a mandatory transport probe. Do not solve the task yourself.",
              "Call mcp__agent_trio__agent_trio exactly once now with these exact arguments:",
              JSON.stringify({
                action: "run",
                objective: promptFor(request),
                cwd: pair.workspace,
                strategy: "direct",
                directTier: "luna",
                domain: domainForFamily(request.instance.familyId),
                constraints: [
                  pair.workspaceConfig.access === "readOnly"
                    ? "read-only benchmark: do not modify files"
                    : "workspace-write benchmark: modify only files required by the sealed task",
                ],
                integrate: true,
              }),
              "The complete tool result is user-visible. After it returns, reply only: Agent Trio completed. Do not repeat finalResponse.",
            ].join("\n\n")
          : options.forceFanout
            ? [
                "MODE: TOOL. This is a mandatory host-Sol fanout probe. Do not solve the task yourself.",
                "Create a valid 2-5 task semanticPlan from the task and workspace file index already supplied, then call mcp__agent_trio__agent_trio exactly once.",
                `Use action=run, objective=${JSON.stringify(promptFor(request))}, cwd=${JSON.stringify(pair.workspace)}, strategy=fanout, domain=${JSON.stringify(domainForFamily(request.instance.familyId))}, integrate=true, and the semanticPlan.`,
                `The plan must use access=${pair.workspaceConfig.access}, merge=deterministic, risk=low. Each task must contain only goal, paths, after, floor, and expectedSeconds; use floor=null for Luna, only real workspace-relative paths, and a real worker-time estimate above ${String(FANOUT_MIN_TASK_SECONDS)} seconds.`,
                "Choose the smallest useful 2-5 leaves that minimize end-to-end wall time while keeping total cost below 40% of direct Sol. Add leaves only when their predicted parallel gain repays fixed startup cost.",
                "The complete tool result is user-visible. After it returns, reply only: Agent Trio completed. Do not repeat finalResponse.",
              ].join("\n\n")
            : [
                "Complete the task already supplied. The agent_trio tool description and schema are binding: call it exactly once only when you can provide an economically valid fanout semanticPlan; otherwise answer directly.",
                `A tool call must reuse the supplied task as objective and set cwd=${JSON.stringify(pair.workspace)}, domain=${JSON.stringify(domainForFamily(request.instance.familyId))}, action=run, strategy=fanout, and integrate=true.`,
                "When planning, use only the supplied objective and Workspace file index; do not run commands or inspect files. semanticPlan must contain access, merge, risk, and tasks. Every task contains only goal, paths, after, floor, and expectedSeconds; never add id.",
                "After a successful tool call reply only: Agent Trio completed. If no call is worthwhile, return only the final task answer.",
              ].join("\n\n");
    const rootThreadId = rootMustAnswerDirectly
      ? await requireThreadFork(pair.hostAppServer)({
          threadId: pair.sourceThreadId,
          model: rootModel,
          ...(environment.serviceTier === "default"
            ? {}
            : { serviceTier: environment.serviceTier }),
          cwd: pair.workspace,
          runtimeWorkspaceRoots: [pair.workspace],
          approvalPolicy: rootApprovalPolicy(),
          sandbox: "workspace-write",
          config: benchmarkDirectRootThreadConfig(),
          developerInstructions: ROOT_BENCHMARK_INSTRUCTIONS,
          threadSource: `${ROOT_THREAD_SOURCE}-direct`,
        })
      : null;
    const executionThreadId =
      rootThreadId === null
        ? pair.sourceThreadId
        : requireId(rootThreadId.thread, "dynamic direct root thread/fork");
    const turn = await pair.hostAppServer.turnStart({
      threadId: executionThreadId,
      input: [textInput(rootInstruction)],
      cwd: pair.workspace,
      runtimeWorkspaceRoots: [pair.workspace],
      approvalPolicy: rootApprovalPolicy(),
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [pair.workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: rootModel,
      ...(environment.serviceTier === "default" ? {} : { serviceTier: environment.serviceTier }),
      effort: rootEffort as never,
      summary: "none",
      personality: "pragmatic",
    } satisfies TurnStartParams);
    const rootTurnId = requireId(turn.turn, "dynamic root turn/start");
    const runtime = runtimeFor(pair.hostAppServer);
    const eventCompleted = await runtime.waitForTurn(executionThreadId, rootTurnId, {
      timeoutMs: BENCHMARK_TURN_TIMEOUT_MS,
    });
    const completed =
      (await runtime.readCompletedTurn(executionThreadId, rootTurnId)) ?? eventCompleted;
    assertNoLegacyAgentTrioSkillUse(completed.items);
    assertNoSubAgentActivity(completed.items, "V3 root");
    const rootOutput = finalMessage(completed.items);
    const rootUsage = await captureTurnUsage({
      server: pair.hostAppServer,
      threadId: executionThreadId,
      turnId: rootTurnId,
      model: rootModel,
      tier: rootTier,
      effort: rootEffort as never,
      priceTable: prices,
    });
    const toolRun = pair.toolState.runs[0];
    if (toolRun === undefined) {
      if (options.forceDelegated || options.forceFanout || localRouteRequiresTool(localRoute)) {
        throw new Error(
          `root model did not perform the required agent_trio tool call; final output: ${rootOutput.slice(0, 2_000)}`,
        );
      }
      const record = await buildRecord({
        request,
        arm: "v3",
        environment,
        startedAt,
        completedAt: new Date(),
        output: rootOutput,
        usageByStage: { direct: rootUsage },
        route: "direct",
        plannerTurns: 0,
        hostPlanned: false,
        replanCount: 0,
        promotionCount: 0,
        finalReviewTurns: 0,
        leafCount: 0,
        launchSkewMs: null,
        batch: null,
        transportItems: completed.items,
        protocolErrors: pair.toolState.protocolErrors,
        evidenceRoot,
        threadId: executionThreadId,
        turnId: rootTurnId,
        workspace: pair.workspace,
      });
      await restoreRootAfterFirstArm(
        request,
        pair,
        executionThreadId === pair.sourceThreadId ? rootTurnId : null,
      );
      return record;
    }

    const { batch } = toolRun;
    const output = batch.finalResponse ?? batch.error ?? batch.needsAction ?? "";
    const actualRoute = batch.plan === null ? "delegated" : "fanout";
    const usageByStage = batchUsageByStage(batch);
    const hostPlanned = batch.plan !== null && batch.metrics?.plannerSkipped === true;
    const rootStage: BenchmarkUsageStage = rootUsesSol
      ? hostPlanned
        ? "planning"
        : "admission"
      : "integration";
    usageByStage[rootStage] = [...rootUsage, ...(usageByStage[rootStage] ?? [])];
    const record = await buildRecord({
      request,
      arm: "v3",
      environment,
      startedAt,
      completedAt: new Date(),
      output,
      usageByStage,
      route: actualRoute,
      plannerTurns: (usageByStage.planning ?? []).length > 0 ? 1 : 0,
      hostPlanned,
      replanCount: batch.metrics?.replanCount ?? 0,
      promotionCount: batch.leaves.filter((leaf) => leaf.taskId.includes("promotion")).length,
      finalReviewTurns: batch.metrics?.usageByStage?.finalReview.usage.length ?? 0,
      leafCount: batch.leaves.length,
      launchSkewMs: actualRoute === "fanout" ? (batch.metrics?.launchSkewMs ?? null) : null,
      batch,
      transportItems: completed.items,
      protocolErrors: pair.toolState.protocolErrors,
      evidenceRoot,
      threadId: executionThreadId,
      turnId: rootTurnId,
      workspace: pair.workspace,
    });
    await restoreRootAfterFirstArm(
      request,
      pair,
      executionThreadId === pair.sourceThreadId ? rootTurnId : null,
    );
    return record;
  } finally {
    pair.toolState.phase = "idle";
    await disposePairRuntime(request);
  }
}

function cheapRootInstruction(
  request: Readonly<BenchmarkExecutionRequest>,
  pair: Readonly<PairRuntime>,
  localRoute: ReturnType<typeof localBenchmarkRoute> | null,
): string {
  const constraints = [
    pair.workspaceConfig.access === "readOnly"
      ? "read-only benchmark: do not modify files"
      : "workspace-write benchmark: modify only files required by the sealed task",
    ...(options.forceFanout ? ["agent-trio-benchmark:force-fanout"] : []),
  ];
  if (!options.forceDelegated && !options.forceFanout) {
    if (localRoute?.route === "direct") {
      return [
        "MODE: DIRECT. Complete the supplied task now and return only the final task result.",
        `Deterministic economic admission selected direct execution: ${localRoute.reason}. The agent_trio tool is disabled for this turn; do not call or mention it.`,
        "Use normal workspace tools when needed. Preserve every requested item marker, exact value, citation, and deliverable contract.",
      ].join("\n\n");
    }
    if (localRoute?.route === "fanout") {
      return [
        "MODE: TOOL. Deterministic economic admission selected fanout. Do not solve, inspect, or modify the task yourself.",
        `Admission result: ${localRoute.reason}. Call mcp__agent_trio__agent_trio exactly once now with these exact arguments:`,
        JSON.stringify({
          action: "run",
          objective: promptFor(request),
          cwd: pair.workspace,
          strategy: "auto",
          domain: domainForFamily(request.instance.familyId),
          constraints,
          integrate: true,
        }),
        "The runtime's Sol planner owns semantic decomposition. The complete tool result is user-visible. After it returns, reply only: Agent Trio completed.",
      ].join("\n\n");
    }
    return [
      "Complete the supplied task now. If it is a bounded one-turn task that you can solve well yourself, answer directly and do not call agent_trio.",
      "Use your normal workspace tools for one local fix, a finite exact calculation over a handful of local inputs, a targeted rewrite, or another single-deliverable task. These remain one-turn tasks; a domain label such as algorithm or research is not a reason to delegate.",
      `Do not call merely because several partitions exist. Call mcp__agent_trio__agent_trio exactly once with strategy=auto when at least two useful independent leaves should take more than ${String(FANOUT_MIN_TASK_SECONDS)} seconds of actual Luna wall time and fanout should meet the 40% cost and 70% latency targets. Let the runtime's complete economic model decide whether several smaller Luna leaves repay planning.`,
      "When calling the tool, do not inspect the workspace or create a semanticPlan first; the runtime performs deterministic economic admission and invokes its internal Sol planner only for admitted fanout.",
      "Use these exact tool arguments:",
      JSON.stringify({
        action: "run",
        objective: promptFor(request),
        cwd: pair.workspace,
        strategy: "auto",
        domain: domainForFamily(request.instance.familyId),
        constraints,
        integrate: true,
      }),
      "The complete tool result is user-visible. After a successful tool call, reply only: Agent Trio completed. Do not repeat finalResponse.",
    ].join("\n\n");
  }
  const strategy = options.forceDelegated ? "direct" : "fanout";
  return [
    "MODE: TOOL. This is a mandatory route diagnostic. Do not solve or plan the task yourself.",
    "Call mcp__agent_trio__agent_trio exactly once now with these exact arguments:",
    JSON.stringify({
      action: "run",
      objective: promptFor(request),
      cwd: pair.workspace,
      strategy,
      ...(options.forceDelegated ? { directTier: "luna" } : {}),
      domain: domainForFamily(request.instance.familyId),
      constraints,
      integrate: true,
    }),
    "Do not include semanticPlan. The runtime performs economic admission and invokes its internal Sol planner only for admitted fanout.",
    "The complete tool result is user-visible. After it returns, reply only: Agent Trio completed. Do not repeat finalResponse.",
  ].join("\n\n");
}

export function localRouteRequiresTool(route: Readonly<{ route: string }> | null): boolean {
  return route?.route === "fanout";
}

export function benchmarkCheapRootTier(
  request: RunRequest,
  options: Readonly<{ dispatchOnly: boolean }>,
): "luna" | "terra" {
  // Once deterministic admission has selected the MCP path, the host only emits one exact tool
  // call and a fixed acknowledgement. Charging a Terra turn for that mechanical envelope both
  // wastes money and contradicts MCP_ROOT_DISPATCH_PROFILE, which models a Luna dispatch.
  return options.dispatchOnly ? "luna" : recommendDirectTier(request);
}

function diagnosticPathPlan(
  request: Readonly<BenchmarkExecutionRequest>,
  access: "readOnly" | "workspaceWrite",
): HostSemanticPlan {
  const paths = workspaceFilePaths(request);
  if (paths.length < 2) {
    return diagnosticHostPlan(access);
  }
  const leafCount = Math.max(2, Math.min(4, Math.ceil(paths.length / 3)));
  const partitions = Array.from({ length: leafCount }, () => [] as string[]);
  for (const [index, path] of paths.entries()) {
    partitions[index % leafCount]!.push(path);
  }
  return {
    access,
    merge: "deterministic",
    risk: "low",
    tasks: partitions.map((ownedPaths) => ({
      goal: null,
      paths: ownedPaths,
      after: [],
      floor: null,
      expectedSeconds: 90,
    })),
  };
}

function batchUsageByStage(
  batch: Readonly<BatchResult>,
): Partial<Record<BenchmarkUsageStage, readonly ModelUsage[]>> {
  if (batch.metrics?.usageByStage === undefined) {
    return emptyUsageByStage();
  }
  return Object.fromEntries(
    (Object.keys(batch.metrics.usageByStage) as BenchmarkUsageStage[]).map((stage) => [
      stage,
      batch.metrics!.usageByStage![stage].usage,
    ]),
  ) as Partial<Record<BenchmarkUsageStage, readonly ModelUsage[]>>;
}

async function generateHostSolRouteDecision(
  pair: Readonly<PairRuntime>,
  request: Readonly<BenchmarkExecutionRequest>,
  environment: BenchmarkEnvironmentEvidence,
) {
  const threadId = pair.sourceThreadId;
  const turn = await pair.hostAppServer.turnStart({
    threadId,
    input: [
      textInput(
        [
          "Choose the cheapest execution shape for the task already supplied.",
          "MODE: ROUTE. Delegation pays for this Sol turn plus every worker. Delegate only when total cost is likely at most 40% of completing with Sol and latency at most 70%; a concise single-Sol answer below about 700 output tokens usually cannot repay delegation, so complete it now.",
          "To complete now, return mode=direct with the full final answer in answer, access/merge/risk=null, and tasks=[]. To delegate the whole bounded task, use the exact answer delegate:luna or delegate:terra instead; prefer Luna unless materially insufficient.",
          `Return mode=plan, answer=null, access=${pair.workspaceConfig.access}, merge=deterministic, risk=low, and a compact plan only when at least two independent tasks are each expected to take over ${String(FANOUT_MIN_TASK_SECONDS)} seconds and parallel execution will repay planning and integration overhead.`,
          "For a plan use the smallest useful 2-5 tasks. For homogeneous path partitions set goal=null; otherwise keep it under 80 characters. paths are workspace-relative; after contains zero-based prerequisite task indexes. Use floor=null unless Luna is insufficient. The runtime creates ids and derives all other fields.",
          ...(options.forceFanout
            ? ["This diagnostic run explicitly requires fanout; return a valid plan."]
            : []),
        ].join("\n\n"),
      ),
    ],
    cwd: pair.workspace,
    runtimeWorkspaceRoots: [pair.workspace],
    approvalPolicy: rootApprovalPolicy(),
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [pair.workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    model: request.baseline.model,
    ...(environment.serviceTier === "default" ? {} : { serviceTier: environment.serviceTier }),
    effort: HOST_SOL_PLANNER_EFFORT,
    summary: "none",
    personality: "pragmatic",
    outputSchema: jsonValue(ROOT_SOL_OUTPUT_SCHEMA),
  } satisfies TurnStartParams);
  const turnId = requireId(turn.turn, "host Sol turn/start");
  const completed = await runtimeFor(pair.hostAppServer).waitForTurn(threadId, turnId, {
    timeoutMs: BENCHMARK_TURN_TIMEOUT_MS,
  });
  assertNoSubAgentActivity(completed.items, "host Sol router");
  const decision = parseRootSolRouteDecision(finalMessage(completed.items));
  const usage = await captureTurnUsage({
    server: pair.hostAppServer,
    threadId,
    turnId,
    model: request.baseline.model,
    tier: "sol",
    effort: HOST_SOL_PLANNER_EFFORT,
    priceTable: prices,
  });
  return { decision, usage, turnId };
}

function localBenchmarkRoute(request: RunRequest) {
  return benchmarkRouteOptimizer.decide({
    runId: "benchmark-local-route",
    request,
    signal: new AbortController().signal,
  });
}

function workspaceFilePaths(request: Readonly<BenchmarkExecutionRequest>): string[] {
  return workspaceConfigFor(request).files.map((file) => file.path);
}

export function diagnosticHostPlan(access: "readOnly" | "workspaceWrite"): HostSemanticPlan {
  return {
    access,
    merge: "deterministic",
    risk: "low",
    tasks: [
      {
        goal: "Inspect the supplied fixture and report its explicit contract, expected result, and material uncertainty without modifying files.",
        paths: [],
        after: [],
        floor: null,
        expectedSeconds: 90,
      },
      {
        goal: "Independently inspect the supplied fixture for contradictions, missing evidence, and validation limits without modifying files.",
        paths: [],
        after: [],
        floor: null,
        expectedSeconds: 90,
      },
    ],
  };
}

function rootSolOutputSchema(): Readonly<Record<string, unknown>> {
  const hostSchema = hostSemanticPlanJsonSchemaForRoute("fanout", 5) as {
    properties: {
      access: Readonly<Record<string, unknown>>;
      merge: Readonly<Record<string, unknown>>;
      risk: Readonly<Record<string, unknown>>;
      tasks: { items: Readonly<Record<string, unknown>> };
    };
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["mode", "answer", "access", "merge", "risk", "tasks"],
    properties: {
      mode: { type: "string", enum: ["direct", "plan"] },
      answer: { type: ["string", "null"], maxLength: 200_000 },
      access: {
        ...hostSchema.properties.access,
        type: ["string", "null"],
        enum: ["readOnly", "workspaceWrite", null],
      },
      merge: {
        ...hostSchema.properties.merge,
        type: ["string", "null"],
        enum: ["deterministic", null],
      },
      risk: { ...hostSchema.properties.risk, type: ["string", "null"], enum: ["low", null] },
      tasks: {
        type: "array",
        minItems: 0,
        maxItems: 5,
        items: hostSchema.properties.tasks.items,
      },
    },
  };
}

function parseRootSolEnvelope(output: string): {
  mode: "direct" | "plan";
  answer: string | null;
  access: "readOnly" | "workspaceWrite" | null;
  merge: "deterministic" | null;
  risk: "low" | null;
  tasks: unknown[];
} {
  const parsed = JSON.parse(output) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("root Sol output must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["mode"] !== "direct" && record["mode"] !== "plan") {
    throw new Error("root Sol output mode must be direct or plan");
  }
  if (record["answer"] !== null && typeof record["answer"] !== "string") {
    throw new Error("root Sol output answer must be a string or null");
  }
  if (!Array.isArray(record["tasks"])) {
    throw new Error("root Sol output tasks must be an array");
  }
  const access = record["access"];
  const merge = record["merge"];
  const risk = record["risk"];
  if (access !== null && access !== "readOnly" && access !== "workspaceWrite") {
    throw new Error("root Sol output access must be readOnly, workspaceWrite, or null");
  }
  if (merge !== null && merge !== "deterministic") {
    throw new Error("root Sol output merge must be deterministic or null");
  }
  if (risk !== null && risk !== "low") {
    throw new Error("root Sol output risk must be low or null");
  }
  return {
    mode: record["mode"],
    answer: record["answer"],
    access,
    merge,
    risk,
    tasks: record["tasks"],
  };
}

export function parseRootSolDirectOutput(output: string): string {
  const envelope = parseRootSolEnvelope(output);
  if (
    envelope.mode !== "direct" ||
    envelope.answer === null ||
    envelope.access !== null ||
    envelope.merge !== null ||
    envelope.risk !== null ||
    envelope.tasks.length !== 0
  ) {
    throw new Error("direct root Sol output must contain answer and no tasks");
  }
  return envelope.answer;
}

export function parseRootSolPlanOutput(output: string): HostSemanticPlan {
  const envelope = parseRootSolEnvelope(output);
  if (
    envelope.mode !== "plan" ||
    envelope.answer !== null ||
    envelope.access === null ||
    envelope.merge === null ||
    envelope.risk === null
  ) {
    throw new Error("planning root Sol output must contain tasks and no answer");
  }
  return parseHostSemanticPlan(
    {
      access: envelope.access,
      merge: envelope.merge,
      risk: envelope.risk,
      tasks: envelope.tasks,
    },
    "fanout",
    5,
  );
}

export type RootSolRouteDecision =
  | { mode: "self"; answer: string }
  | { mode: "delegate"; tier: "luna" | "terra" }
  | { mode: "plan"; plan: HostSemanticPlan };

export function parseRootSolRouteDecision(output: string): RootSolRouteDecision {
  const envelope = parseRootSolEnvelope(output);
  if (envelope.mode === "plan") {
    return { mode: "plan", plan: parseRootSolPlanOutput(output) };
  }
  if (
    envelope.answer === null ||
    envelope.access !== null ||
    envelope.merge !== null ||
    envelope.risk !== null ||
    envelope.tasks.length !== 0
  ) {
    throw new Error("route decision must return a direct answer or delegation with no plan fields");
  }
  if (envelope.answer === "delegate:luna" || envelope.answer === "delegate:terra") {
    return {
      mode: "delegate",
      tier: envelope.answer.slice("delegate:".length) as "luna" | "terra",
    };
  }
  return { mode: "self", answer: envelope.answer };
}

interface RecordInput {
  request: Readonly<BenchmarkExecutionRequest>;
  arm: "direct_sol" | "v3";
  environment: BenchmarkEnvironmentEvidence;
  startedAt: Date;
  completedAt: Date;
  output: string;
  usageByStage: Partial<Record<BenchmarkUsageStage, readonly ModelUsage[]>>;
  route: "direct" | "delegated" | "fanout";
  plannerTurns: number;
  hostPlanned: boolean;
  replanCount: number;
  promotionCount: number;
  finalReviewTurns: number;
  leafCount: number;
  launchSkewMs: number | null;
  batch: BatchResult | null;
  transportItems?: readonly unknown[];
  protocolErrors?: number;
  evidenceRoot: string;
  threadId: string | null;
  turnId: string | null;
  workspace: string;
  completed?: boolean;
}

async function buildRecord(input: RecordInput): Promise<BenchmarkRunRecord> {
  const usage = toBenchmarkUsage(input.usageByStage, input.request, input.arm, {
    threadId: input.threadId,
    turnId: input.turnId,
  });
  const completed = input.completed ?? (input.batch === null || input.batch.status === "completed");
  const qualityArtifact = input.request.instance.artifacts.find(
    (artifact) => artifact.role === "quality_rubric",
  );
  if (qualityArtifact === undefined) {
    throw new Error("benchmark instance is missing a quality rubric");
  }
  const qualityBytes = input.request.artifacts.find(
    (artifact) => artifact.seal.role === "quality_rubric",
  )?.bytes;
  const validation = await validateBenchmarkOutput(input, qualityBytes, completed);
  const qualityScore = validation.score;
  const base = benchmarkEvidenceBase(input.evidenceRoot, input.request, input.arm);
  await mkdir(base, { recursive: true });
  const rawPath = join(base, "raw-output.txt");
  const validatorPath = join(base, "validator-output.json");
  const scorecardPath = join(base, "scorecard.json");
  if (input.batch !== null) {
    await writeFile(join(base, "batch.json"), `${JSON.stringify(input.batch, null, 2)}\n`, "utf8");
  }
  if (input.transportItems !== undefined) {
    await writeFile(
      join(base, "host-turn-items.json"),
      `${JSON.stringify(input.transportItems, null, 2)}\n`,
      "utf8",
    );
  }
  await writeFile(rawPath, input.output, "utf8");
  await writeFile(
    validatorPath,
    `${JSON.stringify(validation.validatorOutput, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    scorecardPath,
    `${JSON.stringify({ qualityScore, qualityDefinitionSha256: qualityArtifact.sha256 }, null, 2)}\n`,
    "utf8",
  );
  const evidence = await Promise.all([
    evidenceSeal("raw_output", rawPath, input.evidenceRoot),
    evidenceSeal("validator_output", validatorPath, input.evidenceRoot),
    evidenceSeal("scorecard", scorecardPath, input.evidenceRoot),
    ...validation.deliverablePaths.map(async (path) => {
      const source = resolve(input.workspace, path);
      const destination = join(base, "deliverables", path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(source));
      return evidenceSeal("deliverable", destination, input.evidenceRoot);
    }),
  ]);
  const evidenceCompletedAt = new Date(Math.max(input.completedAt.getTime(), Date.now()));
  const elapsedMs = Math.max(0, evidenceCompletedAt.getTime() - input.startedAt.getTime());
  const costUsd = Object.values(usage)
    .flat()
    .reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0);
  const observation: BenchmarkObservation = {
    familyId: input.request.instance.familyId,
    instanceId: input.request.instance.instanceId,
    seed: input.request.instance.seed,
    arm: input.arm,
    qualityScore,
    elapsedMs,
    costUsd: costUsd > 0 ? costUsd : null,
    route: input.route,
    launchSkewMs: input.launchSkewMs,
    plannerTurns: input.plannerTurns,
    hostPlanned: input.hostPlanned,
    replanCount: input.replanCount,
    promotionCount: input.promotionCount,
    finalReviewTurns: input.finalReviewTurns,
    leafCount: input.leafCount,
    protocolErrors:
      (input.batch?.status === "failed" ? 1 : 0) +
      Math.max(input.protocolErrors ?? 0, countFailedMcpToolCalls(input.transportItems ?? [])),
    userInterventions: input.batch?.status === "waiting_input" ? 1 : 0,
    // Runtime/protocol failures are recorded by status, protocolErrors, and score.
    // This field is reserved for validator-declared release blockers.
    criticalFailures: mergeCriticalFailures(validation.criticalFailures),
  };
  return {
    observation,
    manifestSha256: input.request.manifestSha256,
    instanceSha256: input.request.instanceSha256,
    startedAt: input.startedAt.toISOString(),
    completedAt: evidenceCompletedAt.toISOString(),
    environment: structuredClone(input.environment),
    usageByStage: usage,
    inputArtifactSha256: input.request.artifacts.map((artifact) => artifact.seal.sha256),
    qualityDefinitionSha256: qualityArtifact.sha256,
    evidenceArtifacts: evidence,
  };
}

function benchmarkEvidenceBase(
  evidenceRoot: string,
  request: Readonly<BenchmarkExecutionRequest>,
  arm: "direct_sol" | "v3",
): string {
  const family = safeEvidenceSegment(request.instance.familyId, "familyId");
  const instance = safeEvidenceSegment(request.instance.instanceId, "instanceId");
  return join(evidenceRoot, family, instance, arm);
}

function safeEvidenceSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not safe for benchmark evidence storage`);
  }
  return value;
}

async function validateBenchmarkOutput(
  input: Readonly<RecordInput>,
  rubricBytes: Uint8Array | undefined,
  completed: boolean,
): Promise<{
  score: number;
  validatorOutput: Readonly<Record<string, unknown>>;
  deliverablePaths: string[];
  criticalFailures: string[];
}> {
  const artifact = input.request.artifacts.find((candidate) => candidate.seal.role === "validator");
  if (artifact === undefined) {
    throw new Error("benchmark instance is missing a sealed validator");
  }
  const source = new TextDecoder().decode(artifact.bytes).trim();
  if (source.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(
        `sealed validator is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
    const hiddenOutput = join(input.workspace, ".agent-trio-benchmark", "model-output.txt");
    await mkdir(dirname(hiddenOutput), { recursive: true });
    await writeFile(hiddenOutput, input.output, "utf8");
    const result = await runSealedBenchmarkValidator(parsed, {
      workspace: input.workspace,
      commandWrapper: (argv, cwd) => bubblewrapValidatorCommand(argv, cwd, input.workspace),
    });
    const score = completed ? result.score : 0;
    return {
      score,
      validatorOutput: {
        mode: "sealed-v1",
        completed,
        route: input.route,
        ...result,
        validatorScore: result.score,
        score,
      },
      deliverablePaths: result.evidence.flatMap((item) =>
        item.kind === "deliverable" && item.actualSha256 !== null ? [item.path] : [],
      ),
      criticalFailures: result.criticalFailures,
    };
  }

  const quality = scoreOutput(input.output, rubricBytes, completed);
  return {
    score: quality.score,
    validatorOutput: {
      mode: "legacy-output-rubric",
      status: quality.score === 100 ? "passed" : "failed",
      completed,
      route: input.route,
      matchedCriteria: quality.matched,
      missingCriteria: quality.missing,
    },
    deliverablePaths: [],
    criticalFailures: [],
  };
}

export function mergeCriticalFailures(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flatMap((group) => group).filter((failure) => failure.length > 0))];
}

function bubblewrapValidatorCommand(
  argv: readonly string[],
  cwd: string,
  workspace: string,
): { argv: readonly string[]; cwd: string } {
  return {
    argv: [
      "bwrap",
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      workspace,
      workspace,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--chdir",
      cwd,
      "--",
      ...argv,
    ],
    cwd: "/",
  };
}

async function requireBubblewrapVersion(): Promise<string> {
  return new Promise((resolveVersion, rejectVersion) => {
    const child = spawn("bwrap", ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      rejectVersion(
        new Error(`Bubblewrap is required for sealed validator isolation: ${error.message}`),
      );
    });
    child.once("close", (code) => {
      const version = stdout.trim();
      if (code !== 0 || version.length === 0) {
        rejectVersion(
          new Error(
            `Bubblewrap is required for sealed validator isolation: ${stderr.trim() || `exit ${String(code)}`}`,
          ),
        );
        return;
      }
      resolveVersion(version);
    });
  });
}

function scoreOutput(
  output: string,
  rubricBytes: Uint8Array | undefined,
  completed: boolean,
): { score: number; matched: string[]; missing: string[] } {
  if (!completed || output.trim().length === 0) {
    return { score: 0, matched: [], missing: ["completed output"] };
  }
  if (rubricBytes === undefined) {
    return { score: 100, matched: ["completed output"], missing: [] };
  }
  const parsed = JSON.parse(new TextDecoder().decode(rubricBytes)) as {
    criteria?: Array<{ label?: unknown; all?: unknown; any?: unknown }>;
  };
  if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
    return { score: 100, matched: ["completed output"], missing: [] };
  }
  const normalized = output.toLowerCase().replaceAll(/\s+/gu, " ");
  const matched: string[] = [];
  const missing: string[] = [];
  for (const [index, criterion] of parsed.criteria.entries()) {
    const label =
      typeof criterion.label === "string" ? criterion.label : `criterion-${String(index + 1)}`;
    const all = Array.isArray(criterion.all)
      ? criterion.all.filter((term): term is string => typeof term === "string")
      : [];
    const any = Array.isArray(criterion.any)
      ? criterion.any.filter((term): term is string => typeof term === "string")
      : [];
    const passes =
      all.every((term) => normalized.includes(term.toLowerCase())) &&
      (any.length === 0 || any.some((term) => normalized.includes(term.toLowerCase())));
    (passes ? matched : missing).push(label);
  }
  return {
    score: (matched.length / parsed.criteria.length) * 100,
    matched,
    missing,
  };
}

function toBenchmarkUsage(
  source: Partial<Record<BenchmarkUsageStage, readonly ModelUsage[]>>,
  request: Readonly<BenchmarkExecutionRequest>,
  arm: "direct_sol" | "v3",
  ids: { threadId: string | null; turnId: string | null },
): BenchmarkUsageByStage {
  const result = emptyUsageByStage();
  for (const stage of Object.keys(result) as BenchmarkUsageStage[]) {
    const entries = source[stage] ?? [];
    result[stage] = entries.map((usage) => {
      const rootSolDirect =
        arm === "v3" &&
        stage === "direct" &&
        usage.model === request.baseline.model &&
        ids.threadId !== null;
      const modelRevision =
        arm === "direct_sol" || rootSolDirect
          ? request.baseline.modelRevision
          : `${usage.model}-${CODEX_VERSION}`;
      const price = priceTable.models[usage.model];
      const preserveServerCost =
        usage.costSource === "app_server" && usage.estimatedCostUsd !== null;
      const cost = preserveServerCost
        ? usage.estimatedCostUsd
        : price === undefined
          ? usage.estimatedCostUsd
          : priceForUsage(usage, price);
      const costSource = preserveServerCost || price === undefined ? "app_server" : "price_table";
      return {
        model: usage.model,
        modelRevision,
        tier: usage.tier,
        effort: usage.effort,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
        uncachedInputTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: cost,
        costSource,
        ...(costSource === "price_table" ? { pricingSha256 } : {}),
        ...((arm === "direct_sol" || rootSolDirect) && ids.threadId !== null
          ? { threadId: ids.threadId }
          : {}),
        ...((arm === "direct_sol" || rootSolDirect) && ids.turnId !== null
          ? { turnId: ids.turnId }
          : {}),
      } satisfies BenchmarkModelUsageEvidence;
    });
  }
  return result;
}

function priceForUsage(usage: Readonly<ModelUsage>, price: PriceEntry): number {
  return (
    (usage.uncachedInputTokens * price.inputPerMillionUsd +
      usage.cachedInputTokens * (price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd) +
      (usage.cacheWriteInputTokens ?? 0) *
        (price.cacheWriteInputPerMillionUsd ?? price.inputPerMillionUsd) +
      usage.outputTokens * price.outputPerMillionUsd) /
    1_000_000
  );
}

function emptyUsageByStage(): BenchmarkUsageByStage {
  return {
    admission: [],
    direct: [],
    planning: [],
    replan: [],
    leaves: [],
    integration: [],
    finalReview: [],
  };
}

function domainForFamily(
  familyId: string,
): "coding" | "algorithm" | "research" | "paper" | "office" | "autoResearch" {
  const prefix = familyId.split("-")[0];
  if (
    prefix === "coding" ||
    prefix === "algorithm" ||
    prefix === "research" ||
    prefix === "paper" ||
    prefix === "office"
  ) {
    return prefix;
  }
  return "autoResearch";
}

function isDecomposableFamily(familyId: string): boolean {
  return familyId !== "coding-local-bugfix" && familyId !== "paper-edit";
}

async function materializeWorkspace(
  request: Readonly<BenchmarkExecutionRequest>,
  config: Readonly<BenchmarkWorkspaceConfig>,
): Promise<string> {
  const identity = hashBenchmarkBytes(
    `${request.suiteId}\0${request.instance.familyId}\0${request.instance.instanceId}\0${request.instance.seed}`,
  );
  const workspace = await mkdtemp(join(tmpdir(), `agent-trio-paired-${identity.slice(0, 12)}-`));
  await writeWorkspaceSnapshot(workspace, config);
  if (config.access === "workspaceWrite") {
    await initializeBenchmarkGitWorkspace(workspace);
  }
  return workspace;
}

function workspaceConfigFor(
  request: Readonly<BenchmarkExecutionRequest>,
): BenchmarkWorkspaceConfig {
  const snapshot = request.artifacts.find(
    (artifact) => artifact.seal.role === "workspace_snapshot",
  );
  if (snapshot === undefined) {
    throw new Error(`missing workspace snapshot for ${request.instance.instanceId}`);
  }
  return parseWorkspaceSnapshot(snapshot.bytes);
}

export function parseWorkspaceSnapshot(bytes: Uint8Array): BenchmarkWorkspaceConfig {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("workspace snapshot must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const access = record["access"] ?? "readOnly";
  if (access !== "readOnly" && access !== "workspaceWrite") {
    throw new Error("workspace snapshot access must be readOnly or workspaceWrite");
  }
  const citationPolicy = record["citationPolicy"] ?? "none";
  if (
    citationPolicy !== "none" &&
    citationPolicy !== "frozen-required" &&
    citationPolicy !== "live-required"
  ) {
    throw new Error(
      "workspace snapshot citationPolicy must be none, frozen-required, or live-required",
    );
  }
  if (citationPolicy === "live-required") {
    throw new Error("the local sealed runner does not enable live network research");
  }
  const decomposition = record["decomposition"] ?? "independent";
  if (decomposition !== "independent" && decomposition !== "coupled") {
    throw new Error("workspace snapshot decomposition must be independent or coupled");
  }
  if (!Array.isArray(record["files"])) {
    throw new Error("workspace snapshot files must be an array");
  }
  const files = record["files"].map((value, index): BenchmarkWorkspaceFile => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`workspace snapshot files[${String(index)}] must be an object`);
    }
    const file = value as Record<string, unknown>;
    const path = file["path"];
    if (typeof path !== "string" || !isSafeWorkspacePath(path)) {
      throw new Error(`workspace snapshot contains unsafe path ${String(path)}`);
    }
    const encodings = ["content", "contentUtf8", "contentBase64"].filter(
      (key) => file[key] !== undefined,
    );
    if (encodings.length !== 1) {
      throw new Error(`workspace snapshot file ${path} must define exactly one content encoding`);
    }
    const encoding = encodings[0]!;
    if (typeof file[encoding] !== "string") {
      throw new Error(`workspace snapshot file ${path} content must be a string`);
    }
    const mode = file["mode"];
    if (
      mode !== undefined &&
      (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777)
    ) {
      throw new Error(
        `workspace snapshot file ${path} mode must be an integer from 0 through 0777`,
      );
    }
    return {
      path,
      [encoding]: file[encoding] as string,
      ...(mode === undefined ? {} : { mode: mode as number }),
    };
  });
  return { access, citationPolicy, decomposition, files };
}

export async function resetMaterializedWorkspace(
  workspace: string,
  config: Readonly<BenchmarkWorkspaceConfig>,
): Promise<void> {
  const entries = await readdir(workspace);
  await Promise.all(
    entries.map((entry) => rm(join(workspace, entry), { recursive: true, force: true })),
  );
  await writeWorkspaceSnapshot(workspace, config);
  if (config.access === "workspaceWrite") {
    await initializeBenchmarkGitWorkspace(workspace);
  }
}

export async function writeWorkspaceSnapshot(
  workspace: string,
  config: Readonly<BenchmarkWorkspaceConfig>,
): Promise<void> {
  for (const file of config.files) {
    if (!isSafeWorkspacePath(file.path)) {
      throw new Error(`workspace snapshot contains unsafe path ${file.path}`);
    }
    const path = join(workspace, file.path);
    await mkdir(dirname(path), { recursive: true });
    const bytes =
      file.contentBase64 === undefined
        ? Buffer.from(file.contentUtf8 ?? file.content ?? "", "utf8")
        : decodeCanonicalBase64(file.contentBase64, file.path);
    await writeFile(path, bytes);
    if (file.mode !== undefined) {
      await chmod(path, file.mode);
    }
  }
}

async function initializeBenchmarkGitWorkspace(workspace: string): Promise<void> {
  await runLocalCommand("git", ["init", "--quiet"], workspace);
  await runLocalCommand("git", ["add", "--all"], workspace);
  await runLocalCommand(
    "git",
    [
      "-c",
      "user.name=Agent Trio Benchmark",
      "-c",
      "user.email=benchmark@invalid.example",
      "commit",
      "--quiet",
      "-m",
      "sealed benchmark baseline",
    ],
    workspace,
  );
}

async function runLocalCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${String(code)}`}`,
        ),
      );
    });
  });
}

function isSafeWorkspacePath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length > 0 &&
    parts.every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/u.test(part))
  );
}

function decodeCanonicalBase64(value: string, path: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`workspace snapshot file ${path} contains invalid base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`workspace snapshot file ${path} base64 is not canonical`);
  }
  return bytes;
}

function promptFor(request: Readonly<BenchmarkExecutionRequest>): string {
  const prompt = request.artifacts.find((artifact) => artifact.seal.role === "prompt");
  if (prompt === undefined) {
    throw new Error(`missing prompt artifact for ${request.instance.instanceId}`);
  }
  const config = workspaceConfigFor(request);
  const accessInstruction =
    config.access === "readOnly"
      ? "This is a read-only benchmark task. Do not modify files or request user input."
      : "This is a sealed workspace-write benchmark. Modify only the requested deliverables and do not request user input.";
  const citationInstruction =
    config.citationPolicy === "none"
      ? "Do not invent external citations."
      : "Use only the frozen source identifiers supplied in the workspace and cite every factual claim.";
  return [accessInstruction, citationInstruction, new TextDecoder().decode(prompt.bytes)].join(
    "\n",
  );
}

function finalMessage(items: readonly unknown[]): string {
  const messages = items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>)["type"] === "agentMessage",
  );
  const final =
    messages.filter((item) => item["phase"] === "final_answer").at(-1) ?? messages.at(-1);
  return final !== undefined && typeof final["text"] === "string" ? final["text"] : "";
}

function countFailedMcpToolCalls(items: readonly unknown[]): number {
  return items.filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>)["type"] === "mcpToolCall" &&
      (item as Record<string, unknown>)["status"] === "failed",
  ).length;
}

export function assertNoSubAgentActivity(items: readonly unknown[], arm: string): void {
  const activities = items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>)["type"] === "subAgentActivity",
  );
  if (activities.length === 0) {
    return;
  }
  const paths = activities
    .map((item) => item["agentPath"])
    .filter((path): path is string => typeof path === "string");
  const detail = paths.length === 0 ? "unknown path" : [...new Set(paths)].join(", ");
  throw new Error(
    `${arm} started native subagents despite recursive-orchestration isolation: ${detail}`,
  );
}

function assertNoLegacyAgentTrioSkillUse(items: readonly unknown[]): void {
  const loaded = items.some((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as Record<string, unknown>)["type"] !== "commandExecution"
    ) {
      return false;
    }
    const command = (item as Record<string, unknown>)["command"];
    return typeof command === "string" && /(?:agent[-_]trio)\/SKILL\.md/iu.test(command);
  });
  if (loaded) {
    throw new Error("root Sol loaded a legacy agent-trio skill during standalone V3 routing");
  }
}

function parseRecoveryWorkerOptions(argv: readonly string[]): RecoveryWorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("invalid recovery worker arguments");
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key)?.trim();
    if (value === undefined || value.length === 0) throw new Error(`missing ${key}`);
    return value;
  };
  const mode = required("--mode");
  const implementation = required("--implementation");
  if (mode !== "start" && mode !== "resume") throw new Error("invalid recovery worker mode");
  if (implementation !== "production" && implementation !== "fixture") {
    throw new Error("invalid recovery worker implementation");
  }
  return {
    mode,
    implementation,
    runId: required("--run-id"),
    workspace: resolve(required("--workspace")),
    jobRoot: resolve(required("--job-root")),
    nonce: required("--nonce"),
    serviceTier: required("--service-tier"),
  };
}

async function runRecoveryWorker(options: Readonly<RecoveryWorkerOptions>): Promise<never> {
  const statePath = join(dirname(options.jobRoot), "worker-state.json");
  const sideEffectPath = join(options.workspace, "resume-side-effect.txt");
  const threadId = `recovery-thread-${options.nonce}`;
  const previousTurnId = `recovery-turn-1-${options.nonce}`;
  const resumedTurnId = `recovery-turn-2-${options.nonce}`;
  const server = await spawnRecoveryAppServer(options.implementation);
  const store = new JobStore(options.jobRoot);
  let invocationCount = 0;
  const directExecutor: DirectExecutor = {
    execute: () =>
      Promise.resolve({
        status: "waiting_input",
        response: null,
        threadId,
        usage: [],
        needsAction: "resume after the supervisor process is restarted",
        error: "deterministic recovery checkpoint",
        waitingTurn: {
          threadId,
          previousTurnId,
          cwd: options.workspace,
          capabilities: [],
        },
      }),
    resumeDirect: async (input) => {
      if (input.userInput !== RECOVERY_CONTINUE_INPUT) {
        throw new Error("recovery worker received the wrong continuation input");
      }
      invocationCount += 1;
      await writeFile(sideEffectPath, `${options.nonce}\n`, { encoding: "utf8", flag: "wx" });
      return {
        status: "completed",
        response: "recovery completed without replaying the committed side effect",
        threadId,
        usage: [],
      };
    },
  };
  const recovery: RecoveryAdapter = {
    reattach: ({ snapshot }) => {
      const waitingInput = snapshot.waitingInputCheckpoint;
      if (waitingInput?.kind !== "direct") {
        throw new Error("recovery fixture expected a persisted direct checkpoint");
      }
      return Promise.resolve({
        result: structuredClone(snapshot.result),
        coordinatorThreadId: snapshot.coordinatorThreadId,
        plannerThreadId: snapshot.plannerThreadId,
        integratorThreadId: snapshot.integratorThreadId,
        continuation: {
          initialLeaves: structuredClone(snapshot.result.leaves),
          workspaceWritersMayHaveRun: false,
          waitingInput: structuredClone(waitingInput),
        },
      });
    },
  };
  const admission: AdmissionController = {
    decide: () => Promise.resolve({ route: "direct", reason: "recovery fixture direct route" }),
  };
  const integrator: ResultIntegrator = {
    integrate: () => Promise.reject(new Error("recovery fixture must not integrate")),
  };
  const service = new AgentTrioService({
    store,
    admission,
    directExecutor,
    planner: {
      plan: () => Promise.reject(new Error("recovery fixture must not plan")),
    },
    scheduler: {
      execute: () => Promise.reject(new Error("recovery fixture must not schedule")),
    },
    integrator,
    recovery,
    routeOptimizer: {
      decide: () => ({ route: "direct", reason: "recovery fixture direct route" }),
    },
  });
  if (options.mode === "start") {
    const result = await service.run({
      runId: options.runId,
      objective: "Persist one direct waiting checkpoint for the process recovery profile.",
      cwd: options.workspace,
      strategy: "direct",
      directTier: "luna",
      constraints: ["deterministic process recovery profile"],
    });
    if (result.status !== "waiting_input") {
      throw new Error(`recovery start returned ${result.status}, expected waiting_input`);
    }
    await writeRecoveryWorkerState(statePath, {
      workerPid: process.pid,
      serverPid: requireChildPid(server),
      threadId,
      previousTurnId,
      status: "waiting_input",
      invocationCount: 0,
    });
  } else {
    const result = await service.resume(options.runId, RECOVERY_CONTINUE_INPUT);
    if (result.status !== "completed") {
      throw new Error(`recovery resume returned ${result.status}, expected completed`);
    }
    const repeated = await service.resume(options.runId, RECOVERY_CONTINUE_INPUT);
    if (repeated.status !== "completed" || invocationCount !== 1) {
      throw new Error("terminal recovery resume replayed the side effect");
    }
    const sideEffect = await readFile(sideEffectPath);
    await writeRecoveryWorkerState(statePath, {
      workerPid: process.pid,
      serverPid: requireChildPid(server),
      threadId,
      previousTurnId,
      resumedTurnId,
      status: "completed",
      invocationCount: 1,
      sideEffectSha256: hashBenchmarkBytes(sideEffect),
    });
  }
  return new Promise<never>(() => undefined);
}

async function spawnRecoveryAppServer(
  implementation: RecoveryWorkerImplementation,
): Promise<ChildProcess> {
  const child =
    implementation === "production"
      ? spawn(process.env["AGENT_TRIO_CODEX_BIN"] ?? "codex", ["app-server"], {
          stdio: ["pipe", "ignore", "ignore"],
        })
      : spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
          stdio: ["ignore", "ignore", "ignore"],
        });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  if (child.pid === undefined) throw new Error("recovery App Server child has no pid");
  return child;
}

function requireChildPid(child: Readonly<ChildProcess>): number {
  if (child.pid === undefined) throw new Error("recovery child pid is unavailable");
  return child.pid;
}

async function writeRecoveryWorkerState(
  path: string,
  state: Readonly<RecoveryWorkerState>,
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function evidenceSeal(
  kind: "raw_output" | "validator_output" | "deliverable" | "scorecard",
  absolutePath: string,
  evidenceRoot: string,
): Promise<BenchmarkRunRecord["evidenceArtifacts"][number]> {
  const bytes = await readFile(absolutePath);
  const path = relative(evidenceRoot, absolutePath).replaceAll("\\", "/");
  return { kind, path, sha256: hashBenchmarkBytes(bytes), sizeBytes: bytes.byteLength };
}

function requireId(value: unknown, label: string): string {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    throw new Error(`${label} did not return an id`);
  }
  return (value as { id: string }).id;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  if (process.argv[2] === RECOVERY_WORKER_FLAG) {
    try {
      await runRecoveryWorker(parseRecoveryWorkerOptions(process.argv.slice(3)));
    } catch (error) {
      process.stderr.write(`recovery worker failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    }
  } else {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    let signalCleanupStarted = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        if (signalCleanupStarted) {
          return;
        }
        signalCleanupStarted = true;
        process.stderr.write(`benchmark received ${signal}; cleaning up active runtimes\n`);
        void disposeAllPairRuntimes().finally(() => {
          for (const [registeredSignal, registeredHandler] of signalHandlers) {
            process.off(registeredSignal, registeredHandler);
          }
          process.kill(process.pid, signal);
        });
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    try {
      await main();
    } catch (error) {
      process.stderr.write(`benchmark failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    } finally {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    }
  }
}
