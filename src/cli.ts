#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import {
  evaluateBenchmark,
  type BenchmarkEvaluation,
  type BenchmarkEvaluationOptions,
  type BenchmarkObservation,
} from "./benchmark.js";
import type {
  AgentTrioRequest,
  BatchResult,
  CapabilityRef,
  ExecutionLimits,
  HostAccess,
  HostApproval,
  OptimizationProfile,
  TaskDomain,
} from "./core/contracts.js";
import type { AgentTrioService } from "./core/service.js";
import { launchDetachedSupervisor, runSupervisorChild, type SubmitRequest } from "./supervisor.js";

const DOMAINS: readonly TaskDomain[] = [
  "coding",
  "algorithm",
  "research",
  "paper",
  "office",
  "autoResearch",
  "general",
];

const HELP = `Usage: agent-trio <command> [options]

Commands:
  run [objective]       Run a task in the foreground
  submit [objective]    Submit a durable background task
  status <run-id>       Show the current result for a run
  resume <run-id>       Resume a durable run, optionally with external input
  cancel <run-id>       Cancel a run
  benchmark <file>      Evaluate benchmark observations from JSON

Common options:
  --json                Write machine-readable JSON
  -h, --help            Show help

Run and submit options:
  -o, --objective TEXT  Task objective (or provide it positionally)
  -C, --cwd PATH        Workspace root (defaults to the current directory)
  --run-id ID           Caller-selected idempotency key
  --host-access MODE    Caller permission: read-only, workspace-write, or full-access
  --host-approval MODE  Caller approval: never or approve-for-me
  --domain DOMAIN       Task domain
  --strategy MODE       Route mode: auto, direct, or fanout
  --profile PROFILE     balanced (default) or quality
  --direct-tier TIER    Luna or Terra for strategy=direct
  --constraint TEXT     Repeatable task constraint
  --skill NAME[=PATH]   Repeatable direct-path skill capability
  --plugin ID           Repeatable direct-path plugin capability
  --[no-]integrate      Enable or disable final integration
  --max-concurrent N    Maximum concurrent leaves (1-5)
  --max-leaves N        Maximum leaves (1-20)
  --max-waves N         Maximum dependency waves (1-3)
  --max-sol-leaves N    Maximum Sol leaves (0-1)
  --max-replans N       Maximum replans (0-1)
  --deadline-ms N       Positive execution deadline in milliseconds
  --max-cost-usd N      Non-negative cost ceiling

Resume options:
  --input TEXT          External input needed by a waiting run (maximum 4 KiB UTF-8)

Benchmark options:
  -i, --input FILE      Observation file (or provide it positionally)
  --minimum-instances N Minimum paired instances per family
  --allow-partial       Do not require every benchmark family
`;

export type AgentTrioServicePort = Pick<AgentTrioService, "handle">;

export interface CliOutput {
  write(chunk: string): unknown;
}

export interface AgentTrioCliOptions {
  service: AgentTrioServicePort;
  stdout?: CliOutput;
  stderr?: CliOutput;
  cwd?: string;
  readTextFile?: (path: string) => Promise<string>;
}

export interface AgentTrioRuntime {
  service: AgentTrioServicePort;
  monitorUrlForRun?: (runId: string) => string | undefined;
  close?: () => void | Promise<void>;
}

export type CreateDefaultRuntime = () => AgentTrioRuntime | Promise<AgentTrioRuntime>;

export interface DefaultCliOptions extends Omit<AgentTrioCliOptions, "service"> {
  createRuntime?: CreateDefaultRuntime;
  launchSupervisor?: (request: SubmitRequest) => Promise<BatchResult>;
}

interface ParsedCommand {
  json: boolean;
  command: "service" | "benchmark" | "help";
  request?: AgentTrioRequest;
  benchmark?: BenchmarkCommand;
}

interface BenchmarkCommand {
  input: string;
  options: BenchmarkEvaluationOptions;
}

interface RuntimeModule {
  createDefaultRuntime: CreateDefaultRuntime;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export async function runCli(
  argv: readonly string[],
  options: AgentTrioCliOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const jsonRequested = argv.includes("--json");

  try {
    const parsed = parseCommand(argv, options.cwd ?? process.cwd());
    if (parsed.command === "help") {
      stdout.write(HELP);
      return 0;
    }
    if (parsed.command === "benchmark") {
      const command = requireValue(parsed.benchmark, "benchmark command");
      const source = await (options.readTextFile ?? readUtf8)(command.input);
      const observations = parseBenchmarkObservations(source);
      const result = evaluateBenchmark(observations, command.options);
      writeBenchmark(stdout, result, parsed.json);
      return result.passed ? 0 : 1;
    }

    const request = requireValue(parsed.request, "service request");
    const result = await options.service.handle(request);
    writeBatchResult(stdout, result, parsed.json);
    return commandFailed(request, result) ? 1 : 0;
  } catch (error) {
    const normalized = normalizeError(error);
    writeCliError(jsonRequested ? stdout : stderr, normalized, jsonRequested);
    if (!jsonRequested && error instanceof CliUsageError) {
      stderr.write("Run 'agent-trio --help' for usage.\n");
    }
    return error instanceof CliUsageError ? 2 : 1;
  }
}

export async function loadDefaultRuntime(): Promise<AgentTrioRuntime> {
  // Keep the executable import lazy so unit tests and library consumers need no live Codex process.
  const runtimeModulePath = "./runtime.js";
  const loaded: unknown = await import(runtimeModulePath);
  if (!isRuntimeModule(loaded)) {
    throw new Error("src/runtime.ts must export createDefaultRuntime()");
  }
  return normalizeRuntime(await loaded.createDefaultRuntime());
}

export async function runDefaultCli(
  argv: readonly string[] = process.argv.slice(2),
  options: DefaultCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (process.env["AGENT_TRIO_SUPERVISOR"] !== "1") {
    try {
      const parsed = parseCommand(argv, options.cwd ?? process.cwd());
      if (parsed.command === "service" && parsed.request?.action === "submit") {
        const request: SubmitRequest = {
          ...parsed.request,
          action: "submit",
          runId: parsed.request.runId ?? randomUUID(),
        };
        const result = await (options.launchSupervisor ?? defaultSupervisorLauncher)(request);
        writeBatchResult(stdout, result, parsed.json);
        return 0;
      }
    } catch (error) {
      const normalized = normalizeError(error);
      writeCliError(argv.includes("--json") ? stdout : stderr, normalized, argv.includes("--json"));
      if (!argv.includes("--json") && error instanceof CliUsageError) {
        stderr.write("Run 'agent-trio --help' for usage.\n");
      }
      return error instanceof CliUsageError ? 2 : 1;
    }
  }
  let runtime: AgentTrioRuntime | undefined;
  let runtimePromise: Promise<AgentTrioRuntime> | undefined;
  const service: AgentTrioServicePort = {
    handle: async (request) => {
      runtimePromise ??= Promise.resolve((options.createRuntime ?? loadDefaultRuntime)()).then(
        normalizeRuntime,
      );
      runtime = await runtimePromise;
      const dispatched =
        (request.action === "run" || request.action === "submit") && request.runId === undefined
          ? { ...request, runId: randomUUID() }
          : request;
      if (dispatched.action === "run" || dispatched.action === "submit") {
        const monitorUrl = runtime.monitorUrlForRun?.(dispatched.runId!);
        if (monitorUrl !== undefined) {
          stderr.write(`Monitor: ${monitorUrl}\n`);
        }
      }
      return runtime.service.handle(dispatched);
    },
  };
  const exitCode = await runCli(argv, {
    service,
    stdout,
    stderr,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile }),
  });
  try {
    await runtime?.close?.();
    return exitCode;
  } catch (error) {
    writeCliError(
      argv.includes("--json") ? stdout : stderr,
      normalizeError(error),
      argv.includes("--json"),
    );
    return 1;
  }
}

export const main = runDefaultCli;

function defaultSupervisorLauncher(request: SubmitRequest): Promise<BatchResult> {
  return launchDetachedSupervisor(request, { modulePath: fileURLToPath(import.meta.url) });
}

function parseCommand(argv: readonly string[], currentDirectory: string): ParsedCommand {
  let json = false;
  const args = argv.filter((arg) => {
    if (arg === "--json") {
      json = true;
      return false;
    }
    return true;
  });
  const command = args[0];
  const rest = args.slice(1);
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { command: "help", json };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "help", json };
  }

  switch (command) {
    case "run":
    case "submit":
      return {
        command: "service",
        json,
        request: parseStartRequest(command, rest, currentDirectory),
      };
    case "status":
    case "resume":
    case "cancel":
      return { command: "service", json, request: parseRunIdRequest(command, rest) };
    case "benchmark":
      return {
        command: "benchmark",
        json,
        benchmark: parseBenchmarkCommand(rest, currentDirectory),
      };
    default:
      throw new CliUsageError(`unknown command: ${command}`);
  }
}

function parseStartRequest(
  action: "run" | "submit",
  args: readonly string[],
  currentDirectory: string,
): AgentTrioRequest {
  let objective: string | undefined;
  let cwd: string | undefined;
  let runId: string | undefined;
  let hostAccess: HostAccess | undefined;
  let hostApproval: HostApproval | undefined;
  let domain: TaskDomain | undefined;
  let strategy: "auto" | "direct" | "fanout" | undefined;
  let profile: OptimizationProfile = "balanced";
  let directTier: "luna" | "terra" | undefined;
  let integrate: boolean | undefined;
  const constraints: string[] = [];
  const capabilities: CapabilityRef[] = [];
  const limits: Partial<ExecutionLimits> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = requireValue(args[index], "argument");
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    const option = splitOption(token);
    switch (option.name) {
      case "-o":
      case "--objective": {
        const consumed = optionValue(option, args, index);
        objective = consumed.value;
        index += consumed.extra;
        break;
      }
      case "-C":
      case "--cwd": {
        const consumed = optionValue(option, args, index);
        cwd = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--run-id": {
        const consumed = optionValue(option, args, index);
        runId = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--host-access": {
        const consumed = optionValue(option, args, index);
        hostAccess = parseHostAccess(consumed.value);
        index += consumed.extra;
        break;
      }
      case "--host-approval": {
        const consumed = optionValue(option, args, index);
        hostApproval = parseHostApproval(consumed.value);
        index += consumed.extra;
        break;
      }
      case "--domain": {
        const consumed = optionValue(option, args, index);
        domain = parseDomain(consumed.value);
        index += consumed.extra;
        break;
      }
      case "--strategy": {
        const consumed = optionValue(option, args, index);
        if (
          consumed.value !== "auto" &&
          consumed.value !== "direct" &&
          consumed.value !== "fanout"
        ) {
          throw new CliUsageError("strategy must be auto, direct, or fanout");
        }
        strategy = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--profile": {
        const consumed = optionValue(option, args, index);
        if (consumed.value !== "balanced" && consumed.value !== "quality") {
          throw new CliUsageError("profile must be balanced or quality");
        }
        profile = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--direct-tier": {
        const consumed = optionValue(option, args, index);
        if (consumed.value !== "luna" && consumed.value !== "terra") {
          throw new CliUsageError("direct tier must be luna or terra");
        }
        directTier = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--constraint": {
        const consumed = optionValue(option, args, index);
        constraints.push(requireNonEmpty(consumed.value, "constraint"));
        index += consumed.extra;
        break;
      }
      case "--skill": {
        const consumed = optionValue(option, args, index);
        capabilities.push(parseSkillCapability(consumed.value));
        index += consumed.extra;
        break;
      }
      case "--plugin": {
        const consumed = optionValue(option, args, index);
        capabilities.push({
          kind: "plugin",
          name: requireNonEmpty(consumed.value, "plugin"),
        });
        index += consumed.extra;
        break;
      }
      case "--integrate":
        integrate = option.inlineValue === undefined ? true : parseBoolean(option.inlineValue);
        break;
      case "--no-integrate":
        rejectInlineValue(option);
        integrate = false;
        break;
      case "--max-concurrent":
        index += setNumericLimit(limits, "maxConcurrent", option, args, index, 1, 5, true);
        break;
      case "--max-leaves":
        index += setNumericLimit(limits, "maxLeaves", option, args, index, 1, 20, true);
        break;
      case "--max-waves":
        index += setNumericLimit(limits, "maxWaves", option, args, index, 1, 3, true);
        break;
      case "--max-sol-leaves":
        index += setNumericLimit(limits, "maxSolLeaves", option, args, index, 0, 1, true);
        break;
      case "--max-replans":
        index += setNumericLimit(limits, "maxReplans", option, args, index, 0, 1, true);
        break;
      case "--deadline-ms":
        index += setNumericLimit(
          limits,
          "deadlineMs",
          option,
          args,
          index,
          Number.MIN_VALUE,
          Number.POSITIVE_INFINITY,
          false,
        );
        break;
      case "--max-cost-usd":
        index += setNumericLimit(
          limits,
          "maxCostUsd",
          option,
          args,
          index,
          0,
          Number.POSITIVE_INFINITY,
          false,
        );
        break;
      case "--input":
        throw new CliUsageError("--input is only valid with resume");
      default:
        if (token.startsWith("-")) {
          throw new CliUsageError(`unknown ${action} option: ${option.name}`);
        }
        positional.push(token);
    }
  }

  if (objective !== undefined && positional.length > 0) {
    throw new CliUsageError("provide the objective either positionally or with --objective");
  }
  objective = requireNonEmpty(objective ?? positional.join(" "), "objective");
  if (directTier !== undefined && strategy !== "direct") {
    throw new CliUsageError("--direct-tier requires --strategy direct");
  }
  const requestCwd = resolve(currentDirectory, cwd ?? ".");
  const request: AgentTrioRequest = {
    action,
    objective,
    cwd: requestCwd,
    profile,
    ...(runId === undefined ? {} : { runId: requireNonEmpty(runId, "runId") }),
    ...(hostAccess === undefined ? {} : { hostAccess }),
    ...(hostApproval === undefined ? {} : { hostApproval }),
    ...(domain === undefined ? {} : { domain }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(directTier === undefined ? {} : { directTier }),
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(capabilities.length === 0
      ? {}
      : {
          capabilities: capabilities.map((capability) =>
            capability.kind === "skill" && capability.path !== undefined
              ? { ...capability, path: resolve(requestCwd, capability.path) }
              : capability,
          ),
        }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(integrate === undefined ? {} : { integrate }),
  };
  return request;
}

function parseHostAccess(value: string): HostAccess {
  switch (value) {
    case "read-only":
      return "readOnly";
    case "workspace-write":
      return "workspaceWrite";
    case "full-access":
      return "fullAccess";
    default:
      throw new CliUsageError("host access must be read-only, workspace-write, or full-access");
  }
}

function parseHostApproval(value: string): HostApproval {
  switch (value) {
    case "never":
      return "never";
    case "approve-for-me":
      return "approveForMe";
    default:
      throw new CliUsageError("host approval must be never or approve-for-me");
  }
}

function parseSkillCapability(value: string): CapabilityRef {
  const separator = value.indexOf("=");
  if (separator < 0) {
    return { kind: "skill", name: requireNonEmpty(value, "skill") };
  }
  return {
    kind: "skill",
    name: requireNonEmpty(value.slice(0, separator), "skill"),
    path: requireNonEmpty(value.slice(separator + 1), "skill path"),
  };
}

function parseRunIdRequest(
  action: "status" | "resume" | "cancel",
  args: readonly string[],
): AgentTrioRequest {
  let runId: string | undefined;
  let input: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = requireValue(args[index], "argument");
    const option = splitOption(token);
    switch (option.name) {
      case "--run-id": {
        const consumed = optionValue(option, args, index);
        runId = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--input": {
        if (action !== "resume") {
          throw new CliUsageError("--input is only valid with resume");
        }
        if (input !== undefined) {
          throw new CliUsageError("--input may only be specified once");
        }
        const consumed = optionValue(option, args, index);
        input = parseResumeInput(consumed.value);
        index += consumed.extra;
        break;
      }
      default:
        if (token.startsWith("-")) {
          throw new CliUsageError(`unknown ${action} option: ${option.name}`);
        }
        positional.push(token);
    }
  }
  if (runId !== undefined && positional.length > 0) {
    throw new CliUsageError("provide runId either positionally or with --run-id");
  }
  if (positional.length > 1) {
    throw new CliUsageError(`${action} accepts exactly one runId`);
  }
  const parsedRunId = requireNonEmpty(runId ?? positional[0] ?? "", "runId");
  return action === "resume"
    ? {
        action,
        runId: parsedRunId,
        ...(input === undefined ? {} : { input }),
      }
    : { action, runId: parsedRunId };
}

function parseResumeInput(value: string): string {
  const input = requireNonEmpty(value, "input");
  if (Buffer.byteLength(input, "utf8") > 4_096) {
    throw new CliUsageError("resume input must not exceed 4 KiB");
  }
  return input;
}

function parseBenchmarkCommand(
  args: readonly string[],
  currentDirectory: string,
): BenchmarkCommand {
  let input: string | undefined;
  let minimumInstancesPerFamily: number | undefined;
  let requireAllFamilies: boolean | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = requireValue(args[index], "argument");
    const option = splitOption(token);
    switch (option.name) {
      case "-i":
      case "--input": {
        const consumed = optionValue(option, args, index);
        input = consumed.value;
        index += consumed.extra;
        break;
      }
      case "--minimum-instances": {
        const consumed = optionValue(option, args, index);
        minimumInstancesPerFamily = parseNumber(
          consumed.value,
          "minimum-instances",
          1,
          Number.POSITIVE_INFINITY,
          true,
        );
        index += consumed.extra;
        break;
      }
      case "--allow-partial":
        rejectInlineValue(option);
        requireAllFamilies = false;
        break;
      default:
        if (token.startsWith("-")) {
          throw new CliUsageError(`unknown benchmark option: ${option.name}`);
        }
        positional.push(token);
    }
  }
  if (input !== undefined && positional.length > 0) {
    throw new CliUsageError("provide the benchmark input either positionally or with --input");
  }
  if (positional.length > 1) {
    throw new CliUsageError("benchmark accepts exactly one input file");
  }
  const inputPath = requireNonEmpty(input ?? positional[0] ?? "", "benchmark input");
  return {
    input: resolve(currentDirectory, inputPath),
    options: {
      ...(minimumInstancesPerFamily === undefined ? {} : { minimumInstancesPerFamily }),
      ...(requireAllFamilies === undefined ? {} : { requireAllFamilies }),
    },
  };
}

interface SplitOption {
  name: string;
  inlineValue?: string;
}

function splitOption(token: string): SplitOption {
  if (!token.startsWith("--")) {
    return { name: token };
  }
  const separator = token.indexOf("=");
  return separator === -1
    ? { name: token }
    : { name: token.slice(0, separator), inlineValue: token.slice(separator + 1) };
}

function optionValue(
  option: SplitOption,
  args: readonly string[],
  index: number,
): { value: string; extra: number } {
  if (option.inlineValue !== undefined) {
    return { value: requireNonEmpty(option.inlineValue, option.name), extra: 0 };
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option.name} requires a value`);
  }
  return { value, extra: 1 };
}

function rejectInlineValue(option: SplitOption): void {
  if (option.inlineValue !== undefined) {
    throw new CliUsageError(`${option.name} does not accept a value`);
  }
}

function setNumericLimit(
  limits: Partial<ExecutionLimits>,
  key: keyof ExecutionLimits,
  option: SplitOption,
  args: readonly string[],
  index: number,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  const consumed = optionValue(option, args, index);
  limits[key] = parseNumber(consumed.value, option.name.slice(2), minimum, maximum, integer);
  return consumed.extra;
}

function parseNumber(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    (integer && !Number.isInteger(parsed))
  ) {
    const upper = Number.isFinite(maximum) ? ` and at most ${String(maximum)}` : "";
    throw new CliUsageError(
      `${name} must be ${integer ? "an integer" : "a number"} at least ${String(minimum)}${upper}`,
    );
  }
  return parsed;
}

function parseDomain(value: string): TaskDomain {
  if (!DOMAINS.includes(value as TaskDomain)) {
    throw new CliUsageError(`domain must be one of: ${DOMAINS.join(", ")}`);
  }
  return value as TaskDomain;
}

function parseBoolean(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new CliUsageError("integrate must be true or false");
}

function parseBenchmarkObservations(source: string): BenchmarkObservation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`invalid benchmark JSON: ${normalizeError(error).message}`, { cause: error });
  }
  const observations = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed["observations"])
      ? parsed["observations"]
      : null;
  if (observations === null) {
    throw new Error("benchmark JSON must be an array or an object with an observations array");
  }
  return observations as BenchmarkObservation[];
}

function writeBatchResult(output: CliOutput, result: BatchResult, json: boolean): void {
  if (json) {
    output.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const lines = [`Run: ${result.runId}`, `Status: ${result.status}`];
  if (result.monitorUrl !== undefined) {
    lines.push(`Monitor: ${result.monitorUrl}`);
  }
  if (result.finalResponse !== null) {
    lines.push("", result.finalResponse);
  }
  if (result.needsAction !== undefined) {
    lines.push("", `Action required: ${result.needsAction}`);
  }
  if (result.error !== undefined) {
    lines.push("", `Error: ${result.error}`);
  }
  if (result.metrics !== null) {
    const cost =
      result.metrics.estimatedCostUsd === null
        ? "unknown"
        : `$${result.metrics.estimatedCostUsd.toFixed(4)}`;
    lines.push(
      "",
      `Elapsed: ${String(result.metrics.elapsedMs)} ms | Peak concurrency: ${String(result.metrics.peakConcurrency)} | Cost: ${cost}`,
    );
  }
  output.write(`${lines.join("\n")}\n`);
}

function writeBenchmark(output: CliOutput, result: BenchmarkEvaluation, json: boolean): void {
  if (json) {
    output.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const lines = [
    `${result.passed ? "PASS" : "FAIL"} Agent Trio benchmark (${String(result.pairCount)} pairs)`,
    ...result.gates.map(
      (gate) =>
        `${gate.passed ? "PASS" : "FAIL"} ${gate.name}: ${String(gate.actual)} (limit ${String(gate.limit)})`,
    ),
    ...result.errors.map((error) => `ERROR ${error}`),
  ];
  output.write(`${lines.join("\n")}\n`);
}

function writeCliError(output: CliOutput, error: Error, json: boolean): void {
  if (json) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    output.write(
      `${JSON.stringify({ error: { ...(code === undefined ? {} : { code }), message: error.message } })}\n`,
    );
    return;
  }
  output.write(`agent-trio: ${error.message}\n`);
}

function commandFailed(request: AgentTrioRequest, result: BatchResult): boolean {
  return (
    (request.action === "run" || request.action === "resume") &&
    (result.status === "failed" ||
      result.status === "cancelled" ||
      result.status === "indeterminate")
  );
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new CliUsageError(`${name} must be non-empty`);
  }
  return value;
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`internal error: missing ${name}`);
  }
  return value;
}

function isRuntimeModule(value: unknown): value is RuntimeModule {
  return isRecord(value) && typeof value["createDefaultRuntime"] === "function";
}

function normalizeRuntime(value: AgentTrioRuntime): AgentTrioRuntime {
  if (
    !isRecord(value) ||
    !isRecord(value["service"]) ||
    typeof value["service"]["handle"] !== "function"
  ) {
    throw new Error("createDefaultRuntime() must return { service, close? }");
  }
  if (value.close !== undefined && typeof value.close !== "function") {
    throw new Error("createDefaultRuntime() close must be a function when provided");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function isEntrypoint(): boolean {
  if (!isMainThread || process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  if (process.env["AGENT_TRIO_SUPERVISOR"] === "1") {
    void runSupervisorChild(loadDefaultRuntime).catch(() => {
      process.exitCode = 1;
    });
  } else {
    void runDefaultCli().then((exitCode) => {
      process.exitCode = exitCode;
    });
  }
}
