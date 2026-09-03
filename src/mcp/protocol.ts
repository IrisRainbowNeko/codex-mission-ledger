import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentTrioRequest,
  BatchResult,
  CapabilityRef,
  ExecutionLimits,
  HostSemanticPlan,
  OptimizationProfile,
  TaskDomain,
} from "../core/contracts.js";
import type { AgentTrioService } from "../core/service.js";
import type { MonitorDataQuery, MonitorDataUpdate } from "../monitor/data.js";
import { PlanValidationError } from "../core/plan-validation.js";
import { hostSemanticPlanJsonSchemaForRoute, parseHostSemanticPlan } from "../core/planner.js";
import { fanoutMinTaskSeconds } from "../core/policy.js";
import { AGENT_TRIO_MONITOR_RESOURCE_URI, MCP_APP_MIME_TYPE, MCP_MONITOR_HTML } from "./app.js";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_MONITOR_STRUCTURED_BYTES = 48 * 1024;
const ROOTS_TIMEOUT_MS = 5_000;
const DOMAIN_VALUES: readonly TaskDomain[] = [
  "coding",
  "algorithm",
  "research",
  "paper",
  "office",
  "autoResearch",
  "general",
];
const FLAT_LIMIT_KEYS = [
  "maxConcurrent",
  "maxLeaves",
  "maxWaves",
  "maxSolLeaves",
  "maxReplans",
  "deadlineMs",
  "maxCostUsd",
] as const;

export const AGENT_TRIO_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["run", "submit", "status", "resume", "cancel"] },
    runId: { type: "string", minLength: 1, maxLength: 128 },
    monitorFirst: { type: "boolean" },
    wait: { type: "boolean" },
    monitorCursor: { type: "integer", minimum: 0 },
    monitorRevision: { type: "string", maxLength: 128 },
    monitorWaitMs: { type: "integer", minimum: 0, maximum: 20_000 },
    input: { type: "string", maxLength: 4_096 },
    objective: { type: "string", minLength: 1, maxLength: 200_000 },
    cwd: { type: "string", minLength: 1, maxLength: 4_096 },
    hostAccess: {
      type: "string",
      enum: ["readOnly", "workspaceWrite", "fullAccess"],
      description:
        "Canonical calling-task permission. Map read-only to readOnly, workspace-write to workspaceWrite, and danger-full-access, unrestricted, or disabled sandboxing to fullAccess. Never request more access than the caller has.",
    },
    hostApproval: {
      type: "string",
      enum: ["never", "approveForMe"],
      description:
        "Canonical calling-task approval. Use never for Never and approveForMe for Approve for me or on-request. Never strengthen the caller's approval mode.",
    },
    strategy: { type: "string", enum: ["auto", "direct", "fanout"] },
    profile: { type: "string", enum: ["balanced", "quality"], default: "balanced" },
    directTier: {
      type: "string",
      enum: ["luna", "terra"],
      description:
        "Required semantic tier choice for strategy=direct. Use this field, never a top-level floor or tier.",
    },
    domain: {
      type: "string",
      enum: DOMAIN_VALUES,
      description:
        "Use exactly coding, algorithm, research, paper, office, autoResearch, or general; omit when uncertain.",
    },
    constraints: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 8_000 },
    },
    capabilities: {
      type: "array",
      maxItems: 16,
      description:
        "Explicitly selected capabilities as {kind,name,path?} objects. Do not use selectedCapabilities or capability names as bare strings.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["skill", "plugin"] },
          name: { type: "string", minLength: 1, maxLength: 256 },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
        },
        required: ["kind", "name"],
      },
    },
    semanticPlan: hostSemanticPlanJsonSchemaForRoute("fanout", 20),
    limits: {
      type: "object",
      additionalProperties: false,
      description: "Put all execution limit fields inside this object, never at tool top level.",
      properties: {
        maxConcurrent: { type: "integer", minimum: 1, maximum: 5 },
        maxLeaves: { type: "integer", minimum: 1, maximum: 20 },
        maxWaves: { type: "integer", minimum: 1, maximum: 3 },
        maxSolLeaves: { type: "integer", minimum: 0, maximum: 1 },
        maxReplans: { type: "integer", minimum: 0, maximum: 1 },
        deadlineMs: { type: "number", exclusiveMinimum: 0 },
        maxCostUsd: { type: "number", minimum: 0 },
      },
    },
    integrate: { type: "boolean" },
  },
  required: ["action"],
  allOf: [
    {
      if: { properties: { action: { enum: ["run", "submit"] } } },
      then: {
        required: ["objective", "cwd", "strategy"],
      },
      else: { required: ["runId"] },
    },
    {
      if: { required: ["semanticPlan"] },
      then: { properties: { strategy: { const: "fanout" } }, required: ["strategy"] },
    },
    {
      if: { properties: { action: { const: "resume" } } },
      else: { not: { required: ["input"] } },
    },
    {
      if: { required: ["monitorFirst"] },
      then: { properties: { action: { const: "submit" } }, required: ["action"] },
    },
    {
      if: { required: ["wait"] },
      then: { properties: { action: { const: "status" } }, required: ["action"] },
    },
    {
      if: {
        anyOf: [
          { required: ["monitorCursor"] },
          { required: ["monitorRevision"] },
          { required: ["monitorWaitMs"] },
        ],
      },
      then: {
        properties: { action: { const: "status" } },
        required: ["action", "monitorCursor"],
      },
    },
    {
      if: { required: ["directTier"] },
      then: { properties: { strategy: { const: "direct" } }, required: ["strategy"] },
    },
  ],
} as const;

export const AGENT_TRIO_TOOL_DESCRIPTION = `Run or monitor Agent Trio. Pass flat top-level fields; never wrap them in request, input, or arguments. Foreground UI calls submit once with monitorFirst=true, then status once with only action, runId, and wait=true, and only after submit succeeds with the same runId. profile defaults to balanced; quality preserves V3.3 routing. strategy=direct delegates one worker and must set directTier to exactly luna or terra, never top-level floor. Luna handles bounded mechanical work; Terra handles recovery/stateful work, coupled debugging, review/synthesis, or office artifacts. Direct omits semanticPlan and all plan-only fields. strategy=fanout requires semanticPlan with 2+ independent tasks; use Luna by default, disjoint writer paths, valid dependencies, and at most one Sol leaf. Put merge and risk only inside semanticPlan. Balanced normally uses 2 tasks; use 3 only for three substantial streams, >30s each, >=90s serial work, and >=20% critical-path gain over the best 2-task grouping. Quality allows 2-5 tasks and >15s each. domain is exactly one of coding, algorithm, research, paper, office, autoResearch, or general. Canonicalize hostAccess and hostApproval using their schema descriptions. capabilities is an object array, not selectedCapabilities. Do not send mode; action and monitorFirst define foreground or durable behavior. Put maxConcurrent, maxLeaves, maxWaves, maxSolLeaves, maxReplans, deadlineMs, and maxCostUsd inside limits. Use strategy=auto only when semantic boundaries are unavailable. Runtime enforces permissions, DAG, ownership, explicit budget, concurrency, and positive time saving; 40% cost and 70% latency are telemetry, not per-run vetoes. Inside semanticPlan, tasks contain only goal, paths, after indexes, floor, and expectedSeconds; merge is deterministic or terra, and risk is low, medium, or high. status/resume/cancel require runId.`;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface RootEntry {
  uri: string;
  name?: string;
}

export interface McpProtocolOptions {
  service: Pick<AgentTrioService, "handle">;
  input: Readable;
  output: Writable;
  onError?: (error: Error) => void;
  /** Trusted fixed roots for an isolated embedding; normal Desktop MCP negotiates roots. */
  workspaceRoots?: readonly string[];
  monitorUrlForRun?: (runId: string) => string | undefined;
  monitorDataForRun?: (runId: string, query: MonitorDataQuery) => Promise<MonitorDataUpdate>;
  createRunId?: () => string;
}

export class AgentTrioMcpProtocol {
  readonly #service: Pick<AgentTrioService, "handle">;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #onError: (error: Error) => void;
  readonly #workspaceRoots: string[] | null;
  readonly #monitorUrlForRun: ((runId: string) => string | undefined) | undefined;
  readonly #monitorDataForRun:
    ((runId: string, query: MonitorDataQuery) => Promise<MonitorDataUpdate>) | undefined;
  readonly #createRunId: () => string;
  #clientSupportsRoots = false;
  #roots: string[] | null = null;
  #rootsResolve: ((roots: string[]) => void) | null = null;
  #rootsPromise: Promise<string[]> = Promise.resolve([]);
  #rootsTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: McpProtocolOptions) {
    this.#service = options.service;
    this.#input = options.input;
    this.#output = options.output;
    this.#onError = options.onError ?? (() => undefined);
    this.#workspaceRoots =
      options.workspaceRoots === undefined
        ? null
        : options.workspaceRoots.map((root) => resolve(root));
    this.#monitorUrlForRun = options.monitorUrlForRun;
    this.#monitorDataForRun = options.monitorDataForRun;
    this.#createRunId = options.createRunId ?? randomUUID;
  }

  async run(): Promise<void> {
    const lines = createInterface({ input: this.#input, crlfDelay: Number.POSITIVE_INFINITY });
    const inFlight = new Set<Promise<void>>();
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        let message: unknown;
        try {
          message = JSON.parse(line) as unknown;
        } catch {
          this.#writeError(null, -32700, "Parse error");
          continue;
        }
        const pending = this.#handle(message).catch((error: unknown) =>
          this.#onError(normalizeError(error)),
        );
        inFlight.add(pending);
        void pending.then(
          () => inFlight.delete(pending),
          () => inFlight.delete(pending),
        );
      }
    } finally {
      if (this.#rootsTimer !== null) {
        clearTimeout(this.#rootsTimer);
        this.#rootsTimer = null;
      }
      this.#resolveRoots([]);
      await Promise.allSettled([...inFlight]);
      this.#closed = true;
    }
  }

  async #handle(message: unknown): Promise<void> {
    if (!isRecord(message) || message["jsonrpc"] !== "2.0") {
      this.#writeError(null, -32600, "Invalid Request");
      return;
    }
    if (typeof message["method"] !== "string") {
      this.#handleResponse(message);
      return;
    }
    const method = message["method"];
    const id = message["id"];
    if (id === undefined) {
      await this.#handleNotification({
        jsonrpc: "2.0",
        method,
        ...("params" in message ? { params: message["params"] } : {}),
      });
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      this.#writeError(null, -32600, "Invalid Request id");
      return;
    }
    await this.#handleRequest({
      jsonrpc: "2.0",
      id,
      method,
      ...(message["params"] === undefined ? {} : { params: message["params"] }),
    });
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      switch (request.method) {
        case "initialize": {
          const params = requireRecord(request.params, "initialize params");
          const capabilities = isRecord(params["capabilities"]) ? params["capabilities"] : {};
          this.#clientSupportsRoots =
            this.#workspaceRoots === null && isRecord(capabilities["roots"]);
          if (this.#workspaceRoots === null) {
            this.#resetRootsPromise();
          } else {
            this.#roots = [...this.#workspaceRoots];
            this.#rootsPromise = Promise.resolve([...this.#workspaceRoots]);
          }
          this.#writeResult(request.id, {
            protocolVersion:
              typeof params["protocolVersion"] === "string"
                ? params["protocolVersion"]
                : "2025-06-18",
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: { name: "agent-trio", version: "3.4.3" },
          });
          return;
        }
        case "ping":
          this.#writeResult(request.id, {});
          return;
        case "resources/list":
          this.#writeResult(request.id, {
            resources: [
              {
                uri: AGENT_TRIO_MONITOR_RESOURCE_URI,
                name: "Agent Trio run monitor",
                title: "Agent Trio Monitor",
                description: "Live execution DAG, subagent state, conversations, and usage.",
                mimeType: MCP_APP_MIME_TYPE,
              },
            ],
          });
          return;
        case "resources/read": {
          const params = requireRecord(request.params, "resources/read params");
          if (params["uri"] !== AGENT_TRIO_MONITOR_RESOURCE_URI) {
            this.#writeError(request.id, -32002, "Resource not found");
            return;
          }
          this.#writeResult(request.id, {
            contents: [
              {
                uri: AGENT_TRIO_MONITOR_RESOURCE_URI,
                mimeType: MCP_APP_MIME_TYPE,
                text: MCP_MONITOR_HTML,
                _meta: { ui: { prefersBorder: true } },
              },
            ],
          });
          return;
        }
        case "resources/templates/list":
          this.#writeResult(request.id, { resourceTemplates: [] });
          return;
        case "tools/list":
          this.#writeResult(request.id, {
            tools: [
              {
                name: "agent_trio",
                title: "Run Agent Trio",
                description: AGENT_TRIO_TOOL_DESCRIPTION,
                inputSchema: AGENT_TRIO_TOOL_SCHEMA,
                // Codex converts this extension into ResponsesApiTool.defer_loading so direct
                // turns do not pay the schema/reasoning cost unless orchestration is relevant.
                defer_loading: true,
                _meta: {
                  ui: { resourceUri: AGENT_TRIO_MONITOR_RESOURCE_URI },
                  "openai/outputTemplate": AGENT_TRIO_MONITOR_RESOURCE_URI,
                  "openai/toolInvocation/invoking": "Running Agent Trio",
                  "openai/toolInvocation/invoked": "Agent Trio finished",
                },
              },
            ],
          });
          return;
        case "tools/call":
          await this.#callTool(request);
          return;
        default:
          this.#writeError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      const normalized = normalizeError(error);
      this.#writeError(request.id, -32602, normalized.message);
    }
  }

  async #handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === "notifications/initialized") {
      if (this.#workspaceRoots !== null) {
        return;
      }
      if (!this.#clientSupportsRoots) {
        this.#resolveRoots([]);
        return;
      }
      this.#write({ jsonrpc: "2.0", id: "agent-trio-roots-1", method: "roots/list" });
      this.#rootsTimer = setTimeout(() => this.#resolveRoots([]), ROOTS_TIMEOUT_MS);
      this.#rootsTimer.unref();
    }
  }

  #handleResponse(message: Record<string, unknown>): void {
    if (message["id"] !== "agent-trio-roots-1") {
      return;
    }
    if (this.#rootsTimer !== null) {
      clearTimeout(this.#rootsTimer);
      this.#rootsTimer = null;
    }
    const result = isRecord(message["result"]) ? message["result"] : null;
    const roots = Array.isArray(result?.["roots"])
      ? result["roots"].filter(isRootEntry).flatMap(resolveRoot)
      : [];
    this.#resolveRoots(roots);
  }

  async #callTool(request: JsonRpcRequest): Promise<void> {
    const params = requireRecord(request.params, "tools/call params");
    if (params["name"] !== "agent_trio") {
      this.#writeError(request.id, -32602, "Unknown tool");
      return;
    }
    const parsed = parseAgentTrioRequest(params["arguments"]);
    const dispatched =
      (parsed.action === "run" || parsed.action === "submit") && parsed.runId === undefined
        ? { ...parsed, runId: this.#createRunId() }
        : parsed;
    if (parsed.action === "run" || parsed.action === "submit") {
      const rootsAreAuthoritative = this.#workspaceRoots !== null || this.#clientSupportsRoots;
      const roots =
        this.#workspaceRoots ??
        (this.#clientSupportsRoots ? (this.#roots ?? (await this.#rootsPromise)) : []);
      assertWorkspaceRoot(parsed.cwd, roots, rootsAreAuthoritative);
    }
    try {
      const dispatchedRunId = "runId" in dispatched ? dispatched.runId : undefined;
      const monitorUrl =
        dispatchedRunId === undefined ? undefined : this.#monitorUrlForRun?.(dispatchedRunId);
      const progressToken = progressTokenFrom(params);
      if (monitorUrl !== undefined && progressToken !== undefined) {
        this.#write({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken,
            progress: 0,
            total: 1,
            message: `Agent Trio Monitor: ${monitorUrl}`,
          },
        });
      }
      const handled = await this.#service.handle(dispatched);
      const monitored =
        handled.monitorUrl === undefined && monitorUrl !== undefined
          ? { ...handled, monitorUrl }
          : handled;
      const result = compactResult(withMonitorLink(monitored));
      const monitor =
        parsed.action === "status" &&
        parsed.monitorCursor !== undefined &&
        this.#monitorDataForRun !== undefined
          ? await this.#monitorDataForRun(parsed.runId, {
              cursor: parsed.monitorCursor,
              ...(parsed.monitorRevision === undefined
                ? {}
                : { afterRevision: parsed.monitorRevision }),
              ...(parsed.monitorWaitMs === undefined ? {} : { waitMs: parsed.monitorWaitMs }),
              maxEventBytes: 16 * 1024,
            })
          : undefined;
      const structuredContent = monitor === undefined ? result : monitorToolResult(result, monitor);
      this.#writeResult(request.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              runId: result.runId,
              status: result.status,
              monitorUrl: result.monitorUrl ?? monitorUrl ?? null,
              finalResponse: monitor === undefined ? result.finalResponse : null,
              needsAction:
                monitor === undefined
                  ? (result.needsAction ?? null)
                  : boundedBytes(result.needsAction, 1_000),
              error:
                monitor === undefined ? (result.error ?? null) : boundedBytes(result.error, 1_000),
            }),
          },
        ],
        structuredContent,
        // The MCP request succeeded even when the managed job reached a failed terminal state.
        // Preserve that state as data so the caller does not redo the task outside the scheduler.
        isError: false,
      });
    } catch (error) {
      const normalized = normalizeError(error);
      this.#writeResult(request.id, {
        content: [{ type: "text", text: normalized.message }],
        isError: true,
      });
    }
  }

  #resetRootsPromise(): void {
    this.#roots = null;
    this.#rootsPromise = new Promise((resolve) => {
      this.#rootsResolve = resolve;
    });
  }

  #resolveRoots(roots: string[]): void {
    if (this.#roots !== null) {
      return;
    }
    this.#roots = roots;
    this.#rootsResolve?.(roots);
    this.#rootsResolve = null;
  }

  #writeResult(id: string | number, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #writeError(id: string | number | null, code: number, message: string): void {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #write(value: unknown): void {
    if (!this.#closed) {
      this.#output.write(`${JSON.stringify(value)}\n`);
    }
  }
}

export type ParsedAgentTrioRequest = AgentTrioRequest & {
  monitorCursor?: number;
  monitorRevision?: string;
  monitorWaitMs?: number;
};

export function parseAgentTrioRequest(value: unknown): ParsedAgentTrioRequest {
  const input = normalizeAgentTrioArguments(value);
  const action = input["action"];
  if (
    action !== "run" &&
    action !== "submit" &&
    action !== "status" &&
    action !== "resume" &&
    action !== "cancel"
  ) {
    throw new Error("action must be run, submit, status, resume, or cancel");
  }
  if ("input" in input && action !== "resume") {
    throw new Error("input is only valid when action is resume");
  }
  if (action === "status" || action === "resume" || action === "cancel") {
    const allowed = new Set(
      action === "resume"
        ? ["action", "runId", "input"]
        : action === "status"
          ? ["action", "runId", "wait", "monitorCursor", "monitorRevision", "monitorWaitMs"]
          : ["action", "runId"],
    );
    rejectUnknownArgument(input, allowed);
    const runId = requiredString(input["runId"], "runId", 128);
    if (action === "status") {
      if (input["wait"] !== undefined && typeof input["wait"] !== "boolean") {
        throw new Error("wait must be boolean");
      }
      const monitorCursor = optionalSafeInteger(
        input["monitorCursor"],
        "monitorCursor",
        Number.MAX_SAFE_INTEGER,
      );
      const monitorWaitMs = optionalSafeInteger(input["monitorWaitMs"], "monitorWaitMs", 20_000);
      const monitorRevision = optionalString(input["monitorRevision"], "monitorRevision", 128);
      if (
        (monitorRevision !== undefined || monitorWaitMs !== undefined) &&
        monitorCursor === undefined
      ) {
        throw new Error("monitorRevision and monitorWaitMs require monitorCursor");
      }
      return {
        action,
        runId,
        ...(input["wait"] === undefined ? {} : { wait: input["wait"] as boolean }),
        ...(monitorCursor === undefined ? {} : { monitorCursor }),
        ...(monitorRevision === undefined ? {} : { monitorRevision }),
        ...(monitorWaitMs === undefined ? {} : { monitorWaitMs }),
      };
    }
    if (action === "cancel") {
      return { action, runId };
    }
    return {
      action,
      runId,
      ...(input["input"] === undefined ? {} : { input: parseResumeInput(input["input"]) }),
    };
  }
  const allowed = new Set([
    "action",
    "runId",
    "objective",
    "cwd",
    "hostAccess",
    "hostApproval",
    "strategy",
    "profile",
    "directTier",
    "domain",
    "constraints",
    "capabilities",
    "semanticPlan",
    "limits",
    "integrate",
    "monitorFirst",
  ]);
  rejectUnknownArgument(input, allowed);
  if (input["monitorFirst"] !== undefined) {
    if (action !== "submit") {
      throw new Error("monitorFirst is only valid when action is submit");
    }
    if (typeof input["monitorFirst"] !== "boolean") {
      throw new Error("monitorFirst must be boolean");
    }
  }
  const domain = input["domain"];
  if (domain !== undefined && !DOMAIN_VALUES.includes(domain as TaskDomain)) {
    throw new Error("invalid domain");
  }
  const constraints = input["constraints"];
  if (
    constraints !== undefined &&
    (!Array.isArray(constraints) ||
      constraints.some((item) => typeof item !== "string" || item.trim().length === 0))
  ) {
    throw new Error("constraints must be an array of non-empty strings");
  }
  const capabilities = parseCapabilities(input["capabilities"]);
  const hostAccess = input["hostAccess"];
  if (
    hostAccess !== undefined &&
    hostAccess !== "readOnly" &&
    hostAccess !== "workspaceWrite" &&
    hostAccess !== "fullAccess"
  ) {
    throw new Error("hostAccess must be readOnly, workspaceWrite, or fullAccess");
  }
  const hostApproval = input["hostApproval"];
  if (hostApproval !== undefined && hostApproval !== "never" && hostApproval !== "approveForMe") {
    throw new Error("hostApproval must be never or approveForMe");
  }
  const strategy = input["strategy"];
  if (strategy !== undefined && !["auto", "direct", "fanout"].includes(strategy as string)) {
    throw new Error("strategy must be auto, direct, or fanout");
  }
  const profileValue = input["profile"];
  if (profileValue !== undefined && profileValue !== "balanced" && profileValue !== "quality") {
    throw new Error("profile must be balanced or quality");
  }
  const profile: OptimizationProfile = profileValue ?? "balanced";
  const hasSemanticPlan = input["semanticPlan"] !== undefined;
  if (hasSemanticPlan && strategy !== "fanout") {
    throw new Error("semanticPlan requires strategy=fanout");
  }
  let semanticPlan: HostSemanticPlan | undefined;
  let hostPlanRepairConstraint: string | undefined;
  if (hasSemanticPlan) {
    try {
      semanticPlan = parseHostSemanticPlan(
        input["semanticPlan"],
        "fanout",
        20,
        fanoutMinTaskSeconds(profile),
      );
    } catch (error) {
      if (!(error instanceof PlanValidationError)) {
        throw error;
      }
      const details = error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join(", ")
        .slice(0, 1_000);
      hostPlanRepairConstraint = `Host semanticPlan failed structural validation and must be regenerated once by internal Sol: ${details}`;
    }
  }
  const directTier = input["directTier"];
  if (directTier !== undefined && directTier !== "luna" && directTier !== "terra") {
    throw new Error("directTier must be luna or terra");
  }
  if (directTier !== undefined && strategy !== "direct") {
    throw new Error("directTier requires strategy=direct");
  }
  const parsedConstraints = constraints === undefined ? undefined : ([...constraints] as string[]);
  const effectiveConstraints =
    hostPlanRepairConstraint === undefined
      ? parsedConstraints
      : [...(parsedConstraints ?? []), hostPlanRepairConstraint];
  const limits = input["limits"] === undefined ? undefined : parseLimits(input["limits"]);
  if (input["integrate"] !== undefined && typeof input["integrate"] !== "boolean") {
    throw new Error("integrate must be boolean");
  }
  return {
    action,
    objective: requiredString(input["objective"], "objective", 200_000),
    cwd: requiredString(input["cwd"], "cwd", 4_096),
    profile,
    ...(input["runId"] === undefined
      ? {}
      : { runId: requiredString(input["runId"], "runId", 128) }),
    ...(domain === undefined ? {} : { domain: domain as TaskDomain }),
    ...(hostAccess === undefined ? {} : { hostAccess }),
    ...(hostApproval === undefined ? {} : { hostApproval }),
    ...(strategy === undefined ? {} : { strategy: strategy as "auto" | "direct" | "fanout" }),
    ...(directTier === undefined ? {} : { directTier: directTier as "luna" | "terra" }),
    ...(effectiveConstraints === undefined ? {} : { constraints: effectiveConstraints }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(semanticPlan === undefined ? {} : { semanticPlan }),
    ...(limits === undefined ? {} : { limits }),
    ...(input["integrate"] === undefined ? {} : { integrate: input["integrate"] as boolean }),
    ...(input["monitorFirst"] === undefined
      ? {}
      : { monitorFirst: input["monitorFirst"] as boolean }),
  };
}

function normalizeAgentTrioArguments(value: unknown): Record<string, unknown> {
  const envelope = requireRecord(value, "agent_trio arguments");
  const input = mergeRequestEnvelope(envelope);
  if (input["action"] !== "run" && input["action"] !== "submit") {
    return input;
  }
  const normalized = { ...input };
  normalizeModeAlias(normalized);
  normalizeDirectTierAlias(normalized);
  normalizeCapabilityAlias(normalized);
  normalizeFlatLimits(normalized);
  normalizeDomainAlias(normalized);
  normalizePermissionAliases(normalized);
  normalizePlanAliases(normalized);
  return normalized;
}

function mergeRequestEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  if (!("request" in envelope)) {
    return envelope;
  }
  const wrapped = requireRecord(envelope["request"], "agent_trio request wrapper");
  if ("request" in wrapped) {
    throw new Error("nested agent_trio request wrappers are not supported");
  }
  const merged = { ...wrapped };
  for (const [key, outerValue] of Object.entries(envelope)) {
    if (key === "request") {
      continue;
    }
    if (key in merged && !isDeepStrictEqual(merged[key], outerValue)) {
      throw new Error(`request wrapper conflicts with top-level agent_trio argument: ${key}`);
    }
    merged[key] = outerValue;
  }
  return merged;
}

function normalizeModeAlias(input: Record<string, unknown>): void {
  if (!("mode" in input)) {
    return;
  }
  const mode = input["mode"];
  if (mode !== "foreground" && mode !== "durable") {
    throw new Error("mode compatibility hint must be foreground or durable");
  }
  const expected =
    input["action"] === "run" || input["monitorFirst"] === true ? "foreground" : "durable";
  if (mode !== expected) {
    throw new Error(`mode=${mode} conflicts with action and monitorFirst (${expected})`);
  }
  delete input["mode"];
}

function normalizeDirectTierAlias(input: Record<string, unknown>): void {
  if (!("floor" in input)) {
    return;
  }
  const floor = input["floor"];
  if (input["strategy"] !== "direct" || (floor !== "luna" && floor !== "terra")) {
    throw new Error("top-level floor is compatible only with strategy=direct and luna or terra");
  }
  if (input["directTier"] !== undefined && input["directTier"] !== floor) {
    throw new Error("top-level floor conflicts with directTier");
  }
  input["directTier"] = floor;
  delete input["floor"];
}

function normalizeCapabilityAlias(input: Record<string, unknown>): void {
  if (!("selectedCapabilities" in input)) {
    return;
  }
  const selected = input["selectedCapabilities"];
  if (!Array.isArray(selected) || selected.length > 16) {
    throw new Error("selectedCapabilities must be an array with at most 16 entries");
  }
  const normalized = parseCapabilities(
    selected.map((entry) => (typeof entry === "string" ? { kind: "skill", name: entry } : entry)),
  );
  if (input["capabilities"] !== undefined) {
    const canonical = parseCapabilities(input["capabilities"]);
    if (!isDeepStrictEqual(canonical, normalized)) {
      throw new Error("selectedCapabilities conflicts with capabilities");
    }
  } else {
    input["capabilities"] = normalized;
  }
  delete input["selectedCapabilities"];
}

function normalizeFlatLimits(input: Record<string, unknown>): void {
  const present = FLAT_LIMIT_KEYS.filter((key) => key in input);
  if (present.length === 0) {
    return;
  }
  const limits =
    input["limits"] === undefined ? {} : { ...requireRecord(input["limits"], "limits") };
  for (const key of present) {
    if (key in limits && !isDeepStrictEqual(limits[key], input[key])) {
      throw new Error(`top-level ${key} conflicts with limits.${key}`);
    }
    limits[key] = input[key];
    delete input[key];
  }
  input["limits"] = limits;
}

function normalizeDomainAlias(input: Record<string, unknown>): void {
  if (input["domain"] === undefined) {
    return;
  }
  if (typeof input["domain"] !== "string" || input["domain"].trim().length === 0) {
    throw new Error("invalid domain");
  }
  input["domain"] = canonicalDomain(input["domain"]);
}

function canonicalDomain(value: string): TaskDomain {
  if (DOMAIN_VALUES.includes(value as TaskDomain)) {
    return value as TaskDomain;
  }
  const lower = value.trim().toLowerCase();
  const compact = lower.replace(/[\s_-]+/gu, "");
  if (
    compact.includes("autoresearch") ||
    compact.includes("automatedresearch") ||
    /自动调研/u.test(compact)
  ) {
    return "autoResearch";
  }
  if (/\b(?:paper|manuscript|thesis)\b/u.test(lower) || /论文|稿件|学术写作/u.test(compact)) {
    return "paper";
  }
  if (
    /\b(?:algorithm|algorithms|math|mathematics)\b/u.test(lower) ||
    /算法|数学|计算题/u.test(compact)
  ) {
    return "algorithm";
  }
  if (
    /(?:spreadsheet|presentation|powerpoint|excel|office)/u.test(lower) ||
    /办公|表格|幻灯片|演示文稿/u.test(compact)
  ) {
    return "office";
  }
  if (
    /(?:research|investigat|survey|review|synthesis)/u.test(lower) ||
    /调研|研究|检索|综述|综合/u.test(compact)
  ) {
    return "research";
  }
  if (
    /(?:code|software|repository|program|frontend|backend)/u.test(lower) ||
    /代码|软件|仓库|前端|后端/u.test(compact)
  ) {
    return "coding";
  }
  return "general";
}

function normalizePermissionAliases(input: Record<string, unknown>): void {
  if (input["hostAccess"] !== undefined) {
    input["hostAccess"] = canonicalHostAccess(input["hostAccess"]);
  }
  if (input["hostApproval"] !== undefined) {
    input["hostApproval"] = canonicalHostApproval(input["hostApproval"]);
  }
}

function canonicalHostAccess(value: unknown): "readOnly" | "workspaceWrite" | "fullAccess" {
  if (typeof value !== "string") {
    throw new Error("hostAccess must be readOnly, workspaceWrite, or fullAccess");
  }
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "");
  if (compact === "readonly") {
    return "readOnly";
  }
  if (compact === "workspacewrite" || compact === "workspace") {
    return "workspaceWrite";
  }
  if (
    compact === "fullaccess" ||
    compact === "dangerfullaccess" ||
    compact === "unrestricted" ||
    compact === "disabled"
  ) {
    return "fullAccess";
  }
  throw new Error("hostAccess must be readOnly, workspaceWrite, or fullAccess");
}

function canonicalHostApproval(value: unknown): "never" | "approveForMe" {
  if (typeof value !== "string") {
    throw new Error("hostApproval must be never or approveForMe");
  }
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "");
  if (compact === "never") {
    return "never";
  }
  if (compact === "approveforme" || compact === "onrequest" || compact === "approve") {
    return "approveForMe";
  }
  throw new Error("hostApproval must be never or approveForMe");
}

function normalizePlanAliases(input: Record<string, unknown>): void {
  const risk = input["risk"];
  const merge = input["merge"];
  if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high") {
    throw new Error("misplaced risk must be low, medium, or high");
  }
  if (merge !== undefined && merge !== "deterministic" && merge !== "terra") {
    throw new Error("misplaced merge must be deterministic or terra");
  }
  if (input["strategy"] !== "fanout") {
    delete input["risk"];
    delete input["merge"];
    if ("access" in input) {
      const access = canonicalHostAccess(input["access"]);
      if (input["hostAccess"] !== undefined && input["hostAccess"] !== access) {
        throw new Error("top-level access conflicts with hostAccess");
      }
      input["hostAccess"] = access;
      delete input["access"];
    }
    return;
  }
  const planKeys = ["access", "merge", "risk", "tasks"] as const;
  if (!planKeys.some((key) => key in input)) {
    return;
  }
  const semanticPlan =
    input["semanticPlan"] === undefined
      ? {}
      : { ...requireRecord(input["semanticPlan"], "semanticPlan") };
  for (const key of planKeys) {
    if (!(key in input)) {
      continue;
    }
    const value = key === "access" ? canonicalPlanAccess(input[key]) : input[key];
    if (key in semanticPlan && !isDeepStrictEqual(semanticPlan[key], value)) {
      throw new Error(`top-level ${key} conflicts with semanticPlan.${key}`);
    }
    semanticPlan[key] = value;
    delete input[key];
  }
  input["semanticPlan"] = semanticPlan;
}

function canonicalPlanAccess(value: unknown): "readOnly" | "workspaceWrite" {
  const access = canonicalHostAccess(value);
  return access === "readOnly" ? "readOnly" : "workspaceWrite";
}

function parseResumeInput(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("input must be a string");
  }
  if (Buffer.byteLength(value, "utf8") > 4_096) {
    throw new Error("input must not exceed 4 KiB");
  }
  return value;
}

function rejectUnknownArgument(
  input: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw new Error(`unknown agent_trio argument: ${extra}`);
  }
}

function parseCapabilities(value: unknown): CapabilityRef[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("capabilities must be an array with at most 16 entries");
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `capabilities[${index}]`);
    const extra = Object.keys(record).find(
      (key) => key !== "kind" && key !== "name" && key !== "path",
    );
    if (extra !== undefined) {
      throw new Error(`unknown capabilities[${index}] property: ${extra}`);
    }
    const kind = record["kind"];
    if (kind !== "skill" && kind !== "plugin") {
      throw new Error(`capabilities[${index}].kind must be skill or plugin`);
    }
    const name = requiredString(record["name"], `capabilities[${index}].name`, 256);
    const path = record["path"];
    if (path !== undefined && (typeof path !== "string" || !isAbsolute(path))) {
      throw new Error(`capabilities[${index}].path must be absolute`);
    }
    if (kind === "plugin" && path !== undefined) {
      throw new Error(`capabilities[${index}] plugin cannot include path`);
    }
    return {
      kind,
      name,
      ...(path === undefined ? {} : { path }),
    };
  });
}

function parseLimits(value: unknown): Partial<ExecutionLimits> {
  const record = requireRecord(value, "limits");
  const allowed = new Set([
    "maxConcurrent",
    "maxLeaves",
    "maxWaves",
    "maxSolLeaves",
    "maxReplans",
    "deadlineMs",
    "maxCostUsd",
  ]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw new Error(`unknown execution limit: ${extra}`);
  }
  const result: Partial<ExecutionLimits> = {};
  for (const key of allowed) {
    const current = record[key];
    if (current !== undefined) {
      if (typeof current !== "number" || !Number.isFinite(current)) {
        throw new Error(`${key} must be a finite number`);
      }
      result[key as keyof ExecutionLimits] = current;
    }
  }
  return result;
}

function assertWorkspaceRoot(
  cwd: string,
  roots: readonly string[],
  rootsAreAuthoritative: boolean,
): void {
  if (!isAbsolute(cwd)) {
    throw new Error("cwd must be absolute");
  }
  const realCwd = realpathSync(cwd);
  if (!rootsAreAuthoritative) {
    return;
  }
  if (roots.length === 0) {
    throw new Error("MCP client advertised workspace roots but did not provide any");
  }
  if (!roots.some((root) => isWithin(root, realCwd))) {
    throw new Error(`cwd is outside the MCP workspace roots: ${cwd}`);
  }
}

function compactResult(result: BatchResult): BatchResult {
  const compact = structuredClone(result);
  compact.finalResponse = truncate(compact.finalResponse, 24_000);
  compact.leaves = compact.leaves.map((leaf) => ({
    ...leaf,
    summary: truncate(leaf.summary, 4_000) ?? "",
    findings: leaf.findings.slice(0, 20).map((finding) => ({
      ...finding,
      text: truncate(finding.text, 1_000) ?? "",
    })),
    citations: leaf.citations.slice(0, 32),
    messages: [],
  }));
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= MAX_RESULT_BYTES) {
    return compact;
  }
  compact.finalResponse = truncate(compact.finalResponse, 8_000);
  compact.leaves = compact.leaves.map((leaf) => ({
    ...leaf,
    summary: truncate(leaf.summary, 1_000) ?? "",
    findings: leaf.findings.slice(0, 5),
    citations: leaf.citations.slice(0, 8),
    usage: [],
  }));
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") > MAX_RESULT_BYTES) {
    throw new Error("agent_trio result exceeds the 64 KiB transport limit");
  }
  return compact;
}

function monitorToolResult(
  result: BatchResult,
  update: MonitorDataUpdate,
): Record<string, unknown> {
  const stored = isRecord(update.snapshot) ? update.snapshot : {};
  const request = isRecord(stored["request"]) ? stored["request"] : {};
  const requestProjection = {
    objective: boundedText(
      typeof request["objective"] === "string" ? request["objective"] : "",
      1_500,
    ),
  };
  const base = {
    runId: result.runId,
    status: result.status,
    finalResponse: null,
    needsAction: boundedBytes(result.needsAction, 2_000),
    error: boundedBytes(result.error, 2_000),
  };
  const detailed = {
    ...base,
    monitor: {
      snapshot: {
        request: requestProjection,
        result: monitorResultProjection(result),
        remoteTurns: monitorRemoteTurns(stored["remoteTurns"]),
        updatedAt: update.revision,
      },
      events: update.events.map(compactMonitorEvent),
      nextCursor: update.nextCursor,
      hasMore: update.hasMore,
      revision: update.revision,
    },
  };
  if (serializedBytes(detailed) <= MAX_MONITOR_STRUCTURED_BYTES) {
    return detailed;
  }

  const events = update.events.map((event) => compactMonitorEvent(event, 2_000));
  const compact = {
    ...base,
    monitor: {
      snapshot: {
        request: { objective: boundedText(requestProjection.objective, 500) },
        result: monitorResultProjection(result, true),
        remoteTurns: monitorRemoteTurns(stored["remoteTurns"], true),
        updatedAt: update.revision,
      },
      events,
      nextCursor: update.nextCursor,
      hasMore: update.hasMore,
      revision: update.revision,
    },
  };
  let omitted = 0;
  while (events.length > 0 && serializedBytes(compact) > MAX_MONITOR_STRUCTURED_BYTES) {
    events.shift();
    omitted += 1;
  }
  if (omitted > 0) {
    events.unshift({
      type: "monitor",
      data: { truncated: true, omittedEvents: omitted },
    });
  }
  if (serializedBytes(compact) <= MAX_MONITOR_STRUCTURED_BYTES) {
    return compact;
  }
  return {
    ...base,
    monitor: {
      snapshot: {
        request: { objective: boundedBytes(requestProjection.objective, 500) ?? "" },
        result: {
          runId: result.runId,
          status: result.status,
          plan: null,
          leaves: [],
          finalResponse: null,
          metrics:
            result.metrics === null
              ? null
              : {
                  startedAt: result.metrics.startedAt,
                  elapsedMs: result.metrics.elapsedMs,
                  profile: result.metrics.profile,
                  estimatedCostUsd: result.metrics.estimatedCostUsd,
                  peakConcurrency: result.metrics.peakConcurrency,
                  routeReason: boundedBytes(result.metrics.routeReason, 500) ?? "",
                  routeSource: result.metrics.routeSource,
                  selectedDomain: result.metrics.selectedDomain,
                  selectedLeafCount: result.metrics.selectedLeafCount,
                  selectedWaveCount: result.metrics.selectedWaveCount,
                  estimatedSerialSeconds: result.metrics.estimatedSerialSeconds,
                  estimatedCriticalPathSeconds: result.metrics.estimatedCriticalPathSeconds,
                },
          needsAction: base.needsAction,
          error: base.error,
        },
        remoteTurns: [],
        updatedAt: boundedBytes(update.revision, 128) ?? "",
      },
      events: [{ type: "monitor", data: { truncated: true, omittedEvents: update.events.length } }],
      nextCursor: update.nextCursor,
      hasMore: update.hasMore,
      revision: boundedBytes(update.revision, 128) ?? "",
    },
  };
}

function compactMonitorEvent(value: unknown, maxBytes = 12 * 1024): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return value;
  }
  if (!isRecord(value)) {
    return { type: "monitor", data: { truncated: true } };
  }
  return {
    ...value,
    data: {
      truncated: true,
      preview: boundedText(serialized, Math.max(0, maxBytes - 512)),
    },
  };
}

function monitorResultProjection(result: BatchResult, compact = false): Record<string, unknown> {
  const plan =
    result.plan === null
      ? null
      : {
          planId: boundedText(result.plan.planId, 128),
          domain: result.plan.domain,
          risk: result.plan.risk,
          origin: result.plan.origin,
          tasks: result.plan.tasks.slice(0, 20).map((task) => ({
            id: boundedText(task.id, compact ? 96 : 128),
            objective: boundedText(task.objective, compact ? 160 : 400),
            tier: task.tier,
            effort: task.effort,
            ownedPaths: compact
              ? []
              : task.ownedPaths.slice(0, 3).map((path) => boundedText(path, 160)),
            dependsOn: compact ? [] : task.dependsOn.slice(0, 8).map((id) => boundedText(id, 128)),
            validation: compact
              ? []
              : task.validation.slice(0, 2).map((item) => ({
                  command: boundedText(item.command, 240),
                })),
          })),
          integration: {
            requiredOutputs: result.plan.integration.requiredOutputs
              .slice(0, compact ? 4 : 8)
              .map((output) => boundedText(output, compact ? 120 : 240)),
          },
        };
  const metrics =
    result.metrics === null
      ? null
      : {
          startedAt: result.metrics.startedAt,
          profile: result.metrics.profile,
          elapsedMs: result.metrics.elapsedMs,
          estimatedCostUsd: result.metrics.estimatedCostUsd,
          peakConcurrency: result.metrics.peakConcurrency,
          routeReason: boundedText(result.metrics.routeReason ?? "", 500),
          routeSource: result.metrics.routeSource,
          selectedDomain: result.metrics.selectedDomain,
          selectedLeafCount: result.metrics.selectedLeafCount,
          selectedWaveCount: result.metrics.selectedWaveCount,
          selectedTierCounts: result.metrics.selectedTierCounts,
          estimatedSerialSeconds: result.metrics.estimatedSerialSeconds,
          estimatedCriticalPathSeconds: result.metrics.estimatedCriticalPathSeconds,
          estimatedCostRatio: result.metrics.estimatedCostRatio,
          estimatedLatencyRatio: result.metrics.estimatedLatencyRatio,
          predictionCostErrorRatio: result.metrics.predictionCostErrorRatio,
          predictionLatencyErrorRatio: result.metrics.predictionLatencyErrorRatio,
          totalTokens: result.metrics.usage.reduce(
            (sum, item) => sum + Number(item.totalTokens ?? 0),
            0,
          ),
        };
  return {
    runId: result.runId,
    status: result.status,
    plan,
    leaves: result.leaves.slice(0, 20).map((leaf) => ({
      taskId: boundedText(leaf.taskId, 128),
      status: leaf.status,
      confidence: leaf.confidence,
    })),
    finalResponse: null,
    metrics,
    needsAction: boundedText(result.needsAction ?? "", compact ? 500 : 2_000) || null,
    error: boundedText(result.error ?? "", compact ? 500 : 2_000) || null,
  };
}

function monitorRemoteTurns(value: unknown, compact = false): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const latest = new Map<string, Record<string, unknown>>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["role"] !== "string") {
      continue;
    }
    const role = boundedText(entry["role"], 32);
    const taskId = typeof entry["taskId"] === "string" ? boundedText(entry["taskId"], 128) : "";
    latest.set(`${role}\u0000${taskId}`, {
      role,
      ...(taskId.length === 0 ? {} : { taskId }),
      threadId: typeof entry["threadId"] === "string" ? boundedText(entry["threadId"], 160) : "",
      turnId: typeof entry["turnId"] === "string" ? boundedText(entry["turnId"], 160) : null,
      state: typeof entry["state"] === "string" ? boundedText(entry["state"], 32) : "running",
      updatedAt: typeof entry["updatedAt"] === "string" ? boundedText(entry["updatedAt"], 64) : "",
    });
  }
  return [...latest.values()].slice(compact ? -24 : -32);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedBytes(value: string | undefined, maxBytes: number): string | null {
  return value === undefined ? null : truncate(value, maxBytes);
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function withMonitorLink(result: BatchResult): BatchResult {
  if (
    result.monitorUrl === undefined ||
    result.finalResponse === null ||
    result.finalResponse.includes(result.monitorUrl)
  ) {
    return result;
  }
  return {
    ...result,
    finalResponse: `[Open Agent Trio Monitor](${result.monitorUrl})\n\n${result.finalResponse}`,
  };
}

function progressTokenFrom(params: Record<string, unknown>): string | number | undefined {
  const metadata = isRecord(params["_meta"]) ? params["_meta"] : null;
  const token = metadata?.["progressToken"];
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function truncate(value: string | null, maxBytes: number): string | null {
  if (value === null || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value, "utf8")
    .subarray(0, maxBytes - 3)
    .toString("utf8")}...`;
}

function optionalSafeInteger(value: unknown, name: string, maximum: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${String(maximum)}`);
  }
  return value as number;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${name} must be a string up to ${String(maxLength)} characters`);
  }
  return value;
}

function resolveRoot(root: RootEntry): string[] {
  try {
    if (!root.uri.startsWith("file:")) {
      return [];
    }
    return [realpathSync(fileURLToPath(root.uri))];
  } catch {
    return [];
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isRootEntry(value: unknown): value is RootEntry {
  return isRecord(value) && typeof value["uri"] === "string";
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
