import { existsSync, watch, type FSWatcher } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_JOB_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENT_CHUNK_BYTES = 512 * 1024;
const MAX_LONG_POLL_MS = 20_000;

export interface MonitorEventPage {
  events: unknown[];
  nextCursor: number;
  hasMore: boolean;
}

export interface MonitorDataQuery {
  cursor: number;
  afterRevision?: string;
  waitMs?: number;
  maxEventBytes?: number;
}

export interface MonitorDataUpdate extends MonitorEventPage {
  snapshot: unknown;
  revision: string;
}

export async function readJobSnapshot(jobRoot: string, runId: string): Promise<unknown> {
  const path = join(jobRoot, runId, "job.json");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_JOB_BYTES) {
    throw new Error("job snapshot is unavailable or too large for the monitor");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readMonitorEvents(
  jobRoot: string,
  runId: string,
  requestedCursor: number,
  maxBytes = DEFAULT_EVENT_CHUNK_BYTES,
): Promise<MonitorEventPage> {
  const path = join(jobRoot, runId, "monitor.jsonl");
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) {
      return { events: [], nextCursor: 0, hasMore: false };
    }
    throw error;
  }
  const cursor = requestedCursor > size ? 0 : requestedCursor;
  if (cursor === size) {
    return { events: [], nextCursor: cursor, hasMore: false };
  }
  const requestedLength = Math.min(positiveInteger(maxBytes, "maxEventBytes"), size - cursor);
  let chunk = await readChunk(path, cursor, requestedLength);
  let lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0 && requestedLength < size - cursor) {
    chunk = await readChunk(path, cursor, Math.min(DEFAULT_EVENT_CHUNK_BYTES, size - cursor));
    lastNewline = chunk.lastIndexOf(0x0a);
  }
  if (lastNewline < 0) {
    return { events: [], nextCursor: cursor, hasMore: true };
  }
  const consumed = lastNewline + 1;
  const events = coalesceEventPage(
    chunk
      .subarray(0, consumed)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      }),
  );
  const nextCursor = cursor + consumed;
  return { events, nextCursor, hasMore: nextCursor < size };
}

async function readChunk(path: string, cursor: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(length);
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, cursor);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readMonitorData(
  jobRoot: string,
  runId: string,
  query: MonitorDataQuery,
): Promise<MonitorDataUpdate> {
  const read = async (): Promise<MonitorDataUpdate> => {
    const [snapshot, page] = await Promise.all([
      readJobSnapshot(jobRoot, runId),
      readMonitorEvents(jobRoot, runId, query.cursor, query.maxEventBytes),
    ]);
    return { snapshot, revision: snapshotRevision(snapshot), ...page };
  };

  let update = await read();
  const waitMs = boundedWaitMs(query.waitMs ?? 0);
  if (waitMs === 0 || monitorDataChanged(update, query.afterRevision)) {
    return update;
  }

  const waiter = watchDirectoryChange(join(jobRoot, runId), waitMs);
  try {
    update = await read();
    if (monitorDataChanged(update, query.afterRevision)) {
      return update;
    }
    await waiter.changed;
    return await read();
  } finally {
    waiter.close();
  }
}

export function coalesceEventPage(events: unknown[]): unknown[] {
  const result: unknown[] = [];
  const streams = new Map<string, number>();
  for (const event of events) {
    const key = deltaEventKey(event);
    if (key === null) {
      result.push(event);
      continue;
    }
    const existingIndex = streams.get(key);
    if (existingIndex === undefined) {
      streams.set(key, result.length);
      result.push(event);
      continue;
    }
    const existing = result[existingIndex];
    if (!isRecord(existing) || !isRecord(existing["data"]) || !isRecord(event)) {
      result.push(event);
      continue;
    }
    const data = event["data"];
    if (!isRecord(data)) {
      result.push(event);
      continue;
    }
    const previousDelta = existing["data"]["delta"];
    const delta = data["delta"];
    if (typeof previousDelta !== "string" || typeof delta !== "string") {
      result.push(event);
      continue;
    }
    result[existingIndex] = {
      ...existing,
      at: event["at"] ?? existing["at"],
      data: { ...existing["data"], delta: previousDelta + delta },
    };
  }
  return result;
}

function watchDirectoryChange(
  directory: string,
  waitMs: number,
): { changed: Promise<void>; close(): void } {
  if (!existsSync(directory)) {
    return { changed: Promise.resolve(), close: () => undefined };
  }
  let watcher: FSWatcher | null = null;
  let close = (): void => undefined;
  const changed = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      watcher = null;
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    timer.unref();
    try {
      watcher = watch(directory, finish);
      watcher.once("error", finish);
    } catch {
      finish();
    }
    close = finish;
  });
  return { changed, close };
}

function monitorDataChanged(update: MonitorDataUpdate, afterRevision: string | undefined): boolean {
  return (
    update.events.length > 0 ||
    update.hasMore ||
    afterRevision === undefined ||
    update.revision !== afterRevision ||
    snapshotIsTerminal(update.snapshot)
  );
}

function snapshotRevision(value: unknown): string {
  return isRecord(value) && typeof value["updatedAt"] === "string" ? value["updatedAt"] : "";
}

function snapshotIsTerminal(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value["result"])) {
    return false;
  }
  return ["completed", "failed", "cancelled", "waiting_input", "indeterminate"].includes(
    String(value["result"]["status"] ?? ""),
  );
}

function deltaEventKey(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value["data"])) {
    return null;
  }
  const method = value["method"];
  const itemId = value["data"]["itemId"];
  if (
    typeof method !== "string" ||
    !method.toLowerCase().endsWith("delta") ||
    typeof itemId !== "string" ||
    itemId.length === 0
  ) {
    return null;
  }
  return [method, value["threadId"] ?? "", value["turnId"] ?? "", itemId].join("\u0000");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function boundedWaitMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LONG_POLL_MS) {
    throw new RangeError(`waitMs must be an integer between 0 and ${String(MAX_LONG_POLL_MS)}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
