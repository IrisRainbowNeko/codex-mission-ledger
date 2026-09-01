import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

export const SEALED_BENCHMARK_VALIDATOR_VERSION = 1 as const;
export const RUNNER_CONTROLLED_NETWORK = "runner-controlled" as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface SealedOutputCriteriaV1 {
  /** Every listed literal must occur in stdout followed by stderr. */
  all?: readonly string[];
  /** At least one listed literal must occur in stdout followed by stderr. */
  any?: readonly string[];
  /** Every listed JavaScript Unicode regular expression must match. */
  regex?: readonly string[];
}

export interface SealedCommandCheckV1 {
  id: string;
  /** A failed check is release-blocking only when this is explicitly true. */
  critical?: boolean;
  /** Executable and arguments. This vector is passed directly to spawn without a shell. */
  argv: readonly string[];
  /** Relative to the validated workspace. Defaults to the workspace root. */
  cwd?: string;
  timeoutMs?: number;
  expectedExitCode?: number;
  output?: Readonly<SealedOutputCriteriaV1>;
}

export interface SealedRequiredDeliverableV1 {
  id: string;
  /** A missing or invalid deliverable is release-blocking only when explicitly true. */
  critical?: boolean;
  /** Required regular file, expressed as a workspace-relative portable path. */
  path: string;
  sha256?: string;
}

export interface SealedBenchmarkValidatorV1 {
  schemaVersion: typeof SEALED_BENCHMARK_VALIDATOR_VERSION;
  /**
   * Network and filesystem isolation are properties of the process that invokes
   * this validator. Node's spawn API does not create a network sandbox.
   */
  runnerSandboxBoundary: {
    networkIsolation: typeof RUNNER_CONTROLLED_NETWORK;
  };
  commandChecks: readonly SealedCommandCheckV1[];
  requiredDeliverables: readonly SealedRequiredDeliverableV1[];
}

export interface SealedCommandEvidence {
  id: string;
  kind: "command";
  passed: boolean;
  critical: boolean;
  summary: string;
  argv: readonly string[];
  cwd: string;
  expectedExitCode: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
  criteria: {
    all: boolean;
    any: boolean;
    regex: boolean;
  };
}

export interface SealedDeliverableEvidence {
  id: string;
  kind: "deliverable";
  passed: boolean;
  critical: boolean;
  summary: string;
  path: string;
  expectedSha256: string | null;
  actualSha256: string | null;
}

export type SealedValidatorEvidence = SealedCommandEvidence | SealedDeliverableEvidence;

export interface SealedBenchmarkValidationResult {
  schemaVersion: typeof SEALED_BENCHMARK_VALIDATOR_VERSION;
  score: number;
  passedChecks: number;
  totalChecks: number;
  evidence: SealedValidatorEvidence[];
  criticalFailures: string[];
}

export interface RunSealedBenchmarkValidatorOptions {
  /** Absolute root of the isolated benchmark workspace. */
  workspace: string;
  /** Optional runner-owned isolation wrapper; evidence continues to report the sealed argv. */
  commandWrapper?: (
    argv: readonly string[],
    cwd: string,
  ) => { argv: readonly string[]; cwd: string };
}

export class SealedBenchmarkValidatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedBenchmarkValidatorError";
  }
}

/** Parse and normalize the sealed validator's strict JSON v1 schema. */
export function parseSealedBenchmarkValidatorV1(value: unknown): SealedBenchmarkValidatorV1 {
  const root = requireRecord(value, "validator");
  allowOnlyKeys(
    root,
    ["schemaVersion", "runnerSandboxBoundary", "commandChecks", "requiredDeliverables"],
    "validator",
  );
  if (root["schemaVersion"] !== SEALED_BENCHMARK_VALIDATOR_VERSION) {
    throw schemaError("validator.schemaVersion must be 1");
  }

  const boundary = requireRecord(root["runnerSandboxBoundary"], "validator.runnerSandboxBoundary");
  allowOnlyKeys(boundary, ["networkIsolation"], "validator.runnerSandboxBoundary");
  if (boundary["networkIsolation"] !== RUNNER_CONTROLLED_NETWORK) {
    throw schemaError(
      `validator.runnerSandboxBoundary.networkIsolation must be '${RUNNER_CONTROLLED_NETWORK}'`,
    );
  }

  const rawCommands = requireArray(root["commandChecks"], "validator.commandChecks");
  const rawDeliverables = requireArray(
    root["requiredDeliverables"],
    "validator.requiredDeliverables",
  );
  if (rawCommands.length + rawDeliverables.length === 0) {
    throw schemaError("validator must define at least one command check or required deliverable");
  }

  const commandChecks = rawCommands.map((item, index) => parseCommand(item, index));
  const requiredDeliverables = rawDeliverables.map((item, index) => parseDeliverable(item, index));
  const ids = [...commandChecks, ...requiredDeliverables].map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw schemaError("validator check ids must be unique");
  }

  return {
    schemaVersion: SEALED_BENCHMARK_VALIDATOR_VERSION,
    runnerSandboxBoundary: { networkIsolation: RUNNER_CONTROLLED_NETWORK },
    commandChecks,
    requiredDeliverables,
  };
}

/** Execute a sealed v1 validator deterministically, one command at a time. */
export async function runSealedBenchmarkValidator(
  validatorValue: unknown,
  options: Readonly<RunSealedBenchmarkValidatorOptions>,
): Promise<SealedBenchmarkValidationResult> {
  if (!isAbsolute(options.workspace)) {
    throw new SealedBenchmarkValidatorError("validator workspace must be an absolute path");
  }
  const validator = parseSealedBenchmarkValidatorV1(validatorValue);
  const workspace = await realpath(options.workspace);
  if (!(await stat(workspace)).isDirectory()) {
    throw new SealedBenchmarkValidatorError("validator workspace must be a directory");
  }
  const evidence: SealedValidatorEvidence[] = [];

  for (const check of validator.commandChecks) {
    const cwd = await resolveExistingWorkspacePath(workspace, check.cwd ?? ".", "command cwd");
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      throw new SealedBenchmarkValidatorError(
        `command cwd is not a directory: ${check.cwd ?? "."}`,
      );
    }
    evidence.push(await runCommandCheck(check, cwd, options.commandWrapper));
  }

  for (const deliverable of validator.requiredDeliverables) {
    evidence.push(await inspectDeliverable(workspace, deliverable));
  }

  const passedChecks = evidence.filter((item) => item.passed).length;
  const totalChecks = evidence.length;
  return {
    schemaVersion: SEALED_BENCHMARK_VALIDATOR_VERSION,
    score: Math.round((passedChecks / totalChecks) * 100),
    passedChecks,
    totalChecks,
    evidence,
    criticalFailures: evidence
      .filter((item) => item.critical && !item.passed)
      .map((item) => `${item.id}: ${item.summary}`),
  };
}

function parseCommand(value: unknown, index: number): SealedCommandCheckV1 {
  const label = `validator.commandChecks[${index}]`;
  const command = requireRecord(value, label);
  allowOnlyKeys(
    command,
    ["id", "critical", "argv", "cwd", "timeoutMs", "expectedExitCode", "output"],
    label,
  );
  const id = requireIdentifier(command["id"], `${label}.id`);
  const critical = optionalBoolean(command["critical"], `${label}.critical`);
  const rawArgv = requireArray(command["argv"], `${label}.argv`);
  if (rawArgv.length === 0 || rawArgv.length > 128) {
    throw schemaError(`${label}.argv must contain between 1 and 128 entries`);
  }
  const argv = rawArgv.map((argument, argumentIndex) => {
    if (typeof argument !== "string" || argument.includes("\0") || argument.length > 32_768) {
      throw schemaError(`${label}.argv[${argumentIndex}] must be a valid string`);
    }
    if (argumentIndex === 0 && argument.length === 0) {
      throw schemaError(`${label}.argv[0] must name an executable`);
    }
    return argument;
  });

  const cwd = optionalRelativePath(command["cwd"], `${label}.cwd`, true);
  const timeoutMs = optionalInteger(command["timeoutMs"], `${label}.timeoutMs`, 1, MAX_TIMEOUT_MS);
  const expectedExitCode = optionalInteger(
    command["expectedExitCode"],
    `${label}.expectedExitCode`,
    0,
    255,
  );
  const output =
    command["output"] === undefined ? undefined : parseOutput(command["output"], label);

  return {
    id,
    ...(critical === undefined ? {} : { critical }),
    argv,
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(expectedExitCode === undefined ? {} : { expectedExitCode }),
    ...(output === undefined ? {} : { output }),
  };
}

function parseOutput(value: unknown, parentLabel: string): SealedOutputCriteriaV1 {
  const label = `${parentLabel}.output`;
  const output = requireRecord(value, label);
  allowOnlyKeys(output, ["all", "any", "regex"], label);
  if (Object.keys(output).length === 0) {
    throw schemaError(`${label} must define all, any, or regex criteria`);
  }
  const all = optionalStringArray(output["all"], `${label}.all`);
  const any = optionalStringArray(output["any"], `${label}.any`);
  const regex = optionalStringArray(output["regex"], `${label}.regex`);
  for (const [index, pattern] of (regex ?? []).entries()) {
    if (pattern.length > 1_024) {
      throw schemaError(`${label}.regex[${index}] exceeds 1024 characters`);
    }
    try {
      new RegExp(pattern, "u");
    } catch {
      throw schemaError(`${label}.regex[${index}] is not a valid Unicode regular expression`);
    }
  }
  return {
    ...(all === undefined ? {} : { all }),
    ...(any === undefined ? {} : { any }),
    ...(regex === undefined ? {} : { regex }),
  };
}

function parseDeliverable(value: unknown, index: number): SealedRequiredDeliverableV1 {
  const label = `validator.requiredDeliverables[${index}]`;
  const deliverable = requireRecord(value, label);
  allowOnlyKeys(deliverable, ["id", "critical", "path", "sha256"], label);
  const id = requireIdentifier(deliverable["id"], `${label}.id`);
  const critical = optionalBoolean(deliverable["critical"], `${label}.critical`);
  const path = optionalRelativePath(deliverable["path"], `${label}.path`, false);
  if (path === undefined) {
    throw schemaError(`${label}.path must be a string`);
  }
  const sha256 = deliverable["sha256"];
  if (sha256 !== undefined && (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))) {
    throw schemaError(`${label}.sha256 must be a lowercase hexadecimal SHA-256 digest`);
  }
  return {
    id,
    ...(critical === undefined ? {} : { critical }),
    path,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

async function runCommandCheck(
  check: Readonly<SealedCommandCheckV1>,
  cwd: string,
  commandWrapper: RunSealedBenchmarkValidatorOptions["commandWrapper"],
): Promise<SealedCommandEvidence> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectedExitCode = check.expectedExitCode ?? 0;
  const command = commandWrapper?.(check.argv, cwd) ?? { argv: check.argv, cwd };
  if (command.argv.length === 0) {
    throw new SealedBenchmarkValidatorError("validator command wrapper returned an empty argv");
  }
  const execution = await executeArgv(command.argv, command.cwd, timeoutMs);
  const combined = `${execution.stdout}\n${execution.stderr}`;
  const criteria = {
    all: (check.output?.all ?? []).every((literal) => combined.includes(literal)),
    any:
      check.output?.any === undefined ||
      check.output.any.some((literal) => combined.includes(literal)),
    regex: (check.output?.regex ?? []).every((pattern) => new RegExp(pattern, "u").test(combined)),
  };
  const passed =
    !execution.timedOut &&
    !execution.outputLimitExceeded &&
    execution.spawnError === null &&
    execution.exitCode === expectedExitCode &&
    criteria.all &&
    criteria.any &&
    criteria.regex;
  const summary = commandSummary(execution, expectedExitCode, criteria);
  return {
    id: check.id,
    kind: "command",
    passed,
    critical: check.critical === true,
    summary,
    argv: [...check.argv],
    cwd,
    expectedExitCode,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    outputLimitExceeded: execution.outputLimitExceeded,
    stdout: execution.stdout,
    stderr: execution.stderr,
    criteria,
  };
}

interface CommandExecution {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
}

async function executeArgv(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandExecution> {
  return new Promise((finish) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: string | null = null;
    const terminate = (): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The group may already have exited; fall back to the direct child handle.
        }
      }
      child.kill("SIGKILL");
    };

    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining > 0) {
        target.push(buffer.subarray(0, remaining));
        capturedBytes += Math.min(buffer.byteLength, remaining);
      }
      if (buffer.byteLength > remaining) {
        outputLimitExceeded = true;
        terminate();
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error.message;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      finish({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        spawnError,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function commandSummary(
  execution: Readonly<CommandExecution>,
  expectedExitCode: number,
  criteria: Readonly<SealedCommandEvidence["criteria"]>,
): string {
  if (execution.spawnError !== null) {
    return `command could not start: ${execution.spawnError}`;
  }
  if (execution.timedOut) {
    return "command timed out";
  }
  if (execution.outputLimitExceeded) {
    return `command output exceeded ${MAX_CAPTURE_BYTES} bytes`;
  }
  if (execution.exitCode !== expectedExitCode) {
    return `expected exit code ${expectedExitCode}, received ${String(execution.exitCode)}`;
  }
  const failedCriteria = (Object.entries(criteria) as [keyof typeof criteria, boolean][])
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedCriteria.length > 0) {
    return `output criteria failed: ${failedCriteria.join(", ")}`;
  }
  return `exit code ${expectedExitCode} and output criteria passed`;
}

async function inspectDeliverable(
  workspace: string,
  deliverable: Readonly<SealedRequiredDeliverableV1>,
): Promise<SealedDeliverableEvidence> {
  const resolved = await resolveOptionalWorkspacePath(workspace, deliverable.path);
  if (resolved === null) {
    return {
      id: deliverable.id,
      kind: "deliverable",
      passed: false,
      critical: deliverable.critical === true,
      summary: "required deliverable is missing",
      path: deliverable.path,
      expectedSha256: deliverable.sha256 ?? null,
      actualSha256: null,
    };
  }
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    return {
      id: deliverable.id,
      kind: "deliverable",
      passed: false,
      critical: deliverable.critical === true,
      summary: "required deliverable is not a regular file",
      path: deliverable.path,
      expectedSha256: deliverable.sha256 ?? null,
      actualSha256: null,
    };
  }
  const actualSha256 = await sha256File(resolved);
  const passed = deliverable.sha256 === undefined || deliverable.sha256 === actualSha256;
  return {
    id: deliverable.id,
    kind: "deliverable",
    passed,
    critical: deliverable.critical === true,
    summary: passed ? "required deliverable exists" : "required deliverable SHA-256 mismatch",
    path: deliverable.path,
    expectedSha256: deliverable.sha256 ?? null,
    actualSha256,
  };
}

async function sha256File(path: string): Promise<string> {
  return new Promise((finish, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => finish(hash.digest("hex")));
  });
}

async function resolveExistingWorkspacePath(
  workspace: string,
  requested: string,
  label: string,
): Promise<string> {
  const candidate = resolve(workspace, requested);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new SealedBenchmarkValidatorError(`${label} does not exist: ${requested}${detail}`);
  }
  assertInsideWorkspace(workspace, resolved, label);
  return resolved;
}

async function resolveOptionalWorkspacePath(
  workspace: string,
  requested: string,
): Promise<string | null> {
  const candidate = resolve(workspace, requested);
  try {
    const resolved = await realpath(candidate);
    assertInsideWorkspace(workspace, resolved, "deliverable path");
    return resolved;
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }
    await assertExistingAncestorInsideWorkspace(workspace, candidate);
    return null;
  }
}

async function assertExistingAncestorInsideWorkspace(
  workspace: string,
  path: string,
): Promise<void> {
  let ancestor = dirname(path);
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      assertInsideWorkspace(workspace, resolved, "deliverable parent path");
      return;
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new SealedBenchmarkValidatorError("could not resolve a deliverable parent path");
    }
    ancestor = parent;
  }
}

function assertInsideWorkspace(workspace: string, candidate: string, label: string): void {
  const fromWorkspace = relative(workspace, candidate);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new SealedBenchmarkValidatorError(`${label} resolves outside the benchmark workspace`);
  }
}

function optionalRelativePath(
  value: unknown,
  label: string,
  allowWorkspaceRoot: boolean,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw schemaError(`${label} must be a portable relative path`);
  }
  if (isAbsolute(value)) {
    throw schemaError(`${label} must be relative to the workspace`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "..") ||
    (!allowWorkspaceRoot && segments.some((segment) => segment === ".")) ||
    (allowWorkspaceRoot && value !== "." && segments.some((segment) => segment === "."))
  ) {
    throw schemaError(`${label} contains a forbidden path segment`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw schemaError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw schemaError(`${label} must be boolean when provided`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = requireArray(value, label);
  if (items.length === 0) {
    throw schemaError(`${label} must not be empty`);
  }
  return items.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 4_096) {
      throw schemaError(`${label}[${index}] must be a non-empty string of at most 4096 characters`);
    }
    return item;
  });
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim()
  ) {
    throw schemaError(`${label} must be a non-empty identifier of at most 128 characters`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemaError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw schemaError(`${label} must be an array`);
  }
  return value;
}

function allowOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw schemaError(`${label} contains unknown property '${unknown}'`);
  }
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function schemaError(message: string): SealedBenchmarkValidatorError {
  return new SealedBenchmarkValidatorError(`invalid sealed benchmark validator: ${message}`);
}
