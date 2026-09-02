import { describe, expect, it, vi } from "vitest";
import {
  AppServerLeafExecutor,
  AppServerPlannerTransport,
  AppServerSolFinalReviewer,
  AppServerTerraIntegrator,
  FINAL_REVIEW_OUTPUT_SCHEMA,
  INTEGRATOR_OUTCOME_OUTPUT_SCHEMA,
  LEAF_RESULT_OUTPUT_SCHEMA,
} from "../src/app-server/index.js";
import type {
  AppServer,
  AppServerNotification,
  CommandExecParams,
  CommandExecResponse,
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
import type {
  AgentMessage,
  ExecutionPlan,
  LeafResult,
  LeafTask,
  RemoteTurnRef,
} from "../src/core/contracts.js";
import type { PlannerTurnRequest } from "../src/core/planner.js";
import {
  assertSafeChildThread,
  captureTurnUsage,
  runtimeFor,
} from "../src/app-server/adapters/runtime.js";

const INITIALIZED: InitializeResponse = {
  userAgent: "codex_app_server/0.151.0",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

interface QueuedTurn {
  output: unknown;
  status?: "completed" | "failed" | "interrupted";
  error?: string;
  beforeResponse?: boolean;
  beforeResponseHook?: (server: FakeAppServer, threadId: string, turnId: string) => Promise<void>;
  completionGate?: Promise<void>;
  failAfterAccept?: Error;
}

class FakeAppServer implements AppServer {
  state = "ready" as const;
  initializeResult: InitializeResponse | null = INITIALIZED;
  readonly threadStarts: ThreadStartParams[] = [];
  readonly threadResumes: ThreadResumeParams[] = [];
  readonly turnStarts: TurnStartParams[] = [];
  readonly steers: TurnSteerParams[] = [];
  readonly interrupts: TurnInterruptParams[] = [];
  readonly handlers = new Map<string, ServerRequestHandler>();
  readonly queued: QueuedTurn[] = [];
  readonly turnsByThread = new Map<string, JsonValue[]>();
  readonly latestUsage = new Map<string, ThreadTokenUsageUpdated>();
  usageMicros = 0;
  #thread = 0;
  #turn = 0;
  #subscriptions = new Set<{ method: string | null; handler: NotificationHandler }>();

  connect = vi.fn(async () => INITIALIZED);
  reconnect = vi.fn(async () => INITIALIZED);
  close = vi.fn(async () => undefined);
  commandExec = vi.fn(async (_params: CommandExecParams): Promise<CommandExecResponse> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));

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
    return {
      thread: { id },
      model: params.model ?? "",
      modelProvider: params.modelProvider ?? "neko",
      cwd: params.cwd ?? "/workspace",
      instructionSources: [],
    };
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    this.threadResumes.push(params);
    return {
      thread: { id: params.threadId },
      model: params.model ?? "gpt-5.6-sol",
      modelProvider: params.modelProvider ?? "neko",
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
    const status = queued.status ?? "completed";
    const turn = {
      id: turnId,
      status,
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
      error: queued.error === undefined ? null : { message: queued.error },
      startedAt: 1_787_875_200,
      completedAt: 1_787_875_201,
      durationMs: 1_000,
    };
    this.turnsByThread.get(params.threadId)?.push(turn as JsonValue);
    this.usageMicros += 10_000;
    this.latestUsage.set(params.threadId, {
      threadId: params.threadId,
      turnId,
      tokenUsage: {
        total: tokenBreakdown(120 * this.#turn),
        last: tokenBreakdown(120),
        modelContextWindow: 128_000,
      },
    });
    await queued.beforeResponseHook?.(this, params.threadId, turnId);
    if (queued.failAfterAccept !== undefined) {
      throw queued.failAfterAccept;
    }
    if (queued.beforeResponse !== false) {
      this.emit("turn/completed", { threadId: params.threadId, turn });
    } else {
      void (queued.completionGate ?? Promise.resolve()).then(() =>
        this.emit("turn/completed", { threadId: params.threadId, turn }),
      );
    }
    return { turn: { id: turnId } };
  }

  async turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    this.steers.push(params);
    return { turnId: params.expectedTurnId };
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
        estimatedUsageUsdMicros: this.usageMicros,
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
    const notification = { method, params };
    for (const subscription of this.#subscriptions) {
      if (subscription.method === null || subscription.method === method) {
        void subscription.handler(notification);
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

function plannerRequest(kind: "execution_plan" | "plan_patch"): PlannerTurnRequest {
  return {
    kind,
    model: "gpt-5.6-sol",
    tier: "sol",
    effort: "high",
    forkTurns: "none",
    cwd: "/workspace",
    prompt: `make ${kind}`,
    responseFormat: {
      type: "json_schema",
      name: kind,
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    },
  };
}

function task(overrides: Partial<LeafTask> = {}): LeafTask {
  return {
    id: "leaf-a",
    objective: "inspect one module",
    domain: "coding",
    tier: "luna",
    effort: "medium",
    access: "readOnly",
    ownedPaths: [],
    dependsOn: [],
    capabilities: [],
    validation: [],
    communicationWith: ["leaf-b"],
    expectedSeconds: 60,
    expectedCostUsd: 0.01,
    difficulty: 0.2,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
    ...overrides,
  };
}

function leafBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "inspection complete",
    confidence: 0.9,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    error: null,
    failureKind: null,
    ...overrides,
  };
}

function executionPlan(): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    objective: "inspect modules",
    domain: "coding",
    assumptions: [],
    tasks: [task()],
    integration: {
      objective: "integrate",
      requiredOutputs: ["answer"],
      validation: [],
      finalReview: "riskTriggered",
    },
    risk: "high",
  };
}

function completedLeaf(): LeafResult {
  return {
    taskId: "leaf-a",
    status: "completed",
    summary: "done",
    confidence: 0.9,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: "leaf-thread",
    turnId: "leaf-turn",
    usage: [],
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
  };
}

describe("App Server safety helpers", () => {
  it("fails closed when child instruction sources are missing or unreadable", () => {
    expect(() => assertSafeChildThread({})).toThrow("child isolation cannot be verified");
    expect(() =>
      assertSafeChildThread({ instructionSources: ["/missing/uninspectable-instructions"] }),
    ).toThrow("cannot be inspected");
  });

  it("retains official USD usage when token notifications are unavailable", async () => {
    const server = new FakeAppServer();
    server.usageMicros = 25_000;

    await expect(
      captureTurnUsage({
        server,
        threadId: "thread-recovered",
        turnId: "turn-recovered",
        model: "gpt-5.6-luna",
        tier: "luna",
        effort: "medium",
        baselineServerCostUsd: 0,
      }),
    ).resolves.toEqual([
      {
        model: "gpt-5.6-luna",
        tier: "luna",
        effort: "medium",
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0.025,
        costSource: "app_server",
      },
    ]);
  });

  it("subtracts cache-write tokens from uncached input and charges their rate", async () => {
    const server = new FakeAppServer();
    server.latestUsage.set("thread-cache", {
      threadId: "thread-cache",
      turnId: "turn-cache",
      tokenUsage: {
        total: {
          totalTokens: 120,
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 120,
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 128_000,
      },
    });

    await expect(
      captureTurnUsage({
        server,
        threadId: "thread-cache",
        turnId: "turn-cache",
        model: "priced-cache-model",
        tier: "luna",
        effort: "medium",
        priceTable: {
          "priced-cache-model": {
            inputPerMillionUsd: 10,
            cachedInputPerMillionUsd: 1,
            cacheWriteInputPerMillionUsd: 2,
            outputPerMillionUsd: 30,
          },
        },
      }),
    ).resolves.toEqual([
      {
        model: "priced-cache-model",
        tier: "luna",
        effort: "medium",
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
        uncachedInputTokens: 50,
        outputTokens: 20,
        totalTokens: 120,
        estimatedCostUsd: 0.00116,
        costSource: "price_table",
      },
    ]);
  });

  it("waits for a token usage notification that arrives after turn completion", async () => {
    const server = new FakeAppServer();
    server.waitForNotification = vi.fn(async () => {
      server.latestUsage.set("thread-race", {
        threadId: "thread-race",
        turnId: "turn-race",
        tokenUsage: {
          total: tokenBreakdown(120),
          last: tokenBreakdown(120),
          modelContextWindow: 128_000,
        },
      });
      return {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-race",
          turnId: "turn-race",
          tokenUsage: {
            total: tokenBreakdown(120),
            last: tokenBreakdown(120),
            modelContextWindow: 128_000,
          },
        },
      };
    });

    await expect(
      captureTurnUsage({
        server,
        threadId: "thread-race",
        turnId: "turn-race",
        model: "priced-race-model",
        tier: "terra",
        effort: "medium",
        priceTable: {
          "priced-race-model": {
            inputPerMillionUsd: 10,
            outputPerMillionUsd: 30,
          },
        },
      }),
    ).resolves.toEqual([
      {
        model: "priced-race-model",
        tier: "terra",
        effort: "medium",
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 60,
        outputTokens: 20,
        totalTokens: 120,
        estimatedCostUsd: 0.0016,
        costSource: "price_table",
      },
    ]);
    expect(server.waitForNotification).toHaveBeenCalledTimes(1);
  });
});

describe("AppServerPlannerTransport", () => {
  it("survives completion notification before turn/start response and continues one Sol thread", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: { value: 1 } }, { output: { value: 2 } });
    const transport = new AppServerPlannerTransport({
      appServer: server,
      cwd: "/workspace",
    });

    const first = await transport.start(plannerRequest("execution_plan"));
    const second = await transport.continue(first.threadId, plannerRequest("plan_patch"));

    expect(first).toMatchObject({ threadId: "thread-1", output: { value: 1 } });
    expect(second).toMatchObject({ threadId: "thread-1", output: { value: 2 } });
    expect(first.usage?.[0]).toMatchObject({
      model: "gpt-5.6-sol",
      tier: "sol",
      cachedInputTokens: 40,
      uncachedInputTokens: 60,
      outputTokens: 20,
      estimatedCostUsd: 0.01,
    });
    expect(second.usage?.[0]?.estimatedCostUsd).toBeCloseTo(0.01);
    expect(server.threadStarts).toHaveLength(1);
    expect(server.turnStarts.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(server.turnStarts[0]?.outputSchema).toEqual(
      plannerRequest("execution_plan").responseFormat.schema,
    );
    expect(server.threadStarts[0]).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [],
      config: {
        agents: { enabled: false },
        features: {
          multi_agent: false,
          shell_tool: false,
          unified_exec: false,
          view_image: false,
          browser_use: false,
          workspace_dependencies: false,
        },
        project_doc_max_bytes: 0,
        mcp_servers: { hierarchical_codex: { enabled: false } },
      },
    });
    expect(server.threadStarts[0]?.baseInstructions).toContain("efficient semantic task planner");
  });

  it("registers a persisted planner thread without starting another thread", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: { value: 2 } });
    const transport = new AppServerPlannerTransport({
      appServer: server,
      cwd: "/workspace",
    });
    transport.registerExistingThread({
      threadId: "persisted-planner",
      cwd: "/workspace",
      runId: "run-1",
    });
    transport.registerExistingThread({ threadId: "persisted-planner", cwd: "/workspace" });

    const response = await transport.continue("persisted-planner", {
      ...plannerRequest("plan_patch"),
      runId: "run-1",
    });

    expect(response.threadId).toBe("persisted-planner");
    expect(server.threadStarts).toHaveLength(0);
    expect(server.threadResumes).toEqual([
      expect.objectContaining({
        threadId: "persisted-planner",
        cwd: "/workspace",
        sandbox: "read-only",
        config: expect.objectContaining({
          agents: { enabled: false },
          features: expect.objectContaining({ multi_agent: false, shell_tool: false }),
        }),
      }),
    ]);
    expect(server.turnStarts).toEqual([expect.objectContaining({ threadId: "persisted-planner" })]);
    await expect(
      transport.continue("persisted-planner", {
        ...plannerRequest("plan_patch"),
        runId: "run-2",
      }),
    ).rejects.toMatchObject({ code: "planner_run_mismatch" });
  });

  it("durably checkpoints a new thread and each planner turn in lifecycle order", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: { value: 1 } }, { output: { value: 2 } });
    const checkpoints: Array<{ runId: string; turn: RemoteTurnRef }> = [];
    let releaseThreadCheckpoint!: () => void;
    const threadCheckpoint = new Promise<void>((resolve) => {
      releaseThreadCheckpoint = resolve;
    });
    const checkpointRemoteTurn = vi.fn(async (runId: string, turn: RemoteTurnRef) => {
      checkpoints.push({ runId, turn: structuredClone(turn) });
      if (turn.state === "thread_started") {
        await threadCheckpoint;
      }
    });
    const transport = new AppServerPlannerTransport({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn,
    });

    const starting = transport.start({
      ...plannerRequest("execution_plan"),
      runId: "run-checkpoint",
    });
    await vi.waitFor(() => expect(checkpointRemoteTurn).toHaveBeenCalledTimes(1));
    expect(server.threadStarts).toHaveLength(1);
    expect(server.turnStarts).toHaveLength(0);
    releaseThreadCheckpoint();
    const first = await starting;
    await transport.continue(first.threadId, plannerRequest("plan_patch"));

    expect(
      checkpoints.map(({ runId, turn }) => ({
        runId,
        role: turn.role,
        threadId: turn.threadId,
        turnId: turn.turnId,
        access: turn.access,
        state: turn.state,
      })),
    ).toEqual([
      {
        runId: "run-checkpoint",
        role: "planner",
        threadId: "thread-1",
        turnId: null,
        access: "readOnly",
        state: "thread_started",
      },
      {
        runId: "run-checkpoint",
        role: "planner",
        threadId: "thread-1",
        turnId: "turn-1",
        access: "readOnly",
        state: "running",
      },
      {
        runId: "run-checkpoint",
        role: "planner",
        threadId: "thread-1",
        turnId: "turn-1",
        access: "readOnly",
        state: "terminal",
      },
      {
        runId: "run-checkpoint",
        role: "planner",
        threadId: "thread-1",
        turnId: "turn-2",
        access: "readOnly",
        state: "running",
      },
      {
        runId: "run-checkpoint",
        role: "planner",
        threadId: "thread-1",
        turnId: "turn-2",
        access: "readOnly",
        state: "terminal",
      },
    ]);
    expect(checkpoints.every(({ turn }) => Number.isFinite(Date.parse(turn.updatedAt)))).toBe(true);
  });

  it("fails closed before turn/start when the thread checkpoint cannot be persisted", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: { value: 1 } });
    const states: RemoteTurnRef["state"][] = [];
    let rejectCheckpoint = true;
    const checkpointRemoteTurn = vi.fn(async (_runId: string, turn: RemoteTurnRef) => {
      states.push(turn.state);
      if (rejectCheckpoint) {
        rejectCheckpoint = false;
        throw new Error("checkpoint unavailable");
      }
    });
    const transport = new AppServerPlannerTransport({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn,
    });

    await expect(
      transport.start({ ...plannerRequest("execution_plan"), runId: "run-1" }),
    ).rejects.toThrow("checkpoint unavailable");
    expect(server.turnStarts).toHaveLength(0);
    expect(states).toEqual(["thread_started"]);
    expect(transport.ownsThread("thread-1")).toBe(false);
  });

  it("rejects markdown-wrapped JSON instead of permissively extracting it", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: '```json\n{"value":1}\n```' });
    const transport = new AppServerPlannerTransport({ appServer: server, cwd: "/workspace" });
    await expect(transport.start(plannerRequest("execution_plan"))).rejects.toMatchObject({
      code: "invalid_final_json",
    });
  });
});

describe("AppServerLeafExecutor", () => {
  it("routes a root-scoped dynamic tool without exposing it to other threads", async () => {
    const server = new FakeAppServer();
    const runtime = runtimeFor(server);
    const release = runtime.registerDynamicToolHandler("root-thread", async (params) => ({
      contentItems: [{ type: "inputText", text: `ran ${params.tool}` }],
      success: true,
    }));
    const releaseApproval = runtime.registerApprovalHandler("root-thread", () => ({
      decision: "accept",
    }));

    await expect(
      server.callServerHandler("item/tool/call", {
        threadId: "root-thread",
        turnId: "root-turn",
        callId: "root-call",
        tool: "agent_trio",
        arguments: { action: "run" },
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      server.callServerHandler("item/tool/call", {
        threadId: "other-thread",
        turnId: "other-turn",
        callId: "other-call",
        tool: "agent_trio",
        arguments: { action: "run" },
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      server.callServerHandler("item/commandExecution/requestApproval", {
        threadId: "root-thread",
        turnId: "root-turn",
        itemId: "command-1",
      }),
    ).resolves.toEqual({ decision: "accept" });

    release();
    releaseApproval();
    await expect(
      server.callServerHandler("item/tool/call", {
        threadId: "root-thread",
        turnId: "root-turn-2",
        callId: "root-call-2",
        tool: "agent_trio",
        arguments: { action: "run" },
      }),
    ).resolves.toMatchObject({ success: false });
  });

  it("maps model/access/effort without advertising unsupported dynamic leaf tools", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody() });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    const controller = new AbortController();
    const result = await executor.runLeaf(
      {
        runId: "run-1",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: controller.signal,
      },
      async () => {
        throw new Error("leaf message callback must remain unused");
      },
    );

    expect(result).toMatchObject({
      taskId: "leaf-a",
      status: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:01.000Z",
    });
    expect(server.threadStarts[0]).toMatchObject({
      model: "gpt-5.6-luna",
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [],
      developerInstructions: expect.stringContaining(
        "run the narrowest relevant local tests available for the owned scope",
      ),
    });
    expect(server.threadStarts[0]?.developerInstructions).not.toContain(
      "Do not run or report configured deterministic validators",
    );
    expect(server.threadStarts[0]?.developerInstructions).toContain(
      "exact observed value, governing threshold, and derived margin",
    );
    expect(server.threadStarts[0]).not.toHaveProperty("environments");
    expect(server.turnStarts[0]).toMatchObject({
      effort: "medium",
      outputSchema: LEAF_RESULT_OUTPUT_SCHEMA,
    });
    expect(server.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Keep metadata compact"),
    });
    expect(server.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("never replace either source value with the margin alone"),
    });
    expect(LEAF_RESULT_OUTPUT_SCHEMA.properties.summary.maxLength).toBe(16_000);
  });

  it.each([
    ["fullAccess", "readOnly", "danger-full-access", { type: "dangerFullAccess" }],
    ["readOnly", "workspaceWrite", "read-only", undefined],
    ["workspaceWrite", "workspaceWrite", "workspace-write", undefined],
  ] as const)(
    "maps %s host permission over a %s leaf without escalation",
    async (hostAccess, taskAccess, expectedSandbox, expectedTurnSandbox) => {
      const server = new FakeAppServer();
      server.queued.push({ output: leafBody() });
      const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });

      await executor.runLeaf(
        {
          runId: `run-${hostAccess}-${taskAccess}`,
          hostAccess,
          task: task({
            access: taskAccess,
            ownedPaths: taskAccess === "workspaceWrite" ? ["src/leaf.ts"] : [],
          }),
          dependencies: [],
          attempt: 1,
          signal: new AbortController().signal,
        },
        async () => null,
      );

      expect(server.threadStarts[0]?.sandbox).toBe(expectedSandbox);
      expect(server.turnStarts[0]?.sandboxPolicy).toEqual(expectedTurnSandbox);
      expect(server.threadStarts[0]).toMatchObject({
        approvalPolicy: "never",
        config: expect.objectContaining({ agents: { enabled: false } }),
      });
    },
  );

  it("inherits Approve for me on leaf thread and turn starts", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody() });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });

    await executor.runLeaf(
      {
        runId: "approve-for-me-leaf",
        hostApproval: "approveForMe",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(server.threadStarts[0]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(server.turnStarts[0]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  it("caps a writer validator at read-only when the caller is read-only", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody() });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/tmp" });

    await executor.runLeaf(
      {
        runId: "read-only-validator",
        hostAccess: "readOnly",
        task: task({
          access: "workspaceWrite",
          ownedPaths: ["src/leaf.ts"],
          validation: [{ command: "npm test" }],
        }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(server.commandExec).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }),
      expect.any(Object),
    );
  });

  it("accepts complete multi-deliverable leaf summaries beyond the old 4k ceiling", async () => {
    const server = new FakeAppServer();
    const summary = "complete result ".repeat(400);
    server.queued.push({ output: leafBody({ summary }) });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/tmp" });

    const result = await executor.runLeaf(
      {
        runId: "run-long-summary",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result.summary).toBe(summary);
    expect(result.summary.length).toBeGreaterThan(4_000);
  });

  it("uses completed status when a provider fills nullable failure placeholders", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: leafBody({ error: "none", failureKind: "unknown" }),
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/tmp" });

    const result = await executor.runLeaf(
      {
        runId: "run-completed-placeholders",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result).toMatchObject({ status: "completed", summary: "inspection complete" });
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("failureKind");
    expect(server.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("For status=completed, set error and failureKind to null"),
    });
  });

  it("shares narrow validator commands with writers and lets the runtime supply results", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody({ validation: undefined }) });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/tmp" });

    const result = await executor.runLeaf(
      {
        runId: "run-compact",
        task: task({
          access: "workspaceWrite",
          ownedPaths: ["src/index.ts"],
          communicationWith: [],
          validation: [{ command: "npm test" }],
        }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(server.threadStarts[0]).toMatchObject({ dynamicTools: [] });
    const prompt = server.turnStarts[0]?.input[0];
    expect(prompt).toMatchObject({ type: "text" });
    if (prompt?.type === "text") {
      expect(prompt.text).not.toContain("expectedCostUsd");
      expect(prompt.text).not.toContain("validatorStrength");
      expect(prompt.text).toContain('"checks":["npm test"]');
    }
    expect(LEAF_RESULT_OUTPUT_SCHEMA.properties).not.toHaveProperty("validation");
    expect(result.validation).toEqual([
      expect.objectContaining({ command: "npm test", status: "passed" }),
    ]);
  });

  it("passes only aggregate successful validation state to dependent leaves", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody({ validation: undefined }) });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    await executor.runLeaf(
      {
        runId: "run-dependency",
        task: task({ dependsOn: ["leaf-before"], communicationWith: [] }),
        dependencies: [
          {
            ...completedLeaf(),
            taskId: "leaf-before",
            validation: [
              {
                command: "private passing validator command",
                status: "passed",
                summary: "private passing validator output",
              },
            ],
          },
        ],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    const prompt = server.turnStarts[0]?.input[0];
    expect(prompt).toMatchObject({ type: "text" });
    if (prompt?.type === "text") {
      expect(prompt.text).toContain('"validation":{"count":1,"status":"passed"}');
      expect(prompt.text).not.toContain("private passing validator command");
      expect(prompt.text).not.toContain("private passing validator output");
    }
  });

  it("continues a permission-blocked leaf on the same thread without starting a new one", async () => {
    const server = new FakeAppServer();
    const checkpoints: RemoteTurnRef[] = [];
    const resolveLeafCwd = vi.fn(async () => "/workspace/recovered-leaf");
    server.queued.push({ output: leafBody({ summary: "continued successfully" }) });
    const executor = new AppServerLeafExecutor({
      appServer: server,
      cwd: "/workspace",
      resolveLeafCwd,
      checkpointRemoteTurn: (_runId, turn) => {
        checkpoints.push(structuredClone(turn));
      },
    });

    const result = await executor.runLeaf(
      {
        runId: "resume-leaf",
        hostAccess: "fullAccess",
        hostApproval: "approveForMe",
        task: task(),
        dependencies: [],
        attempt: 1,
        continuation: {
          threadId: "leaf-thread-existing",
          previousTurnId: "leaf-turn-waiting",
          userInput: "repository access granted",
        },
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result).toMatchObject({
      status: "completed",
      threadId: "leaf-thread-existing",
      turnId: "turn-1",
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.threadResumes).toEqual([
      expect.objectContaining({
        threadId: "leaf-thread-existing",
        cwd: "/workspace/recovered-leaf",
        sandbox: "danger-full-access",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        excludeTurns: false,
      }),
    ]);
    expect(server.turnStarts[0]?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(server.turnStarts[0]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(resolveLeafCwd).toHaveBeenCalledWith("resume-leaf", expect.any(Object), [], true);
    expect(server.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(JSON.stringify({ userInput: "repository access granted" })),
    });
    expect(checkpoints).toEqual([
      expect.objectContaining({
        role: "leaf",
        taskId: "leaf-a",
        threadId: "leaf-thread-existing",
        turnId: null,
        state: "thread_started",
      }),
      expect.objectContaining({ turnId: "turn-1", state: "running" }),
      expect.objectContaining({ turnId: "turn-1", state: "terminal" }),
    ]);
  });

  it("continues a retry on the same shared thread with compact failure evidence", async () => {
    const server = new FakeAppServer();
    server.queued.push(
      {
        output: leafBody({
          status: "failed",
          summary: "the implementation fails the empty-input case",
          confidence: 0.2,
          validation: [
            { command: "npm test -- clamp", status: "failed", summary: "expected 0, got 1" },
          ],
          error: "empty-input counterexample",
          failureKind: "reasoning",
        }),
      },
      { output: leafBody({ summary: "repaired empty-input handling" }) },
    );
    const resolveLeafCwd = vi.fn(
      async (..._args: [string, LeafTask, readonly LeafResult[], boolean?]) =>
        "/workspace/retry-leaf",
    );
    const executor = new AppServerLeafExecutor({
      appServer: server,
      cwd: "/workspace",
      resolveLeafCwd,
    });
    const signal = new AbortController().signal;
    const first = await executor.runLeaf(
      {
        runId: "retry-leaf",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal,
      },
      async () => null,
    );
    const second = await executor.runLeaf(
      {
        runId: "retry-leaf",
        task: task({ tier: "terra", effort: "high" }),
        dependencies: [],
        attempt: 2,
        retry: { kind: "reasoning", previousResult: first },
        signal,
      },
      async () => null,
    );

    expect(server.threadStarts).toHaveLength(1);
    expect(server.threadResumes).toEqual([
      expect.objectContaining({ threadId: "thread-1", model: "gpt-5.6-terra" }),
    ]);
    expect(resolveLeafCwd.mock.calls.map((call) => call[3])).toEqual([false, true]);
    expect(server.turnStarts[1]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"error":"empty-input counterexample"'),
    });
    const retryPrompt = server.turnStarts[1]?.input[0];
    if (retryPrompt?.type === "text") {
      expect(retryPrompt.text).toContain('"failedValidation"');
      expect(retryPrompt.text).toContain("expected 0, got 1");
      expect(retryPrompt.text).not.toContain('"objective":"inspect one module"');
    }
    expect(first.usage.map((item) => item.estimatedCostUsd)).toEqual([0.01]);
    expect(second.usage.map((item) => item.estimatedCostUsd)).toEqual([0.01]);
  });

  it("starts an isolated retry with prior evidence instead of blindly repeating the prompt", async () => {
    const sharedServer = new FakeAppServer();
    const firstServer = new FakeAppServer();
    const secondServer = new FakeAppServer();
    firstServer.queued.push({
      output: leafBody({
        status: "failed",
        summary: "browser extraction selected the wrong table",
        confidence: 0.2,
        error: "missing expected header",
        failureKind: "reasoning",
      }),
    });
    secondServer.queued.push({ output: leafBody({ summary: "selected the correct table" }) });
    const servers = [firstServer, secondServer];
    const resolveLeafCwd = vi.fn(async () => "/workspace/plugin-leaf");
    const capabilityResolver = {
      resolve: vi.fn(async () => ({
        skills: [],
        plugins: [{ kind: "plugin" as const, name: "browser" }],
        requiresIsolatedProcess: true,
      })),
    };
    const isolatedServerFactory = {
      create: vi.fn(async () => servers.shift()!),
    };
    const leafTask = task({ capabilities: [{ kind: "plugin", name: "browser" }] });
    const executor = new AppServerLeafExecutor({
      appServer: sharedServer,
      cwd: "/workspace",
      resolveLeafCwd,
      capabilityResolver,
      isolatedServerFactory,
    });
    const signal = new AbortController().signal;
    const first = await executor.runLeaf(
      { runId: "isolated-retry", task: leafTask, dependencies: [], attempt: 1, signal },
      async () => null,
    );
    await executor.runLeaf(
      {
        runId: "isolated-retry",
        task: task({
          tier: "terra",
          effort: "high",
          capabilities: [{ kind: "plugin", name: "browser" }],
        }),
        dependencies: [],
        attempt: 2,
        retry: { kind: "reasoning", previousResult: first },
        signal,
      },
      async () => null,
    );

    expect(firstServer.threadResumes).toHaveLength(0);
    expect(secondServer.threadResumes).toHaveLength(0);
    expect(secondServer.threadStarts).toHaveLength(1);
    expect(secondServer.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"error":"missing expected header"'),
    });
    const retryPrompt = secondServer.turnStarts[0]?.input[0];
    if (retryPrompt?.type === "text") {
      expect(retryPrompt.text).toContain("do not blindly repeat it");
      expect(retryPrompt.text).toContain('"objective":"inspect one module"');
    }
    expect(firstServer.close).toHaveBeenCalledOnce();
    expect(secondServer.close).toHaveBeenCalledOnce();
  });

  it("enforces the same compact evidence limits at runtime as the leaf schema", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: leafBody({
        findings: [{ text: "x".repeat(2_001), path: null, line: null }],
      }),
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });

    await expect(
      executor.runLeaf(
        {
          runId: "run-1",
          task: task(),
          dependencies: [],
          attempt: 1,
          signal: new AbortController().signal,
        },
        async () => null,
      ),
    ).rejects.toThrow("findings[0].text must be a string of 1-2000 characters");
  });

  it("uses the resolved leaf workspace for capabilities, isolation, thread, and turn", async () => {
    const sharedServer = new FakeAppServer();
    const isolatedServer = new FakeAppServer();
    isolatedServer.queued.push({ output: leafBody() });
    const leafCwd = "/tmp/agent-trio-run-1/leaf-a";
    const resolvedCapabilities = {
      skills: [
        {
          kind: "skill" as const,
          name: "browser-control",
          path: "/opt/plugins/browser/SKILL.md",
          pluginId: "browser",
        },
      ],
      plugins: [{ kind: "plugin" as const, name: "browser" }],
      requiresIsolatedProcess: true,
    };
    const resolveLeafCwd = vi.fn(async () => leafCwd);
    const capabilityResolver = {
      resolve: vi.fn(async () => resolvedCapabilities),
    };
    const isolatedServerFactory = {
      create: vi.fn(async () => isolatedServer),
    };
    const checkpoints: RemoteTurnRef[] = [];
    const leafTask = task({
      access: "workspaceWrite",
      ownedPaths: ["src/leaf.ts"],
      capabilities: [{ kind: "plugin", name: "browser" }],
    });
    const executor = new AppServerLeafExecutor({
      appServer: sharedServer,
      cwd: "/workspace",
      resolveLeafCwd,
      capabilityResolver,
      isolatedServerFactory,
      checkpointRemoteTurn: async (runId, turn) => {
        expect(runId).toBe("run-1");
        checkpoints.push(structuredClone(turn));
      },
    });

    const result = await executor.runLeaf(
      {
        runId: "run-1",
        task: leafTask,
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result.status).toBe("completed");
    expect(resolveLeafCwd).toHaveBeenCalledWith("run-1", leafTask, [], false);
    expect(capabilityResolver.resolve).toHaveBeenCalledWith(leafTask.capabilities, leafCwd);
    expect(isolatedServerFactory.create).toHaveBeenCalledWith({
      capabilities: resolvedCapabilities,
      cwd: leafCwd,
      task: leafTask,
    });
    expect(sharedServer.threadStarts).toHaveLength(0);
    expect(isolatedServer.threadStarts[0]).toMatchObject({
      cwd: leafCwd,
      runtimeWorkspaceRoots: [leafCwd],
      sandbox: "workspace-write",
    });
    expect(isolatedServer.turnStarts[0]).toMatchObject({
      cwd: leafCwd,
      runtimeWorkspaceRoots: [leafCwd],
      input: expect.arrayContaining([
        {
          type: "skill",
          name: "browser-control",
          path: "/opt/plugins/browser/SKILL.md",
        },
      ]),
    });
    expect(
      checkpoints.map(({ role, taskId, threadId, turnId, access, state }) => ({
        role,
        taskId,
        threadId,
        turnId,
        access,
        state,
      })),
    ).toEqual([
      {
        role: "leaf",
        taskId: "leaf-a",
        threadId: "thread-1",
        turnId: null,
        access: "workspaceWrite",
        state: "thread_started",
      },
      {
        role: "leaf",
        taskId: "leaf-a",
        threadId: "thread-1",
        turnId: "turn-1",
        access: "workspaceWrite",
        state: "running",
      },
      {
        role: "leaf",
        taskId: "leaf-a",
        threadId: "thread-1",
        turnId: "turn-1",
        access: "workspaceWrite",
        state: "terminal",
      },
    ]);
    expect(
      checkpoints
        .filter((checkpoint) => checkpoint.state === "terminal")
        .every((checkpoint) => checkpoint.usage?.length === 1),
    ).toBe(true);
  });

  it("rejects an invalid resolved leaf cwd before capability or server work starts", async () => {
    const server = new FakeAppServer();
    const capabilityResolver = {
      resolve: vi.fn(async () => ({
        skills: [],
        plugins: [],
        requiresIsolatedProcess: false,
      })),
    };
    const executor = new AppServerLeafExecutor({
      appServer: server,
      cwd: "/workspace",
      resolveLeafCwd: async () => "relative/worktree",
      capabilityResolver,
    });

    await expect(
      executor.runLeaf(
        {
          runId: "run-1",
          task: task(),
          dependencies: [],
          attempt: 1,
          signal: new AbortController().signal,
        },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "invalid_leaf_cwd" });
    expect(capabilityResolver.resolve).not.toHaveBeenCalled();
    expect(server.threadStarts).toHaveLength(0);
  });

  it("checkpoints terminal state with the full leaf identity when result parsing fails", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: "not-json" });
    const checkpoints: RemoteTurnRef[] = [];
    const executor = new AppServerLeafExecutor({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn: async (_runId, turn) => {
        checkpoints.push(structuredClone(turn));
      },
    });

    await expect(
      executor.runLeaf(
        {
          runId: "run-1",
          task: task(),
          dependencies: [],
          attempt: 1,
          signal: new AbortController().signal,
        },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "invalid_final_json" });
    expect(checkpoints.at(-1)).toMatchObject({
      role: "leaf",
      taskId: "leaf-a",
      threadId: "thread-1",
      turnId: "turn-1",
      access: "readOnly",
      state: "terminal",
    });
  });

  it("interrupts and fails closed when the running leaf checkpoint cannot be persisted", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody() });
    const states: RemoteTurnRef["state"][] = [];
    const executor = new AppServerLeafExecutor({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn: async (_runId, turn) => {
        states.push(turn.state);
        if (turn.state === "running") {
          throw new Error("running checkpoint unavailable");
        }
      },
    });

    const result = await executor.runLeaf(
      {
        runId: "run-1",
        task: task({ access: "workspaceWrite", ownedPaths: ["src/leaf.ts"] }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      threadId: "thread-1",
      turnId: "turn-1",
      error: "running checkpoint unavailable",
    });
    expect(server.interrupts).toContainEqual({ threadId: "thread-1", turnId: "turn-1" });
    // Interrupt acceptance is not proof that the remote turn reached a terminal state.
    expect(states).toEqual(["thread_started", "running"]);
  });

  it("marks a writer indeterminate when turn/start acceptance is uncertain", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: leafBody(),
      failAfterAccept: new Error("turn/start response lost"),
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });

    const result = await executor.runLeaf(
      {
        runId: "run-1",
        task: task({ access: "workspaceWrite", ownedPaths: ["src/leaf.ts"] }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result).toMatchObject({
      status: "indeterminate",
      threadId: "thread-1",
      turnId: null,
      error: "turn/start response lost",
    });
  });

  it("fails closed if approvalPolicy=never still produces an approval request", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: leafBody(),
      beforeResponseHook: async (fake, threadId, turnId) => {
        await fake.callServerHandler("item/fileChange/requestApproval", {
          threadId,
          turnId,
          itemId: "item-1",
        });
      },
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    const result = await executor.runLeaf(
      {
        runId: "run-1",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );
    expect(result).toMatchObject({
      status: "blocked",
      failureKind: "permission",
      error: "unexpected approval request 'item/fileChange/requestApproval'",
    });
  });

  it("reports an approval escalated by automatic review without bypassing it", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: leafBody(),
      beforeResponseHook: async (fake, threadId, turnId) => {
        const response = await fake.callServerHandler("item/fileChange/requestApproval", {
          threadId,
          turnId,
          itemId: "item-1",
        });
        expect(response).toEqual({ decision: "decline" });
      },
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    const result = await executor.runLeaf(
      {
        runId: "approve-for-me-escalation",
        hostApproval: "approveForMe",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );
    expect(result).toMatchObject({
      status: "blocked",
      failureKind: "permission",
      error:
        "automatic review escalated unresolved approval request 'item/fileChange/requestApproval'",
    });
  });

  it("marks a writer indeterminate when its terminal payload cannot be trusted", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: "not-json" });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    const result = await executor.runLeaf(
      {
        runId: "run-1",
        task: task({
          access: "workspaceWrite",
          ownedPaths: ["src/leaf.ts"],
        }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      threadId: "thread-1",
      turnId: "turn-1",
      failureKind: "unknown",
      usage: [expect.objectContaining({ estimatedCostUsd: 0.01 })],
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:01.000Z",
    });
  });

  it("rejects recursive skills and requires a distinct process for plugin capabilities", async () => {
    const server = new FakeAppServer();
    const recursive = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    await expect(
      recursive.runLeaf(
        {
          runId: "run-1",
          task: task({ capabilities: [{ kind: "skill", name: "agent-trio", path: "/x" }] }),
          dependencies: [],
          attempt: 1,
          signal: new AbortController().signal,
        },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "recursive_capability" });

    const resolver = {
      resolve: vi.fn(async () => ({
        skills: [],
        plugins: [{ kind: "plugin" as const, name: "browser" }],
        requiresIsolatedProcess: true,
      })),
    };
    const bypassed = new AppServerLeafExecutor({
      appServer: server,
      cwd: "/workspace",
      capabilityResolver: resolver,
      isolatedServerFactory: { create: async () => server },
    });
    await expect(
      bypassed.runLeaf(
        {
          runId: "run-1",
          task: task({ capabilities: [{ kind: "plugin", name: "browser" }] }),
          dependencies: [],
          attempt: 1,
          signal: new AbortController().signal,
        },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "plugin_isolation_bypassed" });
  });

  it("steers only the active target turn", async () => {
    const server = new FakeAppServer();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.queued.push({
      output: leafBody(),
      beforeResponse: false,
      completionGate: hold,
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/workspace" });
    const running = executor.runLeaf(
      {
        runId: "run-1",
        task: task(),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );
    await vi.waitFor(() => expect(server.threadStarts).toHaveLength(1));
    await expect(executor.deliverMessage("missing", agentMessage())).rejects.toMatchObject({
      code: "message_target_unavailable",
    });
    await vi.waitFor(() => expect(server.turnStarts).toHaveLength(1));
    await executor.deliverMessage("leaf-a", agentMessage());
    release();
    await running;
    expect(server.steers).toHaveLength(1);
    expect(server.steers[0]).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
  });

  it("overrides model-reported validation with the real command exit code", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: leafBody({
        validation: [{ command: "npm test", status: "passed", summary: "model said ok" }],
      }),
    });
    server.commandExec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "test failed",
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/tmp" });

    const result = await executor.runLeaf(
      {
        runId: "validator-run",
        task: task({ validation: [{ command: "npm test" }] }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("validation");
    expect(result.validation).toEqual([
      expect.objectContaining({ command: "npm test", status: "failed" }),
    ]);
    expect(server.commandExec).toHaveBeenCalledWith(
      expect.objectContaining({ command: ["npm", "test"], cwd: "/tmp" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not classify a validator sandbox startup failure as a code failure", async () => {
    const server = new FakeAppServer();
    server.queued.push({ output: leafBody() });
    server.commandExec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "bwrap: Can't create file /workspace/.agents: Read-only file system",
    });
    const executor = new AppServerLeafExecutor({ appServer: server, cwd: "/tmp" });

    const result = await executor.runLeaf(
      {
        runId: "validator-sandbox-run",
        task: task({ validation: [{ command: "npm test" }] }),
        dependencies: [],
        attempt: 1,
        signal: new AbortController().signal,
      },
      async () => null,
    );

    expect(result).toMatchObject({
      status: "failed",
      summary: "deterministic leaf validator could not run",
      failureKind: "transient",
    });
  });
});

describe("integration adapters", () => {
  it("omits integrator validation output and compacts leaf validator evidence", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: {
        status: "completed",
        response: "integrated",
        needsAction: null,
        error: null,
        planIssues: [],
      },
    });
    const plan = executionPlan();
    plan.integration.validation = [{ command: "private aggregate validator command" }];
    const leaf = completedLeaf();
    leaf.validation = [
      {
        command: "private passing validator command",
        status: "passed",
        summary: "private passing validator output",
      },
      {
        command: "failing validator command",
        status: "failed",
        summary: "concise failure evidence",
      },
    ];
    const integrator = new AppServerTerraIntegrator({ appServer: server, cwd: "/workspace" });

    const outcome = await integrator.integrate({
      runId: "compact-integration",
      request: { objective: "inspect modules", cwd: "/workspace" },
      plan,
      leaves: [leaf],
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
    });

    expect(outcome.validation).toEqual([]);
    expect(server.turnStarts[0]?.outputSchema).toEqual(INTEGRATOR_OUTCOME_OUTPUT_SCHEMA);
    expect(INTEGRATOR_OUTCOME_OUTPUT_SCHEMA.properties).not.toHaveProperty("validation");
    const prompt = server.turnStarts[0]?.input[0];
    expect(prompt).toMatchObject({ type: "text" });
    if (prompt?.type === "text") {
      expect(prompt.text).toContain('"validation":{"count":2,"status":"failed"');
      expect(prompt.text).toContain("failing validator command");
      expect(prompt.text).toContain("concise failure evidence");
      expect(prompt.text).not.toContain("private passing validator command");
      expect(prompt.text).not.toContain("private passing validator output");
      expect(prompt.text).not.toContain("private aggregate validator command");
    }
  });

  it("continues Terra integration on the persisted thread without rerunning integrate", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: {
        status: "completed",
        response: "continued integration",
        validation: [],
        needsAction: null,
        error: null,
        planIssues: [],
      },
    });
    const integrator = new AppServerTerraIntegrator({ appServer: server, cwd: "/workspace" });

    const outcome = await integrator.resumeIntegration({
      runId: "resume-integration",
      request: { objective: "inspect modules", cwd: "/workspace/recovered-candidate" },
      plan: executionPlan(),
      leaves: [completedLeaf()],
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      continuation: {
        threadId: "integrator-thread-existing",
        previousTurnId: "integrator-turn-waiting",
        cwd: "/workspace/old-candidate",
        capabilities: [],
      },
      userInput: "source credentials added",
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      response: "continued integration",
      threadId: "integrator-thread-existing",
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.threadResumes).toEqual([
      expect.objectContaining({
        threadId: "integrator-thread-existing",
        cwd: "/workspace/recovered-candidate",
        sandbox: "read-only",
      }),
    ]);
    expect(server.turnStarts[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("source credentials added"),
    });
  });

  it("reuses the Terra admission thread when the service provides one", async () => {
    const server = new FakeAppServer();
    const checkpoints: RemoteTurnRef[] = [];
    server.queued.push({
      output: {
        status: "completed",
        response: "integrated",
        validation: [],
        needsAction: null,
        error: null,
        planIssues: [],
      },
    });
    const integrator = new AppServerTerraIntegrator({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn: (_runId, turn) => {
        checkpoints.push(structuredClone(turn));
      },
    });
    const outcome = await integrator.integrate({
      runId: "run-1",
      request: { objective: "inspect modules", cwd: "/workspace/candidate" },
      plan: executionPlan(),
      leaves: [completedLeaf()],
      coordinatorThreadId: "terra-admission",
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
    });

    expect(outcome.threadId).toBe("terra-admission");
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts[0]).toMatchObject({
      threadId: "terra-admission",
      model: "gpt-5.6-terra",
      cwd: "/workspace/candidate",
      runtimeWorkspaceRoots: ["/workspace/candidate"],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(checkpoints).toEqual([
      expect.objectContaining({ role: "integrator", turnId: null, state: "thread_started" }),
      expect.objectContaining({ role: "integrator", turnId: "turn-1", state: "running" }),
      expect.objectContaining({ role: "integrator", turnId: "turn-1", state: "terminal" }),
    ]);
  });

  it("checkpoints new integrator and reused final-review threads through terminal state", async () => {
    const server = new FakeAppServer();
    server.queued.push(
      {
        output: {
          status: "completed",
          response: "integrated",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
      },
      {
        output: {
          approved: true,
          issues: [],
          replacementResponse: null,
        },
      },
    );
    const checkpoints: RemoteTurnRef[] = [];
    const checkpointRemoteTurn = async (runId: string, turn: RemoteTurnRef): Promise<void> => {
      expect(runId).toBe("run-1");
      checkpoints.push(structuredClone(turn));
    };
    const plan = executionPlan();
    const request = { objective: "inspect modules", cwd: "/workspace" };
    const leaves = [completedLeaf()];
    const integrator = new AppServerTerraIntegrator({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn,
    });
    const ensurePlannerThread = vi.fn(async () => undefined);
    const integrated = await integrator.integrate({
      runId: "run-1",
      request,
      plan,
      leaves,
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
    });
    const reviewer = new AppServerSolFinalReviewer({
      appServer: server,
      cwd: "/workspace",
      checkpointRemoteTurn,
      ensurePlannerThread,
    });
    await reviewer.review({
      runId: "run-1",
      request,
      plan,
      leaves,
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
      integratedResponse: integrated.response ?? "",
      integrationValidation: integrated.validation ?? [],
      integratorThreadId: integrated.threadId,
    });

    expect(ensurePlannerThread).toHaveBeenCalledWith("planner-thread", expect.any(AbortSignal));

    expect(
      checkpoints.map(({ role, taskId, threadId, turnId, access, state }) => ({
        role,
        taskId,
        threadId,
        turnId,
        access,
        state,
      })),
    ).toEqual([
      {
        role: "integrator",
        taskId: undefined,
        threadId: "thread-1",
        turnId: null,
        access: "readOnly",
        state: "thread_started",
      },
      {
        role: "integrator",
        taskId: undefined,
        threadId: "thread-1",
        turnId: "turn-1",
        access: "readOnly",
        state: "running",
      },
      {
        role: "integrator",
        taskId: undefined,
        threadId: "thread-1",
        turnId: "turn-1",
        access: "readOnly",
        state: "terminal",
      },
      {
        role: "finalReview",
        taskId: undefined,
        threadId: "planner-thread",
        turnId: "turn-2",
        access: "readOnly",
        state: "running",
      },
      {
        role: "finalReview",
        taskId: undefined,
        threadId: "planner-thread",
        turnId: "turn-2",
        access: "readOnly",
        state: "terminal",
      },
    ]);
  });

  it("runs ordinary Terra integration and continues the planner thread for Sol review", async () => {
    const server = new FakeAppServer();
    server.queued.push(
      {
        output: {
          status: "completed",
          response: "integrated",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
      },
      {
        output: {
          approved: true,
          issues: [],
          replacementResponse: null,
        },
      },
    );
    const plan = executionPlan();
    const request = { objective: "inspect modules", cwd: "/workspace/candidate" };
    const leaves = [completedLeaf()];
    const integrator = new AppServerTerraIntegrator({ appServer: server, cwd: "/workspace" });
    const integrated = await integrator.integrate({
      runId: "run-1",
      request,
      plan,
      leaves,
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
    });
    const reviewer = new AppServerSolFinalReviewer({ appServer: server, cwd: "/workspace" });
    const reviewed = await reviewer.review({
      runId: "run-1",
      request,
      plan,
      leaves,
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
      integratedResponse: integrated.response ?? "",
      integrationValidation: integrated.validation ?? [],
      integratorThreadId: integrated.threadId,
    });

    expect(integrated).toMatchObject({
      status: "completed",
      response: "integrated",
      threadId: "thread-1",
    });
    expect(reviewed).toMatchObject({
      approved: true,
      issues: [],
      threadId: "planner-thread",
    });
    expect(reviewed).not.toHaveProperty("replacementResponse");
    expect(server.threadStarts).toHaveLength(1);
    expect(server.threadStarts[0]).toMatchObject({
      model: "gpt-5.6-terra",
      cwd: "/workspace/candidate",
      runtimeWorkspaceRoots: ["/workspace/candidate"],
      sandbox: "read-only",
    });
    expect(server.turnStarts[0]).toMatchObject({
      cwd: "/workspace/candidate",
      runtimeWorkspaceRoots: ["/workspace/candidate"],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(server.turnStarts[1]).toMatchObject({
      threadId: "planner-thread",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/workspace/candidate",
      runtimeWorkspaceRoots: ["/workspace/candidate"],
      outputSchema: FINAL_REVIEW_OUTPUT_SCHEMA,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("returns a replacement response only when Sol rejects the Terra response", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: {
        approved: false,
        issues: ["The conclusion contradicts the validator output."],
        replacementResponse: "Corrected result",
      },
    });
    const reviewer = new AppServerSolFinalReviewer({ appServer: server, cwd: "/workspace" });

    const reviewed = await reviewer.review({
      runId: "run-1",
      request: { objective: "inspect modules", cwd: "/workspace/candidate" },
      plan: executionPlan(),
      leaves: [completedLeaf()],
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
      integratedResponse: "integrated",
      integrationValidation: [],
      integratorThreadId: "terra-integrator",
    });

    expect(reviewed).toMatchObject({
      approved: false,
      issues: ["The conclusion contradicts the validator output."],
      replacementResponse: "Corrected result",
      threadId: "planner-thread",
    });
  });

  it("gives Sol aggregate passing state and bounded failure evidence", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: {
        approved: true,
        issues: [],
        replacementResponse: null,
      },
    });
    const leaf = completedLeaf();
    leaf.validation = [
      {
        command: "failing command ".repeat(40),
        status: "failed",
        summary: "failure detail ".repeat(80),
      },
      {
        command: "private passing leaf command",
        status: "passed",
        summary: "private passing leaf output",
      },
    ];
    const reviewer = new AppServerSolFinalReviewer({ appServer: server, cwd: "/workspace" });

    await reviewer.review({
      runId: "compact-review",
      request: { objective: "inspect modules", cwd: "/workspace/candidate" },
      plan: executionPlan(),
      leaves: [leaf],
      coordinatorThreadId: null,
      plannerThreadId: "planner-thread",
      signal: new AbortController().signal,
      integratedResponse: "integrated",
      integrationValidation: [
        {
          command: "private passing integration command",
          status: "passed",
          summary: "private passing integration output",
        },
      ],
      integratorThreadId: "terra-integrator",
    });

    const prompt = server.turnStarts[0]?.input[0];
    expect(prompt).toMatchObject({ type: "text" });
    if (prompt?.type === "text") {
      expect(prompt.text).toContain('"integrationValidation":{"count":1,"status":"passed"}');
      expect(prompt.text).toContain('"validation":{"count":2,"status":"failed"');
      expect(prompt.text).toContain('"failures"');
      expect(prompt.text).not.toContain("private passing integration command");
      expect(prompt.text).not.toContain("private passing integration output");
      expect(prompt.text).not.toContain("private passing leaf command");
      expect(prompt.text).not.toContain("private passing leaf output");
      expect(prompt.text.length).toBeLessThan(2_500);
    }
  });

  it("rejects a duplicated response in an approved Sol verdict", async () => {
    const server = new FakeAppServer();
    server.queued.push({
      output: {
        approved: true,
        issues: [],
        replacementResponse: "unnecessarily repeated response",
      },
    });
    const reviewer = new AppServerSolFinalReviewer({ appServer: server, cwd: "/workspace" });

    await expect(
      reviewer.review({
        runId: "run-1",
        request: { objective: "inspect modules", cwd: "/workspace/candidate" },
        plan: executionPlan(),
        leaves: [completedLeaf()],
        coordinatorThreadId: null,
        plannerThreadId: "planner-thread",
        signal: new AbortController().signal,
        integratedResponse: "integrated",
        integrationValidation: [],
        integratorThreadId: "terra-integrator",
      }),
    ).rejects.toThrow("approved FinalReview cannot include replacementResponse");
  });
});

function agentMessage(): AgentMessage {
  return {
    id: "message-1",
    type: "answer",
    fromTaskId: "leaf-b",
    toTaskId: "leaf-a",
    body: "Use v3.",
    blocking: false,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}
