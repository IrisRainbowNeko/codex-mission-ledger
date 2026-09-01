import { describe, expect, it, vi } from "vitest";
import {
  AppServerTerraCoordinator,
  AppServerTerraIntegrator,
  TERRA_COORDINATOR_OUTPUT_SCHEMA,
  parseTerraCoordinatorBody,
} from "../src/app-server/index.js";
import type {
  AppServer,
  AppServerNotification,
  InitializeResponse,
  JsonValue,
  ModelListParams,
  ModelListResponse,
  NotificationHandler,
  NotificationWaitOptions,
  RequestOptions,
  ServerRequestHandler,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdated,
  ThreadUsageResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "../src/app-server/types.js";
import type { ExecutionPlan, RemoteTurnRef } from "../src/core/contracts.js";

const INITIALIZED: InitializeResponse = {
  userAgent: "codex_app_server/0.151.0",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

interface QueuedTurn {
  output: unknown;
  beforeCompletion?: (server: FakeAppServer, threadId: string, turnId: string) => Promise<void>;
  failAfterAccept?: Error;
}

class FakeAppServer implements AppServer {
  state = "ready" as const;
  initializeResult: InitializeResponse | null = INITIALIZED;
  readonly threadStarts: ThreadStartParams[] = [];
  readonly threadResumes: ThreadResumeParams[] = [];
  readonly turnStarts: TurnStartParams[] = [];
  readonly interrupts: TurnInterruptParams[] = [];
  readonly handlers = new Map<string, ServerRequestHandler>();
  readonly queued: QueuedTurn[] = [];
  readonly turnsByThread = new Map<string, JsonValue[]>();
  readonly latestUsage = new Map<string, ThreadTokenUsageUpdated>();
  readonly costMicros = new Map<string, number>();
  #thread = 0;
  #turn = 0;
  #subscriptions = new Set<{ method: string | null; handler: NotificationHandler }>();

  connect = vi.fn(async () => INITIALIZED);
  reconnect = vi.fn(async () => INITIALIZED);
  close = vi.fn(async () => undefined);

  request<TResult = JsonValue>(
    _method: string,
    _params?: unknown,
    _options?: RequestOptions,
  ): Promise<TResult> {
    return Promise.reject(new Error("generic request not implemented"));
  }

  notify(_method: string, _params?: unknown): Promise<void> {
    return Promise.resolve();
  }

  onNotification(handler: NotificationHandler): () => void;
  onNotification(method: string, handler: NotificationHandler): () => void;
  onNotification(
    methodOrHandler: string | NotificationHandler,
    maybeHandler?: NotificationHandler,
  ): () => void {
    const subscription =
      typeof methodOrHandler === "string"
        ? { method: methodOrHandler, handler: maybeHandler as NotificationHandler }
        : { method: null, handler: methodOrHandler };
    this.#subscriptions.add(subscription);
    return () => this.#subscriptions.delete(subscription);
  }

  waitForNotification(
    _method?: string,
    _options?: NotificationWaitOptions,
  ): Promise<AppServerNotification> {
    return Promise.reject(new Error("not implemented"));
  }

  setServerRequestHandler(method: string, handler: ServerRequestHandler | null): void {
    if (handler === null) {
      this.handlers.delete(method);
    } else {
      this.handlers.set(method, handler);
    }
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    this.threadStarts.push(params);
    const id = `thread-${++this.#thread}`;
    this.turnsByThread.set(id, []);
    this.costMicros.set(id, 0);
    return {
      thread: { id },
      model: params.model ?? "",
      modelProvider: params.modelProvider ?? "test",
      cwd: params.cwd ?? "/workspace",
      instructionSources: [],
    };
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    this.threadResumes.push(params);
    this.turnsByThread.set(params.threadId, this.turnsByThread.get(params.threadId) ?? []);
    this.costMicros.set(params.threadId, this.costMicros.get(params.threadId) ?? 10_000);
    return {
      thread: { id: params.threadId },
      model: params.model ?? "gpt-5.6-terra",
      modelProvider: params.modelProvider ?? "test",
      cwd: params.cwd ?? "/workspace",
      instructionSources: [],
    };
  }

  async threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return {
      thread: {
        id: params.threadId,
        turns: params.includeTurns === true ? (this.turnsByThread.get(params.threadId) ?? []) : [],
      },
    };
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    this.turnStarts.push(params);
    const queued = this.queued.shift();
    if (queued === undefined) {
      throw new Error("no queued turn");
    }
    const turnId = `turn-${++this.#turn}`;
    const turn = {
      id: turnId,
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: `message-${turnId}`,
          text: typeof queued.output === "string" ? queued.output : JSON.stringify(queued.output),
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
        },
      ],
      itemsView: { type: "all" },
      error: null,
      startedAt: 1_787_875_200,
      completedAt: 1_787_875_201,
      durationMs: 1_000,
    };
    this.turnsByThread.get(params.threadId)?.push(turn as JsonValue);
    this.costMicros.set(params.threadId, (this.costMicros.get(params.threadId) ?? 0) + 10_000);
    this.latestUsage.set(params.threadId, {
      threadId: params.threadId,
      turnId,
      tokenUsage: {
        total: tokenBreakdown(this.#turn * 120),
        last: tokenBreakdown(120),
        modelContextWindow: 128_000,
      },
    });
    await queued.beforeCompletion?.(this, params.threadId, turnId);
    if (queued.failAfterAccept !== undefined) {
      throw queued.failAfterAccept;
    }
    this.emit("turn/completed", { threadId: params.threadId, turn });
    return { turn: { id: turnId } };
  }

  turnSteer(_params: TurnSteerParams): Promise<TurnSteerResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    this.interrupts.push(params);
    return {};
  }

  async threadUsage(threadId: string): Promise<ThreadUsageResponse> {
    return {
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
      threadUsage: {
        threadId,
        estimatedUsageCreditsMicros: 0,
        estimatedUsageUsdMicros: this.costMicros.get(threadId) ?? 0,
        groups: [],
      },
    };
  }

  modelList(_params?: ModelListParams): Promise<ModelListResponse> {
    return Promise.resolve({ data: [], nextCursor: null });
  }

  latestThreadTokenUsage(threadId: string): ThreadTokenUsageUpdated | null {
    return this.latestUsage.get(threadId) ?? null;
  }

  async callServerHandler(method: string, params: JsonValue): Promise<JsonValue> {
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      throw new Error(`missing handler ${method}`);
    }
    return handler({ id: "request-1", method, params }, new AbortController().signal);
  }

  emit(method: string, params: JsonValue): void {
    for (const subscription of this.#subscriptions) {
      if (subscription.method === null || subscription.method === method) {
        void subscription.handler({ method, params });
      }
    }
  }
}

function tokenBreakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
  };
}

function outcomeBody(response = "done") {
  return {
    status: "completed",
    response,
    validation: [],
    needsAction: null,
    error: null,
  };
}

function coordinatorBody(overrides: Record<string, unknown> = {}) {
  return {
    route: "fanout",
    reason: "two independent packages",
    outcome: null,
    needsAction: null,
    requiredCapabilities: [],
    ...overrides,
  };
}

function request() {
  return { objective: "inspect two independent modules", cwd: "/workspace" };
}

function plan(): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    objective: "inspect two independent modules",
    domain: "coding",
    assumptions: [],
    tasks: [],
    integration: {
      objective: "integrate results",
      requiredOutputs: ["answer"],
      validation: [],
      finalReview: "never",
    },
    risk: "low",
  };
}

describe("AppServerTerraCoordinator", () => {
  it("routes difficult non-decomposable work to planned_single", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: coordinatorBody({
        route: "planned_single",
        reason: "one highly ambiguous algorithm needs Sol planning",
      }),
    });
    const coordinator = new AppServerTerraCoordinator({ appServer: server, cwd: "/workspace" });

    const decision = await coordinator.decide({
      runId: "run-planned-single",
      request: { objective: "prove a difficult algorithm", cwd: "/workspace" },
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      route: "planned_single",
      reason: "one highly ambiguous algorithm needs Sol planning",
      threadId: "thread-1",
    });
    expect(server.turnStarts[0]?.outputSchema).toMatchObject({
      properties: {
        route: { enum: ["direct", "fanout", "planned_single", "waiting_input"] },
      },
    });
  });

  it("marks admission indeterminate when turn/start acceptance is uncertain", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: coordinatorBody(),
      failAfterAccept: new Error("turn/start response lost"),
    });
    const coordinator = new AppServerTerraCoordinator({ appServer: server, cwd: "/workspace" });

    const result = await coordinator.decide({
      runId: "run-indeterminate",
      request: { objective: "modify files", cwd: "/workspace" },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      route: "direct",
      outcome: {
        status: "indeterminate",
        threadId: "thread-1",
        error: "turn/start response lost",
      },
    });
    expect(server.interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
  });

  it("returns a completed direct outcome from the admission turn with real usage", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: coordinatorBody({
        route: "direct",
        reason: "small coupled task",
        outcome: outcomeBody("completed in admission"),
      }),
    });
    const coordinator = new AppServerTerraCoordinator({
      appServer: server,
      cwd: "/workspace",
    });

    const decision = await coordinator.decide({
      runId: "run-direct",
      request: request(),
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      route: "direct",
      reason: "small coupled task",
      threadId: "thread-1",
      outcome: {
        status: "completed",
        response: "completed in admission",
        threadId: "thread-1",
        usage: [
          {
            model: "gpt-5.6-terra",
            tier: "terra",
            effort: "medium",
            cachedInputTokens: 40,
            uncachedInputTokens: 60,
            outputTokens: 20,
            totalTokens: 120,
            estimatedCostUsd: 0.01,
          },
        ],
      },
    });
    expect(decision).not.toHaveProperty("usage");
    expect(server.threadStarts[0]).toMatchObject({
      model: "gpt-5.6-terra",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      dynamicTools: [],
      threadSource: "agent-trio-v3-coordinator",
      config: {
        agents: { enabled: false },
        features: { multi_agent: false },
        project_doc_max_bytes: 0,
        mcp_servers: { hierarchical_codex: { enabled: false } },
      },
    });
    expect(server.turnStarts[0]?.outputSchema).toEqual(TERRA_COORDINATOR_OUTPUT_SCHEMA);
  });

  it("loads an explicitly requested direct skill in the single admission turn", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: coordinatorBody({
        route: "direct",
        reason: "small document task",
        outcome: outcomeBody("document updated"),
      }),
    });
    const resolve = vi.fn(async () => ({
      skills: [
        {
          kind: "skill" as const,
          name: "documents",
          path: "/capabilities/documents/SKILL.md",
          pluginId: null,
        },
      ],
      plugins: [],
      requiresIsolatedProcess: false,
    }));
    const coordinator = new AppServerTerraCoordinator({
      appServer: server,
      cwd: "/workspace",
      capabilityResolver: { resolve },
    });

    const decision = await coordinator.decide({
      runId: "run-direct-skill",
      request: {
        objective: "update the document",
        cwd: "/workspace",
        capabilities: [{ kind: "skill", name: "documents" }],
      },
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      route: "direct",
      outcome: { status: "completed", response: "document updated" },
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(server.threadStarts).toHaveLength(1);
    expect(server.turnStarts).toHaveLength(1);
    expect(server.turnStarts[0]?.input).toContainEqual({
      type: "skill",
      name: "documents",
      path: "/capabilities/documents/SKILL.md",
    });
  });

  it("omits unique skill paths from the admission catalog and keeps ambiguous paths", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: coordinatorBody() });
    const coordinator = new AppServerTerraCoordinator({
      appServer: server,
      cwd: "/workspace",
      capabilityCatalog: {
        listSkills: async () => [
          {
            name: "documents",
            path: "/capabilities/documents/SKILL.md",
            enabled: true,
            pluginId: null,
          },
          {
            name: "browser",
            path: "/capabilities/browser-a/SKILL.md",
            enabled: true,
            pluginId: null,
          },
          {
            name: "browser",
            path: "/capabilities/browser-b/SKILL.md",
            enabled: true,
            pluginId: "browser-plugin",
          },
          {
            name: "agent-trio",
            path: "/capabilities/agent-trio/SKILL.md",
            enabled: true,
            pluginId: null,
          },
          {
            name: "disabled",
            path: "/capabilities/disabled/SKILL.md",
            enabled: false,
            pluginId: null,
          },
        ],
        listPlugins: async () => [
          { id: "browser-plugin", enabled: true },
          { id: "disabled-plugin", enabled: false },
        ],
      },
    });

    await coordinator.decide({
      runId: "run-capability-catalog",
      request: request(),
      signal: new AbortController().signal,
    });

    const promptInput = server.turnStarts[0]?.input[0];
    if (promptInput?.type !== "text") {
      throw new Error("Terra admission prompt was not text");
    }
    const serializedInput = promptInput.text.split("\n").at(-1);
    if (serializedInput === undefined) {
      throw new Error("Terra admission prompt omitted its serialized input");
    }
    const prompt = JSON.parse(serializedInput) as { availableCapabilities: unknown };
    expect(prompt.availableCapabilities).toEqual([
      { kind: "skill", name: "documents" },
      {
        kind: "skill",
        name: "browser",
        path: "/capabilities/browser-a/SKILL.md",
      },
      {
        kind: "skill",
        name: "browser",
        path: "/capabilities/browser-b/SKILL.md",
      },
      { kind: "plugin", name: "browser-plugin" },
    ]);
  });

  it("runs an explicitly requested plugin in an isolated server and closes it", async () => {
    const shared = new FakeAppServer();
    const isolated = new FakeAppServer();
    isolated.queued.push({
      output: coordinatorBody({
        route: "direct",
        reason: "small browser task",
        outcome: outcomeBody("browser task complete"),
      }),
    });
    const create = vi.fn(async () => isolated);
    const coordinator = new AppServerTerraCoordinator({
      appServer: shared,
      cwd: "/workspace",
      capabilityResolver: {
        resolve: async () => ({
          skills: [],
          plugins: [{ kind: "plugin", name: "browser@openai-bundled" }],
          requiresIsolatedProcess: true,
        }),
      },
      isolatedServerFactory: { create },
    });

    const decision = await coordinator.decide({
      runId: "run-direct-plugin",
      request: {
        objective: "inspect the browser page",
        cwd: "/workspace",
        capabilities: [{ kind: "plugin", name: "browser@openai-bundled" }],
      },
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      route: "direct",
      outcome: { status: "completed", response: "browser task complete" },
    });
    expect(shared.threadStarts).toHaveLength(0);
    expect(isolated.threadStarts).toHaveLength(1);
    expect(create).toHaveBeenCalledWith({
      cwd: "/workspace",
      capabilities: expect.objectContaining({ requiresIsolatedProcess: true }),
    });
    expect(isolated.close).toHaveBeenCalledOnce();
    expect(shared.close).not.toHaveBeenCalled();
  });

  it("creates an isolated server lazily when admission selects a plugin-backed skill", async () => {
    const shared = new FakeAppServer();
    const isolated = new FakeAppServer();
    shared.queued.push({
      output: coordinatorBody({
        route: "direct",
        reason: "document capability required",
        outcome: null,
        requiredCapabilities: [
          { kind: "skill", name: "documents", path: "/plugins/documents/SKILL.md" },
        ],
      }),
    });
    isolated.queued.push({ output: outcomeBody("document complete") });
    const resolve = vi.fn(async (requested: readonly { name: string }[]) =>
      requested.length === 0
        ? { skills: [], plugins: [], requiresIsolatedProcess: false }
        : {
            skills: [
              {
                kind: "skill" as const,
                name: "documents",
                path: "/plugins/documents/SKILL.md",
                pluginId: "documents@openai-primary-runtime",
              },
            ],
            plugins: [],
            requiresIsolatedProcess: true,
          },
    );
    const create = vi.fn(async () => isolated);
    const coordinator = new AppServerTerraCoordinator({
      appServer: shared,
      cwd: "/workspace",
      capabilityCatalog: {
        listSkills: async () => [
          {
            name: "documents",
            path: "/plugins/documents/SKILL.md",
            enabled: true,
            pluginId: "documents@openai-primary-runtime",
          },
        ],
        listPlugins: async () => [],
      },
      capabilityResolver: { resolve },
      isolatedServerFactory: { create },
    });
    const input = {
      runId: "run-auto-capability",
      request: { objective: "update the document", cwd: "/workspace" },
      signal: new AbortController().signal,
    };

    const decision = await coordinator.decide(input);

    expect(decision).toMatchObject({ route: "direct", threadId: "thread-1" });
    expect(create).not.toHaveBeenCalled();
    expect(isolated.threadStarts).toHaveLength(0);

    const outcome = await coordinator.execute(input);

    expect(outcome).toMatchObject({
      status: "completed",
      response: "document complete",
      threadId: "thread-1",
    });
    expect(shared.turnStarts).toHaveLength(1);
    expect(isolated.turnStarts).toHaveLength(1);
    expect(isolated.turnStarts[0]?.input).toContainEqual({
      type: "skill",
      name: "documents",
      path: "/plugins/documents/SKILL.md",
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    expect(isolated.close).toHaveBeenCalledOnce();
  });

  it("rejects a plugin capability when isolation returns the shared server", async () => {
    const shared = new FakeAppServer();
    const coordinator = new AppServerTerraCoordinator({
      appServer: shared,
      cwd: "/workspace",
      capabilityResolver: {
        resolve: async () => ({
          skills: [],
          plugins: [{ kind: "plugin", name: "browser@openai-bundled" }],
          requiresIsolatedProcess: true,
        }),
      },
      isolatedServerFactory: { create: async () => shared },
    });

    await expect(
      coordinator.decide({
        runId: "run-bypassed-isolation",
        request: {
          objective: "browse",
          cwd: "/workspace",
          capabilities: [{ kind: "plugin", name: "browser@openai-bundled" }],
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "plugin_isolation_bypassed" });
    expect(shared.threadStarts).toHaveLength(0);
  });

  it("rejects deferred plugin isolation before starting the direct turn", async () => {
    const shared = new FakeAppServer();
    shared.queued.push({
      output: coordinatorBody({
        route: "direct",
        outcome: null,
        requiredCapabilities: [{ kind: "plugin", name: "browser@openai-bundled", path: null }],
      }),
    });
    const coordinator = new AppServerTerraCoordinator({
      appServer: shared,
      cwd: "/workspace",
      capabilityCatalog: {
        listSkills: async () => [],
        listPlugins: async () => [{ id: "browser@openai-bundled", enabled: true }],
      },
      capabilityResolver: {
        resolve: async (requested) => ({
          skills: [],
          plugins:
            requested.length === 0
              ? []
              : [{ kind: "plugin" as const, name: "browser@openai-bundled" }],
          requiresIsolatedProcess: requested.length > 0,
        }),
      },
      isolatedServerFactory: { create: async () => shared },
    });
    const input = {
      runId: "run-deferred-bypassed-isolation",
      request: { objective: "browse", cwd: "/workspace" },
      signal: new AbortController().signal,
    };

    await expect(coordinator.decide(input)).resolves.toMatchObject({ route: "direct" });
    await expect(coordinator.execute(input)).rejects.toMatchObject({
      code: "plugin_isolation_bypassed",
    });
    expect(shared.threadStarts).toHaveLength(1);
  });

  it("rejects an admission-selected capability that the resolver does not authorize", async () => {
    const shared = new FakeAppServer();
    shared.queued.push({
      output: coordinatorBody({
        route: "direct",
        outcome: null,
        requiredCapabilities: [{ kind: "plugin", name: "browser@openai-bundled", path: null }],
      }),
    });
    const coordinator = new AppServerTerraCoordinator({
      appServer: shared,
      cwd: "/workspace",
      capabilityCatalog: {
        listSkills: async () => [],
        listPlugins: async () => [{ id: "browser@openai-bundled", enabled: true }],
      },
      capabilityResolver: {
        resolve: async (requested) => {
          if (requested.length === 0) {
            return { skills: [], plugins: [], requiresIsolatedProcess: false };
          }
          throw new Error("plugin capabilities are disabled");
        },
      },
    });

    await expect(
      coordinator.decide({
        runId: "run-unauthorized-capability",
        request: { objective: "browse", cwd: "/workspace" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "capability_resolution_failed",
      message: "plugin capabilities are disabled",
    });
    expect(shared.turnStarts).toHaveLength(1);
  });

  it("continues a deferred direct decision on the same thread", async () => {
    const server = new FakeAppServer();
    const checkpoints: Array<{ runId: string; turn: RemoteTurnRef }> = [];
    server.queued.push(
      {
        output: coordinatorBody({
          route: "direct",
          reason: "direct but needs another turn",
          outcome: null,
        }),
      },
      { output: outcomeBody("completed on continuation") },
    );
    const coordinator = new AppServerTerraCoordinator({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn: (runId, turn) => {
        checkpoints.push({ runId, turn });
      },
    });
    const input = {
      runId: "run-deferred",
      request: request(),
      signal: new AbortController().signal,
    };

    const decision = await coordinator.decide(input);
    const outcome = await coordinator.execute(input);

    expect(decision).toMatchObject({
      route: "direct",
      threadId: "thread-1",
      usage: [{ estimatedCostUsd: 0.01 }],
    });
    expect(outcome).toMatchObject({
      status: "completed",
      response: "completed on continuation",
      threadId: "thread-1",
      usage: [{ estimatedCostUsd: 0.01 }],
    });
    expect(server.threadStarts).toHaveLength(1);
    expect(server.turnStarts.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    const directInput = server.turnStarts[1]?.input[0];
    expect(directInput).toMatchObject({ type: "text" });
    if (directInput?.type !== "text") {
      throw new Error("Terra direct prompt was not text");
    }
    expect(directInput.text).toContain(
      "Built-in workspace file and command tools remain available",
    );
    expect(directInput.text).toContain("an empty list never means the workspace is unavailable");
    expect(
      checkpoints.map(({ runId, turn }) => [
        runId,
        turn.role,
        turn.state,
        turn.threadId,
        turn.turnId,
        turn.access,
      ]),
    ).toEqual([
      ["run-deferred", "admission", "thread_started", "thread-1", null, "workspaceWrite"],
      ["run-deferred", "admission", "running", "thread-1", "turn-1", "workspaceWrite"],
      ["run-deferred", "admission", "terminal", "thread-1", "turn-1", "workspaceWrite"],
      ["run-deferred", "direct", "running", "thread-1", "turn-2", "workspaceWrite"],
      ["run-deferred", "direct", "terminal", "thread-1", "turn-2", "workspaceWrite"],
    ]);
  });

  it("executes directly without prior admission and checkpoints the new direct thread", async () => {
    const server = new FakeAppServer();
    const checkpoints: RemoteTurnRef[] = [];
    server.queued.push({ output: outcomeBody("standalone direct") });
    const coordinator = new AppServerTerraCoordinator({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn: (_runId, turn) => {
        checkpoints.push(turn);
      },
    });

    const outcome = await coordinator.execute({
      runId: "run-standalone-direct",
      request: request(),
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      response: "standalone direct",
      threadId: "thread-1",
      usage: [{ estimatedCostUsd: 0.01 }],
    });
    expect(checkpoints.map((turn) => [turn.role, turn.state, turn.turnId])).toEqual([
      ["direct", "thread_started", null],
      ["direct", "running", "turn-1"],
      ["direct", "terminal", "turn-1"],
    ]);
  });

  it("hands a fanout admission thread to the existing Terra integrator", async () => {
    const server = new FakeAppServer();
    server.queued.push(
      { output: coordinatorBody() },
      { output: { ...outcomeBody("integrated"), planIssues: [] } },
    );
    const coordinator = new AppServerTerraCoordinator({ appServer: server, cwd: "/workspace" });
    const decision = await coordinator.decide({
      runId: "run-fanout",
      request: request(),
      signal: new AbortController().signal,
    });
    expect(decision.route).toBe("fanout");
    expect(decision.threadId).toBe("thread-1");
    if (typeof decision.threadId !== "string") {
      throw new Error("fanout decision omitted its coordinator thread id");
    }

    const integrator = new AppServerTerraIntegrator({ appServer: server, cwd: "/workspace" });
    const outcome = await integrator.integrate({
      runId: "run-fanout",
      request: request(),
      plan: plan(),
      leaves: [],
      coordinatorThreadId: decision.threadId,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      response: "integrated",
      threadId: "thread-1",
      usage: [{ estimatedCostUsd: 0.01 }],
    });
    expect(server.threadStarts).toHaveLength(1);
    expect(server.turnStarts.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
  });

  it.each(["item/commandExecution/requestApproval", "item/tool/requestUserInput"])(
    "fails closed when the admission turn calls %s",
    async (method) => {
      const server = new FakeAppServer();
      server.queued.push({
        output: coordinatorBody({ route: "direct", outcome: outcomeBody() }),
        beforeCompletion: async (fake, threadId, turnId) => {
          await fake
            .callServerHandler(method, { threadId, turnId, command: "npm test", questions: [] })
            .catch(() => undefined);
        },
      });
      const coordinator = new AppServerTerraCoordinator({ appServer: server, cwd: "/workspace" });

      const decision = await coordinator.decide({
        runId: `run-${method}`,
        request: request(),
        signal: new AbortController().signal,
      });

      expect(decision).toMatchObject({
        route: "waiting_input",
        threadId: "thread-1",
        usage: [{ estimatedCostUsd: 0.01 }],
      });
      if (decision.route === "waiting_input") {
        expect(decision.needsAction).toMatch(/request/u);
        expect(decision.waitingTurn).toMatchObject({
          threadId: "thread-1",
          previousTurnId: "turn-1",
          cwd: "/workspace",
        });
      }
    },
  );

  it("continues waiting admission on the same Terra thread", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: coordinatorBody({
        route: "direct",
        reason: "external source is now available",
        outcome: outcomeBody("continued admission result"),
      }),
    });
    const coordinator = new AppServerTerraCoordinator({ appServer: server, cwd: "/workspace" });

    const decision = await coordinator.resumeAdmission({
      runId: "resume-admission",
      request: request(),
      continuation: {
        threadId: "terra-waiting-admission",
        previousTurnId: "turn-before-input",
        cwd: "/workspace",
        capabilities: [],
      },
      userInput: "the source file is now present",
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      route: "direct",
      outcome: { status: "completed", response: "continued admission result" },
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.threadResumes).toEqual([
      expect.objectContaining({
        threadId: "terra-waiting-admission",
        cwd: "/workspace",
        excludeTurns: false,
      }),
    ]);
    expect(server.turnStarts[0]).toMatchObject({ threadId: "terra-waiting-admission" });
    expect(server.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        JSON.stringify({ userInput: "the source file is now present" }),
      ),
    });
  });

  it("continues waiting direct execution on the same Terra thread", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: outcomeBody("continued direct result") });
    const coordinator = new AppServerTerraCoordinator({ appServer: server, cwd: "/workspace" });

    const outcome = await coordinator.resumeDirect({
      runId: "resume-direct",
      request: request(),
      continuation: {
        threadId: "terra-waiting-direct",
        previousTurnId: "turn-before-permission",
        cwd: "/workspace",
        capabilities: [],
      },
      userInput: "permission granted",
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      response: "continued direct result",
      threadId: "terra-waiting-direct",
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.threadResumes).toHaveLength(1);
    expect(server.turnStarts[0]).toMatchObject({ threadId: "terra-waiting-direct" });
  });
});

describe("parseTerraCoordinatorBody", () => {
  it("rejects unknown and contradictory fields", () => {
    expect(() => parseTerraCoordinatorBody({ ...coordinatorBody(), extra: true })).toThrow(
      /unknown property/u,
    );
    expect(() =>
      parseTerraCoordinatorBody(
        coordinatorBody({ route: "fanout", outcome: outcomeBody("not allowed") }),
      ),
    ).toThrow(/cannot include outcome/u);
    expect(() =>
      parseTerraCoordinatorBody(
        coordinatorBody({ route: "planned_single", outcome: outcomeBody("not allowed") }),
      ),
    ).toThrow(/cannot include outcome/u);
    expect(() =>
      parseTerraCoordinatorBody(coordinatorBody({ route: "waiting_input", needsAction: "" })),
    ).toThrow(/must include needsAction/u);
    expect(() =>
      parseTerraCoordinatorBody(
        coordinatorBody({
          route: "direct",
          outcome: outcomeBody(),
          requiredCapabilities: [{ kind: "skill", name: "documents", path: null }],
        }),
      ),
    ).toThrow(/completed direct admission/u);
  });
});
