import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_TRIO_PROTOCOL_VERSION } from "./contracts.js";
import type { JobSnapshot, RemoteTurnRef, RunRequest } from "./contracts.js";

export interface JobEvent {
  type: string;
  at: string;
  data?: unknown;
}

export interface JobLock {
  release(): void;
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

const MALFORMED_LOCK_STALE_MS = 60_000;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 8;
const MAX_BOUNDED_SNAPSHOT_READS = 1_024;
const MAX_CHECKPOINT_LEAVES = 20;
const MAX_CHECKPOINT_VALIDATIONS = 64;
const MAX_CHECKPOINT_RESPONSE_LENGTH = 200_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_REMOTE_ID_LENGTH = 4_096;
const MAX_CHECKPOINT_CWD_LENGTH = 4_096;
const MAX_CHECKPOINT_NEEDS_ACTION_LENGTH = 16_000;
const MAX_CHECKPOINT_CAPABILITIES = 16;
const MAX_CAPABILITY_NAME_LENGTH = 256;
const MAX_CAPABILITY_PATH_LENGTH = 4_096;
const MAX_VALIDATION_COMMAND_LENGTH = 4_000;
const MAX_VALIDATION_SUMMARY_LENGTH = 2_000;
const MAX_ACCOUNTED_USAGE_TURNS = 512;
const MAX_ACCOUNTED_USAGE_KEY_LENGTH = 9_000;

export interface JobSnapshotReadOptions {
  /** Maximum number of job.json files to open. Directory enumeration is not counted. */
  maxJobs: number;
}

export class JobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirPrivate(root);
  }

  jobDirectory(runId: string): string {
    assertRunId(runId);
    return join(this.root, runId);
  }

  load(runId: string): JobSnapshot | null {
    const path = join(this.jobDirectory(runId), "job.json");
    if (!existsSync(path)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      throw invalidSnapshot(runId, "job.json is not valid JSON", error);
    }

    if (isRecord(parsed)) {
      // Snapshots written before durable remote-turn coordination omitted these fields.
      parsed["remoteTurns"] ??= [];
      parsed["coordinatorThreadId"] ??= null;
    }

    const issue = storedJobSnapshotIssue(parsed, runId);
    if (issue !== null) {
      throw invalidSnapshot(runId, issue);
    }
    return parsed as JobSnapshot;
  }

  /**
   * Reads a deterministic, bounded slice of durable snapshots for aggregate history. A corrupt
   * or concurrently removed job is skipped so optional historical data cannot block a new run.
   */
  readSnapshots(options: JobSnapshotReadOptions): JobSnapshot[] {
    const maxJobs = boundedSnapshotReadLimit(options.maxJobs);
    const runIds = readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && validRunId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, maxJobs);
    const snapshots: JobSnapshot[] = [];
    for (const runId of runIds) {
      try {
        const snapshot = this.load(runId);
        if (snapshot !== null) {
          snapshots.push(snapshot);
        }
      } catch {
        // History is advisory. Active run reads still use load() and retain strict error behavior.
      }
    }
    return snapshots;
  }

  save(snapshot: JobSnapshot): void {
    const directory = this.jobDirectory(snapshot.result.runId);
    mkdirPrivate(directory);
    const path = join(directory, "job.json");
    const temporary = join(directory, `.job.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, path);
      syncDirectory(directory);
    } finally {
      try {
        if (descriptor !== null) {
          closeSync(descriptor);
        }
      } finally {
        const temporaryExists = existsSync(temporary);
        rmSync(temporary, { force: true });
        if (temporaryExists) {
          syncDirectory(directory);
        }
      }
    }
  }

  recordRemoteTurn(runId: string, turn: RemoteTurnRef): void {
    const snapshot = this.load(runId);
    if (snapshot === null) {
      throw new Error(`cannot checkpoint remote turn for unknown run ${runId}`);
    }
    const key = remoteTurnKey(turn);
    const remoteTurns = snapshot.remoteTurns.filter(
      (candidate) =>
        remoteTurnKey(candidate) !== key &&
        !(
          turn.turnId !== null &&
          candidate.turnId === null &&
          remoteTurnBaseKey(candidate) === remoteTurnBaseKey(turn)
        ),
    );
    remoteTurns.push(structuredClone(turn));
    this.save({ ...snapshot, remoteTurns, updatedAt: turn.updatedAt });
  }

  appendEvent(runId: string, event: JobEvent): void {
    const directory = this.jobDirectory(runId);
    mkdirPrivate(directory);
    const path = join(directory, "events.jsonl");
    const descriptor = openSync(path, "a", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(event)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(directory);
  }

  acquire(runId: string): JobLock {
    const directory = this.jobDirectory(runId);
    mkdirPrivate(directory);
    const path = join(directory, "job.lock");
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
      let descriptor: number;
      try {
        descriptor = openSync(path, "wx", 0o600);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        if (!this.#clearStaleLock(path)) {
          throw new Error(`job ${runId} is already active`, { cause: error });
        }
        continue;
      }

      let identity: FileIdentity;
      try {
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
        fsyncSync(descriptor);
        identity = fileIdentity(fstatSync(descriptor));
      } catch (error) {
        closeSync(descriptor);
        if (removeIfOwned(path, owner.token)) {
          syncDirectory(directory);
        }
        throw error;
      }
      closeSync(descriptor);
      syncDirectory(directory);

      let released = false;
      return {
        release: () => {
          if (released) {
            return;
          }
          removeIfOwned(path, owner.token, identity);
          syncDirectory(directory);
          released = true;
        },
      };
    }

    throw new Error(`job ${runId} lock changed too often while acquiring`);
  }

  #clearStaleLock(path: string): boolean {
    let identity: FileIdentity;
    try {
      identity = fileIdentity(statSync(path));
      const parsed = parseLockOwner(readFileSync(path, "utf8"));
      if (parsed !== null && processAlive(parsed.pid)) {
        return false;
      }
      if (parsed === null && Date.now() - statSync(path).mtimeMs < MALFORMED_LOCK_STALE_MS) {
        return false;
      }
    } catch (error) {
      if (isMissing(error)) {
        return true;
      }
      throw error;
    }
    const removed = removeIfIdentityMatches(path, identity);
    if (removed) {
      syncDirectory(dirname(path));
    }
    return removed;
  }
}

export function hashRunRequest(request: RunRequest): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

export function assertMatchingRequest(snapshot: JobSnapshot, request: RunRequest): void {
  const hash = hashRunRequest(request);
  if (hash !== snapshot.requestHash) {
    throw new Error(
      `runId ${snapshot.result.runId} already exists with a different request (${snapshot.requestHash} != ${hash})`,
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function mkdirPrivate(path: string): void {
  if (existsSync(path)) {
    return;
  }
  const parent = dirname(path);
  if (parent !== path) {
    mkdirPrivate(parent);
  }
  try {
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(parent);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
}

function assertRunId(runId: string): void {
  if (!validRunId(runId)) {
    throw new Error(`invalid runId: ${runId}`);
  }
}

function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId);
}

function boundedSnapshotReadLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_BOUNDED_SNAPSHOT_READS) {
    throw new RangeError(
      `maxJobs must be an integer between 1 and ${String(MAX_BOUNDED_SNAPSHOT_READS)}`,
    );
  }
  return value;
}

function storedJobSnapshotIssue(value: unknown, runId: string): string | null {
  if (!isRecord(value) || value["protocolVersion"] !== AGENT_TRIO_PROTOCOL_VERSION) {
    return `protocolVersion must equal ${String(AGENT_TRIO_PROTOCOL_VERSION)}`;
  }
  const request = value["request"];
  const result = value["result"];
  if (typeof value["requestHash"] !== "string") {
    return "requestHash must be a string";
  }
  if (
    !isRecord(request) ||
    typeof request["objective"] !== "string" ||
    typeof request["cwd"] !== "string"
  ) {
    return "request must contain string objective and cwd fields";
  }
  if (!isRecord(result) || result["protocolVersion"] !== AGENT_TRIO_PROTOCOL_VERSION) {
    return "result must use the current protocolVersion";
  }
  if (result["runId"] !== runId) {
    return "result.runId must match its job directory";
  }
  if (typeof result["status"] !== "string" || !Array.isArray(result["leaves"])) {
    return "result must contain a string status and leaves array";
  }
  if (!Array.isArray(value["remoteTurns"])) {
    return "remoteTurns must be an array";
  }
  if (typeof value["updatedAt"] !== "string") {
    return "updatedAt must be a string";
  }

  const integrationCheckpoint = value["integrationCheckpoint"];
  if (integrationCheckpoint !== undefined) {
    const issue = integrationCheckpointIssue(integrationCheckpoint);
    if (issue !== null) {
      return issue;
    }
  }
  const waitingInputCheckpoint = value["waitingInputCheckpoint"];
  if (waitingInputCheckpoint !== undefined) {
    const issue = waitingInputCheckpointIssue(waitingInputCheckpoint);
    if (issue !== null) {
      return issue;
    }
  }
  const accountedUsageTurnKeys = value["accountedUsageTurnKeys"];
  if (accountedUsageTurnKeys === undefined) {
    return null;
  }
  if (
    !Array.isArray(accountedUsageTurnKeys) ||
    accountedUsageTurnKeys.length > MAX_ACCOUNTED_USAGE_TURNS
  ) {
    return `accountedUsageTurnKeys must be an array with at most ${String(MAX_ACCOUNTED_USAGE_TURNS)} items`;
  }
  const unique = new Set<string>();
  for (const [index, key] of accountedUsageTurnKeys.entries()) {
    if (!isBoundedString(key, 1, MAX_ACCOUNTED_USAGE_KEY_LENGTH)) {
      return `accountedUsageTurnKeys[${String(index)}] must be a non-empty bounded string`;
    }
    if (unique.has(key)) {
      return `accountedUsageTurnKeys[${String(index)}] must not duplicate an earlier key`;
    }
    unique.add(key);
  }
  return null;
}

function integrationCheckpointIssue(value: unknown): string | null {
  const path = "integrationCheckpoint";
  if (!isRecord(value)) {
    return `${path} must be an object`;
  }
  if (!isBoundedString(value["planId"], 1, MAX_IDENTIFIER_LENGTH)) {
    return `${path}.planId must be a non-empty string up to ${String(MAX_IDENTIFIER_LENGTH)} characters`;
  }

  const leafIdentityIssue = leafIdentitiesIssue(value["leafIdentities"], `${path}.leafIdentities`);
  if (leafIdentityIssue !== null) {
    return leafIdentityIssue;
  }

  if (!isBoundedString(value["response"], 0, MAX_CHECKPOINT_RESPONSE_LENGTH)) {
    return `${path}.response must be a string up to ${String(MAX_CHECKPOINT_RESPONSE_LENGTH)} characters`;
  }

  const validation = value["validation"];
  if (!Array.isArray(validation) || validation.length > MAX_CHECKPOINT_VALIDATIONS) {
    return `${path}.validation must be an array with at most ${String(MAX_CHECKPOINT_VALIDATIONS)} items`;
  }
  for (const [index, result] of validation.entries()) {
    const resultPath = `${path}.validation[${String(index)}]`;
    if (!isRecord(result)) {
      return `${resultPath} must be an object`;
    }
    if (!isBoundedString(result["command"], 1, MAX_VALIDATION_COMMAND_LENGTH)) {
      return `${resultPath}.command must be a non-empty string up to ${String(MAX_VALIDATION_COMMAND_LENGTH)} characters`;
    }
    if (!isValidationStatus(result["status"])) {
      return `${resultPath}.status must be passed, failed, or skipped`;
    }
    if (!isBoundedString(result["summary"], 0, MAX_VALIDATION_SUMMARY_LENGTH)) {
      return `${resultPath}.summary must be a string up to ${String(MAX_VALIDATION_SUMMARY_LENGTH)} characters`;
    }
  }

  if (!isNullableBoundedString(value["integratorThreadId"], MAX_REMOTE_ID_LENGTH)) {
    return `${path}.integratorThreadId must be null or a non-empty bounded string`;
  }
  if (value["launchSkewMs"] !== null && !isFiniteNonnegativeNumber(value["launchSkewMs"])) {
    return `${path}.launchSkewMs must be null or a nonnegative finite number`;
  }
  if (!isNonnegativeInteger(value["peakConcurrency"])) {
    return `${path}.peakConcurrency must be a nonnegative integer`;
  }
  if (value["replanCount"] !== 0 && value["replanCount"] !== 1) {
    return `${path}.replanCount must be 0 or 1`;
  }
  if (!isIsoTimestamp(value["updatedAt"])) {
    return `${path}.updatedAt must be an ISO timestamp with a timezone`;
  }
  return null;
}

function waitingInputCheckpointIssue(value: unknown): string | null {
  const path = "waitingInputCheckpoint";
  if (!isRecord(value)) {
    return `${path} must be an object`;
  }
  const kind = value["kind"];
  if (kind === "admission" || kind === "direct") {
    return waitingTurnCheckpointIssue(value["turn"], `${path}.turn`);
  }
  if (kind === "leaves") {
    if (!isBoundedString(value["planId"], 1, MAX_IDENTIFIER_LENGTH)) {
      return `${path}.planId must be a non-empty string up to ${String(MAX_IDENTIFIER_LENGTH)} characters`;
    }
    const leaves = value["leaves"];
    if (!Array.isArray(leaves) || leaves.length === 0 || leaves.length > MAX_CHECKPOINT_LEAVES) {
      return `${path}.leaves must contain between 1 and ${String(MAX_CHECKPOINT_LEAVES)} items`;
    }
    for (const [index, leaf] of leaves.entries()) {
      const leafPath = `${path}.leaves[${String(index)}]`;
      if (!isRecord(leaf)) {
        return `${leafPath} must be an object`;
      }
      if (!isBoundedString(leaf["taskId"], 1, MAX_IDENTIFIER_LENGTH)) {
        return `${leafPath}.taskId must be a non-empty string up to ${String(MAX_IDENTIFIER_LENGTH)} characters`;
      }
      if (!isBoundedString(leaf["threadId"], 1, MAX_REMOTE_ID_LENGTH)) {
        return `${leafPath}.threadId must be a non-empty bounded string`;
      }
      if (!isBoundedString(leaf["previousTurnId"], 1, MAX_REMOTE_ID_LENGTH)) {
        return `${leafPath}.previousTurnId must be a non-empty bounded string`;
      }
      if (!isPositiveSafeInteger(leaf["attempt"])) {
        return `${leafPath}.attempt must be a positive safe integer`;
      }
      if (!isBoundedString(leaf["needsAction"], 1, MAX_CHECKPOINT_NEEDS_ACTION_LENGTH)) {
        return `${leafPath}.needsAction must be a non-empty string up to ${String(MAX_CHECKPOINT_NEEDS_ACTION_LENGTH)} characters`;
      }
    }
    return isIsoTimestamp(value["updatedAt"])
      ? null
      : `${path}.updatedAt must be an ISO timestamp with a timezone`;
  }
  if (kind === "integration") {
    if (!isBoundedString(value["planId"], 1, MAX_IDENTIFIER_LENGTH)) {
      return `${path}.planId must be a non-empty string up to ${String(MAX_IDENTIFIER_LENGTH)} characters`;
    }
    const turnIssue = waitingTurnCheckpointIssue(value["turn"], `${path}.turn`);
    if (turnIssue !== null) {
      return turnIssue;
    }
    return leafIdentitiesIssue(value["leafIdentities"], `${path}.leafIdentities`, true);
  }
  return `${path}.kind must be admission, direct, leaves, or integration`;
}

function waitingTurnCheckpointIssue(value: unknown, path: string): string | null {
  if (!isRecord(value)) {
    return `${path} must be an object`;
  }
  if (!isBoundedString(value["threadId"], 1, MAX_REMOTE_ID_LENGTH)) {
    return `${path}.threadId must be a non-empty bounded string`;
  }
  if (!isBoundedString(value["previousTurnId"], 1, MAX_REMOTE_ID_LENGTH)) {
    return `${path}.previousTurnId must be a non-empty bounded string`;
  }
  if (!isBoundedString(value["cwd"], 1, MAX_CHECKPOINT_CWD_LENGTH)) {
    return `${path}.cwd must be a non-empty string up to ${String(MAX_CHECKPOINT_CWD_LENGTH)} characters`;
  }
  if (!isBoundedString(value["needsAction"], 1, MAX_CHECKPOINT_NEEDS_ACTION_LENGTH)) {
    return `${path}.needsAction must be a non-empty string up to ${String(MAX_CHECKPOINT_NEEDS_ACTION_LENGTH)} characters`;
  }
  const capabilities = value["capabilities"];
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CHECKPOINT_CAPABILITIES) {
    return `${path}.capabilities must be an array with at most ${String(MAX_CHECKPOINT_CAPABILITIES)} items`;
  }
  for (const [index, capability] of capabilities.entries()) {
    const capabilityPath = `${path}.capabilities[${String(index)}]`;
    if (!isRecord(capability)) {
      return `${capabilityPath} must be an object`;
    }
    if (capability["kind"] !== "skill" && capability["kind"] !== "plugin") {
      return `${capabilityPath}.kind must be skill or plugin`;
    }
    if (!isBoundedString(capability["name"], 1, MAX_CAPABILITY_NAME_LENGTH)) {
      return `${capabilityPath}.name must be a non-empty string up to ${String(MAX_CAPABILITY_NAME_LENGTH)} characters`;
    }
    if (
      capability["path"] !== undefined &&
      !isBoundedString(capability["path"], 1, MAX_CAPABILITY_PATH_LENGTH)
    ) {
      return `${capabilityPath}.path must be absent or a non-empty string up to ${String(MAX_CAPABILITY_PATH_LENGTH)} characters`;
    }
  }
  return isIsoTimestamp(value["updatedAt"])
    ? null
    : `${path}.updatedAt must be an ISO timestamp with a timezone`;
}

function leafIdentitiesIssue(value: unknown, path: string, requireNonempty = false): string | null {
  if (
    !Array.isArray(value) ||
    (requireNonempty && value.length === 0) ||
    value.length > MAX_CHECKPOINT_LEAVES
  ) {
    return requireNonempty
      ? `${path} must contain between 1 and ${String(MAX_CHECKPOINT_LEAVES)} items`
      : `${path} must be an array with at most ${String(MAX_CHECKPOINT_LEAVES)} items`;
  }
  for (const [index, identity] of value.entries()) {
    const identityPath = `${path}[${String(index)}]`;
    if (!isRecord(identity)) {
      return `${identityPath} must be an object`;
    }
    if (!isBoundedString(identity["taskId"], 1, MAX_IDENTIFIER_LENGTH)) {
      return `${identityPath}.taskId must be a non-empty string up to ${String(MAX_IDENTIFIER_LENGTH)} characters`;
    }
    if (!isNullableBoundedString(identity["threadId"], MAX_REMOTE_ID_LENGTH)) {
      return `${identityPath}.threadId must be null or a non-empty bounded string`;
    }
    if (!isNullableBoundedString(identity["turnId"], MAX_REMOTE_ID_LENGTH)) {
      return `${identityPath}.turnId must be null or a non-empty bounded string`;
    }
    if (!isIsoTimestamp(identity["completedAt"])) {
      return `${identityPath}.completedAt must be an ISO timestamp with a timezone`;
    }
  }
  return null;
}

function invalidSnapshot(runId: string, detail: string, cause?: unknown): Error {
  const message = `invalid snapshot for run ${runId}: ${detail}`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function isBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function isNullableBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || isBoundedString(value, 1, maxLength);
}

function isValidationStatus(value: unknown): value is "passed" | "failed" | "skipped" {
  return value === "passed" || value === "failed" || value === "skipped";
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return isFiniteNonnegativeNumber(value) && Number.isInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    isBoundedString(value, 20, 64) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed["token"] !== "string" ||
      parsed["token"].length === 0 ||
      typeof parsed["pid"] !== "number" ||
      !Number.isSafeInteger(parsed["pid"]) ||
      parsed["pid"] <= 0 ||
      typeof parsed["createdAt"] !== "string"
    ) {
      return null;
    }
    return {
      token: parsed["token"],
      pid: parsed["pid"],
      createdAt: parsed["createdAt"],
    };
  } catch {
    return null;
  }
}

function fileIdentity(stats: { dev: number; ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeIfIdentityMatches(path: string, expected: FileIdentity): boolean {
  try {
    if (!sameFile(fileIdentity(statSync(path)), expected)) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return true;
    }
    throw error;
  }
}

function removeIfOwned(path: string, token: string, identity?: FileIdentity): boolean {
  try {
    const currentIdentity = fileIdentity(statSync(path));
    if (identity !== undefined && !sameFile(currentIdentity, identity)) {
      return false;
    }
    const owner = parseLockOwner(readFileSync(path, "utf8"));
    if (owner?.token !== token) {
      return false;
    }
    return removeIfIdentityMatches(path, currentIdentity);
  } catch (error) {
    if (isMissing(error)) {
      return true;
    }
    throw error;
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function defaultJobStoreRoot(codexHome: string): string {
  return join(codexHome, "agent-trio", "jobs");
}

export function ensureParent(path: string): void {
  mkdirPrivate(dirname(path));
}

function remoteTurnKey(turn: RemoteTurnRef): string {
  return `${remoteTurnBaseKey(turn)}:${turn.turnId ?? "<pending>"}`;
}

function remoteTurnBaseKey(turn: RemoteTurnRef): string {
  return `${turn.role}:${turn.taskId ?? ""}:${String(turn.attempt ?? 0)}:${turn.threadId}`;
}
