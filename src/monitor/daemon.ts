#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { startMonitorServer } from "./server.js";

export interface MonitorDaemonReadyMessage {
  type: "ready" | "error";
  port?: number;
  error?: string;
}

export async function runMonitorDaemon(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const jobRoot = required(environment["AGENT_TRIO_MONITOR_JOB_ROOT"], "monitor job root");
  const token = required(environment["AGENT_TRIO_MONITOR_TOKEN"], "monitor token");
  const port = parsePort(required(environment["AGENT_TRIO_MONITOR_PORT"], "monitor port"));
  try {
    const server = await startMonitorServer({ jobRoot, token, port });
    await send({ type: "ready", port: server.port });
    process.disconnect?.();
    const stop = (): void => {
      void server.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await send({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    process.disconnect?.();
    throw error;
  }
}

function send(message: MonitorDaemonReadyMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      resolve();
      return;
    }
    process.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("monitor port must be an integer between 1 and 65535");
  }
  return port;
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
  void runMonitorDaemon().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
