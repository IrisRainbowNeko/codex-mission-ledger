import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionLimits,
  ExecutionPlan,
  LeafResult,
  LeafTask,
  PlanPatch,
} from "../src/core/contracts.js";
import {
  DeterministicScheduler,
  computeWaves,
  type LeafExecutor,
  type ReplanHandler,
} from "../src/core/scheduler.js";

const limits: ExecutionLimits = {
  maxConcurrent: 2,
  maxLeaves: 8,
  maxWaves: 3,
  maxSolLeaves: 1,
  maxReplans: 1,
};

function task(id: string, dependsOn: string[] = [], critical = false): LeafTask {
  return {
    id,
    objective: id,
    domain: "coding",
    tier: critical ? "terra" : "luna",
    effort: critical ? "medium" : "low",
    access: "readOnly",
    ownedPaths: [],
    dependsOn,
    capabilities: [],
    validation: [],
    communicationWith: [],
    expectedSeconds: 600,
    difficulty: 0.2,
    ambiguity: 0.1,
    confidence: 0.9,
    critical,
  };
}

function plan(tasks: LeafTask[]): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan",
    objective: "test",
    domain: "coding",
    assumptions: [],
    tasks,
    integration: {
      objective: "integrate",
      requiredOutputs: ["result"],
      validation: [],
      finalReview: "riskTriggered",
    },
    risk: "medium",
  };
}

function completed(taskId: string, confidence = 0.9): LeafResult {
  const now = new Date().toISOString();
  return {
    taskId,
    status: "completed",
    summary: taskId,
    confidence,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: `thread-${taskId}`,
    turnId: `turn-${taskId}`,
    usage: [],
    startedAt: now,
    completedAt: now,
  };
}

function completedWithCost(taskId: string, cost: number): LeafResult {
  return {
    ...completed(taskId),
    usage: [
      {
        model: "test-model",
        tier: "other",
        effort: null,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCostUsd: cost,
      },
    ],
  };
}

const noReplan: ReplanHandler = {
  replan: async () => null,
  answer: async () => "answer",
};

describe("DeterministicScheduler", () => {
  it("passes caller permissions to every scheduled leaf", async () => {
    const runLeaf = vi.fn(async ({ task: item }: Parameters<LeafExecutor["runLeaf"]>[0]) =>
      completed(item.id),
    );
    await new DeterministicScheduler({ runLeaf }, noReplan).execute(
      "permission-run",
      plan([task("a"), task("b")]),
      limits,
      undefined,
      undefined,
      undefined,
      undefined,
      "fullAccess",
      "approveForMe",
    );

    expect(runLeaf).toHaveBeenCalledTimes(2);
    for (const [input] of runLeaf.mock.calls) {
      expect(input.hostAccess).toBe("fullAccess");
      expect(input.hostApproval).toBe("approveForMe");
    }
  });

  it("runs independent leaves concurrently before dependent work", async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item }) => {
        order.push(`start:${item.id}`);
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        order.push(`end:${item.id}`);
        return completed(item.id);
      },
    };
    const scheduler = new DeterministicScheduler(executor, noReplan);
    const result = await scheduler.execute(
      "run",
      plan([task("a"), task("b"), task("c", ["a", "b"])]),
      limits,
    );

    expect(peak).toBe(2);
    expect(result.peakConcurrency).toBe(2);
    expect(order.indexOf("start:c")).toBeGreaterThan(order.indexOf("end:b"));
    expect(result.leaves.map((item) => item.taskId)).toEqual(["a", "b", "c"]);
    expect(computeWaves(result.plan.tasks)).toBe(2);
  });

  it("seeds completed leaves without rerunning them and retains their usage", async () => {
    const seeded = {
      ...completedWithCost("a", 0.1),
      validation: [{ command: "npm test -- a", status: "passed" as const, summary: "ok" }],
    };
    const dependencies: LeafResult[][] = [];
    const runLeaf = vi.fn(
      async ({ task: item, dependencies: inputs }: Parameters<LeafExecutor["runLeaf"]>[0]) => {
        dependencies.push(inputs);
        return completedWithCost(item.id, 0.2);
      },
    );
    const scheduler = new DeterministicScheduler({ runLeaf }, noReplan);

    const result = await scheduler.execute(
      "resumed-run",
      plan([task("a"), task("b", ["a"])]),
      limits,
      undefined,
      undefined,
      undefined,
      { initialResults: [seeded] },
    );

    expect(runLeaf).toHaveBeenCalledOnce();
    expect(runLeaf.mock.calls[0]?.[0].task.id).toBe("b");
    expect(dependencies).toEqual([[expect.objectContaining({ taskId: "a" })]]);
    expect(result.leaves).toEqual([
      expect.objectContaining({ taskId: "a", validation: seeded.validation }),
      expect.objectContaining({ taskId: "b", status: "completed" }),
    ]);
    expect(result.usage.map((item) => item.estimatedCostUsd)).toEqual([0.1, 0.2]);
  });

  it("continues only permission-blocked leaves and then releases their dependents", async () => {
    const blocked = {
      ...completedWithCost("a", 0.1),
      status: "blocked" as const,
      summary: "permission required",
      confidence: 0,
      error: "grant repository access",
      failureKind: "permission" as const,
      threadId: "thread-a",
      turnId: "turn-a-waiting",
    };
    const sibling = completed("b");
    const runLeaf = vi.fn(
      async ({ task: item, continuation }: Parameters<LeafExecutor["runLeaf"]>[0]) => {
        if (item.id === "a") {
          expect(continuation).toEqual({
            threadId: "thread-a",
            previousTurnId: "turn-a-waiting",
            userInput: "access granted",
          });
          return completedWithCost("a", 0.2);
        }
        expect(item.id).toBe("c");
        expect(continuation).toBeUndefined();
        return completed(item.id);
      },
    );
    const scheduler = new DeterministicScheduler({ runLeaf }, noReplan);

    const result = await scheduler.execute(
      "waiting-leaf-run",
      plan([task("a"), task("b"), task("c", ["a"])]),
      limits,
      undefined,
      undefined,
      undefined,
      {
        initialResults: [blocked, sibling],
        waitingLeaves: [
          {
            taskId: "a",
            threadId: "thread-a",
            previousTurnId: "turn-a-waiting",
            attempt: 1,
            needsAction: "grant repository access",
          },
        ],
        userInput: "access granted",
      },
    );

    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(runLeaf.mock.calls.map(([input]) => input.task.id)).toEqual(["a", "c"]);
    expect(result.leaves).toEqual([
      expect.objectContaining({ taskId: "a", status: "completed" }),
      expect.objectContaining({ taskId: "b", status: "completed" }),
      expect.objectContaining({ taskId: "c", status: "completed" }),
    ]);
    expect(result.leaves[0]?.usage.map((item) => item.estimatedCostUsd)).toEqual([0.1, 0.2]);
  });

  it("fills a freed slot with newly-ready dependent work while a sibling is still running", async () => {
    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const childDependencies: string[][] = [];
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item, dependencies }) => {
        order.push(`start:${item.id}`);
        if (item.id === "slow") {
          await slowGate;
        }
        if (item.id === "child") {
          childDependencies.push(dependencies.map((dependency) => dependency.taskId));
        }
        order.push(`end:${item.id}`);
        return completed(item.id);
      },
    };
    const running = new DeterministicScheduler(executor, noReplan).execute(
      "run",
      plan([task("slow"), task("fast"), task("child", ["fast"])]),
      limits,
    );

    await vi.waitFor(() => expect(order).toContain("start:child"));
    expect(order).not.toContain("end:slow");
    expect(childDependencies).toEqual([["fast"]]);

    releaseSlow();
    const result = await running;
    expect(result.peakConcurrency).toBe(2);
    expect(order.indexOf("start:child")).toBeLessThan(order.indexOf("end:slow"));
    expect(result.leaves.map((item) => item.taskId)).toEqual(["slow", "fast", "child"]);
  });

  it("upgrades only a reasoning failure and only once", async () => {
    const tiers: string[] = [];
    const retries: Array<Parameters<LeafExecutor["runLeaf"]>[0]["retry"]> = [];
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item, attempt, retry }) => {
        tiers.push(item.tier);
        retries.push(retry);
        return attempt === 1
          ? {
              ...completedWithCost(item.id, 0.1),
              status: "failed",
              summary: "algorithm chose the wrong branch",
              error: "counterexample n=0",
              failureKind: "reasoning",
              startedAt: "2026-08-28T00:00:00.000Z",
              completedAt: "2026-08-28T00:00:30.000Z",
            }
          : {
              ...completedWithCost(item.id, 0.2),
              startedAt: "2026-08-28T00:00:31.000Z",
              completedAt: "2026-08-28T00:01:00.000Z",
            };
      },
    };
    const result = await new DeterministicScheduler(executor, noReplan).execute(
      "run",
      plan([task("a")]),
      limits,
    );
    expect(tiers).toEqual(["luna", "terra"]);
    expect(retries).toEqual([
      undefined,
      {
        kind: "reasoning",
        previousResult: expect.objectContaining({
          summary: "algorithm chose the wrong branch",
          error: "counterexample n=0",
          failureKind: "reasoning",
        }),
      },
    ]);
    expect(result.leaves[0]?.status).toBe("completed");
    expect(result.leaves[0]?.startedAt).toBe("2026-08-28T00:00:00.000Z");
    expect(result.leaves[0]?.usage.map((item) => item.estimatedCostUsd)).toEqual([0.1, 0.2]);
    expect(result.usage.map((item) => item.estimatedCostUsd)).toEqual([0.1, 0.2]);
  });

  it("upgrades a self-reported local validation failure without declared validators", async () => {
    const calls: Array<{
      tier: LeafTask["tier"];
      retry: Parameters<LeafExecutor["runLeaf"]>[0]["retry"];
    }> = [];
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item, attempt, retry }) => {
        calls.push({ tier: item.tier, retry });
        return attempt === 1
          ? {
              ...completed(item.id),
              status: "failed",
              summary: "focused test still fails",
              error: "expected c,a; received b,c",
              failureKind: "validation",
            }
          : completed(item.id);
      },
    };

    const result = await new DeterministicScheduler(executor, noReplan).execute(
      "run",
      plan([task("a")]),
      limits,
    );

    expect(calls).toEqual([
      { tier: "luna", retry: undefined },
      {
        tier: "terra",
        retry: {
          kind: "validation",
          previousResult: expect.objectContaining({
            status: "failed",
            failureKind: "validation",
            error: "expected c,a; received b,c",
          }),
        },
      },
    ]);
    expect(result.leaves[0]).toMatchObject({ status: "completed" });
  });

  it("retries a pure declared validator failure once without rerunning successful siblings", async () => {
    const validator = { ...task("a"), validation: [{ command: "npm test -- a" }] };
    const calls: Array<{
      id: string;
      attempt: number;
      tier: LeafTask["tier"];
      effort: LeafTask["effort"];
      retry: Parameters<LeafExecutor["runLeaf"]>[0]["retry"];
    }> = [];
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => null),
      answer: async () => "answer",
    };
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item, attempt, retry }) => {
        calls.push({ id: item.id, attempt, tier: item.tier, effort: item.effort, retry });
        return item.id === "a" && attempt === 1
          ? {
              ...completed(item.id),
              validation: [
                { command: "npm test -- a", status: "failed" as const, summary: "exit 1" },
              ],
            }
          : completed(item.id);
      },
    };

    const result = await new DeterministicScheduler(executor, replanner).execute(
      "run",
      plan([validator, task("sibling")]),
      limits,
    );

    expect(calls.filter((call) => call.id === "a")).toEqual([
      { id: "a", attempt: 1, tier: "luna", effort: "low", retry: undefined },
      {
        id: "a",
        attempt: 2,
        tier: "terra",
        effort: "medium",
        retry: {
          kind: "validation",
          previousResult: expect.objectContaining({
            validation: [{ command: "npm test -- a", status: "failed", summary: "exit 1" }],
          }),
        },
      },
    ]);
    expect(calls.filter((call) => call.id === "sibling")).toEqual([
      {
        id: "sibling",
        attempt: 1,
        tier: "luna",
        effort: "low",
        retry: undefined,
      },
    ]);
    expect(replanner.replan).not.toHaveBeenCalled();
    expect(result.leaves.map((item) => item.status)).toEqual(["completed", "completed"]);
  });

  it("escalates a declared validator failure only after its one mechanical repair is exhausted", async () => {
    const validator = { ...task("a"), validation: [{ command: "npm test -- a" }] };
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => null),
      answer: async () => "answer",
    };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) => ({
      ...completed(item.id),
      validation: [{ command: "npm test -- a", status: "failed" as const, summary: "exit 1" }],
    }));

    const result = await new DeterministicScheduler({ runLeaf }, replanner).execute(
      "run",
      plan([validator]),
      limits,
    );

    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(replanner.replan).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ type: "validator_failure", taskIds: ["a"] })],
      expect.anything(),
    );
    expect(result).toMatchObject({ patch: null, replanCount: 1 });
  });

  it("does not retry or replan a validator infrastructure failure", async () => {
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => null),
      answer: async () => "answer",
    };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) => ({
      ...completed(item.id),
      status: "failed" as const,
      summary: "deterministic leaf validator could not run",
      failureKind: "transient" as const,
      validation: [
        {
          command: "npm test",
          status: "failed" as const,
          summary: "exit code 1\nstderr:\nbwrap: startup failed",
        },
      ],
    }));

    const result = await new DeterministicScheduler({ runLeaf }, replanner).execute(
      "run",
      plan([{ ...task("a"), validation: [{ command: "npm test" }] }]),
      limits,
    );

    expect(runLeaf).toHaveBeenCalledOnce();
    expect(replanner.replan).not.toHaveBeenCalled();
    expect(result.leaves[0]).toMatchObject({ status: "failed", failureKind: "transient" });
  });

  it("applies one Sol plan patch after a critical low-confidence result", async () => {
    const patch: PlanPatch = {
      protocolVersion: 1,
      planId: "plan",
      reason: "add targeted follow-up",
      operations: [{ op: "add", task: task("follow", ["a"]) }],
    };
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => patch),
      answer: async () => "answer",
    };
    const updatePlan = vi.fn(async () => undefined);
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item }) => completed(item.id, item.id === "a" ? 0.5 : 0.9),
      updatePlan,
    };
    const result = await new DeterministicScheduler(executor, replanner).execute(
      "run",
      plan([task("a", [], true)]),
      limits,
    );
    expect(replanner.replan).toHaveBeenCalledTimes(1);
    expect(updatePlan).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        tasks: expect.arrayContaining([expect.objectContaining({ id: "follow" })]),
      }),
    );
    expect(result.replanCount).toBe(1);
    expect(result.leaves.map((item) => item.taskId)).toEqual(["a", "follow"]);
  });

  it("retains leaf evidence when a PlanPatch exceeds the remaining leaf capacity", async () => {
    const roots = [task("a", [], true), task("b", [], true), task("c", [], true)];
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => ({
        protocolVersion: 1 as const,
        planId: "plan",
        reason: "add one replacement beside every failed task",
        operations: roots.map((item, index) => ({
          op: "add" as const,
          task: task(`replacement-${String(index + 1)}`, [item.id]),
        })),
      })),
      answer: async () => "answer",
    };
    const updatePlan = vi.fn(async () => undefined);
    const result = await new DeterministicScheduler(
      {
        runLeaf: async ({ task: item }) => completed(item.id, 0.5),
        updatePlan,
      },
      replanner,
    ).execute("run", plan(roots), { ...limits, maxConcurrent: 3, maxLeaves: 5 });

    expect(result).toMatchObject({ patch: null, replanCount: 1 });
    expect(result.leaves.map((item) => [item.taskId, item.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "completed"],
    ]);
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it("feeds terminal Terra integration issues back into the same replan loop", async () => {
    const patch: PlanPatch = {
      protocolVersion: 1,
      planId: "plan",
      reason: "repair missing integration output",
      operations: [{ op: "add", task: task("follow", ["a"]) }],
    };
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => patch),
      answer: async () => "answer",
    };
    const inspect = vi
      .fn()
      .mockResolvedValueOnce([
        {
          type: "contract_incomplete",
          taskIds: ["a"],
          summary: "required integration output is missing",
          observedAt: "2026-08-29T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) => completed(item.id));

    const result = await new DeterministicScheduler({ runLeaf }, replanner).execute(
      "run",
      plan([task("a")]),
      limits,
      undefined,
      replanner,
      { inspect },
    );

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(replanner.replan).toHaveBeenCalledTimes(1);
    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(result.leaves.map((item) => item.taskId)).toEqual(["a", "follow"]);
  });

  it("preserves integrator-bound broker messages in completion and final results", async () => {
    const inspect = vi.fn(async (_plan: ExecutionPlan, leaves: readonly LeafResult[]) => {
      expect(leaves[0]?.messages).toEqual([
        expect.objectContaining({
          type: "result",
          fromTaskId: "a",
          toTaskId: "integrator",
          body: "include this detail",
        }),
      ]);
      return [];
    });
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item }, postMessage) => {
        await postMessage({
          type: "result",
          fromTaskId: item.id,
          toTaskId: "integrator",
          body: "include this detail",
        });
        return completed(item.id);
      },
    };

    const result = await new DeterministicScheduler(executor, noReplan).execute(
      "run",
      plan([task("a")]),
      limits,
      undefined,
      noReplan,
      { inspect },
    );

    expect(inspect).toHaveBeenCalledOnce();
    expect(result.leaves[0]?.messages).toEqual([
      expect.objectContaining({ body: "include this detail", toTaskId: "integrator" }),
    ]);
  });

  it("rejects a patch that replaces a completed task", async () => {
    const original = task("a", [], true);
    const replanner: ReplanHandler = {
      replan: async () => ({
        protocolVersion: 1,
        planId: "plan",
        reason: "Rewrite completed work",
        operations: [
          {
            op: "replace",
            taskId: "a",
            task: { ...original, objective: "replacement" },
          },
        ],
      }),
      answer: async () => "answer",
    };
    const scheduler = new DeterministicScheduler(
      { runLeaf: async () => completed("a", 0.5) },
      replanner,
    );

    await expect(scheduler.execute("run", plan([original]), limits)).rejects.toThrow(
      "completed task 'a' cannot be replaced or cancelled",
    );
  });

  it("does not replan a successful terminal batch solely for an estimate overrun", async () => {
    const replanner: ReplanHandler = {
      replan: vi.fn(async () => null),
      answer: async () => "answer",
    };
    const scheduler = new DeterministicScheduler(
      {
        runLeaf: async ({ task: item }) => ({
          ...completed(item.id),
          startedAt: "2026-08-28T00:00:00.000Z",
          completedAt: "2026-08-28T00:00:40.000Z",
        }),
      },
      replanner,
    );

    await expect(
      scheduler.execute("run", plan([{ ...task("a"), expectedSeconds: 30 }]), limits),
    ).resolves.toMatchObject({
      replanCount: 0,
      leaves: [expect.objectContaining({ status: "completed" })],
    });
    expect(replanner.replan).not.toHaveBeenCalled();
  });

  it("stops before launching work that would exceed the remaining cost budget", async () => {
    const first = { ...task("a"), expectedCostUsd: 0.2 };
    const second = { ...task("b"), expectedCostUsd: 0.2 };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) =>
      completedWithCost(item.id, 0.35),
    );
    const result = await new DeterministicScheduler({ runLeaf }, noReplan).execute(
      "run",
      plan([first, second]),
      { ...limits, maxConcurrent: 1, maxCostUsd: 0.5, maxReplans: 0 },
    );

    expect(runLeaf).toHaveBeenCalledTimes(1);
    expect(result.leaves.find((item) => item.taskId === "b")?.status).toBe("cancelled");
    expect(result.usage).toHaveLength(1);
  });

  it("requires cost estimates when a hard cost budget is configured", async () => {
    const scheduler = new DeterministicScheduler(
      { runLeaf: async ({ task: item }) => completed(item.id) },
      noReplan,
    );
    await expect(
      scheduler.execute("run", plan([task("a")]), { ...limits, maxCostUsd: 1 }),
    ).rejects.toThrow("must declare expectedCostUsd");
  });

  it("stops pending work when the relative execution deadline expires", async () => {
    let nowMs = 0;
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) => {
      nowMs = 100;
      return {
        ...completed(item.id),
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(nowMs).toISOString(),
      };
    });
    const scheduler = new DeterministicScheduler({ runLeaf }, noReplan, {
      now: () => new Date(nowMs),
    });
    const result = await scheduler.execute("run", plan([task("a"), task("b")]), {
      ...limits,
      maxConcurrent: 1,
      deadlineMs: 50,
      maxReplans: 0,
    });

    expect(runLeaf).toHaveBeenCalledTimes(1);
    expect(result.leaves.find((item) => item.taskId === "b")?.status).toBe("cancelled");
  });

  it("uses launch-request timestamps when leaves omit startedAt", async () => {
    let call = 0;
    const scheduler = new DeterministicScheduler(
      {
        runLeaf: async ({ task: item }) => ({ ...completed(item.id), startedAt: null }),
      },
      noReplan,
      { now: () => new Date(call++ * 10) },
    );
    const result = await scheduler.execute("run", plan([task("a"), task("b")]), limits);

    expect(result.launchSkewMs).toBe(10);
  });

  it("waits for the interrupt request and marks an uncertain writer indeterminate", async () => {
    const controller = new AbortController();
    let releaseInterrupt!: () => void;
    const interrupt = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseInterrupt = resolve;
        }),
    );
    const runLeaf = vi.fn(
      async ({ signal }: { signal: AbortSignal }) =>
        new Promise<LeafResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const writer = { ...task("writer"), access: "workspaceWrite" as const };
    const running = new DeterministicScheduler({ runLeaf, interrupt }, noReplan).execute(
      "run",
      plan([writer]),
      limits,
      controller.signal,
    );
    await vi.waitFor(() => expect(runLeaf).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel writer"));
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseInterrupt();
    const result = await running;
    expect(result.leaves[0]).toMatchObject({
      taskId: "writer",
      status: "indeterminate",
      summary: expect.stringContaining("workspace changes may have occurred"),
    });
  });

  it("does not let a reasoning escalation consume a second Sol slot", async () => {
    const terra = { ...task("a"), tier: "terra" as const, effort: "medium" as const };
    const sol = { ...task("b"), tier: "sol" as const, effort: "high" as const };
    const tiers: string[] = [];
    const executor: LeafExecutor = {
      runLeaf: async ({ task: item }) => {
        tiers.push(item.tier);
        return item.id === "a"
          ? { ...completed(item.id), status: "failed", failureKind: "reasoning" }
          : completed(item.id);
      },
    };
    await new DeterministicScheduler(executor, noReplan).execute("run", plan([terra, sol]), {
      ...limits,
      maxConcurrent: 1,
    });

    expect(tiers).toEqual(["terra", "sol"]);
  });

  it("reruns a failed task when a patch replaces it with the same id", async () => {
    const original = task("a", [], true);
    const replacement = { ...original, objective: "repaired contract", critical: false };
    const replanner: ReplanHandler = {
      replan: async () => ({
        protocolVersion: 1,
        planId: "plan",
        reason: "repair contract",
        operations: [{ op: "replace", taskId: "a", task: replacement }],
      }),
      answer: async () => "answer",
    };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) =>
      item.objective === "a"
        ? {
            ...completed(item.id),
            status: "blocked" as const,
            failureKind: "contract" as const,
          }
        : completed(item.id),
    );
    const result = await new DeterministicScheduler({ runLeaf }, replanner).execute(
      "run",
      plan([original]),
      limits,
    );

    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(result.leaves[0]?.status).toBe("completed");
  });

  it("clears transitive blocked descendants when a failed upstream task is replaced", async () => {
    const original = task("a", [], true);
    const replacement = { ...original, objective: "fixed upstream" };
    const replanner: ReplanHandler = {
      replan: async () => ({
        protocolVersion: 1,
        planId: "plan",
        reason: "repair upstream",
        operations: [{ op: "replace", taskId: "a", task: replacement }],
      }),
      answer: async () => "answer",
    };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) =>
      item.objective === "a"
        ? { ...completed(item.id), status: "blocked" as const, failureKind: "contract" as const }
        : completed(item.id),
    );

    const result = await new DeterministicScheduler({ runLeaf }, replanner).execute(
      "run",
      plan([original, task("b", ["a"]), task("c", ["b"])]),
      limits,
    );

    expect(runLeaf.mock.calls.map(([input]) => input.task.id)).toEqual(["a", "a", "b", "c"]);
    expect(result.leaves.map((item) => [item.taskId, item.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "completed"],
    ]);
  });

  it("rejects a patch that cancels an indeterminate workspace writer without dropping evidence", async () => {
    const writer = { ...task("writer", [], true), access: "workspaceWrite" as const };
    const trigger = task("trigger", [], true);
    const observed = vi.fn();
    const replanner: ReplanHandler = {
      replan: async (_plan, _triggers, results) => {
        observed(results);
        return {
          protocolVersion: 1,
          planId: "plan",
          reason: "discard uncertain work",
          operations: [{ op: "cancel", taskId: "writer", reason: "retry" }],
        };
      },
      answer: async () => "answer",
    };
    const updatePlan = vi.fn();
    const scheduler = new DeterministicScheduler(
      {
        runLeaf: async ({ task: item }) =>
          item.id === "writer"
            ? {
                ...completed("writer"),
                status: "indeterminate",
                summary: "workspace changes may have occurred",
                artifacts: [{ path: "/durable/writer.patch" }],
              }
            : completed(item.id, 0.5),
        updatePlan,
      },
      replanner,
    );

    await expect(scheduler.execute("run", plan([writer, trigger]), limits)).rejects.toThrow(
      "cannot be replaced or cancelled",
    );
    expect(observed).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "writer",
          status: "indeterminate",
          artifacts: [{ path: "/durable/writer.patch" }],
        }),
      ]),
    );
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it("fails closed when an executor returns a result for a different task", async () => {
    const result = await new DeterministicScheduler(
      { runLeaf: async () => completed("other") },
      noReplan,
    ).execute("run", plan([task("a")]), { ...limits, maxReplans: 0 });

    expect(result.leaves).toEqual([
      expect.objectContaining({
        taskId: "a",
        status: "failed",
        failureKind: "contract",
        error: expect.stringContaining("expected 'a'"),
      }),
    ]);
  });

  it("does not spend an escalation attempt after its prior usage would exceed the hard budget", async () => {
    const leaf = { ...task("a"), expectedCostUsd: 0.2 };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) => ({
      ...completedWithCost(item.id, 0.4),
      status: "failed" as const,
      failureKind: "reasoning" as const,
    }));

    const result = await new DeterministicScheduler({ runLeaf }, noReplan).execute(
      "run",
      plan([leaf]),
      { ...limits, maxCostUsd: 0.5, maxReplans: 0 },
    );

    expect(runLeaf).toHaveBeenCalledOnce();
    expect(result.leaves[0]).toMatchObject({ status: "failed", failureKind: "reasoning" });
    expect(result.usage[0]?.estimatedCostUsd).toBe(0.4);
  });

  it("does not escalate an unaccounted remote turn under a hard budget", async () => {
    const leaf = { ...task("a"), expectedCostUsd: 0.2 };
    const runLeaf = vi.fn(async ({ task: item }: { task: LeafTask }) => ({
      ...completed(item.id),
      status: "failed" as const,
      failureKind: "reasoning" as const,
      usage: [],
      threadId: "remote-thread",
    }));

    await new DeterministicScheduler({ runLeaf }, noReplan).execute("run", plan([leaf]), {
      ...limits,
      maxCostUsd: 1,
      maxReplans: 0,
    });

    expect(runLeaf).toHaveBeenCalledOnce();
  });

  it("restores prior Sol usage as consumed capacity when resuming", async () => {
    const seeded = {
      ...completed("a"),
      usage: [
        {
          model: "sol-model",
          tier: "sol" as const,
          effort: "high",
          cachedInputTokens: 0,
          uncachedInputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0.1,
        },
      ],
    };
    const pending = { ...task("b"), tier: "terra" as const, effort: "medium" as const };
    const tiers: string[] = [];
    const result = await new DeterministicScheduler(
      {
        runLeaf: async ({ task: item }) => {
          tiers.push(item.tier);
          return { ...completed(item.id), status: "failed", failureKind: "reasoning" };
        },
      },
      noReplan,
    ).execute(
      "run",
      plan([task("a"), pending]),
      { ...limits, maxConcurrent: 1, maxReplans: 0, maxSolLeaves: 1 },
      undefined,
      undefined,
      undefined,
      { initialResults: [seeded] },
    );

    expect(tiers).toEqual(["terra"]);
    expect(result.leaves.find((item) => item.taskId === "b")?.status).toBe("failed");
  });

  it("preserves a consumed null replan slot across resume", async () => {
    const replanner: ReplanHandler = {
      replan: async () => null,
      answer: async () => "answer",
    };
    const first = await new DeterministicScheduler(
      { runLeaf: async ({ task: item }) => completed(item.id, 0.5) },
      replanner,
    ).execute("run", plan([task("a", [], true)]), limits);

    expect(first).toMatchObject({ patch: null, replanCount: 1 });
    await expect(
      new DeterministicScheduler(
        { runLeaf: async ({ task: item }) => completed(item.id) },
        replanner,
      ).execute("resume", plan([task("a", [], true)]), limits, undefined, undefined, undefined, {
        initialResults: first.leaves,
        patch: null,
        replanCount: 1,
      }),
    ).resolves.toMatchObject({ replanCount: 1, patch: null });
  });

  it("abandons an in-flight replan on abort without updating the remote plan", async () => {
    const controller = new AbortController();
    let replanStarted!: () => void;
    const replanner: ReplanHandler = {
      replan: async () =>
        new Promise<PlanPatch | null>((resolve) => {
          replanStarted = () => resolve(null);
        }),
      answer: async () => "answer",
    };
    const updatePlan = vi.fn();
    const running = new DeterministicScheduler(
      { runLeaf: async ({ task: item }) => completed(item.id, 0.5), updatePlan },
      replanner,
    ).execute("run", plan([task("a", [], true)]), limits, controller.signal);

    await vi.waitFor(() => expect(replanStarted).toBeTypeOf("function"));
    controller.abort(new Error("stop before patch"));
    await expect(running).resolves.toMatchObject({ patch: null, replanCount: 1 });
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it("settles after abort when a leaf ignores its signal and ignores its late success", async () => {
    const controller = new AbortController();
    let finishLeaf!: (result: LeafResult) => void;
    const runLeaf = vi.fn(
      async () =>
        new Promise<LeafResult>((resolve) => {
          finishLeaf = resolve;
        }),
    );
    const writer = { ...task("writer"), access: "workspaceWrite" as const };
    const running = new DeterministicScheduler({ runLeaf }, noReplan, {
      interruptGraceMs: 0,
    }).execute("run", plan([writer]), limits, controller.signal);
    await vi.waitFor(() => expect(runLeaf).toHaveBeenCalledOnce());

    controller.abort(new Error("stop ignored leaf"));
    const result = await running;
    finishLeaf(completed("writer"));
    await Promise.resolve();

    expect(result.leaves[0]).toMatchObject({ taskId: "writer", status: "indeterminate" });
  });
});
