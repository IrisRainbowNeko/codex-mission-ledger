import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { MONITOR_APP_JS, MONITOR_HTML, MONITOR_STYLES } from "./ui.js";

const MAX_JOB_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_CHUNK_BYTES = 512 * 1024;
const MAX_LISTED_RUNS = 100;

export interface MonitorServerOptions {
  jobRoot: string;
  token: string;
  port: number;
  host?: string;
}

export interface MonitorServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Local read-only dashboard server. It never calls a model or mutates a run. */
export async function startMonitorServer(options: MonitorServerOptions): Promise<MonitorServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handleRequest(options, request.url ?? "/", response).catch((error: unknown) => {
      if (!response.headersSent) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 30_000;
  await listen(server, options.port, host);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Agent Trio Monitor did not bind a TCP address");
  }
  return {
    host,
    port: address.port,
    close: async () => closeServer(server),
  };
}

async function handleRequest(
  options: MonitorServerOptions,
  rawUrl: string,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(rawUrl, `http://${options.host ?? "127.0.0.1"}`);
  if (url.pathname === "/assets/monitor.css") {
    text(response, 200, "text/css; charset=utf-8", MONITOR_STYLES, "public, max-age=3600");
    return;
  }
  if (url.pathname === "/assets/monitor.js") {
    text(response, 200, "text/javascript; charset=utf-8", MONITOR_APP_JS, "public, max-age=3600");
    return;
  }
  if (!authorized(url.searchParams.get("token"), options.token)) {
    json(response, 401, { error: "invalid monitor token" });
    return;
  }
  if (url.pathname === "/healthz") {
    json(response, 200, { ok: true, jobRoot: options.jobRoot });
    return;
  }
  if (url.pathname === "/" || /^\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(url.pathname)) {
    html(response, MONITOR_HTML);
    return;
  }
  if (url.pathname === "/api/runs") {
    json(response, 200, { runs: listRuns(options.jobRoot) });
    return;
  }
  const snapshotMatch = /^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/snapshot$/u.exec(
    url.pathname,
  );
  if (snapshotMatch !== null) {
    const runId = snapshotMatch[1]!;
    json(response, 200, await readJobSnapshot(options.jobRoot, runId));
    return;
  }
  const eventsMatch = /^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/events$/u.exec(
    url.pathname,
  );
  if (eventsMatch !== null) {
    const runId = eventsMatch[1]!;
    const cursor = parseCursor(url.searchParams.get("cursor"));
    json(response, 200, await readMonitorEvents(options.jobRoot, runId, cursor));
    return;
  }
  const streamMatch = /^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/stream$/u.exec(
    url.pathname,
  );
  if (streamMatch !== null) {
    streamChanges(options.jobRoot, streamMatch[1]!, response);
    return;
  }
  json(response, 404, { error: "not found" });
}

function listRuns(jobRoot: string): unknown[] {
  if (!existsSync(jobRoot)) {
    return [];
  }
  return readdirSync(jobRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validRunId(entry.name))
    .flatMap((entry) => {
      try {
        const path = join(jobRoot, entry.name, "job.json");
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const result = isRecord(parsed["result"]) ? parsed["result"] : {};
        const request = isRecord(parsed["request"]) ? parsed["request"] : {};
        return [
          {
            runId: entry.name,
            status: result["status"] ?? "unknown",
            objective: request["objective"] ?? "",
            updatedAt: parsed["updatedAt"] ?? null,
            monitorUrl: result["monitorUrl"] ?? null,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, MAX_LISTED_RUNS);
}

async function readJobSnapshot(jobRoot: string, runId: string): Promise<unknown> {
  const path = join(jobRoot, runId, "job.json");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_JOB_BYTES) {
    throw new Error("job snapshot is unavailable or too large for the monitor");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readMonitorEvents(
  jobRoot: string,
  runId: string,
  requestedCursor: number,
): Promise<{ events: unknown[]; nextCursor: number; hasMore: boolean }> {
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
  const length = Math.min(MAX_EVENT_CHUNK_BYTES, size - cursor);
  const handle = await open(path, "r");
  let bytesRead: number;
  const buffer = Buffer.allocUnsafe(length);
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, cursor));
  } finally {
    await handle.close();
  }
  const chunk = buffer.subarray(0, bytesRead);
  const lastNewline = chunk.lastIndexOf(0x0a);
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

function coalesceEventPage(events: unknown[]): unknown[] {
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

function streamChanges(jobRoot: string, runId: string, response: ServerResponse): void {
  const directory = join(jobRoot, runId);
  if (!existsSync(directory)) {
    json(response, 404, { error: "unknown run" });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
  response.write(`event: connected\ndata: ${JSON.stringify({ runId })}\n\n`);
  let debounce: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const cleanup = (): void => {
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    watcher?.close();
    watcher = null;
  };
  try {
    watcher = watch(directory, () => {
      if (debounce !== null) {
        return;
      }
      debounce = setTimeout(() => {
        debounce = null;
        response.write(`event: change\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      }, 100);
      debounce.unref();
    });
  } catch {
    response.end();
    return;
  }
  response.once("close", cleanup);
  response.once("error", cleanup);
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  text(response, statusCode, "application/json; charset=utf-8", JSON.stringify(body), "no-store");
}

function text(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  cacheControl: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function authorized(candidate: string | null, expected: string): boolean {
  if (candidate === null) {
    return false;
  }
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCursor(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function validRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
