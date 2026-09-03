import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppServer, AppServerNotification, JsonValue } from "../app-server/types.js";
import type { JobStore } from "../core/job-store.js";
import type { RemoteTurnRef } from "../core/contracts.js";
import type { MonitorEvent, MonitorRecorderPort } from "./types.js";

const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_PENDING_BYTES = 512 * 1024;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_STRING_BYTES = 12 * 1024;
const MAX_DELTA_CHUNK_BYTES = 8 * 1024;
const MAX_DELTA_STREAMS = 32;
const MAX_TRACKED_DELTA_ITEMS = 2_048;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_JSON_DEPTH = 10;

interface RunBuffer {
  lines: BufferedLine[];
  bufferedBytes: number;
  pendingBytes: number;
  writtenBytes: number | null;
  flushTimer: NodeJS.Timeout | null;
  chain: Promise<void>;
  capped: boolean;
  dropped: number;
}

interface BufferedLine {
  event: MonitorEvent;
  line: string;
  bytes: number;
}

interface ThreadContext {
  runId: string;
  role: RemoteTurnRef["role"];
  taskId?: string;
}

interface DeltaStream {
  runId: string;
  itemKey: string;
  event: MonitorEvent;
  delta: string;
  timer: NodeJS.Timeout;
}

export interface MonitorRecorderOptions {
  flushMs?: number;
  maxPendingBytes?: number;
  maxLogBytes?: number;
  now?: () => Date;
}

/** Records already-produced App Server events without adding model turns or synchronous I/O. */
export class MonitorRecorder implements MonitorRecorderPort {
  readonly #store: JobStore;
  readonly #flushMs: number;
  readonly #maxPendingBytes: number;
  readonly #maxLogBytes: number;
  readonly #now: () => Date;
  readonly #threads = new Map<string, ThreadContext>();
  readonly #servers = new WeakSet<AppServer>();
  readonly #unsubscribers = new Set<() => void>();
  readonly #buffers = new Map<string, RunBuffer>();
  readonly #deltaStreams = new Map<string, DeltaStream>();
  readonly #itemsWithDeltas = new Set<string>();
  #closed = false;

  constructor(store: JobStore, options: MonitorRecorderOptions = {}) {
    this.#store = store;
    this.#flushMs = positiveInteger(options.flushMs ?? DEFAULT_FLUSH_MS, "flushMs");
    this.#maxPendingBytes = positiveInteger(
      options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      "maxPendingBytes",
    );
    this.#maxLogBytes = positiveInteger(
      options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
      "maxLogBytes",
    );
    this.#now = options.now ?? (() => new Date());
  }

  attach(server: AppServer): void {
    if (this.#closed || this.#servers.has(server)) {
      return;
    }
    this.#servers.add(server);
    const unsubscribe = server.onNotification((notification) => {
      this.#capture(notification);
    });
    this.#unsubscribers.add(unsubscribe);
  }

  recordRemoteTurn(runId: string, turn: RemoteTurnRef): void {
    if (this.#closed) {
      return;
    }
    this.#threads.set(turn.threadId, {
      runId,
      role: turn.role,
      ...(turn.taskId === undefined ? {} : { taskId: turn.taskId }),
    });
    this.#enqueue(runId, {
      type: "remote_turn",
      at: turn.updatedAt,
      role: turn.role,
      ...(turn.taskId === undefined ? {} : { taskId: turn.taskId }),
      threadId: turn.threadId,
      turnId: turn.turnId,
      data: {
        state: turn.state,
        access: turn.access,
        ...(turn.attempt === undefined ? {} : { attempt: turn.attempt }),
        ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      },
    });
  }

  recordNotification(runId: string, notification: AppServerNotification): void {
    if (this.#closed) {
      return;
    }
    const params = jsonSafe(notification.params);
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const context = threadId === undefined ? undefined : this.#threads.get(threadId);
    this.#recordAppServerEvent(runId, notification, params, context, threadId, turnId);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribers) {
      unsubscribe();
    }
    this.#unsubscribers.clear();
    for (const key of [...this.#deltaStreams.keys()]) {
      this.#flushDelta(key);
    }
    await Promise.all([...this.#buffers.keys()].map(async (runId) => this.#flush(runId)));
    await Promise.all([...this.#buffers.values()].map(async (buffer) => buffer.chain));
    this.#buffers.clear();
    this.#deltaStreams.clear();
    this.#itemsWithDeltas.clear();
    this.#threads.clear();
  }

  #capture(notification: AppServerNotification): void {
    const params = jsonSafe(notification.params);
    const threadId = extractThreadId(params);
    if (threadId === undefined) {
      return;
    }
    const context = this.#threads.get(threadId);
    if (context === undefined) {
      return;
    }
    const turnId = extractTurnId(params);
    this.#recordAppServerEvent(context.runId, notification, params, context, threadId, turnId);
  }

  #recordAppServerEvent(
    runId: string,
    notification: AppServerNotification,
    params: JsonValue | undefined,
    context: ThreadContext | undefined,
    threadId: string | undefined,
    turnId: string | undefined,
  ): void {
    let event: MonitorEvent = {
      type: "app_server",
      at: timestamp(notification.emittedAtMs, this.#now),
      ...(context === undefined ? {} : { role: context.role }),
      ...(context?.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(turnId === undefined ? {} : { turnId }),
      method: notification.method,
      data: params,
    };
    if (notificationIsDeltaMethod(notification.method)) {
      this.#appendDelta(runId, event);
      return;
    }
    const itemKey = monitorItemKey(runId, event);
    this.#flushRelatedDeltas(runId, event, itemKey);
    if (
      event.method === "item/completed" &&
      itemKey !== undefined &&
      this.#itemsWithDeltas.delete(itemKey)
    ) {
      event = completionWithoutRepeatedDelta(event);
    }
    this.#enqueue(runId, event);
  }

  #appendDelta(runId: string, event: MonitorEvent): void {
    const itemKey = monitorItemKey(runId, event);
    const delta = monitorDelta(event);
    if (itemKey === undefined || delta === undefined || event.method === undefined) {
      return;
    }
    const key = `${itemKey}\u0000${event.method}`;
    const existing = this.#deltaStreams.get(key);
    if (existing !== undefined) {
      this.#trackDeltaItem(itemKey);
      existing.delta += delta;
      existing.event.at = event.at;
      if (Buffer.byteLength(existing.delta, "utf8") >= MAX_DELTA_CHUNK_BYTES) {
        this.#flushDelta(key);
      }
      return;
    }
    if (this.#deltaStreams.size >= MAX_DELTA_STREAMS) {
      return;
    }
    const itemId = monitorItemId(event.data);
    if (itemId === undefined) {
      return;
    }
    this.#trackDeltaItem(itemKey);
    const timer = setTimeout(() => this.#flushDelta(key), this.#flushMs);
    timer.unref();
    this.#deltaStreams.set(key, {
      runId,
      itemKey,
      event: { ...event, data: { itemId, delta: "" } },
      delta,
      timer,
    });
    if (Buffer.byteLength(delta, "utf8") >= MAX_DELTA_CHUNK_BYTES) {
      this.#flushDelta(key);
    }
  }

  #trackDeltaItem(itemKey: string): void {
    if (
      !this.#itemsWithDeltas.has(itemKey) &&
      this.#itemsWithDeltas.size >= MAX_TRACKED_DELTA_ITEMS
    ) {
      const oldest = this.#itemsWithDeltas.values().next().value as string | undefined;
      if (oldest !== undefined) {
        this.#itemsWithDeltas.delete(oldest);
      }
    }
    this.#itemsWithDeltas.add(itemKey);
  }

  #flushRelatedDeltas(runId: string, event: MonitorEvent, itemKey: string | undefined): void {
    const completesTurn = event.method === "turn/completed";
    for (const [key, stream] of this.#deltaStreams) {
      if (
        stream.runId === runId &&
        (stream.itemKey === itemKey ||
          (completesTurn &&
            stream.event.threadId === event.threadId &&
            stream.event.turnId === event.turnId))
      ) {
        this.#flushDelta(key);
      }
    }
  }

  #flushDelta(key: string): void {
    const stream = this.#deltaStreams.get(key);
    if (stream === undefined) {
      return;
    }
    clearTimeout(stream.timer);
    this.#deltaStreams.delete(key);
    this.#enqueue(stream.runId, {
      ...stream.event,
      data: {
        ...(isJsonRecord(stream.event.data) ? stream.event.data : {}),
        delta: stream.delta,
      },
    });
  }

  #enqueue(runId: string, event: MonitorEvent): void {
    const buffer = this.#bufferFor(runId);
    if (buffer.capped) {
      buffer.dropped += 1;
      return;
    }
    const line = boundedEventLine(event);
    const bytes = Buffer.byteLength(line, "utf8");
    if (buffer.pendingBytes + bytes > this.#maxPendingBytes) {
      buffer.dropped += 1;
      void this.#flush(runId);
    }
    buffer.lines.push({ event, line, bytes });
    buffer.bufferedBytes += bytes;
    buffer.pendingBytes += bytes;
    this.#scheduleFlush(runId, buffer);
  }

  #scheduleFlush(runId: string, buffer: RunBuffer): void {
    if (buffer.bufferedBytes >= 256 * 1024) {
      void this.#flush(runId);
      return;
    }
    if (buffer.flushTimer === null) {
      buffer.flushTimer = setTimeout(() => void this.#flush(runId), this.#flushMs);
      buffer.flushTimer.unref();
    }
  }

  #bufferFor(runId: string): RunBuffer {
    const existing = this.#buffers.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const created: RunBuffer = {
      lines: [],
      bufferedBytes: 0,
      pendingBytes: 0,
      writtenBytes: null,
      flushTimer: null,
      chain: Promise.resolve(),
      capped: false,
      dropped: 0,
    };
    this.#buffers.set(runId, created);
    return created;
  }

  async #flush(runId: string): Promise<void> {
    const buffer = this.#buffers.get(runId);
    if (buffer === undefined || buffer.lines.length === 0) {
      return buffer?.chain;
    }
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = null;
    }
    const lines = buffer.lines;
    const bytes = buffer.bufferedBytes;
    buffer.lines = [];
    buffer.bufferedBytes = 0;
    const path = join(this.#store.jobDirectory(runId), "monitor.jsonl");
    buffer.chain = buffer.chain
      .then(async () => {
        await mkdir(this.#store.jobDirectory(runId), { recursive: true, mode: 0o700 });
        buffer.writtenBytes ??= await fileSize(path);
        if (buffer.writtenBytes >= this.#maxLogBytes) {
          buffer.capped = true;
          return;
        }
        const remaining = this.#maxLogBytes - buffer.writtenBytes;
        let payload = "";
        let payloadBytes = 0;
        for (const entry of lines) {
          if (payloadBytes + entry.bytes > remaining) {
            buffer.capped = true;
            break;
          }
          payload += entry.line;
          payloadBytes += entry.bytes;
        }
        if (payload.length === 0) {
          return;
        }
        const handle = await open(path, "a", 0o600);
        try {
          await handle.writeFile(payload, "utf8");
        } finally {
          await handle.close();
        }
        buffer.writtenBytes += payloadBytes;
      })
      .catch(() => undefined)
      .finally(() => {
        buffer.pendingBytes = Math.max(0, buffer.pendingBytes - bytes);
      });
    return buffer.chain;
  }
}

function boundedEventLine(event: MonitorEvent): string {
  let line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES) {
    return line;
  }
  const serializedData = JSON.stringify(event.data) ?? "";
  let previewBytes = Math.floor(MAX_EVENT_BYTES / 2);
  while (previewBytes > 0) {
    line = `${JSON.stringify({
      ...event,
      data: {
        truncated: true,
        preview: truncateUtf8(serializedData, previewBytes),
      },
    })}\n`;
    if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES) {
      return line;
    }
    previewBytes = Math.floor(previewBytes / 2);
  }
  return `${JSON.stringify({ ...event, data: { truncated: true } })}\n`;
}

function jsonSafe(value: unknown, depth = 0): JsonValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) || typeof value !== "number" ? value : String(value);
  }
  if (typeof value === "string") {
    return truncateUtf8(value, MAX_STRING_BYTES);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= MAX_JSON_DEPTH) {
    return "[depth limited]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => jsonSafe(item, depth + 1) ?? null) as JsonValue[];
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const normalized = jsonSafe(item, depth + 1);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  }
  return String(value);
}

function extractThreadId(value: JsonValue | undefined): string | undefined {
  return extractId(value, "threadId", "thread");
}

function extractTurnId(value: JsonValue | undefined): string | undefined {
  return extractId(value, "turnId", "turn");
}

function extractId(
  value: JsonValue | undefined,
  directKey: "threadId" | "turnId",
  objectKey: "thread" | "turn",
): string | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  const direct = value[directKey];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const nested = value[objectKey];
  if (nested !== null && !Array.isArray(nested) && typeof nested === "object") {
    const id = nested["id"];
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  for (const item of Object.values(value)) {
    const found = extractId(item, directKey, objectKey);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function notificationIsDeltaMethod(method: string): boolean {
  return method.toLowerCase().endsWith("delta");
}

function monitorItemKey(runId: string, event: MonitorEvent): string | undefined {
  const itemId = monitorItemId(event.data);
  return itemId === undefined
    ? undefined
    : [runId, event.threadId ?? "", event.turnId ?? "", itemId].join("\u0000");
}

function monitorItemId(value: unknown): string | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  if (typeof value["itemId"] === "string" && value["itemId"].length > 0) {
    return value["itemId"];
  }
  const item = value["item"];
  return isJsonRecord(item) && typeof item["id"] === "string" && item["id"].length > 0
    ? item["id"]
    : undefined;
}

function monitorDelta(event: MonitorEvent): string | undefined {
  return isJsonRecord(event.data) && typeof event.data["delta"] === "string"
    ? event.data["delta"]
    : undefined;
}

function completionWithoutRepeatedDelta(event: MonitorEvent): MonitorEvent {
  if (event.method !== "item/completed" || !isJsonRecord(event.data)) {
    return event;
  }
  const item = event.data["item"];
  if (!isJsonRecord(item)) {
    return event;
  }
  const compactItem = { ...item };
  switch (compactItem["type"]) {
    case "agentMessage":
      delete compactItem["text"];
      break;
    case "reasoning":
      delete compactItem["content"];
      break;
    case "commandExecution":
      delete compactItem["aggregatedOutput"];
      break;
  }
  return { ...event, data: { ...event.data, item: compactItem } };
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(emittedAtMs: number | undefined, now: () => Date): string {
  return emittedAtMs === undefined || !Number.isFinite(emittedAtMs)
    ? now().toISOString()
    : new Date(emittedAtMs).toISOString();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - 3))
    .toString("utf8")}...`;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) {
      return 0;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
