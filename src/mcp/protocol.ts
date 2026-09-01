import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type {
  AgentTrioRequest,
  BatchResult,
  CapabilityRef,
  ExecutionLimits,
  TaskDomain,
} from "../core/contracts.js";
import type { AgentTrioService } from "../core/service.js";
import { hostSemanticPlanJsonSchemaForRoute, parseHostSemanticPlan } from "../core/planner.js";
import { FANOUT_MIN_TASK_SECONDS } from "../core/policy.js";

const MAX_RESULT_BYTES = 64 * 1024;
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

export const AGENT_TRIO_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["run", "submit", "status", "resume", "cancel"] },
    runId: { type: "string", minLength: 1, maxLength: 128 },
    input: { type: "string", maxLength: 4_096 },
    objective: { type: "string", minLength: 1, maxLength: 200_000 },
    cwd: { type: "string", minLength: 1, maxLength: 4_096 },
    strategy: { type: "string", enum: ["auto", "direct", "fanout"] },
    directTier: { type: "string", enum: ["luna", "terra"] },
    domain: { type: "string", enum: DOMAIN_VALUES },
    constraints: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 8_000 },
    },
    capabilities: {
      type: "array",
      maxItems: 16,
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
      if: { required: ["directTier"] },
      then: { properties: { strategy: { const: "direct" } }, required: ["strategy"] },
    },
  ],
} as const;

export const AGENT_TRIO_TOOL_DESCRIPTION = `Run, submit, inspect, resume, or cancel Agent Trio. The result is the complete user-visible delivery; after success, do not repeat finalResponse. For nontrivial work use objective, cwd, and strategy=auto without semanticPlan: the runtime selects cheap direct execution or invokes its internal Sol planner before Luna-first fanout. The root handles one-turn work itself, using its normal workspace tools when needed. One local fix, a finite exact calculation over a handful of local inputs, a targeted rewrite, or another single-deliverable task is direct; a domain label such as algorithm or research is not by itself a reason to call this tool. Do not call merely because partitions exist: call when at least two useful independent leaves are expected to take over ${String(FANOUT_MIN_TASK_SECONDS)} seconds of actual Luna wall time and the predicted complete plan remains below 40% cost and 70% latency. The economic gate, not a fixed total-duration threshold, decides whether several smaller Luna leaves repay Sol planning. A current Sol root may instead supply strategy=fanout and a semanticPlan fast path. Plan from the objective and workspace file index; leave file inspection to the leaves. Use 2-5 independent leaves, preferring finer partitions only when they shorten the critical path. Host plans use exactly semanticPlan={"access":"readOnly","merge":"deterministic","risk":"low","tasks":[{"goal":"short bounded goal","paths":["relative/path"],"after":[],"floor":null,"expectedSeconds":90}]}. Tasks never contain id, task, tier, model, effort, checks, or the repeated full objective. Omit capabilities unless exact structured capability objects were supplied. status/resume/cancel require runId.`;

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
}

export class AgentTrioMcpProtocol {
  readonly #service: Pick<AgentTrioService, "handle">;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #onError: (error: Error) => void;
  readonly #workspaceRoots: string[] | null;
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
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "agent-trio", version: "3.1.0" },
          });
          return;
        }
        case "ping":
          this.#writeResult(request.id, {});
          return;
        case "resources/list":
          this.#writeResult(request.id, { resources: [] });
          return;
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
    if (parsed.action === "run" || parsed.action === "submit") {
      const roots = this.#workspaceRoots ?? this.#roots ?? (await this.#rootsPromise);
      assertWorkspaceRoot(parsed.cwd, roots);
    }
    try {
      const result = compactResult(await this.#service.handle(parsed));
      this.#writeResult(request.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              runId: result.runId,
              status: result.status,
              finalResponse: result.finalResponse,
              needsAction: result.needsAction ?? null,
              error: result.error ?? null,
            }),
          },
        ],
        structuredContent: result,
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

export function parseAgentTrioRequest(value: unknown): AgentTrioRequest {
  const input = requireRecord(value, "agent_trio arguments");
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
      action === "resume" ? ["action", "runId", "input"] : ["action", "runId"],
    );
    rejectUnknownArgument(input, allowed);
    const runId = requiredString(input["runId"], "runId", 128);
    if (action !== "resume") {
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
    "strategy",
    "directTier",
    "domain",
    "constraints",
    "capabilities",
    "semanticPlan",
    "limits",
    "integrate",
  ]);
  rejectUnknownArgument(input, allowed);
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
  const semanticPlan =
    input["semanticPlan"] === undefined
      ? undefined
      : parseHostSemanticPlan(input["semanticPlan"], "fanout", 20);
  const strategy = input["strategy"];
  if (strategy !== undefined && !["auto", "direct", "fanout"].includes(strategy as string)) {
    throw new Error("strategy must be auto, direct, or fanout");
  }
  const directTier = input["directTier"];
  if (directTier !== undefined && directTier !== "luna" && directTier !== "terra") {
    throw new Error("directTier must be luna or terra");
  }
  if (directTier !== undefined && strategy !== "direct") {
    throw new Error("directTier requires strategy=direct");
  }
  if (semanticPlan !== undefined && strategy !== "fanout") {
    throw new Error("semanticPlan requires strategy=fanout");
  }
  const limits = input["limits"] === undefined ? undefined : parseLimits(input["limits"]);
  if (input["integrate"] !== undefined && typeof input["integrate"] !== "boolean") {
    throw new Error("integrate must be boolean");
  }
  return {
    action,
    objective: requiredString(input["objective"], "objective", 200_000),
    cwd: requiredString(input["cwd"], "cwd", 4_096),
    ...(input["runId"] === undefined
      ? {}
      : { runId: requiredString(input["runId"], "runId", 128) }),
    ...(domain === undefined ? {} : { domain: domain as TaskDomain }),
    ...(strategy === undefined ? {} : { strategy: strategy as "auto" | "direct" | "fanout" }),
    ...(directTier === undefined ? {} : { directTier: directTier as "luna" | "terra" }),
    ...(constraints === undefined ? {} : { constraints: [...constraints] as string[] }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(semanticPlan === undefined ? {} : { semanticPlan }),
    ...(limits === undefined ? {} : { limits }),
    ...(input["integrate"] === undefined ? {} : { integrate: input["integrate"] as boolean }),
  };
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

function assertWorkspaceRoot(cwd: string, roots: readonly string[]): void {
  if (roots.length === 0) {
    throw new Error("MCP client did not provide workspace roots");
  }
  if (!isAbsolute(cwd)) {
    throw new Error("cwd must be absolute");
  }
  const realCwd = realpathSync(cwd);
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

function truncate(value: string | null, maxBytes: number): string | null {
  if (value === null || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value, "utf8")
    .subarray(0, maxBytes - 3)
    .toString("utf8")}...`;
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
