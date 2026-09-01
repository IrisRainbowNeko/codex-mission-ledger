import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { BatchResult, RunRequest } from "./core/contracts.js";
import type { AgentTrioService } from "./core/service.js";

const SUPERVISOR_HANDSHAKE_TIMEOUT_MS = 30_000;

export type SubmitRequest = RunRequest & { action: "submit"; runId: string };

export interface SupervisorRuntime {
  service: Pick<AgentTrioService, "handle">;
  close?: () => void | Promise<void>;
}

export interface SupervisorChildMessage {
  type: "accepted" | "error";
  result?: BatchResult;
  error?: string;
}

export interface LaunchSupervisorOptions {
  modulePath: string;
  execPath?: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** Launch one detached process and return only after its durable job snapshot exists. */
export async function launchDetachedSupervisor(
  request: SubmitRequest,
  options: LaunchSupervisorOptions,
): Promise<BatchResult> {
  const child = (options.spawnProcess ?? spawn)(
    options.execPath ?? process.execPath,
    [...(options.execArgv ?? process.execArgv), options.modulePath],
    {
      detached: true,
      env: { ...process.env, ...options.env, AGENT_TRIO_SUPERVISOR: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
  try {
    const accepted = await supervisorHandshake(
      child,
      request,
      options.timeoutMs ?? SUPERVISOR_HANDSHAKE_TIMEOUT_MS,
    );
    if (child.connected) {
      child.disconnect();
    }
    child.unref();
    return accepted;
  } catch (error) {
    if (child.connected) {
      child.disconnect();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

/** Child entrypoint: submit once, acknowledge persistence, then wait for the same run. */
export async function runSupervisorChild(
  createRuntime: () => SupervisorRuntime | Promise<SupervisorRuntime>,
  receive: (handler: (request: unknown) => void) => void = (handler) => {
    process.once("message", handler);
  },
  send: (message: SupervisorChildMessage) => void | Promise<void> = sendProcessMessage,
  disconnect: () => void = () => process.disconnect?.(),
): Promise<void> {
  let runtime: SupervisorRuntime | undefined;
  try {
    const request = await new Promise<SubmitRequest>((resolve, reject) =>
      receive((message) => {
        try {
          resolve(assertSubmitRequest(message));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
    runtime = await createRuntime();
    const accepted = await runtime.service.handle(request);
    await send({ type: "accepted", result: accepted });
    disconnect();
    if (isActive(accepted.status)) {
      await runtime.service.handle({ action: "resume", runId: request.runId });
    }
  } catch (error) {
    await Promise.resolve(
      send({ type: "error", error: error instanceof Error ? error.message : String(error) }),
    ).catch(() => undefined);
    disconnect();
    throw error;
  } finally {
    await runtime?.close?.();
  }
}

function supervisorHandshake(
  child: ChildProcess,
  request: SubmitRequest,
  timeoutMs: number,
): Promise<BatchResult> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      if (!isSupervisorMessage(message)) {
        return;
      }
      cleanup();
      if (message.type === "accepted" && message.result !== undefined) {
        resolve(message.result);
      } else {
        reject(new Error(message.error ?? "Agent Trio supervisor rejected the job"));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `Agent Trio supervisor exited before accepting the job (${String(code ?? signal)})`,
        ),
      );
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Agent Trio supervisor did not respond within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    timer.unref();
    child.send(request, (error) => {
      if (error !== null) {
        cleanup();
        reject(error);
      }
    });
  });
}

function assertSubmitRequest(value: unknown): SubmitRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("action" in value) ||
    value.action !== "submit" ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    value.runId.length === 0
  ) {
    throw new Error("supervisor received an invalid submit request");
  }
  return value as SubmitRequest;
}

function isSupervisorMessage(value: unknown): value is SupervisorChildMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "accepted" || value.type === "error")
  );
}

function isActive(status: BatchResult["status"]): boolean {
  return (
    status === "pending" ||
    status === "planning" ||
    status === "running" ||
    status === "integrating"
  );
}

function sendProcessMessage(message: SupervisorChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error("supervisor IPC channel is unavailable"));
      return;
    }
    process.send(message, (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
