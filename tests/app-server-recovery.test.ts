import { describe, expect, it, vi } from "vitest";
import { AppServerRecoveryAdapter } from "../src/app-server/index.js";
import type {
  AppServer,
  AppServerNotification,
  InitializeResponse,
  JsonValue,
  NotificationHandler,
  NotificationWaitOptions,
  RequestOptions,
  ServerRequestHandler,
  ThreadReadParams,
  ThreadReadResponse,
  TurnInterruptParams,
} from "../src/app-server/types.js";
import type {
  ExecutionPlan,
  JobSnapshot,
  LeafResult,
  LeafTask,
  RemoteTurnRef,
} from "../src/core/contracts.js";

const INITIALIZED: InitializeResponse = {
  userAgent: "codex_app_server/0.151.0",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

class RecoveryAppServer implements AppServer {
  state = "ready" as const;
  initializeResult: InitializeResponse | null = INITIALIZED;
  readonly turns = new Map<string, JsonValue[]>();
  readonly interrupts: TurnInterruptParams[] = [];
  readonly threadStarts: unknown[] = [];
  readonly turnStarts: unknown[] = [];
  readonly handlers = new Map<string, ServerRequestHandler>();

  connect = vi.fn(async () => INITIALIZED);
  reconnect = vi.fn(async () => INITIALIZED);
  close = vi.fn(async () => undefined);

  request<TResult = JsonValue>(
    _method: string,
    _params?: unknown,
    _options?: RequestOptions,
  ): Promise<TResult> {
    return Promise.reject(new Error("not implemented"));
  }

  notify(_method: string, _params?: unknown): Promise<void> {
    return Promise.resolve();
  }

  onNotification(_handler: NotificationHandler): () => void;
  onNotification(_method: string, _handler: NotificationHandler): () => void;
  onNotification(
    _methodOrHandler: string | NotificationHandler,
    _handler?: NotificationHandler,
  ): () => void {
    return () => undefined;
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

  async threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return {
      thread: {
        id: params.threadId,
        turns: params.includeTurns === true ? (this.turns.get(params.threadId) ?? []) : [],
      },
    };
  }

  async threadStart(): Promise<never> {
    this.threadStarts.push({});
    throw new Error("recovery must not start threads");
  }

  threadResume(): Promise<never> {
    return Promise.reject(new Error("recovery must not resume threads"));
  }

  async turnStart(): Promise<never> {
    this.turnStarts.push({});
    throw new Error("recovery must not start turns");
  }

  turnSteer(): Promise<never> {
    return Promise.reject(new Error("recovery must not steer turns"));
  }

  async turnInterrupt(params: TurnInterruptParams) {
    this.interrupts.push(params);
    return {};
  }

  async threadUsage() {
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
        threadId: "thread",
        estimatedUsageCreditsMicros: 0,
        estimatedUsageUsdMicros: 0,
        groups: [],
      },
    };
  }

  modelList() {
    return Promise.resolve({ data: [], nextCursor: null });
  }

  latestThreadTokenUsage() {
    return null;
  }
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
    communicationWith: [],
    expectedSeconds: 30,
    difficulty: 0.2,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
    ...overrides,
  };
}

function plan(leaf = task()): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    objective: "inspect modules",
    domain: "coding",
    assumptions: [],
    tasks: [leaf],
    integration: {
      objective: "integrate",
      requiredOutputs: ["answer"],
      validation: [],
      finalReview: "never",
    },
    risk: "low",
  };
}

function snapshot(leaf = task(), remoteTurns: RemoteTurnRef[] = []): JobSnapshot {
  return {
    protocolVersion: 1,
    requestHash: "hash",
    request: { objective: "inspect modules", cwd: "/workspace", integrate: false },
    result: {
      protocolVersion: 1,
      runId: "run-1",
      status: "running",
      plan: plan(leaf),
      patch: null,
      leaves: [],
      finalResponse: null,
      metrics: null,
    },
    remoteTurns,
    coordinatorThreadId: null,
    plannerThreadId: "planner-thread",
    integratorThreadId: null,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function leafRef(overrides: Partial<RemoteTurnRef> = {}): RemoteTurnRef {
  return {
    role: "leaf",
    taskId: "leaf-a",
    threadId: "leaf-thread",
    turnId: "leaf-turn",
    access: "readOnly",
    state: "terminal",
    updatedAt: "2026-08-28T00:00:01.000Z",
    ...overrides,
  };
}

function completedTurn(output: unknown, id = "leaf-turn"): JsonValue {
  return {
    id,
    status: "completed",
    items: [
      {
        type: "agentMessage",
        id: "message-1",
        text: JSON.stringify(output),
        phase: "final_answer",
      },
    ],
    startedAt: 1_787_875_200,
    completedAt: 1_787_875_201,
  } as JsonValue;
}

function leafOutput() {
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

function persistedLeaf(overrides: Partial<LeafResult> = {}): LeafResult {
  return {
    taskId: "leaf-a",
    status: "completed",
    summary: "inspection complete",
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
    ...overrides,
  };
}

describe("AppServerRecoveryAdapter", () => {
  it("rehydrates a terminal leaf without starting or replaying model work", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [completedTurn(leafOutput())]);
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: snapshot(task(), [leafRef()]),
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "running",
      finalResponse: null,
      leaves: [
        {
          taskId: "leaf-a",
          status: "completed",
          threadId: "leaf-thread",
          turnId: "leaf-turn",
        },
      ],
    });
    expect(recovered.continuation).toMatchObject({
      workspaceWritersMayHaveRun: false,
      initialLeaves: [
        {
          taskId: "leaf-a",
          status: "completed",
          threadId: "leaf-thread",
          turnId: "leaf-turn",
        },
      ],
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("returns a same-thread direct continuation for a durable waiting checkpoint", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("terra-direct", [completedTurn({}, "direct-turn")]);
    const input = snapshot();
    input.result.plan = null;
    input.result.status = "waiting_input";
    input.result.needsAction = "provide credentials";
    input.plannerThreadId = null;
    input.integratorThreadId = "terra-direct";
    input.remoteTurns = [
      {
        role: "direct",
        threadId: "terra-direct",
        turnId: "direct-turn",
        access: "workspaceWrite",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
    ];
    input.waitingInputCheckpoint = {
      kind: "direct",
      turn: {
        threadId: "terra-direct",
        previousTurnId: "direct-turn",
        cwd: "/workspace",
        needsAction: "provide credentials",
        capabilities: [],
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    };
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("running");
    expect(recovered.continuation).toMatchObject({
      initialLeaves: [],
      workspaceWritersMayHaveRun: false,
      waitingInput: {
        kind: "direct",
        turn: { threadId: "terra-direct", previousTurnId: "direct-turn" },
      },
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("keeps completed siblings and resumes only a permission-blocked leaf", async () => {
    const server = new RecoveryAppServer();
    const blocked = persistedLeaf({
      status: "blocked",
      summary: "permission required",
      confidence: 0,
      threadId: "leaf-thread",
      turnId: "leaf-turn",
      error: "grant repository access",
      failureKind: "permission",
    });
    const input = snapshot(task(), [leafRef({ attempt: 1 })]);
    input.result.status = "waiting_input";
    input.result.needsAction = "grant repository access";
    input.result.leaves = [blocked];
    input.waitingInputCheckpoint = {
      kind: "leaves",
      planId: "plan-1",
      leaves: [
        {
          taskId: "leaf-a",
          threadId: "leaf-thread",
          previousTurnId: "leaf-turn",
          attempt: 1,
          needsAction: "grant repository access",
        },
      ],
      updatedAt: "2026-08-28T00:00:02.000Z",
    };
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("running");
    expect(recovered.continuation).toMatchObject({
      initialLeaves: [{ taskId: "leaf-a", status: "blocked" }],
      waitingInput: { kind: "leaves", leaves: [{ taskId: "leaf-a", attempt: 1 }] },
    });
  });

  it("returns an integration continuation only when every persisted leaf identity matches", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [completedTurn({}, "integrator-turn")]);
    const leaf = persistedLeaf();
    const input = snapshot(task(), [
      leafRef(),
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.status = "waiting_input";
    input.result.needsAction = "provide the missing source";
    input.result.leaves = [leaf];
    input.waitingInputCheckpoint = {
      kind: "integration",
      planId: "plan-1",
      turn: {
        threadId: "integrator-thread",
        previousTurnId: "integrator-turn",
        cwd: "/workspace",
        needsAction: "provide the missing source",
        capabilities: [],
        updatedAt: "2026-08-28T00:00:03.000Z",
      },
      leafIdentities: [
        {
          taskId: leaf.taskId,
          threadId: leaf.threadId,
          turnId: leaf.turnId,
          completedAt: leaf.completedAt,
        },
      ],
    };
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("running");
    expect(recovered.continuation).toMatchObject({
      initialLeaves: [{ taskId: "leaf-a", status: "completed" }],
      waitingInput: {
        kind: "integration",
        turn: { threadId: "integrator-thread", previousTurnId: "integrator-turn" },
      },
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("preserves a persisted validated leaf instead of rebuilding it from model output", async () => {
    const server = new RecoveryAppServer();
    const validatedTask = task({
      validation: [{ command: "npm test" }],
    });
    const input = snapshot(validatedTask, [leafRef()]);
    input.result.leaves = [
      {
        taskId: "leaf-a",
        status: "completed",
        summary: "persisted validated result",
        confidence: 0.95,
        findings: [],
        changedFiles: [],
        validation: [{ command: "npm test", status: "passed", summary: "ok" }],
        citations: [],
        artifacts: [],
        messages: [],
        threadId: "leaf-thread",
        turnId: "leaf-turn",
        usage: [],
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:00:01.000Z",
      },
    ];
    const readCompletedLeaf = vi.fn();
    const recovery = new AppServerRecoveryAdapter({
      appServer: server,
      cwd: "/workspace",
      leafExecutor: { readCompletedLeaf },
    });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "running",
      finalResponse: null,
      leaves: [{ summary: "persisted validated result" }],
    });
    expect(recovered.continuation).toMatchObject({
      workspaceWritersMayHaveRun: false,
      initialLeaves: [{ taskId: "leaf-a", summary: "persisted validated result" }],
    });
    expect(readCompletedLeaf).not.toHaveBeenCalled();
  });

  it("refuses continuation when persisted leaves are absent from the active plan", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [completedTurn(leafOutput())]);
    const input = snapshot(task(), [leafRef()]);
    input.result.leaves = [
      {
        taskId: "removed-leaf",
        status: "completed",
        summary: "stale result",
        confidence: 0.9,
        findings: [],
        changedFiles: [],
        validation: [],
        citations: [],
        artifacts: [],
        messages: [],
        threadId: "removed-thread",
        turnId: "removed-turn",
        usage: [],
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:00:01.000Z",
      },
    ];
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.error).toContain("absent from the active execution plan");
    expect(recovered.continuation).toBeUndefined();
  });

  it("does not treat model-reported validation as recovery evidence", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [
      completedTurn({
        ...leafOutput(),
        validation: [{ command: "npm test", status: "passed", summary: "model says ok" }],
      }),
    ]);
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: snapshot(task({ validation: [{ command: "npm test" }] }), [leafRef()]),
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.error).toContain(
      "deterministic leaf validation result was not persisted",
    );
    expect(recovered.result.leaves).toEqual([
      expect.objectContaining({ taskId: "leaf-a", status: "indeterminate" }),
    ]);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("recovers only the latest logical leaf attempt", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("old-thread", [
      {
        id: "old-turn",
        status: "failed",
        items: [],
        error: { message: "superseded attempt failed" },
      },
    ]);
    server.turns.set("new-thread", [completedTurn(leafOutput(), "new-turn")]);
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: snapshot(task(), [
        leafRef({
          attempt: 1,
          threadId: "old-thread",
          turnId: "old-turn",
          updatedAt: "2026-08-28T00:00:01.000Z",
        }),
        leafRef({
          attempt: 2,
          threadId: "new-thread",
          turnId: "new-turn",
          updatedAt: "2026-08-28T00:00:02.000Z",
        }),
      ]),
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "running",
      finalResponse: null,
      leaves: [
        {
          taskId: "leaf-a",
          status: "completed",
          threadId: "new-thread",
          turnId: "new-turn",
        },
      ],
    });
    expect(recovered.continuation).toMatchObject({
      workspaceWritersMayHaveRun: false,
      initialLeaves: [
        {
          taskId: "leaf-a",
          status: "completed",
          threadId: "new-thread",
          turnId: "new-turn",
        },
      ],
    });
  });

  it("does not skip a risk-triggered final review after recovered integration validation fails", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [completedTurn(leafOutput())]);
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "unreviewed integration",
          validation: [
            {
              command: "npm test",
              status: "failed",
              summary: "tests failed",
            },
          ],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    const input = snapshot(task(), [
      leafRef(),
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "workspaceWrite",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "riskTriggered";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.finalResponse).toBeNull();
    expect(recovered.result.error).toContain("before the run produced a final response");
  });

  it("continues only the missing final review from a durable integration checkpoint", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [completedTurn({}, "integrator-turn")]);
    const leaf = persistedLeaf();
    const input = snapshot(task(), [
      leafRef(),
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    input.result.leaves = [leaf];
    input.integrationCheckpoint = {
      planId: "plan-1",
      leafIdentities: [
        {
          taskId: leaf.taskId,
          threadId: leaf.threadId,
          turnId: leaf.turnId,
          completedAt: leaf.completedAt,
        },
      ],
      response: "Terra integrated response",
      validation: [],
      integratorThreadId: "integrator-thread",
      launchSkewMs: 12,
      peakConcurrency: 1,
      replanCount: 0,
      updatedAt: "2026-08-28T00:00:03.000Z",
    };
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "running",
      finalResponse: null,
      leaves: [{ taskId: "leaf-a", status: "completed" }],
    });
    expect(recovered.continuation).toMatchObject({
      workspaceWritersMayHaveRun: false,
      initialLeaves: [{ taskId: "leaf-a", status: "completed" }],
      finalReview: {
        integratedResponse: "Terra integrated response",
        integrationValidation: [],
        integratorThreadId: "integrator-thread",
        launchSkewMs: 12,
        peakConcurrency: 1,
        replanCount: 0,
      },
    });
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("does not recover an integration outcome when validator evidence was not persisted", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [completedTurn(leafOutput())]);
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "apparently validated integration",
          validation: [{ command: "npm test", status: "passed", summary: "model says ok" }],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    const input = snapshot(task(), [
      leafRef(),
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "workspaceWrite",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.validation = [{ command: "npm test" }];
    input.result.plan!.integration.finalReview = "riskTriggered";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.finalResponse).toBeNull();
    expect(recovered.result.error).toContain(
      "deterministic integration validation result was not persisted",
    );
    expect(server.turnStarts).toHaveLength(0);
  });

  it("does not recover unresolved Terra plan issues as a completed result", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "integration with an unresolved conflict",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [
            {
              type: "result_conflict",
              taskIds: ["leaf-a"],
              summary: "two implementations disagree on the interface",
              requiresPlanPatch: true,
            },
          ],
        },
        "integrator-turn",
      ),
    ]);
    const input = snapshot(task(), [
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.error).toContain("unresolved plan issues");
    expect(recovered.result.finalResponse).toBeNull();
  });

  it.each([
    {
      status: "failed" as const,
      needsAction: null,
      error: "integration failed",
    },
    {
      status: "waiting_input" as const,
      needsAction: "provide the missing source",
      error: "external input required",
    },
  ])("preserves a recovered $status integrator without forcing final review", async (outcome) => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          ...outcome,
          response: null,
          validation: [],
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    const input = snapshot(task(), [
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: outcome.status,
      finalResponse: null,
      error: outcome.error,
    });
    if (outcome.status === "waiting_input") {
      expect(recovered.result.needsAction).toBe(outcome.needsAction);
    }
  });

  it("returns the latest recovered Terra response when Sol approved it", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("old-integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "stale Terra response",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "old-integrator-turn",
      ),
    ]);
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "latest Terra response",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    server.turns.set("planner-thread", [
      completedTurn({ approved: true, issues: [], replacementResponse: null }, "review-turn"),
    ]);
    const input = snapshot(task(), [
      {
        role: "integrator",
        threadId: "old-integrator-thread",
        turnId: "old-integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
      {
        role: "finalReview",
        threadId: "planner-thread",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:03.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "completed",
      finalResponse: "latest Terra response",
    });
    expect(recovered.result).not.toHaveProperty("error");
  });

  it("returns Sol's replacement response when final review rejects Terra", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "incorrect Terra response",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    server.turns.set("planner-thread", [
      completedTurn(
        {
          approved: false,
          issues: ["the conclusion is incorrect"],
          replacementResponse: "corrected Sol response",
        },
        "review-turn",
      ),
    ]);
    const input = snapshot(task(), [
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
      {
        role: "finalReview",
        threadId: "planner-thread",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:03.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "completed",
      finalResponse: "corrected Sol response",
    });
    expect(recovered.result).not.toHaveProperty("error");
  });

  it("fails with Sol's issues when rejected final review has no replacement", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "rejected Terra response",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    server.turns.set("planner-thread", [
      completedTurn(
        {
          approved: false,
          issues: ["missing required evidence", "unsupported conclusion"],
          replacementResponse: null,
        },
        "review-turn",
      ),
    ]);
    const input = snapshot(task(), [
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
      {
        role: "finalReview",
        threadId: "planner-thread",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:03.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "failed",
      finalResponse: null,
      error:
        "Sol final review rejected the result: missing required evidence; unsupported conclusion",
    });
  });

  it("is indeterminate when Sol approved but no Terra response can be recovered", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("planner-thread", [
      completedTurn({ approved: true, issues: [], replacementResponse: null }, "review-turn"),
    ]);
    const input = snapshot(task(), [
      {
        role: "finalReview",
        threadId: "planner-thread",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:03.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "indeterminate",
      finalResponse: null,
      error: expect.stringContaining("no recoverable Terra response"),
    });
  });

  it("marks a running workspace writer indeterminate and never waits for it", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [{ id: "leaf-turn", status: "inProgress" }]);
    const writer = task({ access: "workspaceWrite", ownedPaths: ["src/leaf.ts"] });
    const awaitRunningTurn = vi.fn(async () => undefined);
    const recovery = new AppServerRecoveryAdapter({
      appServer: server,
      cwd: "/workspace",
      awaitRunningTurn,
      now: () => new Date("2026-08-28T00:01:00.000Z"),
    });

    const recovered = await recovery.reattach({
      snapshot: snapshot(writer, [leafRef({ access: "workspaceWrite", state: "running" })]),
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "indeterminate",
      finalResponse: null,
      leaves: [
        {
          status: "indeterminate",
          failureKind: "unknown",
          threadId: "leaf-thread",
          turnId: "leaf-turn",
        },
      ],
    });
    expect(recovered.result.error).toContain("workspace changes may have occurred");
    expect(awaitRunningTurn).not.toHaveBeenCalled();
    expect(server.turnStarts).toHaveLength(0);
  });

  it("reports a running read-only turn safely when no await capability is configured", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [{ id: "leaf-turn", status: "inProgress" }]);
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: snapshot(task(), [leafRef({ state: "running" })]),
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.error).toContain("transport cannot await it");
    expect(server.turnStarts).toHaveLength(0);
  });

  it("reattaches a running read-only turn when an await capability is provided", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("leaf-thread", [{ id: "leaf-turn", status: "inProgress" }]);
    const awaitRunningTurn = vi.fn(async () => {
      server.turns.set("leaf-thread", [completedTurn(leafOutput())]);
    });
    const recovery = new AppServerRecoveryAdapter({
      appServer: server,
      cwd: "/workspace",
      awaitRunningTurn,
    });

    const recovered = await recovery.reattach({
      snapshot: snapshot(task(), [leafRef({ state: "running" })]),
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({ status: "running", finalResponse: null });
    expect(recovered.continuation).toMatchObject({
      workspaceWritersMayHaveRun: false,
      initialLeaves: [{ taskId: "leaf-a", status: "completed" }],
    });
    expect(awaitRunningTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "leaf-thread", turnId: "leaf-turn" }),
    );
    expect(server.turnStarts).toHaveLength(0);
  });

  it("recovers a terminal direct outcome and reattaches its thread id", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("direct-thread", [
      completedTurn(
        {
          status: "completed",
          response: "direct answer",
          validation: [],
          needsAction: null,
          error: null,
        },
        "direct-turn",
      ),
    ]);
    const directSnapshot = snapshot();
    directSnapshot.result.plan = null;
    directSnapshot.plannerThreadId = null;
    directSnapshot.remoteTurns = [
      {
        role: "direct",
        threadId: "direct-thread",
        turnId: "direct-turn",
        access: "workspaceWrite",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
    ];
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: directSnapshot,
      signal: new AbortController().signal,
    });

    expect(recovered.result).toMatchObject({
      status: "completed",
      finalResponse: "direct answer",
    });
    expect(recovered.continuation).toBeUndefined();
    expect(recovered.integratorThreadId).toBe("direct-thread");
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("does not report recovered final review success before writer patches are marked applied", async () => {
    const server = new RecoveryAppServer();
    server.turns.set("integrator-thread", [
      completedTurn(
        {
          status: "completed",
          response: "review approved before the crash",
          validation: [],
          needsAction: null,
          error: null,
          planIssues: [],
        },
        "integrator-turn",
      ),
    ]);
    server.turns.set("planner-thread", [
      completedTurn({ approved: true, issues: [], replacementResponse: null }, "review-turn"),
    ]);
    const writer = task({ access: "workspaceWrite", ownedPaths: ["src/leaf.ts"] });
    const input = snapshot(writer, [
      {
        role: "integrator",
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
      {
        role: "finalReview",
        threadId: "planner-thread",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:00:02.000Z",
      },
    ]);
    input.request.integrate = true;
    input.result.plan!.integration.finalReview = "always";
    input.workspaceCommitState = "pending";
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const recovered = await recovery.reattach({
      snapshot: input,
      signal: new AbortController().signal,
    });

    expect(recovered.result.status).toBe("indeterminate");
    expect(recovered.result.finalResponse).toBeNull();
    expect(recovered.result.error).toContain("not durably marked as applied");
    expect(recovered.continuation).toBeUndefined();
    expect(server.threadStarts).toHaveLength(0);
    expect(server.turnStarts).toHaveLength(0);
  });

  it("interrupts every known nonterminal turn once and reports missing confirmation", async () => {
    const server = new RecoveryAppServer();
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });
    const turns = [
      leafRef({ state: "running" }),
      leafRef({ state: "running", updatedAt: "2026-08-28T00:00:02.000Z" }),
      {
        role: "integrator" as const,
        threadId: "integrator-thread",
        turnId: "integrator-turn",
        access: "workspaceWrite" as const,
        state: "thread_started" as const,
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
      {
        role: "planner" as const,
        threadId: "planner-thread",
        turnId: "planner-turn",
        access: "readOnly" as const,
        state: "terminal" as const,
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
    ];

    const cancellation = await recovery.cancel({ snapshot: snapshot(task(), turns) });

    expect(server.interrupts).toHaveLength(2);
    expect(server.interrupts).toEqual(
      expect.arrayContaining([
        { threadId: "leaf-thread", turnId: "leaf-turn" },
        { threadId: "integrator-thread", turnId: "integrator-turn" },
      ]),
    );
    expect(server.turnStarts).toHaveLength(0);
    expect(cancellation.allTerminal).toBe(false);
    expect(cancellation.remoteTurns).toHaveLength(2);
    expect(cancellation.remoteTurns.every((turn) => turn.state !== "terminal")).toBe(true);
    expect(cancellation.reasons).toHaveLength(2);
  });

  it("waits until an interrupted writer is observed terminal", async () => {
    const server = new RecoveryAppServer();
    const writer = task({ access: "workspaceWrite" });
    const ref = leafRef({ access: "workspaceWrite", state: "running" });
    server.turns.set(ref.threadId, [
      { id: ref.turnId, status: "inProgress", items: [], error: null },
    ]);
    const awaitRunningTurn = vi.fn(async ({ threadId, turnId }) => {
      server.turns.set(threadId, [{ id: turnId, status: "interrupted", items: [], error: null }]);
    });
    const recovery = new AppServerRecoveryAdapter({
      appServer: server,
      cwd: "/workspace",
      awaitRunningTurn,
    });

    const cancellation = await recovery.cancel({ snapshot: snapshot(writer, [ref]) });

    expect(server.interrupts).toEqual([{ threadId: ref.threadId, turnId: ref.turnId }]);
    expect(awaitRunningTurn).toHaveBeenCalledOnce();
    expect(cancellation).toMatchObject({ allTerminal: true, reasons: [] });
    expect(cancellation.remoteTurns).toEqual([
      expect.objectContaining({ threadId: ref.threadId, turnId: ref.turnId, state: "terminal" }),
    ]);
  });

  it("accepts a terminal race when interrupt reports that the turn already ended", async () => {
    const server = new RecoveryAppServer();
    const ref = leafRef({ state: "running" });
    server.turns.set(ref.threadId, [{ id: ref.turnId, status: "inProgress" }]);
    vi.spyOn(server, "turnInterrupt").mockImplementationOnce(async () => {
      server.turns.set(ref.threadId, [{ id: ref.turnId, status: "completed" }]);
      throw new Error("turn already completed");
    });
    const recovery = new AppServerRecoveryAdapter({ appServer: server, cwd: "/workspace" });

    const cancellation = await recovery.cancel({ snapshot: snapshot(task(), [ref]) });

    expect(cancellation).toMatchObject({ allTerminal: true, reasons: [] });
    expect(cancellation.remoteTurns).toEqual([
      expect.objectContaining({ threadId: ref.threadId, turnId: ref.turnId, state: "terminal" }),
    ]);
  });
});
