import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ModelTier = "sol" | "terra" | "luna" | "other";

export interface TokenBreakdown {
  cachedInputTokens: number;
  /** Tokens written to the prompt cache; omitted by legacy snapshots. */
  cacheWriteInputTokens?: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionThread {
  filePath: string;
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  agentRole: string | null;
  modelNames: string[];
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number;
  turnCount: number;
  tokens: TokenBreakdown;
  tokensByModel: Record<string, TokenBreakdown>;
  malformedLineCount: number;
}

export interface TierTokenBreakdown {
  sol: TokenBreakdown;
  terra: TokenBreakdown;
  luna: TokenBreakdown;
  other: TokenBreakdown;
}

export interface ModelPrice {
  uncachedInputPerMillion: number;
  cachedInputPerMillion: number;
  /** Optional for compatibility with price files created before cache-write billing. */
  cacheWriteInputPerMillion?: number;
  outputPerMillion: number;
}

export type ModelPriceTable = Record<string, ModelPrice>;

export interface CostEstimate {
  total: number;
  byModel: Record<string, number>;
  unpricedModels: string[];
  complete: boolean;
}

export interface SessionMetrics {
  rootId: string;
  threadCount: number;
  threadIds: string[];
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number;
  rootTurnCount: number;
  totalTurnCount: number;
  directChildCount: number;
  directChildLaunchSkewMs: number | null;
  directChildElapsedMs: number;
  directChildParallelIntervalMs: number;
  directChildEffectiveParallelism: number | null;
  modelNames: string[];
  tokens: TokenBreakdown;
  tokensByTier: TierTokenBreakdown;
  tokensByModel: Record<string, TokenBreakdown>;
  estimatedCost: CostEstimate | null;
}

export interface MetricsComparison {
  // Greater than one means the candidate completed faster than the baseline.
  speedRatio: number | null;
  // Less than one means the candidate used fewer host tokens than the baseline.
  tokenRatio: number | null;
  solTokenRatio: number | null;
  costRatio: number | null;
}

interface UsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  hasCacheWriteInputTokens: boolean;
  outputTokens: number;
}

export interface ParsedMetricsArguments {
  rootId: string | null;
  baselineRootId: string | null;
  codexHome: string;
  pricePath: string | null;
  pretty: boolean;
  help: boolean;
}

export interface MetricsCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const UNKNOWN_MODEL = "unknown";

function zeroTokens(): TokenBreakdown {
  return {
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function zeroTierTokens(): TierTokenBreakdown {
  return {
    sol: zeroTokens(),
    terra: zeroTokens(),
    luna: zeroTokens(),
    other: zeroTokens(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addTokens(target: TokenBreakdown, source: TokenBreakdown): void {
  target.cachedInputTokens += source.cachedInputTokens;
  if (source.cacheWriteInputTokens !== undefined || target.cacheWriteInputTokens !== undefined) {
    target.cacheWriteInputTokens =
      (target.cacheWriteInputTokens ?? 0) + (source.cacheWriteInputTokens ?? 0);
  }
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
}

function cloneTokens(source: TokenBreakdown): TokenBreakdown {
  return { ...source };
}

function snapshotFromRecord(value: unknown): UsageSnapshot | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const inputTokens = nonNegativeNumber(record["input_tokens"]);
  const cachedInputTokens = Math.min(inputTokens, nonNegativeNumber(record["cached_input_tokens"]));
  const cacheWriteValue =
    record["cache_write_input_tokens"] ??
    record["cacheWriteInputTokens"] ??
    record["cache_write_input"];
  const hasCacheWriteInputTokens =
    typeof cacheWriteValue === "number" && Number.isFinite(cacheWriteValue) && cacheWriteValue >= 0;
  const cacheWriteInputTokens = hasCacheWriteInputTokens
    ? Math.min(Math.max(0, inputTokens - cachedInputTokens), cacheWriteValue)
    : 0;
  const outputTokens = nonNegativeNumber(record["output_tokens"]);
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    hasCacheWriteInputTokens,
    outputTokens,
  };
}

function snapshotDelta(current: UsageSnapshot, previous: UsageSnapshot | null): TokenBreakdown {
  const reset =
    previous === null ||
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.cacheWriteInputTokens < previous.cacheWriteInputTokens ||
    current.outputTokens < previous.outputTokens;
  const inputTokens = reset ? current.inputTokens : current.inputTokens - previous.inputTokens;
  const cachedInputTokens = reset
    ? current.cachedInputTokens
    : current.cachedInputTokens - previous.cachedInputTokens;
  const cacheWriteInputTokens = reset
    ? current.cacheWriteInputTokens
    : current.cacheWriteInputTokens - previous.cacheWriteInputTokens;
  const outputTokens = reset ? current.outputTokens : current.outputTokens - previous.outputTokens;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens);
  return {
    cachedInputTokens,
    ...(current.hasCacheWriteInputTokens || previous?.hasCacheWriteInputTokens === true
      ? { cacheWriteInputTokens }
      : {}),
    uncachedInputTokens,
    outputTokens,
    totalTokens: cachedInputTokens + cacheWriteInputTokens + uncachedInputTokens + outputTokens,
  };
}

function nestedParentThreadId(meta: Record<string, unknown>): string | null {
  const source = asRecord(meta["source"]);
  const subagent = asRecord(source?.["subagent"]);
  const threadSpawn = asRecord(subagent?.["thread_spawn"]);
  return nonEmptyString(threadSpawn?.["parent_thread_id"]);
}

/** Parse one Codex rollout JSONL file without performing filesystem I/O. */
export function parseSessionJsonl(text: string, filePath = "<memory>"): SessionThread | null {
  let id: string | null = null;
  let sessionId: string | null = null;
  let parentThreadId: string | null = null;
  let agentRole: string | null = null;
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;
  let currentModel: string | null = null;
  let previousSnapshot: UsageSnapshot | null = null;
  let malformedLineCount = 0;
  let turnCount = 0;
  const modelNames = new Set<string>();
  const tokensByModel = new Map<string, TokenBreakdown>();

  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    const row = asRecord(parsed);
    if (row === null) {
      malformedLineCount += 1;
      continue;
    }
    const rowTimestamp = timestampMs(row["timestamp"]);
    if (rowTimestamp !== null) {
      startedAtMs = startedAtMs === null ? rowTimestamp : Math.min(startedAtMs, rowTimestamp);
      endedAtMs = endedAtMs === null ? rowTimestamp : Math.max(endedAtMs, rowTimestamp);
    }
    const payload = asRecord(row["payload"]);
    if (payload === null) {
      continue;
    }

    if (row["type"] === "session_meta") {
      id = nonEmptyString(payload["id"]) ?? nonEmptyString(payload["session_id"]) ?? id;
      sessionId = nonEmptyString(payload["session_id"]) ?? sessionId;
      parentThreadId =
        nonEmptyString(payload["parent_thread_id"]) ??
        nestedParentThreadId(payload) ??
        parentThreadId;
      agentRole = nonEmptyString(payload["agent_role"]) ?? agentRole;
      const metaTimestamp = timestampMs(payload["timestamp"]);
      if (metaTimestamp !== null) {
        startedAtMs = startedAtMs === null ? metaTimestamp : Math.min(startedAtMs, metaTimestamp);
      }
      const metaModel = nonEmptyString(payload["model"]);
      if (metaModel !== null) {
        currentModel = metaModel;
        modelNames.add(metaModel);
      }
      continue;
    }

    if (row["type"] === "turn_context") {
      turnCount += 1;
      const model = nonEmptyString(payload["model"]);
      if (model !== null) {
        currentModel = model;
        modelNames.add(model);
      }
      continue;
    }

    if (row["type"] !== "event_msg" || payload["type"] !== "token_count") {
      continue;
    }
    const info = asRecord(payload["info"]);
    const snapshot = snapshotFromRecord(info?.["total_token_usage"]);
    if (snapshot === null) {
      continue;
    }
    const delta = snapshotDelta(snapshot, previousSnapshot);
    previousSnapshot = snapshot;
    const model = currentModel ?? UNKNOWN_MODEL;
    const aggregate = tokensByModel.get(model) ?? zeroTokens();
    addTokens(aggregate, delta);
    tokensByModel.set(model, aggregate);
  }

  if (id === null) {
    return null;
  }
  sessionId ??= id;

  if (tokensByModel.has(UNKNOWN_MODEL) && modelNames.size === 1) {
    const onlyModel = [...modelNames][0];
    const unknownTokens = tokensByModel.get(UNKNOWN_MODEL);
    if (onlyModel !== undefined && unknownTokens !== undefined) {
      const aggregate = tokensByModel.get(onlyModel) ?? zeroTokens();
      addTokens(aggregate, unknownTokens);
      tokensByModel.set(onlyModel, aggregate);
      tokensByModel.delete(UNKNOWN_MODEL);
    }
  }

  const serializedByModel: Record<string, TokenBreakdown> = {};
  const tokens = zeroTokens();
  for (const model of [...tokensByModel.keys()].sort()) {
    const usage = tokensByModel.get(model);
    if (usage === undefined) {
      continue;
    }
    serializedByModel[model] = cloneTokens(usage);
    addTokens(tokens, usage);
  }

  return {
    filePath,
    id,
    sessionId,
    parentThreadId,
    agentRole,
    modelNames: [...modelNames].sort(),
    startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    endedAt: endedAtMs === null ? null : new Date(endedAtMs).toISOString(),
    elapsedMs:
      startedAtMs === null || endedAtMs === null ? 0 : Math.max(0, endedAtMs - startedAtMs),
    turnCount,
    tokens,
    tokensByModel: serializedByModel,
    malformedLineCount,
  };
}

/** Recursively find session JSONL files in stable lexical order. */
export function discoverSessionFiles(roots: readonly string[]): string[] {
  const files: string[] = [];
  const directories = [...roots];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) {
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) {
          directories.push(path);
        } else if (stat.isFile() && name.endsWith(".jsonl")) {
          files.push(path);
        }
      } catch {
        // A concurrently archived or deleted session can disappear during the scan.
      }
    }
  }
  return files.sort();
}

function preferMoreCompleteThread(left: SessionThread, right: SessionThread): SessionThread {
  if (right.tokens.totalTokens !== left.tokens.totalTokens) {
    return right.tokens.totalTokens > left.tokens.totalTokens ? right : left;
  }
  const leftEnd = timestampMs(left.endedAt) ?? 0;
  const rightEnd = timestampMs(right.endedAt) ?? 0;
  if (rightEnd !== leftEnd) {
    return rightEnd > leftEnd ? right : left;
  }
  return right.filePath > left.filePath ? right : left;
}

/** Remove duplicate active/archive copies of the same Codex thread. */
export function deduplicateSessionThreads(threads: readonly SessionThread[]): SessionThread[] {
  const byId = new Map<string, SessionThread>();
  for (const thread of threads) {
    const existing = byId.get(thread.id);
    byId.set(
      thread.id,
      existing === undefined ? thread : preferMoreCompleteThread(existing, thread),
    );
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Load both active and archived Codex rollout files below a CODEX_HOME directory. */
export function loadCodexSessionThreads(codexHome: string): SessionThread[] {
  const files = discoverSessionFiles([
    join(codexHome, "sessions"),
    join(codexHome, "archived_sessions"),
  ]);
  const threads: SessionThread[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSessionJsonl(content, file);
    if (parsed !== null) {
      threads.push(parsed);
    }
  }
  return deduplicateSessionThreads(threads);
}

function readFirstJsonlLine(file: string): string | null {
  const handle = openSync(file, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesReadTotal = 0;
  try {
    while (bytesReadTotal < 4 * 1024 * 1024) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      const length = newline === -1 ? bytesRead : newline;
      chunks.push(Buffer.from(buffer.subarray(0, length)));
      bytesReadTotal += length;
      if (newline !== -1) {
        break;
      }
    }
  } finally {
    closeSync(handle);
  }
  return chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8").replace(/\r$/u, "");
}

function threadIsInTree(
  thread: SessionThread,
  rootId: string,
  byId: ReadonlyMap<string, SessionThread>,
): boolean {
  if (thread.id === rootId || thread.sessionId === rootId) {
    return true;
  }
  let cursor = thread.parentThreadId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === rootId) {
      return true;
    }
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentThreadId ?? null;
  }
  return false;
}

/** Select a root and every descendant, including nested descendants. */
export function selectSessionTree(
  threads: readonly SessionThread[],
  rootId: string,
): SessionThread[] {
  const unique = deduplicateSessionThreads(threads);
  const byId = new Map(unique.map((thread) => [thread.id, thread]));
  return unique
    .filter((thread) => threadIsInTree(thread, rootId, byId))
    .sort((left, right) => {
      const timeOrder = (timestampMs(left.startedAt) ?? 0) - (timestampMs(right.startedAt) ?? 0);
      return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
    });
}

/**
 * Load only the requested trees. The metadata-first pass avoids parsing every historical
 * rollout in full when the CLI is comparing one or two known roots.
 */
export function loadCodexSessionTrees(
  codexHome: string,
  rootIds: readonly string[],
): SessionThread[] {
  const requestedRoots = [...new Set(rootIds.filter((rootId) => rootId.length > 0))];
  if (requestedRoots.length === 0) {
    return [];
  }
  const files = discoverSessionFiles([
    join(codexHome, "sessions"),
    join(codexHome, "archived_sessions"),
  ]);
  const metadata: SessionThread[] = [];
  for (const file of files) {
    try {
      const firstLine = readFirstJsonlLine(file);
      const parsed = firstLine === null ? null : parseSessionJsonl(firstLine, file);
      if (parsed !== null) {
        metadata.push(parsed);
      }
    } catch {
      continue;
    }
  }
  const uniqueMetadata = deduplicateSessionThreads(metadata);
  const byId = new Map(uniqueMetadata.map((thread) => [thread.id, thread]));
  const selectedFiles = metadata
    .filter((thread) => requestedRoots.some((rootId) => threadIsInTree(thread, rootId, byId)))
    .map((thread) => thread.filePath);
  const selected: SessionThread[] = [];
  for (const file of selectedFiles) {
    try {
      const parsed = parseSessionJsonl(readFileSync(file, "utf8"), file);
      if (parsed !== null) {
        selected.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return deduplicateSessionThreads(selected);
}

function resolveNaturalRoot(
  thread: SessionThread,
  byId: ReadonlyMap<string, SessionThread>,
): string {
  if (thread.sessionId !== thread.id) {
    return thread.sessionId;
  }
  let rootId = thread.id;
  let cursor = thread.parentThreadId;
  const seen = new Set<string>([thread.id]);
  while (cursor !== null && !seen.has(cursor)) {
    rootId = cursor;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentThreadId ?? null;
  }
  return rootId;
}

/** Group every loaded thread into its natural root session tree. */
export function groupSessionTrees(threads: readonly SessionThread[]): Map<string, SessionThread[]> {
  const unique = deduplicateSessionThreads(threads);
  const byId = new Map(unique.map((thread) => [thread.id, thread]));
  const grouped = new Map<string, SessionThread[]>();
  for (const thread of unique) {
    const rootId = resolveNaturalRoot(thread, byId);
    const group = grouped.get(rootId) ?? [];
    group.push(thread);
    grouped.set(rootId, group);
  }
  return new Map(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rootId, group]) => [rootId, selectSessionTree(group, rootId)]),
  );
}

export function classifyModelTier(
  model: string | null,
  agentRole: string | null = null,
): ModelTier {
  const normalizedModel = (model ?? "").toLowerCase();
  if (normalizedModel.includes("sol")) {
    return "sol";
  }
  if (normalizedModel.includes("terra")) {
    return "terra";
  }
  if (normalizedModel.includes("luna")) {
    return "luna";
  }
  if (normalizedModel.length > 0 && normalizedModel !== UNKNOWN_MODEL) {
    return "other";
  }
  const normalizedRole = (agentRole ?? "").toLowerCase();
  if (normalizedRole.includes("sol")) {
    return "sol";
  }
  if (normalizedRole.includes("terra")) {
    return "terra";
  }
  if (normalizedRole.includes("luna")) {
    return "luna";
  }
  return "other";
}

function priceNumber(record: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

/** Validate a JSON-compatible model price table and normalize common key aliases. */
export function parseModelPrices(value: unknown): ModelPriceTable {
  const outer = asRecord(value);
  if (outer === null) {
    throw new Error("Model prices must be a JSON object.");
  }
  const wrappedModels = asRecord(outer["models"]);
  const entries = wrappedModels ?? outer;
  const result: ModelPriceTable = {};
  for (const [model, rawPrice] of Object.entries(entries)) {
    const price = asRecord(rawPrice);
    if (price === null) {
      throw new Error(`Price for '${model}' must be an object.`);
    }
    const uncachedInputPerMillion = priceNumber(price, [
      "uncachedInputPerMillion",
      "uncachedInput",
      "uncached_input_per_million",
      "uncached_input",
      "inputPerMillionUsd",
      "input",
    ]);
    const cachedInputPerMillion = priceNumber(price, [
      "cachedInputPerMillion",
      "cachedInput",
      "cached_input_per_million",
      "cached_input",
      "cachedInputPerMillionUsd",
    ]);
    const cacheWriteInputPerMillion = priceNumber(price, [
      "cacheWriteInputPerMillion",
      "cacheWriteInput",
      "cache_write_input_per_million",
      "cache_write_input",
      "cache_write",
      "cacheWriteInputPerMillionUsd",
    ]);
    const outputPerMillion = priceNumber(price, [
      "outputPerMillion",
      "output",
      "output_per_million",
      "outputPerMillionUsd",
    ]);
    if (
      uncachedInputPerMillion === null ||
      cachedInputPerMillion === null ||
      outputPerMillion === null
    ) {
      throw new Error(
        `Price for '${model}' must define non-negative uncached input, cached input, and output rates per million tokens.`,
      );
    }
    result[model] = {
      uncachedInputPerMillion,
      cachedInputPerMillion,
      ...(cacheWriteInputPerMillion === null ? {} : { cacheWriteInputPerMillion }),
      outputPerMillion,
    };
  }
  return result;
}

function lookupPrice(prices: ModelPriceTable, model: string, tier: ModelTier): ModelPrice | null {
  return (
    prices[model] ??
    prices[model.toLowerCase()] ??
    prices[tier] ??
    prices["default"] ??
    prices["*"] ??
    null
  );
}

/** Estimate cost in the same currency used by the supplied per-million rates. */
export function estimateModelCost(
  tokensByModel: Readonly<Record<string, TokenBreakdown>>,
  prices: ModelPriceTable,
): CostEstimate {
  const byModel: Record<string, number> = {};
  const unpricedModels: string[] = [];
  let total = 0;
  for (const model of Object.keys(tokensByModel).sort()) {
    const tokens = tokensByModel[model];
    if (tokens === undefined || tokens.totalTokens === 0) {
      continue;
    }
    const price = lookupPrice(prices, model, classifyModelTier(model));
    if (price === null) {
      unpricedModels.push(model);
      continue;
    }
    const cost =
      (tokens.uncachedInputTokens * price.uncachedInputPerMillion +
        tokens.cachedInputTokens * price.cachedInputPerMillion +
        (tokens.cacheWriteInputTokens ?? 0) *
          (price.cacheWriteInputPerMillion ?? price.uncachedInputPerMillion) +
        tokens.outputTokens * price.outputPerMillion) /
      1_000_000;
    byModel[model] = cost;
    total += cost;
  }
  return { total, byModel, unpricedModels, complete: unpricedModels.length === 0 };
}

/** Summarize a selected root and all descendants into performance metrics. */
export function summarizeSessionTree(
  rootId: string,
  threads: readonly SessionThread[],
  prices: ModelPriceTable | null = null,
): SessionMetrics {
  const selected = selectSessionTree(threads, rootId);
  if (selected.length === 0) {
    throw new Error(`No Codex session tree found for root '${rootId}'.`);
  }
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;
  const tokens = zeroTokens();
  const tokensByTier = zeroTierTokens();
  const tokensByModel: Record<string, TokenBreakdown> = {};
  const modelNames = new Set<string>();
  const rootThread =
    selected.find((thread) => thread.id === rootId) ??
    selected.find((thread) => thread.sessionId === rootId && thread.parentThreadId === null) ??
    selected[0];
  const rootAliases = new Set([rootId, rootThread?.id].filter((id) => id !== undefined));
  const directChildren = selected.filter(
    (thread) => thread.parentThreadId !== null && rootAliases.has(thread.parentThreadId),
  );
  const directStarts = directChildren
    .map((thread) => timestampMs(thread.startedAt))
    .filter((value): value is number => value !== null);
  const directEnds = directChildren
    .map((thread) => timestampMs(thread.endedAt))
    .filter((value): value is number => value !== null);
  const directChildElapsedMs = directChildren.reduce(
    (total, thread) => total + thread.elapsedMs,
    0,
  );
  const directChildParallelIntervalMs =
    directStarts.length === 0 || directEnds.length === 0
      ? 0
      : Math.max(...directEnds) - Math.min(...directStarts);

  for (const thread of selected) {
    const threadStart = timestampMs(thread.startedAt);
    const threadEnd = timestampMs(thread.endedAt);
    if (threadStart !== null) {
      startedAtMs = startedAtMs === null ? threadStart : Math.min(startedAtMs, threadStart);
    }
    if (threadEnd !== null) {
      endedAtMs = endedAtMs === null ? threadEnd : Math.max(endedAtMs, threadEnd);
    }
    for (const model of thread.modelNames) {
      modelNames.add(model);
    }
    for (const [model, modelTokens] of Object.entries(thread.tokensByModel)) {
      const aggregate = tokensByModel[model] ?? zeroTokens();
      addTokens(aggregate, modelTokens);
      tokensByModel[model] = aggregate;
      addTokens(tokens, modelTokens);
      const tier = classifyModelTier(model === UNKNOWN_MODEL ? null : model, thread.agentRole);
      addTokens(tokensByTier[tier], modelTokens);
    }
  }

  const orderedTokensByModel: Record<string, TokenBreakdown> = {};
  for (const model of Object.keys(tokensByModel).sort()) {
    const usage = tokensByModel[model];
    if (usage !== undefined) {
      orderedTokensByModel[model] = cloneTokens(usage);
    }
  }

  return {
    rootId,
    threadCount: selected.length,
    threadIds: selected.map((thread) => thread.id),
    startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    endedAt: endedAtMs === null ? null : new Date(endedAtMs).toISOString(),
    elapsedMs:
      startedAtMs === null || endedAtMs === null ? 0 : Math.max(0, endedAtMs - startedAtMs),
    rootTurnCount: rootThread?.turnCount ?? 0,
    totalTurnCount: selected.reduce((total, thread) => total + thread.turnCount, 0),
    directChildCount: directChildren.length,
    directChildLaunchSkewMs:
      directStarts.length < 2 ? null : Math.max(...directStarts) - Math.min(...directStarts),
    directChildElapsedMs,
    directChildParallelIntervalMs,
    directChildEffectiveParallelism: finiteRatio(
      directChildElapsedMs,
      directChildParallelIntervalMs,
    ),
    modelNames: [...modelNames].sort(),
    tokens,
    tokensByTier,
    tokensByModel: orderedTokensByModel,
    estimatedCost: prices === null ? null : estimateModelCost(orderedTokensByModel, prices),
  };
}

function finiteRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : null;
}

/** Compare a candidate tree with a direct or historical baseline tree. */
export function compareSessionMetrics(
  candidate: SessionMetrics,
  baseline: SessionMetrics,
): MetricsComparison {
  return {
    speedRatio: finiteRatio(baseline.elapsedMs, candidate.elapsedMs),
    tokenRatio: finiteRatio(candidate.tokens.totalTokens, baseline.tokens.totalTokens),
    solTokenRatio: finiteRatio(
      candidate.tokensByTier.sol.totalTokens,
      baseline.tokensByTier.sol.totalTokens,
    ),
    costRatio:
      candidate.estimatedCost === null || baseline.estimatedCost === null
        ? null
        : finiteRatio(candidate.estimatedCost.total, baseline.estimatedCost.total),
  };
}

function requireArgument(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseMetricsArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): ParsedMetricsArguments {
  let rootId: string | null = null;
  let baselineRootId: string | null = null;
  let codexHome = environment["CODEX_HOME"] ?? join(environment["HOME"] ?? homedir(), ".codex");
  let pricePath: string | null = null;
  let pretty = true;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--root") {
      rootId = requireArgument(argv, ++index, argument);
    } else if (argument === "--baseline") {
      baselineRootId = requireArgument(argv, ++index, argument);
    } else if (argument === "--codex-home") {
      codexHome = requireArgument(argv, ++index, argument);
    } else if (argument === "--prices") {
      pricePath = requireArgument(argv, ++index, argument);
    } else if (argument === "--compact") {
      pretty = false;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (!argument.startsWith("-") && rootId === null) {
      rootId = argument;
    } else {
      throw new Error(`Unknown metrics argument '${argument}'.`);
    }
  }
  if (baselineRootId !== null && rootId === null) {
    throw new Error("--baseline requires --root (or a positional root id).");
  }
  return { rootId, baselineRootId, codexHome: resolve(codexHome), pricePath, pretty, help };
}

function usageText(): string {
  return [
    "Usage: npm run metrics -- [ROOT_ID] [options]",
    "",
    "Options:",
    "  --root ID           Session root to summarize",
    "  --baseline ID       Baseline root used for speed/token ratios",
    "  --codex-home PATH   Codex home (default: CODEX_HOME or ~/.codex)",
    "  --prices FILE       JSON model prices per million tokens",
    "  --compact           Emit compact JSON",
    "  -h, --help          Show this help",
    "",
    "Price fields: uncachedInputPerMillion, cachedInputPerMillion, cacheWriteInputPerMillion (optional), outputPerMillion",
  ].join("\n");
}

export function runMetricsCli(
  argv: readonly string[] = process.argv.slice(2),
  io: MetricsCliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  environment: NodeJS.ProcessEnv = process.env,
): number {
  try {
    const options = parseMetricsArguments(argv, environment);
    if (options.help) {
      io.stdout(`${usageText()}\n`);
      return 0;
    }
    const prices =
      options.pricePath === null
        ? null
        : parseModelPrices(JSON.parse(readFileSync(options.pricePath, "utf8")) as unknown);
    const requestedRoots =
      options.rootId === null
        ? []
        : [options.rootId, ...(options.baselineRootId === null ? [] : [options.baselineRootId])];
    const threads =
      requestedRoots.length === 0
        ? loadCodexSessionThreads(options.codexHome)
        : loadCodexSessionTrees(options.codexHome, requestedRoots);
    let output: unknown;
    if (options.rootId === null) {
      const trees = [...groupSessionTrees(threads).entries()].map(([rootId, group]) =>
        summarizeSessionTree(rootId, group, prices),
      );
      output = { codexHome: options.codexHome, trees };
    } else {
      const target = summarizeSessionTree(options.rootId, threads, prices);
      const baseline =
        options.baselineRootId === null
          ? null
          : summarizeSessionTree(options.baselineRootId, threads, prices);
      output = {
        codexHome: options.codexHome,
        target,
        baseline,
        comparison: baseline === null ? null : compareSessionMetrics(target, baseline),
      };
    }
    io.stdout(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`metrics: ${message}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  process.exitCode = runMetricsCli();
}
