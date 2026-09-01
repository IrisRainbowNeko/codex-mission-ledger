import { describe, expect, it, vi } from "vitest";
import { AppServerLeafExecutor } from "../src/app-server/adapters.js";
import type {
  AppServer,
  AppServerNotification,
  AppServerState,
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
import type { LeafTask } from "../src/core/contracts.js";

const INITIALIZED: InitializeResponse = {
  userAgent: "codex_app_server/0.151.0",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

class LifecycleAppServer implements AppServer {
  state: AppServerState;
  initializeResult: InitializeResponse | null;
  readonly turnStarts: TurnStartParams[] = [];
  readonly interrupts: TurnInterruptParams[] = [];
  readonly close = vi.fn(async () => undefined);
  readonly connect = vi.fn(async () => {
    if (this.connectError !== null) {
      throw this.connectError;
    }
    this.state = "ready";
    this.initializeResult = INITIALIZED;
    return INITIALIZED;
  });
  readonly reconnect = vi.fn(async () => INITIALIZED);
  connectError: Error | null = null;
  completeTurns = true;
  #threadCount = 0;
  #turnCount = 0;
  readonly #subscriptions = new Set<{ method: string | null; handler: NotificationHandler }>();
  readonly #handlers = new Map<string, ServerRequestHandler>();

  constructor(state: AppServerState = "ready") {
    this.state = state;
    this.initializeResult = state === "ready" ? INITIALIZED : null;
  }

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
      this.#handlers.delete(method);
    } else {
      this.#handlers.set(method, handler);
    }
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const id = `thread-${++this.#threadCount}`;
    return Promise.resolve({
      thread: { id },
      model: params.model ?? "gpt-5.6-luna",
      modelProvider: params.modelProvider ?? "test",
      cwd: params.cwd ?? "/workspace",
      instructionSources: [],
    });
  }

  threadResume(_params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  threadRead(_params: ThreadReadParams): Promise<ThreadReadResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    this.turnStarts.push(params);
    const turnId = `turn-${++this.#turnCount}`;
    if (this.completeTurns) {
      this.emit("turn/completed", {
        threadId: params.threadId,
        turn: {
          id: turnId,
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: `message-${turnId}`,
              text: JSON.stringify(completedLeafBody()),
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
        },
      });
    }
    return Promise.resolve({ turn: { id: turnId } });
  }

  turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return Promise.resolve({ turnId: params.expectedTurnId });
  }

  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    this.interrupts.push(params);
    return Promise.resolve({});
  }

  threadUsage(threadId: string): Promise<ThreadUsageResponse> {
    return Promise.resolve({
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
        estimatedUsageUsdMicros: 0,
        groups: [],
      },
    });
  }

  modelList(_params?: ModelListParams): Promise<ModelListResponse> {
    return Promise.resolve({ data: [], nextCursor: null });
  }

  latestThreadTokenUsage(_threadId: string): ThreadTokenUsageUpdated | null {
    return null;
  }

  private emit(method: string, params: JsonValue): void {
    for (const subscription of this.#subscriptions) {
      if (subscription.method === null || subscription.method === method) {
        void subscription.handler({ method, params });
      }
    }
  }
}

describe("AppServerLeafExecutor isolated server lifecycle", () => {
  it("closes an isolated server exactly once after a successful leaf", async () => {
    const shared = new LifecycleAppServer();
    const isolated = new LifecycleAppServer();
    const executor = isolatedExecutor(shared, isolated);

    const result = await runLeaf(executor, new AbortController().signal, pluginTask());

    expect(result.status).toBe("completed");
    expect(isolated.close).toHaveBeenCalledTimes(1);
    expect(shared.close).not.toHaveBeenCalled();
  });

  it("closes an isolated server exactly once when connecting fails", async () => {
    const shared = new LifecycleAppServer();
    const isolated = new LifecycleAppServer("disconnected");
    isolated.connectError = new Error("isolated connect failed");
    const executor = isolatedExecutor(shared, isolated);

    await expect(runLeaf(executor, new AbortController().signal, pluginTask())).rejects.toThrow(
      "isolated connect failed",
    );

    expect(isolated.close).toHaveBeenCalledTimes(1);
    expect(shared.close).not.toHaveBeenCalled();
  });

  it("closes an isolated server exactly once when a running leaf is aborted", async () => {
    const shared = new LifecycleAppServer();
    const isolated = new LifecycleAppServer();
    isolated.completeTurns = false;
    const executor = isolatedExecutor(shared, isolated);
    const controller = new AbortController();

    const running = runLeaf(executor, controller.signal, pluginTask());
    await vi.waitFor(() => expect(isolated.turnStarts).toHaveLength(1));
    controller.abort(new Error("cancel leaf"));

    await expect(running).rejects.toThrow("cancel leaf");
    expect(isolated.interrupts).toContainEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(isolated.close).toHaveBeenCalledTimes(1);
    expect(shared.close).not.toHaveBeenCalled();
  });

  it("never closes the shared server after a non-isolated leaf completes", async () => {
    const shared = new LifecycleAppServer();
    const unusedIsolated = new LifecycleAppServer();
    const create = vi.fn(async () => unusedIsolated);
    const executor = new AppServerLeafExecutor({
      appServer: shared,
      cwd: "/workspace",
      isolatedServerFactory: { create },
    });

    const result = await runLeaf(executor, new AbortController().signal, plainTask());

    expect(result.status).toBe("completed");
    expect(create).not.toHaveBeenCalled();
    expect(shared.close).not.toHaveBeenCalled();
    expect(unusedIsolated.close).not.toHaveBeenCalled();
  });

  it("allows the same task id to run concurrently in different runs", async () => {
    const shared = new LifecycleAppServer();
    shared.completeTurns = false;
    const executor = new AppServerLeafExecutor({ appServer: shared, cwd: "/workspace" });
    const first = new AbortController();
    const second = new AbortController();

    const firstRun = runLeaf(executor, first.signal, plainTask(), "run-a");
    const secondRun = runLeaf(executor, second.signal, plainTask(), "run-b");
    await vi.waitFor(() => expect(shared.turnStarts).toHaveLength(2));

    first.abort(new Error("stop run a"));
    second.abort(new Error("stop run b"));
    await expect(firstRun).rejects.toThrow("stop run a");
    await expect(secondRun).rejects.toThrow("stop run b");
  });
});

function isolatedExecutor(shared: AppServer, isolated: AppServer): AppServerLeafExecutor {
  return new AppServerLeafExecutor({
    appServer: shared,
    cwd: "/workspace",
    capabilityResolver: {
      resolve: async () => ({
        skills: [],
        plugins: [{ kind: "plugin", name: "browser" }],
        requiresIsolatedProcess: true,
      }),
    },
    isolatedServerFactory: { create: async () => isolated },
  });
}

function runLeaf(
  executor: AppServerLeafExecutor,
  signal: AbortSignal,
  task: LeafTask,
  runId = "run-lifecycle",
) {
  return executor.runLeaf(
    {
      runId,
      task,
      dependencies: [],
      attempt: 1,
      signal,
    },
    async () => null,
  );
}

function plainTask(): LeafTask {
  return {
    id: "leaf-lifecycle",
    objective: "inspect one module",
    domain: "coding",
    tier: "luna",
    effort: "medium",
    access: "readOnly",
    ownedPaths: [],
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

function pluginTask(): LeafTask {
  return {
    ...plainTask(),
    capabilities: [{ kind: "plugin", name: "browser" }],
  };
}

function completedLeafBody(): Record<string, unknown> {
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
  };
}
