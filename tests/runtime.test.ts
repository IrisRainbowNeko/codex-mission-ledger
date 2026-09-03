import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../src/app-server/client.js";
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
import type {
  ExecutionLimits,
  ExecutionPlan,
  JobSnapshot,
  LeafResult,
  LeafTask,
  ModelUsage,
} from "../src/core/contracts.js";
import type {
  AdmissionController,
  AgentOutcome,
  DirectExecutor,
  RecoveryAdapter,
  ResultIntegrator,
} from "../src/core/integration.js";
import { JobStore, hashRunRequest } from "../src/core/job-store.js";
import { validateExecutionPlan } from "../src/core/plan-validation.js";
import { evaluateFanoutAdmission } from "../src/core/policy.js";
import type { PlannerSession, PlannerTransport, PlannerTurnRequest } from "../src/core/planner.js";
import type { ReplanHandler } from "../src/core/scheduler.js";
import {
  createDefaultRuntime,
  createNonLeafCostEstimator,
  loadPriceTable,
  type RuntimePlanner,
  type RuntimeScheduler,
  type RuntimeWorkspace,
} from "../src/runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createDefaultRuntime", () => {
  it("assembles a lazy pinned App Server client without launching a process", async () => {
    const root = temporaryRoot("agent-trio-runtime-");
    const spawnProcess = vi.fn(() => {
      throw new Error("runtime construction must not start codex");
    });

    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "jobs"),
      processOptions: { spawnProcess },
    });

    expect(runtime.appServer).toBeInstanceOf(CodexAppServerClient);
    expect(runtime.appServer.state).toBe("disconnected");
    expect(existsSync(join(root, "jobs"))).toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();

    await runtime.close();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects proxy transport when the runtime cannot prove process-level plugin isolation", () => {
    const root = temporaryRoot("agent-trio-runtime-proxy-");

    expect(() =>
      createDefaultRuntime({
        cwd: root,
        jobRoot: join(root, "jobs"),
        processOptions: { transport: "proxy", socketPath: join(root, "app-server.sock") },
      }),
    ).toThrow("proxy transport cannot guarantee plugin isolation");
  });

  it("requires an explicit credential for the lightweight Responses planner", () => {
    const root = temporaryRoot("agent-trio-runtime-responses-");
    const codexHome = temporaryRoot("agent-trio-runtime-empty-codex-home-");
    expect(() =>
      createDefaultRuntime({
        cwd: root,
        jobRoot: join(root, "jobs"),
        env: { AGENT_TRIO_PLANNER_TRANSPORT: "responses", CODEX_HOME: codexHome },
      }),
    ).toThrow("requires explicit credentials or a Responses-compatible local Codex provider");
  });

  it("prices conservative non-leaf reservations from the configured model table", () => {
    const estimator = createNonLeafCostEstimator(
      { sol: "sol-priced" },
      {
        "sol-priced": {
          inputPerMillionUsd: 10,
          cachedInputPerMillionUsd: 1,
          outputPerMillionUsd: 30,
        },
      },
    );
    const input = {
      stage: "planning" as const,
      request: { objective: "plan", cwd: "/workspace" },
      context: { constraints: ["bounded"] },
    };
    const structuredTokens = Math.ceil(Buffer.byteLength(JSON.stringify(input), "utf8") / 4);

    expect(estimator.estimateUsd(input)).toBeCloseTo(
      ((14_500 + structuredTokens) * 10 + 250 * 30) / 1_000_000,
      10,
    );
    expect(createNonLeafCostEstimator({}, undefined).estimateUsd(input)).toBeNull();
  });

  it("uses the compact reservation envelope for a Responses Sol planner", () => {
    const prices = {
      "sol-priced": {
        inputPerMillionUsd: 10,
        cachedInputPerMillionUsd: 1,
        outputPerMillionUsd: 30,
      },
    };
    const input = {
      stage: "planning" as const,
      request: { objective: "plan", cwd: "/workspace" },
      context: { constraints: ["bounded"] },
    };
    const appServer = createNonLeafCostEstimator({ sol: "sol-priced" }, prices).estimateUsd(input);
    const responses = createNonLeafCostEstimator({ sol: "sol-priced" }, prices, {
      plannerTransport: "responses",
      plannerModel: "sol-priced",
    }).estimateUsd(input);

    expect(responses).not.toBeNull();
    expect(responses!).toBeLessThan(appServer!);
  });

  it("prices direct reservations at the tier used by the direct executor", () => {
    const estimator = createNonLeafCostEstimator(
      { luna: "luna-priced", terra: "terra-priced" },
      {
        "luna-priced": {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 2,
        },
        "terra-priced": {
          inputPerMillionUsd: 10,
          outputPerMillionUsd: 20,
        },
      },
    );
    const luna = estimator.estimateUsd({
      stage: "direct",
      request: { objective: "fix one typo", cwd: "/workspace" },
      context: {},
    });
    const terra = estimator.estimateUsd({
      stage: "direct",
      request: {
        objective: "redesign the authentication security architecture",
        cwd: "/workspace",
      },
      context: {},
    });

    expect(luna).not.toBeNull();
    expect(terra).not.toBeNull();
    expect(terra!).toBeGreaterThan(luna! * 9);
  });

  it("loads an optional cache-write rate while retaining legacy price aliases", () => {
    const root = temporaryRoot("agent-trio-runtime-prices-");
    const path = join(root, "prices.json");
    writeFileSync(
      path,
      JSON.stringify({
        models: {
          "priced-cache": {
            inputPerMillionUsd: 10,
            cachedInputPerMillionUsd: 1,
            cacheWriteInputPerMillionUsd: 2,
            outputPerMillionUsd: 30,
          },
        },
      }),
    );

    expect(loadPriceTable(path)).toEqual({
      "priced-cache": {
        inputPerMillionUsd: 10,
        cachedInputPerMillionUsd: 1,
        cacheWriteInputPerMillionUsd: 2,
        outputPerMillionUsd: 30,
      },
    });
  });

  it("fails before starting App Server work when hard-budget pricing is unavailable", async () => {
    const root = temporaryRoot("agent-trio-runtime-unpriced-budget-");
    const appServer = new FakeAppServer({});
    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "jobs"),
      modelMap: { luna: "unpriced-luna" },
      components: { appServer },
    });

    const result = await runtime.service.run({
      runId: "runtime-unpriced-budget",
      objective: "bounded task",
      cwd: root,
      limits: { maxCostUsd: 1 },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("no reliable pre-call USD estimate"),
    });
    expect(appServer.threadStarts).toHaveLength(0);
    await runtime.close();
  });

  it("merges durable latency percentiles with prices in the default Sol planner context", async () => {
    const root = temporaryRoot("agent-trio-runtime-history-");
    const store = new JobStore(join(root, "jobs"));
    const historyTask = {
      ...leafTask(),
      access: "readOnly" as const,
      ownedPaths: [],
    };
    const historyPlan = executionPlan(historyTask);
    const historicalRequest = { objective: "historical task", cwd: root };
    store.save({
      protocolVersion: 1,
      requestHash: hashRunRequest(historicalRequest),
      request: historicalRequest,
      result: {
        protocolVersion: 1,
        runId: "history-luna",
        status: "completed",
        plan: historyPlan,
        patch: null,
        leaves: [runtimeLeafResult(historyTask, 12_500)],
        finalResponse: "done",
        metrics: null,
      },
      remoteTurns: [],
      coordinatorThreadId: null,
      plannerThreadId: null,
      integratorThreadId: null,
      updatedAt: "2026-08-28T01:00:00.000Z",
    } satisfies JobSnapshot);

    const plan = executionPlan({
      ...historyTask,
      id: "alpha",
      objective: "inspect alpha",
      expectedSeconds: 90,
    });
    plan.tasks.push({
      ...historyTask,
      id: "beta",
      objective: "inspect beta",
      expectedSeconds: 90,
    });
    expect(validateExecutionPlan(plan)).toMatchObject({ ok: true });
    expect(evaluateFanoutAdmission(plan)).toMatchObject({ admitted: true });
    const starts: PlannerTurnRequest[] = [];
    const plannerTransport: PlannerTransport = {
      start: vi.fn(async (request) => {
        starts.push(request);
        return { threadId: "planner-history", output: plan };
      }),
      continue: vi.fn(async () => {
        throw new Error("unexpected planner continuation");
      }),
    };
    const scheduler: RuntimeScheduler = {
      execute: vi.fn(async (_runId, activePlan: ExecutionPlan) => ({
        plan: activePlan,
        patch: null,
        leaves: activePlan.tasks.map((task) => runtimeLeafResult(task, 1_000)),
        launchSkewMs: 0,
        peakConcurrency: 2,
        replanCount: 0,
        usage: [],
      })),
    };
    const workspace: RuntimeWorkspace = {
      prepare: vi.fn(async () => undefined),
      cwdFor: vi.fn(() => root),
      updatePlan: vi.fn(async () => undefined),
      prepareTask: vi.fn(async () => root),
      prepareValidation: vi.fn(async () => root),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const coordinator: AdmissionController & DirectExecutor = {
      decide: vi.fn(() => ({ route: "fanout" as const, reason: "independent work" })),
      execute: vi.fn(async () => completedOutcome("unused")),
    };
    const appServer = new FakeAppServer({});
    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "ignored-jobs"),
      modelMap: { luna: "luna-priced" },
      priceTable: {
        "luna-priced": {
          inputPerMillionUsd: 10,
          cachedInputPerMillionUsd: 1,
          outputPerMillionUsd: 30,
        },
      },
      components: {
        appServer,
        store,
        workspace,
        capabilityCatalog: {
          listSkills: async () => [],
          listPlugins: async () => [],
        },
        plannerTransport,
        scheduler,
        coordinator,
      },
    });

    const result = await runtime.service.run({
      runId: "runtime-latency-merge",
      objective: "inspect alpha and beta",
      cwd: root,
      integrate: false,
    });

    expect(
      result.status,
      `${result.error ?? "runtime failed without an error"}; planner starts=${String(starts.length)}`,
    ).toBe("completed");
    expect(starts).toHaveLength(1);
    const payload = plannerPromptPayload(starts[0]?.prompt ?? "");
    expect(payload.economics).toContainEqual(["l", 10, 1, 30, 12.5, 12.5]);

    await runtime.close();
  });

  it("routes bounded direct work to Luna without a model admission turn", async () => {
    const root = temporaryRoot("agent-trio-runtime-luna-direct-");
    const appServer = new FakeAppServer({
      status: "completed",
      response: "fixed",
      validation: [],
      needsAction: null,
      error: null,
    });
    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "jobs"),
      components: { appServer },
    });

    const result = await runtime.service.run({ objective: "fix one typo", cwd: root });

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "fixed",
      metrics: {
        plannerSkipped: true,
        usageByStage: { admission: { usage: [] }, direct: { usage: [{ tier: "luna" }] } },
      },
    });
    expect(appServer.threadStarts).toHaveLength(1);
    expect(appServer.threadStarts[0]?.model).toBe("gpt-5.6-luna");
    expect(appServer.turnStarts[0]?.effort).toBe("low");
    await runtime.close();
  });

  it("honors the calling Sol's Luna choice for delegated direct algorithm work", async () => {
    const root = temporaryRoot("agent-trio-runtime-delegated-luna-");
    const appServer = new FakeAppServer({
      status: "completed",
      response: "proved",
      validation: [],
      needsAction: null,
      error: null,
    });
    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "jobs"),
      components: { appServer },
    });

    const result = await runtime.service.run({
      objective: "prove the bound",
      cwd: root,
      domain: "algorithm",
      strategy: "direct",
      directTier: "luna",
    });

    expect(result.metrics?.usageByStage?.admission.usage).toEqual([]);
    expect(result.metrics?.usageByStage?.direct.usage).toEqual([
      expect.objectContaining({ tier: "luna" }),
    ]);
    expect(appServer.threadStarts).toHaveLength(1);
    expect(appServer.threadStarts[0]?.model).toBe("gpt-5.6-luna");
    expect(appServer.turnStarts[0]?.effort).toBe("low");
    await runtime.close();
  });

  it("runs a host-Sol semantic plan on parallel Luna leaves without a planner thread", async () => {
    const root = temporaryRoot("agent-trio-runtime-host-plan-");
    const appServer = new FakeAppServer({ ...leafBody(), changedFiles: [] });
    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "jobs"),
      components: {
        appServer,
        capabilityCatalog: { listSkills: async () => [], listPlugins: async () => [] },
      },
    });
    const ownedPaths = ["alpha", "beta"].map((id) =>
      Array.from({ length: 20 }, (_, index) => {
        const path = `${id}-${String(index)}.txt`;
        writeFileSync(join(root, path), "x".repeat(4_096));
        return path;
      }),
    );
    const semanticPlan = {
      access: "readOnly" as const,
      merge: "deterministic" as const,
      risk: "low" as const,
      tasks: ["alpha", "beta"].map((id, index) => ({
        goal: `Inspect ${id}`,
        paths: ownedPaths[index]!,
        after: [],
        floor: null,
        expectedSeconds: 46,
      })),
    };

    const result = await runtime.service.run({
      runId: "runtime-host-plan",
      objective:
        "Inspect alpha and beta as two independent long-running workstreams and produce a comprehensive evidence report.",
      cwd: root,
      domain: "autoResearch",
      semanticPlan,
      limits: { maxLeaves: 2 },
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      plan: { planId: "host-plan" },
      metrics: {
        plannerSkipped: true,
        selectedLeafCount: 2,
        usageByStage: { planning: { usage: [] } },
      },
    });
    expect(appServer.threadStarts).toHaveLength(2);
    expect(appServer.threadStarts.every((thread) => thread.model === "gpt-5.6-luna")).toBe(true);
    await runtime.close();
  });

  it("wires capability discovery, resolution, and isolation into the default Terra coordinator", async () => {
    const root = temporaryRoot("agent-trio-runtime-capabilities-");
    const shared = new FakeAppServer({
      route: "direct",
      reason: "browser capability required",
      outcome: null,
      needsAction: null,
      requiredCapabilities: [{ kind: "plugin", name: "browser@openai-bundled", path: null }],
    });
    const isolated = new FakeAppServer({
      status: "completed",
      response: "browser task complete",
      validation: [],
      needsAction: null,
      error: null,
    });
    const listSkills = vi.fn(async () => []);
    const listPlugins = vi.fn(async () => [{ id: "browser@openai-bundled", enabled: true }]);
    const resolveCapabilities = vi.fn(async (requested: readonly { name: string }[]) =>
      requested.length === 0
        ? { skills: [], plugins: [], requiresIsolatedProcess: false }
        : {
            skills: [],
            plugins: [{ kind: "plugin" as const, name: "browser@openai-bundled" }],
            requiresIsolatedProcess: true,
          },
    );
    const createIsolated = vi.fn(async () => isolated);
    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "jobs"),
      components: {
        appServer: shared,
        capabilityCatalog: { listSkills, listPlugins },
        capabilityResolver: { resolve: resolveCapabilities },
        isolatedServerFactory: { create: createIsolated },
      },
    });

    const result = await runtime.service.run({
      runId: "runtime-capability-wiring",
      objective: "inspect the current browser page",
      cwd: root,
    });

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "browser task complete",
    });
    expect(listSkills).toHaveBeenCalledWith(root);
    expect(listPlugins).toHaveBeenCalledOnce();
    expect(resolveCapabilities).toHaveBeenCalledTimes(2);
    expect(createIsolated).toHaveBeenCalledWith({
      cwd: root,
      capabilities: expect.objectContaining({ requiresIsolatedProcess: true }),
    });
    expect(shared.threadStarts).toHaveLength(1);
    expect(isolated.threadStarts).toHaveLength(1);
    expect(isolated.close).toHaveBeenCalledOnce();

    await runtime.close();
    expect(shared.close).toHaveBeenCalledOnce();
  });

  it("shares injected components and wires leaf cwd, checkpoints, models, and prices", async () => {
    const root = temporaryRoot("agent-trio-runtime-wiring-");
    const store = new JobStore(join(root, "jobs"));
    const appServer = new FakeAppServer(leafBody());
    const task = leafTask();
    const plan = executionPlan(task);
    const limits: ExecutionLimits = {
      maxConcurrent: 2,
      maxLeaves: 4,
      maxWaves: 3,
      maxSolLeaves: 1,
      maxReplans: 1,
    };
    const session: PlannerSession = {
      threadId: "planner-injected",
      request: { objective: "implement leaf", cwd: root },
      limits,
      initialPlan: structuredClone(plan),
      plan,
      patch: null,
      replanCount: 0,
      usage: [],
    };
    const replanHandler: ReplanHandler = {
      replan: async () => null,
      answer: async () => "answer",
    };
    const planner: RuntimePlanner = {
      plan: vi.fn(async () => session),
      createReplanHandler: vi.fn(() => replanHandler),
      getSession: vi.fn(() => session),
    };
    const leafCwd = join(root, "isolated-leaf");
    const workspace: RuntimeWorkspace = {
      prepare: vi.fn(async () => undefined),
      cwdFor: vi.fn(() => leafCwd),
      updatePlan: vi.fn(async () => undefined),
      prepareTask: vi.fn(async () => leafCwd),
      prepareValidation: vi.fn(async () => leafCwd),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const coordinator: AdmissionController & DirectExecutor = {
      decide: vi.fn(() => ({ route: "fanout" as const, reason: "independent work" })),
      execute: vi.fn(async () => completedOutcome("unused")),
    };
    const integrator: ResultIntegrator = {
      integrate: vi.fn(async () => completedOutcome("integrated")),
    };
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot }) => ({ result: snapshot.result })),
    };

    const runtime = createDefaultRuntime({
      cwd: root,
      jobRoot: join(root, "ignored-jobs"),
      modelMap: { luna: "luna-test-model" },
      priceTable: {
        "luna-test-model": {
          inputPerMillionUsd: 10,
          cachedInputPerMillionUsd: 1,
          outputPerMillionUsd: 30,
        },
      },
      components: {
        appServer,
        store,
        workspace,
        planner,
        coordinator,
        integrator,
        recovery,
      },
    });

    const result = await runtime.service.run({
      runId: "runtime-wiring",
      objective: "implement leaf",
      cwd: root,
    });

    expect(result.status).toBe("completed");
    expect(result.finalResponse).toBe("integrated");
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.00124, 8);
    expect(workspace.prepareTask).toHaveBeenCalledWith("runtime-wiring", task, []);
    expect(appServer.threadStarts).toEqual([
      expect.objectContaining({ cwd: leafCwd, model: "luna-test-model" }),
    ]);
    expect(store.load("runtime-wiring")?.remoteTurns).toEqual([
      expect.objectContaining({
        role: "leaf",
        taskId: "leaf-a",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "terminal",
      }),
    ]);

    await runtime.close();
    expect(appServer.close).toHaveBeenCalledOnce();
  });
});

class FakeAppServer implements AppServer {
  state = "ready" as const;
  initializeResult: InitializeResponse | null = {
    userAgent: "codex_app_server/0.151.0",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "linux",
  };
  readonly threadStarts: ThreadStartParams[] = [];
  readonly turnStarts: TurnStartParams[] = [];
  readonly close = vi.fn(async () => undefined);
  readonly #output: Record<string, unknown>;
  readonly #handlers = new Map<string, ServerRequestHandler>();
  readonly #subscriptions = new Set<{ method: string | null; handler: NotificationHandler }>();
  readonly #usage = new Map<string, ThreadTokenUsageUpdated>();
  #threadCount = 0;
  #turnCount = 0;

  constructor(output: Record<string, unknown>) {
    this.#output = output;
  }

  connect(): Promise<InitializeResponse> {
    return Promise.resolve(this.initializeResult as InitializeResponse);
  }

  reconnect(): Promise<InitializeResponse> {
    return this.connect();
  }

  request<TResult = JsonValue>(
    _method: string,
    _params?: unknown,
    _options?: RequestOptions,
  ): Promise<TResult> {
    return Promise.reject(new Error("request is not implemented"));
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
    return Promise.reject(new Error("waitForNotification is not implemented"));
  }

  setServerRequestHandler(method: string, handler: ServerRequestHandler | null): void {
    if (handler === null) {
      this.#handlers.delete(method);
    } else {
      this.#handlers.set(method, handler);
    }
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    this.threadStarts.push(params);
    return {
      thread: { id: `thread-${++this.#threadCount}` },
      model: params.model ?? "",
      modelProvider: params.modelProvider ?? "test",
      cwd: params.cwd ?? "/",
      instructionSources: [],
    };
  }

  threadResume(_params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return Promise.reject(new Error("threadResume is not implemented"));
  }

  threadRead(_params: ThreadReadParams): Promise<ThreadReadResponse> {
    return Promise.reject(new Error("threadRead is not implemented"));
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    this.turnStarts.push(params);
    const turnId = `turn-${++this.#turnCount}`;
    const turn = {
      id: turnId,
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: `message-${turnId}`,
          text: JSON.stringify(this.#output),
          phase: "final_answer",
        },
      ],
      error: null,
      startedAt: 1_787_875_200,
      completedAt: 1_787_875_201,
    };
    this.#usage.set(params.threadId, {
      threadId: params.threadId,
      turnId,
      tokenUsage: {
        total: tokenBreakdown(),
        last: tokenBreakdown(),
        modelContextWindow: 128_000,
      },
    });
    this.#emit("turn/completed", { threadId: params.threadId, turn });
    return { turn: { id: turnId } };
  }

  turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return Promise.resolve({ turnId: params.expectedTurnId });
  }

  turnInterrupt(_params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return Promise.resolve({});
  }

  threadUsage(_threadId: string): Promise<ThreadUsageResponse> {
    return Promise.reject(new Error("account usage unavailable"));
  }

  modelList(_params?: ModelListParams): Promise<ModelListResponse> {
    return Promise.resolve({ data: [], nextCursor: null });
  }

  latestThreadTokenUsage(threadId: string): ThreadTokenUsageUpdated | null {
    return this.#usage.get(threadId) ?? null;
  }

  #emit(method: string, params: JsonValue): void {
    const notification = { method, params };
    for (const subscription of this.#subscriptions) {
      if (subscription.method === null || subscription.method === method) {
        void subscription.handler(notification);
      }
    }
  }
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function tokenBreakdown() {
  return {
    totalTokens: 120,
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
  };
}

function leafTask(): LeafTask {
  return {
    id: "leaf-a",
    objective: "implement one bounded file",
    domain: "coding",
    tier: "luna",
    effort: "medium",
    access: "workspaceWrite",
    ownedPaths: ["src/a.ts"],
    dependsOn: [],
    capabilities: [],
    validation: [],
    communicationWith: [],
    expectedSeconds: 60,
    expectedCostUsd: 0.01,
    difficulty: 0.2,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
  };
}

function executionPlan(task: LeafTask): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-runtime",
    objective: "implement leaf",
    domain: "coding",
    assumptions: [],
    tasks: [task],
    integration: {
      objective: "integrate",
      requiredOutputs: ["working result"],
      validation: [],
      finalReview: "never",
    },
    risk: "low",
  };
}

function leafBody(): Record<string, unknown> {
  return {
    status: "completed",
    summary: "leaf complete",
    confidence: 0.9,
    findings: [],
    changedFiles: ["src/a.ts"],
    validation: [],
    citations: [],
    artifacts: [],
    error: null,
    failureKind: null,
  };
}

function completedOutcome(response: string): AgentOutcome {
  return {
    status: "completed",
    response,
    threadId: "terra-injected",
    usage: [] as ModelUsage[],
  };
}

function runtimeLeafResult(task: LeafTask, durationMs: number): LeafResult {
  const startedAt = Date.parse("2026-08-28T00:00:00.000Z");
  return {
    taskId: task.id,
    status: "completed",
    summary: `${task.id} complete`,
    confidence: 0.9,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: `thread-${task.id}`,
    turnId: `turn-${task.id}`,
    usage: [],
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + durationMs).toISOString(),
  };
}

function plannerPromptPayload(prompt: string): {
  economics: unknown[][];
} {
  const marker = prompt.lastIndexOf("\n\n{");
  if (marker < 0) {
    throw new Error("planner prompt does not contain a JSON payload");
  }
  return JSON.parse(prompt.slice(marker + 2)) as {
    economics: unknown[][];
  };
}
