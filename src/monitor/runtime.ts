import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppServer } from "../app-server/types.js";
import type { RemoteTurnRef } from "../core/contracts.js";
import type { JobStore } from "../core/job-store.js";
import { MonitorRecorder } from "./recorder.js";
import { readMonitorData, type MonitorDataQuery, type MonitorDataUpdate } from "./data.js";
import type { MonitorDaemonReadyMessage } from "./daemon.js";
import type { MonitorRuntimePort } from "./types.js";

const DEFAULT_MONITOR_PORT_BASE = 43_173;
const MONITOR_PORT_SPAN = 1_000;
const MONITOR_START_TIMEOUT_MS = 5_000;
const TOKEN_FILE = ".monitor-token";

export interface MonitorRuntimeOptions {
  jobRoot: string;
  store: JobStore;
  env?: NodeJS.ProcessEnv;
  daemonModulePath?: string;
  spawnProcess?: typeof spawn;
}

export class AgentTrioMonitorRuntime implements MonitorRuntimePort {
  readonly enabled: boolean;
  readonly #jobRoot: string;
  readonly #recorder: MonitorRecorder | null;
  readonly #port: number;
  readonly #token: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #daemonModulePath: string;
  readonly #spawnProcess: typeof spawn;
  #startPromise: Promise<void> | null = null;
  #started = false;

  constructor(options: MonitorRuntimeOptions) {
    this.#jobRoot = options.jobRoot;
    this.#env = options.env ?? process.env;
    const nodeEnv = this.#env["NODE_ENV"] ?? process.env["NODE_ENV"];
    this.enabled =
      this.#env["AGENT_TRIO_MONITOR"] === "1" ||
      (this.#env["AGENT_TRIO_MONITOR"] !== "0" && nodeEnv !== "test");
    this.#port = monitorPort(this.#jobRoot, this.#env["AGENT_TRIO_MONITOR_PORT"]);
    this.#token = this.enabled ? readOrCreateToken(this.#jobRoot) : "";
    this.#recorder = this.enabled ? new MonitorRecorder(options.store) : null;
    this.#daemonModulePath =
      options.daemonModulePath ?? fileURLToPath(new URL("./daemon.js", import.meta.url));
    this.#spawnProcess = options.spawnProcess ?? spawn;
    if (this.enabled) {
      void this.ensureStarted().catch(() => undefined);
    }
  }

  attach(server: AppServer): void {
    this.#recorder?.attach(server);
  }

  recordRemoteTurn(runId: string, turn: RemoteTurnRef): void {
    this.#recorder?.recordRemoteTurn(runId, turn);
  }

  urlForRun(runId: string): string | undefined {
    if (!this.enabled) {
      return undefined;
    }
    void this.ensureStarted().catch(() => undefined);
    return `http://127.0.0.1:${String(this.#port)}/runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(this.#token)}`;
  }

  readData(runId: string, query: MonitorDataQuery): Promise<MonitorDataUpdate> {
    return readMonitorData(this.#jobRoot, runId, query);
  }

  ensureStarted(): Promise<void> {
    if (!this.enabled || this.#started) {
      return Promise.resolve();
    }
    this.#startPromise ??= this.#start()
      .then(() => {
        this.#started = true;
      })
      .finally(() => {
        this.#startPromise = null;
      });
    return this.#startPromise;
  }

  async close(): Promise<void> {
    await this.#recorder?.close();
  }

  async #start(): Promise<void> {
    if (await healthy(this.#port, this.#token, this.#jobRoot)) {
      return;
    }
    const child = this.#spawnProcess(
      process.execPath,
      [...process.execArgv, this.#daemonModulePath],
      {
        detached: true,
        env: {
          ...process.env,
          ...this.#env,
          AGENT_TRIO_MONITOR_JOB_ROOT: this.#jobRoot,
          AGENT_TRIO_MONITOR_PORT: String(this.#port),
          AGENT_TRIO_MONITOR_TOKEN: this.#token,
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    try {
      await daemonHandshake(child);
      if (child.connected) {
        child.disconnect();
      }
      child.unref();
    } catch (error) {
      if (child.connected) {
        child.disconnect();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      if (await healthy(this.#port, this.#token, this.#jobRoot)) {
        return;
      }
      throw error;
    }
  }
}

function daemonHandshake(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      if (!isDaemonMessage(message)) {
        return;
      }
      cleanup();
      if (message.type === "ready") {
        resolve();
      } else {
        reject(new Error(message.error ?? "Agent Trio Monitor failed to start"));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Agent Trio Monitor exited during startup (${String(code ?? signal)})`));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Agent Trio Monitor did not start in time"));
    }, MONITOR_START_TIMEOUT_MS);
    timer.unref();
  });
}

function healthy(port: number, token: string, jobRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/healthz?token=${encodeURIComponent(token)}`,
        method: "GET",
        timeout: 750,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 16_384) {
            body += chunk;
          }
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { ok?: unknown; jobRoot?: unknown };
            resolve(
              response.statusCode === 200 && parsed.ok === true && parsed.jobRoot === jobRoot,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
    request.end();
  });
}

function monitorPort(jobRoot: string, configured: string | undefined): number {
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new Error("AGENT_TRIO_MONITOR_PORT must be an integer between 1 and 65535");
    }
    return parsed;
  }
  const digest = createHash("sha256").update(jobRoot).digest();
  return DEFAULT_MONITOR_PORT_BASE + (digest.readUInt16BE(0) % MONITOR_PORT_SPAN);
}

function readOrCreateToken(jobRoot: string): string {
  mkdirSync(jobRoot, { recursive: true, mode: 0o700 });
  const path = join(jobRoot, TOKEN_FILE);
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token.length >= 32) {
      return token;
    }
  }
  const token = randomBytes(24).toString("base64url");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${token}\n`, "utf8");
    closeSync(descriptor);
    descriptor = null;
    return token;
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    if (existsSync(path)) {
      const raced = readFileSync(path, "utf8").trim();
      if (raced.length >= 32) {
        return raced;
      }
    }
    throw error;
  }
}

function isDaemonMessage(value: unknown): value is MonitorDaemonReadyMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "ready" || value.type === "error")
  );
}
