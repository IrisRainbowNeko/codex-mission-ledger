import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import type { AgentTrioRequest, BatchResult } from "../core/contracts.js";
import type { AgentTrioService } from "../core/service.js";
import type { MonitorDataQuery, MonitorDataUpdate } from "../monitor/data.js";
import { launchDetachedSupervisor, type SupervisorRequest } from "../supervisor.js";
import { AgentTrioMcpProtocol } from "./protocol.js";
import { MCP_ROOT_DISPATCH_CONSTRAINT } from "../core/router.js";

export type McpService = Pick<AgentTrioService, "handle"> &
  Partial<Pick<AgentTrioService, "waitForSettlement">>;

export interface AgentTrioMcpRuntime {
  service: McpService;
  monitorUrlForRun?: (runId: string) => string | undefined;
  monitorDataForRun?: (runId: string, query: MonitorDataQuery) => Promise<MonitorDataUpdate>;
  close?: () => void | Promise<void>;
}

export type CreateDefaultMcpRuntime = () => AgentTrioMcpRuntime | Promise<AgentTrioMcpRuntime>;

export type McpSupervisorLauncher = (request: SupervisorRequest) => Promise<BatchResult>;
export type McpRunIdGenerator = () => string;

export interface McpDispatchOptions {
  launchSupervisor?: McpSupervisorLauncher;
  generateRunId?: McpRunIdGenerator;
  workspaceRoots?: readonly string[];
  monitorUrlForRun?: (runId: string) => string | undefined;
  monitorDataForRun?: (runId: string, query: MonitorDataQuery) => Promise<MonitorDataUpdate>;
}

export interface RunMcpStdioOptions extends McpDispatchOptions {
  createRuntime?: CreateDefaultMcpRuntime;
  input?: Readable;
  output?: Writable;
  errorOutput?: Pick<Writable, "write">;
}

/** Create the V3 stdio protocol around the shared service instance. */
export function createMcpServer(
  service: McpService,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  errorOutput: Pick<Writable, "write"> = process.stderr,
  dispatchOptions: McpDispatchOptions = {},
): AgentTrioMcpProtocol {
  return new AgentTrioMcpProtocol({
    service: createDispatchService(service, dispatchOptions),
    input,
    output,
    onError: (error) => errorOutput.write(`${error.stack ?? error.message}\n`),
    ...(dispatchOptions.workspaceRoots === undefined
      ? {}
      : { workspaceRoots: dispatchOptions.workspaceRoots }),
    ...(dispatchOptions.monitorUrlForRun === undefined
      ? {}
      : { monitorUrlForRun: dispatchOptions.monitorUrlForRun }),
    ...(dispatchOptions.monitorDataForRun === undefined
      ? {}
      : { monitorDataForRun: dispatchOptions.monitorDataForRun }),
    ...(dispatchOptions.generateRunId === undefined
      ? {}
      : { createRunId: dispatchOptions.generateRunId }),
  });
}

interface RuntimeModule {
  createDefaultRuntime: CreateDefaultMcpRuntime;
}

export async function loadDefaultMcpRuntime(): Promise<AgentTrioMcpRuntime> {
  // Keep construction in the runtime module so CLI and MCP share one service core.
  const runtimeModuleUrl = new URL("../runtime.js", import.meta.url).href;
  const loaded: unknown = await import(runtimeModuleUrl);
  if (!isRuntimeModule(loaded)) {
    throw new Error("src/runtime.ts must export createDefaultRuntime()");
  }
  return normalizeRuntime(await loaded.createDefaultRuntime());
}

export async function runMcpStdio(options: RunMcpStdioOptions = {}): Promise<void> {
  const runtime = normalizeRuntime(await (options.createRuntime ?? loadDefaultMcpRuntime)());
  try {
    const protocol = createMcpServer(
      runtime.service,
      options.input ?? process.stdin,
      options.output ?? process.stdout,
      options.errorOutput ?? process.stderr,
      {
        ...options,
        ...(runtime.monitorUrlForRun === undefined
          ? {}
          : { monitorUrlForRun: runtime.monitorUrlForRun }),
        ...(runtime.monitorDataForRun === undefined
          ? {}
          : { monitorDataForRun: runtime.monitorDataForRun }),
      },
    );
    await protocol.run();
  } finally {
    await runtime.close?.();
  }
}

export const main = runMcpStdio;

function isRuntimeModule(value: unknown): value is RuntimeModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "createDefaultRuntime" in value &&
    typeof value.createDefaultRuntime === "function"
  );
}

function normalizeRuntime(value: AgentTrioMcpRuntime): AgentTrioMcpRuntime {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.service !== "object" ||
    value.service === null ||
    typeof value.service.handle !== "function"
  ) {
    throw new Error("createDefaultRuntime() must return { service, close? }");
  }
  if (value.close !== undefined && typeof value.close !== "function") {
    throw new Error("createDefaultRuntime() close must be a function when provided");
  }
  return value;
}

function createDispatchService(service: McpService, options: McpDispatchOptions): McpService {
  const launchSupervisor = options.launchSupervisor ?? defaultSupervisorLauncher;
  const generateRunId = options.generateRunId ?? randomUUID;
  return {
    handle: async (request: AgentTrioRequest): Promise<BatchResult> => {
      if (request.action === "status") {
        if (request.wait === true) {
          if (service.waitForSettlement === undefined) {
            throw new Error("this Agent Trio runtime cannot wait for a submitted run");
          }
          return service.waitForSettlement(request.runId);
        }
        return service.handle({ action: "status", runId: request.runId });
      }
      if (request.action !== "submit") {
        return service.handle(markInternalPlannerDispatch(request));
      }
      const dispatched = markInternalPlannerDispatch(request);
      const runId = request.runId ?? generateRunId();
      if (runId.trim().length === 0 || runId.length > 128) {
        throw new Error("generated runId must be a non-empty string up to 128 characters");
      }
      const start = { ...dispatched };
      delete start.monitorFirst;
      return launchSupervisor({
        ...start,
        action: request.monitorFirst === true ? "run" : "submit",
        runId,
      });
    },
  };
}

export function markInternalPlannerDispatch<T extends AgentTrioRequest>(request: T): T {
  if (
    (request.action !== "run" && request.action !== "submit") ||
    request.strategy === "direct" ||
    request.semanticPlan !== undefined
  ) {
    return request;
  }
  const constraints = request.constraints ?? [];
  if (constraints.includes(MCP_ROOT_DISPATCH_CONSTRAINT)) {
    return request;
  }
  return { ...request, constraints: [...constraints, MCP_ROOT_DISPATCH_CONSTRAINT] } as T;
}

function defaultSupervisorLauncher(request: SupervisorRequest): Promise<BatchResult> {
  return launchDetachedSupervisor(request, {
    modulePath: fileURLToPath(new URL("../cli.js", import.meta.url)),
  });
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
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
