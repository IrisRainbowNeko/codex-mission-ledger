import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BatchResult,
  ExecutionLimits,
  ExecutionPlan,
  JobSnapshot,
  LeafResult,
  ModelUsage,
  RemoteTurnRef,
} from "../src/core/contracts.js";
import type {
  AdmissionController,
  DirectExecutor,
  AgentOutcome,
  FinalReviewer,
  RecoveryAdapter,
  ResultIntegrator,
  WorkspaceController,
} from "../src/core/integration.js";
import { hashRunRequest, JobStore } from "../src/core/job-store.js";
import {
  PlannerStateError,
  type PlannerService,
  type PlannerSession,
} from "../src/core/planner.js";
import {
  DeterministicScheduler,
  type LeafExecutor,
  type ScheduleResult,
} from "../src/core/scheduler.js";
import {
  AgentTrioService,
  type AgentTrioServiceOptions,
  type NonLeafCostEstimator,
} from "../src/core/service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const limits: ExecutionLimits = {
  maxConcurrent: 5,
  maxLeaves: 8,
  maxWaves: 3,
  maxSolLeaves: 1,
  maxReplans: 1,
};

function usage(tier: "luna" | "terra" | "sol", cost: number): ModelUsage {
  return {
    model: `gpt-5.6-${tier}`,
    tier,
    effort: "medium",
    cachedInputTokens: 0,
    uncachedInputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    estimatedCostUsd: cost,
  };
}

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    objective: "parallel work",
    domain: "coding",
    assumptions: [],
    tasks: [
      {
        id: "leaf-a",
        objective: "implement a",
        domain: "coding",
        tier: "luna",
        effort: "medium",
        access: "workspaceWrite",
        ownedPaths: ["src/a.ts"],
        dependsOn: [],
        capabilities: [],
        validation: [],
        communicationWith: [],
        expectedSeconds: 90,
        expectedCostUsd: 0.02,
        difficulty: 0.2,
        ambiguity: 0.1,
        confidence: 0.9,
        critical: false,
      },
      {
        id: "leaf-b",
        objective: "implement b",
        domain: "coding",
        tier: "luna",
        effort: "medium",
        access: "workspaceWrite",
        ownedPaths: ["src/b.ts"],
        dependsOn: [],
        capabilities: [],
        validation: [],
        communicationWith: [],
        expectedSeconds: 90,
        expectedCostUsd: 0.02,
        difficulty: 0.2,
        ambiguity: 0.1,
        confidence: 0.9,
        critical: false,
      },
    ],
    integration: {
      objective: "integrate",
      requiredOutputs: ["working result"],
      validation: [{ command: "npm test" }],
      finalReview: "never",
    },
    risk: "medium",
    ...overrides,
  };
}

function leaf(taskId: string): LeafResult {
  return {
    taskId,
    status: "completed",
    summary: `${taskId} complete`,
    confidence: 0.9,
    findings: [],
    changedFiles: [`src/${taskId}.ts`],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: `thread-${taskId}`,
    turnId: `turn-${taskId}`,
    usage: [usage("luna", 0.02)],
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
  };
}

function createStore(): JobStore {
  const root = mkdtempSync(join(tmpdir(), "agent-trio-service-"));
  roots.push(root);
  return new JobStore(root);
}

function resumableFanoutSnapshot(
  runId: string,
  executionPlan: ExecutionPlan,
  leaves: LeafResult[],
): JobSnapshot {
  const request = {
    objective: "resume parallel work",
    cwd: "/workspace",
    mode: "durable" as const,
  };
  const planningUsage = [usage("sol", 0.02)];
  const admissionUsage = [usage("terra", 0.01)];
  return {
    protocolVersion: 1,
    requestHash: hashRunRequest(request),
    request,
    result: {
      protocolVersion: 1,
      runId,
      status: "running",
      plan: structuredClone(executionPlan),
      patch: null,
      leaves: structuredClone(leaves),
      finalResponse: null,
      metrics: null,
    },
    remoteTurns: [],
    coordinatorThreadId: "terra-admission-resume",
    plannerThreadId: "sol-planner-resume",
    integratorThreadId: null,
    plannerSession: {
      runId,
      threadId: "sol-planner-resume",
      request,
      limits,
      initialPlan: structuredClone(executionPlan),
      plan: structuredClone(executionPlan),
      patch: null,
      replanCount: 0 as const,
      usage: planningUsage,
    },
    startedAt: "2026-08-28T00:00:00.000Z",
    planningMs: 17,
    integrationMs: 0,
    usageByStage: {
      admission: { usage: admissionUsage, estimatedCostUsd: 0.01 },
      direct: { usage: [], estimatedCostUsd: 0 },
      planning: { usage: planningUsage, estimatedCostUsd: 0.02 },
      replan: { usage: [], estimatedCostUsd: 0 },
      leaves: {
        usage: leaves.flatMap((item) => item.usage),
        estimatedCostUsd: leaves.reduce(
          (total, item) =>
            total +
            item.usage.reduce((sum, itemUsage) => sum + (itemUsage.estimatedCostUsd ?? 0), 0),
          0,
        ),
      },
      integration: { usage: [], estimatedCostUsd: 0 },
      finalReview: { usage: [], estimatedCostUsd: 0 },
    },
    updatedAt: "2026-08-28T00:01:00.000Z",
  };
}

function finalReviewRecovery(
  leaves: readonly LeafResult[],
  workspaceWritersMayHaveRun: boolean,
): RecoveryAdapter {
  return {
    reattach: vi.fn(async ({ snapshot }) => {
      const checkpoint = snapshot.integrationCheckpoint;
      if (checkpoint === undefined) {
        throw new Error("final-review recovery requires an integration checkpoint");
      }
      return {
        result: {
          ...structuredClone(snapshot.result),
          status: "running" as const,
          leaves: structuredClone([...leaves]),
          finalResponse: null,
        },
        plannerThreadId: snapshot.plannerThreadId,
        integratorThreadId: checkpoint.integratorThreadId,
        continuation: {
          initialLeaves: structuredClone([...leaves]),
          workspaceWritersMayHaveRun,
          finalReview: {
            integratedResponse: checkpoint.response,
            integrationValidation: structuredClone(checkpoint.validation),
            integratorThreadId: checkpoint.integratorThreadId,
            launchSkewMs: checkpoint.launchSkewMs,
            peakConcurrency: checkpoint.peakConcurrency,
            replanCount: checkpoint.replanCount,
          },
        },
      };
    }),
  };
}

function createService(
  overrides: Partial<Omit<AgentTrioServiceOptions, "costEstimator">> & {
    costEstimator?: NonLeafCostEstimator | null;
  } = {},
): AgentTrioService {
  const admission: AdmissionController = {
    decide: () => ({ route: "direct", reason: "small request" }),
  };
  const directExecutor: DirectExecutor = {
    execute: async () => ({
      status: "completed",
      response: "direct result",
      threadId: "terra-direct",
      usage: [],
    }),
  };
  const planner: Pick<PlannerService, "plan"> = {
    plan: async () => {
      throw new Error("planner should not run");
    },
  };
  const scheduler: Pick<DeterministicScheduler, "execute"> = {
    execute: async () => {
      throw new Error("scheduler should not run");
    },
  };
  const integrator: ResultIntegrator = {
    integrate: async () => {
      throw new Error("integrator should not run");
    },
  };
  const costEstimator: NonLeafCostEstimator = {
    estimateUsd: ({ stage }) => (stage === "admission" ? 0 : 0.001),
  };
  const { costEstimator: overrideCostEstimator, ...otherOverrides } = overrides;
  return new AgentTrioService({
    store: createStore(),
    admission,
    directExecutor,
    planner,
    scheduler,
    integrator,
    validator: {
      validate: async ({ specs }) =>
        specs.map((spec) => ({ command: spec.command, status: "passed", summary: "ok" })),
    },
    ...(overrideCostEstimator === null
      ? {}
      : { costEstimator: overrideCostEstimator ?? costEstimator }),
    ...otherOverrides,
  });
}

describe("AgentTrioService", () => {
  it("adds the local monitor URL without adding an execution stage", async () => {
    const service = createService({
      monitorUrlForRun: (runId) => `http://127.0.0.1:43173/runs/${runId}?token=test`,
    });

    const result = await service.run({
      runId: "monitored-direct",
      objective: "complete a direct task",
      cwd: "/workspace",
    });

    expect(result.monitorUrl).toBe("http://127.0.0.1:43173/runs/monitored-direct?token=test");
    expect(result.metrics?.usageByStage?.planning.usage).toEqual([]);
  });

  it("bypasses Sol planning and leaves for a direct Terra request", async () => {
    const store = createStore();
    const planner = { plan: vi.fn(async () => Promise.reject(new Error("unexpected planner"))) };
    const scheduler = {
      execute: vi.fn(async () => Promise.reject(new Error("unexpected scheduler"))),
    };
    const executeDirect = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "finished directly",
      threadId: "terra-direct",
      usage: [usage("terra", 0.01)],
    }));
    const directExecutor: DirectExecutor = { execute: executeDirect };
    const service = createService({ store, planner, scheduler, directExecutor });

    const result = await service.run({
      runId: "direct-1",
      objective: "rename one local symbol",
      cwd: "/workspace",
    });

    expect(result).toMatchObject({
      runId: "direct-1",
      status: "completed",
      plan: null,
      leaves: [],
      finalResponse: "finished directly",
    });
    expect(result.metrics).toMatchObject({
      planningMs: 0,
      peakConcurrency: 0,
      estimatedCostUsd: 0.01,
      usageByStage: {
        admission: { usage: [], estimatedCostUsd: 0 },
        direct: { estimatedCostUsd: 0.01 },
        planning: { usage: [], estimatedCostUsd: 0 },
        replan: { usage: [], estimatedCostUsd: 0 },
        leaves: { usage: [], estimatedCostUsd: 0 },
        integration: { usage: [], estimatedCostUsd: 0 },
        finalReview: { usage: [], estimatedCostUsd: 0 },
      },
    });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(scheduler.execute).not.toHaveBeenCalled();
    expect(directExecutor.execute).toHaveBeenCalledTimes(1);
    expect(service.status("direct-1")).toEqual(result);
    expect(store.load("direct-1")?.result.metrics?.usageByStage).toEqual(
      result.metrics?.usageByStage,
    );
  });

  it("preserves explicit capabilities through the public handle and normalized request", async () => {
    const store = createStore();
    const decide = vi.fn(() => ({ route: "direct" as const, reason: "small request" }));
    const execute = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "document updated",
      threadId: "terra-capability",
      usage: [],
    }));
    const service = createService({
      store,
      admission: { decide },
      directExecutor: { execute },
    });
    const capabilities = [
      { kind: "skill" as const, name: "documents", path: "/capabilities/documents/SKILL.md" },
      { kind: "plugin" as const, name: "browser@openai-bundled" },
    ];

    const result = await service.handle({
      action: "run",
      runId: "direct-capabilities",
      objective: "update the document",
      cwd: "/workspace",
      hostAccess: "fullAccess",
      hostApproval: "approveForMe",
      capabilities,
    });

    expect(result.status).toBe("completed");
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          capabilities,
          hostAccess: "fullAccess",
          hostApproval: "approveForMe",
        }),
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          capabilities,
          hostAccess: "fullAccess",
          hostApproval: "approveForMe",
        }),
      }),
    );
    expect(store.load("direct-capabilities")?.request.capabilities).toEqual(capabilities);
    expect(store.load("direct-capabilities")?.request.hostAccess).toBe("fullAccess");
    expect(store.load("direct-capabilities")?.request.hostApproval).toBe("approveForMe");
  });

  it("uses the model-free router for explicit fanout with declared capabilities", async () => {
    const admission = {
      decide: vi.fn(() => {
        throw new Error("Terra admission should not run for explicit fanout");
      }),
    };
    const decide = vi.fn(() => ({ route: "direct" as const, reason: "test route" }));
    const service = createService({
      admission,
      routeOptimizer: { decide },
    });
    const capabilities = [{ kind: "skill" as const, name: "documents" }];

    const result = await service.run({
      runId: "fanout-capability-route",
      objective: "update two independent document sections",
      cwd: "/workspace",
      strategy: "fanout",
      capabilities,
    });

    expect(result.status).toBe("completed");
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ strategy: "fanout", capabilities }),
      }),
    );
    expect(admission.decide).not.toHaveBeenCalled();
  });

  it("uses a direct outcome produced by Terra admission without a second turn", async () => {
    const directExecutor: DirectExecutor = {
      execute: vi.fn(async () => {
        throw new Error("direct executor should not run");
      }),
    };
    const service = createService({
      admission: {
        decide: () => ({
          route: "direct",
          reason: "completed during admission",
          threadId: "terra-admission",
          outcome: {
            status: "completed",
            response: "one-turn result",
            threadId: "terra-admission",
            usage: [usage("terra", 0.01)],
          },
        }),
      },
      directExecutor,
    });

    const result = await service.run({
      runId: "direct-one-turn",
      objective: "small direct task",
      cwd: "/workspace",
    });

    expect(result.finalResponse).toBe("one-turn result");
    expect(result.metrics?.estimatedCostUsd).toBe(0.01);
    expect(directExecutor.execute).not.toHaveBeenCalled();
  });

  it("falls back to the internal Sol planner when a host plan is outside the fast path", async () => {
    const executionPlan = plan({
      tasks: [
        { ...plan().tasks[0]!, access: "readOnly", ownedPaths: [] },
        { ...plan().tasks[1]!, access: "readOnly", ownedPaths: [] },
      ],
      integration: {
        objective: "combine findings",
        requiredOutputs: ["complete result"],
        validation: [],
        finalReview: "never",
        aggregation: "deterministic",
      },
      risk: "low",
    });
    const adoptHostPlan = vi.fn(async () => {
      throw new PlannerStateError(
        "host_plan_requires_internal_sol",
        "semantic integration is required",
      );
    });
    const internalPlan = vi.fn(async (request) => ({
      threadId: "sol-internal-fallback",
      request,
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0 as const,
      usage: [],
    }));
    const completedLeaves = executionPlan.tasks.map((task) => ({
      ...leaf(task.id),
      changedFiles: [],
    }));
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "explicit host plan" }) },
      planner: { adoptHostPlan, plan: internalPlan },
      scheduler: {
        execute: async () => ({
          plan: executionPlan,
          patch: null,
          leaves: completedLeaves,
          launchSkewMs: 0,
          peakConcurrency: 2,
          replanCount: 0,
          usage: completedLeaves.flatMap((item) => item.usage),
        }),
      },
    });

    const result = await service.run({
      runId: "host-plan-internal-fallback",
      objective: "compare two reports and reconcile their conclusions",
      cwd: "/workspace",
      semanticPlan: {
        access: "readOnly",
        merge: "terra",
        risk: "medium",
        tasks: [
          {
            goal: "inspect report a",
            paths: [],
            after: [],
            floor: null,
            expectedSeconds: 90,
          },
          {
            goal: "inspect report b",
            paths: [],
            after: [],
            floor: null,
            expectedSeconds: 90,
          },
        ],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.metrics?.plannerSkipped).toBe(false);
    expect(adoptHostPlan).toHaveBeenCalledOnce();
    expect(internalPlan).toHaveBeenCalledWith(
      expect.not.objectContaining({ semanticPlan: expect.anything() }),
      "host-plan-internal-fallback",
      expect.any(AbortSignal),
      "fanout",
    );
  });

  it("fails closed when a remote stage omits usage under a hard cost budget", async () => {
    const service = createService({
      directExecutor: {
        execute: async () => ({
          status: "completed",
          response: "unaccounted result",
          threadId: "terra-direct",
          usage: [],
        }),
      },
    });

    const result = await service.run({
      runId: "missing-cost-usage",
      objective: "bounded task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.1 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("did not report usage");
  });

  it("does not start admission without a reliable pre-call estimate under maxCostUsd", async () => {
    const decide = vi.fn(() => ({ route: "direct" as const, reason: "small request" }));
    const service = createService({
      admission: { decide },
      costEstimator: null,
    });

    const result = await service.run({
      runId: "missing-precall-estimate",
      objective: "bounded task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.1 },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("no reliable pre-call USD estimate"),
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("does not start a stage whose reservation would exceed maxCostUsd", async () => {
    const decide = vi.fn(() => ({ route: "direct" as const, reason: "small request" }));
    const service = createService({
      admission: { decide },
      costEstimator: { estimateUsd: () => 0.11 },
    });

    const result = await service.run({
      runId: "precall-estimate-too-large",
      objective: "bounded task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.1 },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("above maxCostUsd=0.1"),
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("deducts admission and planning cost before scheduling leaves", async () => {
    const executionPlan = plan();
    const planner: Pick<PlannerService, "plan"> = {
      plan: async (request) => ({
        threadId: "sol-planner-budget",
        request,
        limits: { ...limits, maxCostUsd: 0.5 },
        initialPlan: executionPlan,
        plan: executionPlan,
        patch: null,
        replanCount: 0,
        usage: [usage("sol", 0.02)],
      }),
    };
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const estimateUsd = vi.fn(({ stage }: { stage: string }) => {
      switch (stage) {
        case "admission":
          return 0.1;
        case "planning":
          return 0.2;
        case "integration":
          return 0.1;
        default:
          return 0.01;
      }
    });
    let leafBudgetAtStart: number | undefined;
    const execute = vi.fn(
      async (
        _runId: string,
        _plan: ExecutionPlan,
        executionLimits: ExecutionLimits,
      ): Promise<ScheduleResult> => {
        leafBudgetAtStart = executionLimits.maxCostUsd;
        return {
          plan: executionPlan,
          patch: null,
          leaves,
          launchSkewMs: 1,
          peakConcurrency: 2,
          replanCount: 0,
          usage: leaves.flatMap((item) => item.usage),
        };
      },
    );
    const service = createService({
      admission: {
        decide: () => ({
          route: "fanout",
          reason: "parallel work",
          threadId: "terra-admission-budget",
          usage: [usage("terra", 0.01)],
        }),
      },
      planner,
      scheduler: { execute },
      integrator: {
        integrate: async () => ({
          status: "completed",
          response: "integrated",
          threadId: "terra-integrator-budget",
          usage: [usage("terra", 0.01)],
        }),
      },
      costEstimator: { estimateUsd },
    });

    const result = await service.run({
      runId: "shared-cost-budget",
      objective: "parallel task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.5 },
    });

    expect(result.status).toBe("completed");
    expect(leafBudgetAtStart).toBeCloseTo(0.47);
    expect(estimateUsd.mock.calls.map(([input]) => input.stage)).toEqual([
      "admission",
      "planning",
      "integration",
    ]);
    expect(result.metrics?.usageByStage).toMatchObject({
      admission: { estimatedCostUsd: 0.01 },
      planning: { estimatedCostUsd: 0.02 },
      leaves: { estimatedCostUsd: 0.04 },
      integration: { estimatedCostUsd: 0.01 },
    });
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.08);
    expect(execute).toHaveBeenCalledWith(
      "shared-cost-budget",
      executionPlan,
      expect.any(Object),
      expect.any(AbortSignal),
      undefined,
      expect.objectContaining({ inspect: expect.any(Function) }),
      undefined,
      undefined,
      undefined,
    );
  });

  it("blocks Terra integration before its estimate would exceed the remaining budget", async () => {
    const executionPlan = plan();
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const integrate = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "must not run",
      threadId: "terra-integration",
      usage: [usage("terra", 0.01)],
    }));
    const service = createService({
      admission: {
        decide: () => ({
          route: "fanout",
          reason: "parallel work",
          usage: [usage("terra", 0.01)],
        }),
      },
      planner: {
        plan: async (request) => ({
          threadId: "sol-planner",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [usage("sol", 0.01)],
        }),
      },
      scheduler: {
        execute: async (...args) => {
          await args[5]?.inspect(executionPlan, leaves);
          return {
            plan: executionPlan,
            patch: null,
            leaves,
            launchSkewMs: 0,
            peakConcurrency: 2,
            replanCount: 0,
            usage: leaves.flatMap((item) => item.usage),
          };
        },
      },
      integrator: { integrate },
      costEstimator: {
        estimateUsd: ({ stage }) => (stage === "integration" ? 0.02 : 0.005),
      },
    });

    const result = await service.run({
      runId: "integration-precall-budget",
      objective: "parallel task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.075 },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Terra integration requires an estimated 0.02 USD"),
      metrics: { estimatedCostUsd: 0.06 },
    });
    expect(integrate).not.toHaveBeenCalled();
  });

  it("reconciles an underestimated stage to actual usage before allowing later work", async () => {
    const executionPlan = plan();
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const integrate = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "too expensive",
      threadId: "terra-integration",
      usage: [usage("terra", 0.01)],
    }));
    const service = createService({
      admission: {
        decide: () => ({
          route: "fanout",
          reason: "parallel work",
          usage: [usage("terra", 0.01)],
        }),
      },
      planner: {
        plan: async (request) => ({
          threadId: "sol-planner",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [usage("sol", 0.01)],
        }),
      },
      scheduler: {
        execute: async (...args) => {
          await args[5]?.inspect(executionPlan, leaves);
          return {
            plan: executionPlan,
            patch: null,
            leaves,
            launchSkewMs: 0,
            peakConcurrency: 2,
            replanCount: 0,
            usage: leaves.flatMap((item) => item.usage),
          };
        },
      },
      integrator: { integrate },
      costEstimator: {
        estimateUsd: ({ stage }) => (stage === "integration" ? 0.001 : 0.005),
      },
    });

    const result = await service.run({
      runId: "integration-actual-budget",
      objective: "parallel task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.065 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("raised total cost to");
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.07);
    expect(result.metrics?.usageByStage?.integration.estimatedCostUsd).toBeCloseTo(0.01);
    expect(integrate).toHaveBeenCalledOnce();
  });

  it("falls back to Terra direct when Sol rejects fanout economics", async () => {
    const planningUsage = [usage("sol", 0.03)];
    const planAttempt = vi.fn(async () => {
      throw new PlannerStateError(
        "fanout_rejected",
        "Sol plan does not justify fanout: no_time_saving",
        { threadId: "sol-rejected-fanout", usage: planningUsage },
      );
    });
    const direct = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "completed directly after economic rejection",
      threadId: "terra-fallback",
      usage: [usage("terra", 0.01)],
    }));
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "appears decomposable" }) },
      planner: { plan: planAttempt },
      directExecutor: { execute: direct },
    });

    const result = await service.run({
      runId: "fanout-direct-fallback",
      objective: "finish a task whose decomposition is not economic",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.5 },
    });

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "completed directly after economic rejection",
      metrics: {
        routeReason:
          "appears decomposable; planner fallback: Sol plan does not justify fanout: no_time_saving",
        usageByStage: {
          planning: { estimatedCostUsd: 0.03 },
          direct: { estimatedCostUsd: 0.01 },
        },
      },
    });
    expect(planAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      "fanout-direct-fallback",
      expect.any(AbortSignal),
      "fanout",
    );
    expect(direct).toHaveBeenCalledOnce();
  });

  it("does not launch leaves when the final plan misses economic admission", async () => {
    const executionPlan = plan();
    const scheduler = vi.fn(async (): Promise<ScheduleResult> => {
      throw new Error("scheduler must not run after plan rejection");
    });
    const direct = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "direct fallback",
      threadId: "terra-final-plan-fallback",
      usage: [usage("terra", 0.01)],
    }));
    const assessPlan = vi.fn(() => ({
      route: "direct" as const,
      reason: "fanout misses cost/time gate",
      estimatedDirectCostUsd: 0.05,
      estimatedFanoutCostUsd: 0.03,
      estimatedDirectSeconds: 100,
      estimatedFanoutSeconds: 80,
    }));
    const service = createService({
      routeOptimizer: {
        decide: () => ({ route: "fanout", reason: "candidate" }),
        assessPlan,
      },
      planner: {
        plan: async (request) => ({
          threadId: "sol-final-plan-check",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [usage("sol", 0.01)],
        }),
      },
      scheduler: { execute: scheduler },
      directExecutor: { execute: direct },
    });

    const result = await service.run({
      runId: "final-plan-economic-rejection",
      objective: "parallel candidate",
      cwd: "/workspace",
      strategy: "fanout",
      limits: { maxCostUsd: 0.5 },
    });

    expect(result).toMatchObject({
      status: "completed",
      plan: null,
      finalResponse: "direct fallback",
      metrics: {
        selectedLeafCount: 0,
        routeReason: "fanout misses cost/time gate",
        usageByStage: {
          planning: { estimatedCostUsd: 0.01 },
          leaves: { usage: [] },
        },
      },
    });
    expect(assessPlan).toHaveBeenCalledOnce();
    expect(scheduler).not.toHaveBeenCalled();
    expect(direct).toHaveBeenCalledOnce();
  });

  it("interrupts a running stage when the end-to-end deadline expires", async () => {
    const service = createService({
      directExecutor: {
        execute: async ({ signal }) =>
          new Promise<AgentOutcome>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
    });

    const result = await service.run({
      runId: "service-deadline",
      objective: "long direct task",
      cwd: "/workspace",
      limits: { deadlineMs: 20 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("deadline");
    expect(result.metrics?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("binds run and submit to their foreground and durable leaf caps", async () => {
    const service = createService();

    await expect(
      service.run({
        runId: "foreground-too-large",
        objective: "task",
        cwd: "/workspace",
        limits: { maxLeaves: 9 },
      }),
    ).rejects.toThrow("foreground runs cannot exceed 8 leaves");
    await expect(
      service.run({
        runId: "wrong-run-mode",
        objective: "task",
        cwd: "/workspace",
        mode: "durable",
      }),
    ).rejects.toThrow("run requests must use foreground mode");

    await expect(
      service.submit({
        runId: "durable-cap",
        objective: "task",
        cwd: "/workspace",
        limits: { maxLeaves: 20 },
      }),
    ).resolves.toMatchObject({ runId: "durable-cap" });
  });

  it("runs Sol plan, leaves, Terra integration, and risk-triggered Sol review in order", async () => {
    const order: string[] = [];
    const store = createStore();
    const executionPlan = plan({
      risk: "high",
      integration: {
        objective: "integrate",
        requiredOutputs: ["working result"],
        validation: [{ command: "npm test" }],
        finalReview: "riskTriggered",
      },
    });
    const planner: Pick<PlannerService, "plan"> = {
      plan: vi.fn(async (request): Promise<PlannerSession & { usage: ModelUsage[] }> => {
        order.push("plan");
        return {
          threadId: "sol-planner",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0 as const,
          usage: [usage("sol", 0.03)],
        };
      }),
    };
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const scheduler: Pick<DeterministicScheduler, "execute"> = {
      execute: vi.fn(async (...args): Promise<ScheduleResult> => {
        order.push("schedule");
        const scheduled = {
          plan: executionPlan,
          patch: null,
          leaves,
          launchSkewMs: 4,
          peakConcurrency: 2,
          replanCount: 0,
          usage: leaves.flatMap((item) => item.usage),
        };
        await args[5]?.inspect(executionPlan, leaves);
        return scheduled;
      }),
    };
    const integrator: ResultIntegrator = {
      integrate: vi.fn(async (input): Promise<AgentOutcome> => {
        expect(input.request.cwd).toBe("/workspace/candidate");
        order.push("integrate");
        return {
          status: "completed",
          response: "integrated",
          threadId: "terra-integrator",
          usage: [usage("terra", 0.04)],
          validation: [{ command: "npm test", status: "passed", summary: "ok" }],
        };
      }),
    };
    const finalReviewer: FinalReviewer = {
      review: vi.fn(async (input) => {
        expect(input.request.cwd).toBe("/workspace/candidate");
        order.push("review");
        return {
          approved: true,
          issues: [],
          threadId: "sol-planner",
          usage: [usage("sol", 0.05)],
        };
      }),
    };
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => {
        order.push("workspace-prepare");
      }),
      prepareValidation: vi.fn(async () => {
        order.push("workspace-candidate");
        return "/workspace/candidate";
      }),
      integrate: vi.fn(async () => {
        order.push("workspace-apply");
      }),
      cleanup: vi.fn(async () => {
        order.push("workspace-cleanup");
      }),
    };
    const service = createService({
      store,
      admission: { decide: () => ({ route: "fanout", reason: "two independent modules" }) },
      planner,
      scheduler,
      integrator,
      finalReviewer,
      workspace,
    });

    const result = await service.run({
      runId: "complex-1",
      objective: "implement two modules",
      cwd: "/workspace",
    });

    expect(order).toEqual([
      "plan",
      "workspace-prepare",
      "schedule",
      "workspace-candidate",
      "integrate",
      "review",
      "workspace-apply",
      "workspace-cleanup",
    ]);
    expect(result.status).toBe("completed");
    expect(result.finalResponse).toBe("integrated");
    expect(result.metrics).toMatchObject({ launchSkewMs: 4, peakConcurrency: 2 });
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.16);
    expect(result.metrics?.usage.map((item) => item.tier)).toEqual([
      "sol",
      "luna",
      "luna",
      "terra",
      "sol",
    ]);
    expect(result.metrics?.usageByStage).toMatchObject({
      admission: { usage: [], estimatedCostUsd: 0 },
      direct: { usage: [], estimatedCostUsd: 0 },
      planning: { estimatedCostUsd: 0.03 },
      replan: { usage: [], estimatedCostUsd: 0 },
      leaves: { estimatedCostUsd: 0.04 },
      integration: { estimatedCostUsd: 0.04 },
      finalReview: { estimatedCostUsd: 0.05 },
    });
    expect(result.metrics?.usageByStage?.planning.usage[0]?.tier).toBe("sol");
    expect(result.metrics?.usageByStage?.finalReview.usage[0]?.tier).toBe("sol");
    expect(store.load("complex-1")?.workspaceCommitState).toBe("applied");
  });

  it("blocks the final Sol review before its reservation exceeds maxCostUsd", async () => {
    const executionPlan = plan({
      risk: "high",
      integration: { ...plan().integration, finalReview: "riskTriggered" },
    });
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const review = vi.fn(async () => ({
      approved: true,
      issues: [],
      threadId: "sol-planner",
      usage: [usage("sol", 0.01)],
    }));
    const service = createService({
      admission: {
        decide: () => ({
          route: "fanout",
          reason: "parallel work",
          usage: [usage("terra", 0.01)],
        }),
      },
      planner: {
        plan: async (request) => ({
          threadId: "sol-planner",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [usage("sol", 0.02)],
        }),
      },
      scheduler: {
        execute: async (...args) => {
          await args[5]?.inspect(executionPlan, leaves);
          return {
            plan: executionPlan,
            patch: null,
            leaves,
            launchSkewMs: 0,
            peakConcurrency: 2,
            replanCount: 0,
            usage: leaves.flatMap((item) => item.usage),
          };
        },
      },
      integrator: {
        integrate: async () => ({
          status: "completed",
          response: "integrated",
          threadId: "terra-integrator",
          usage: [usage("terra", 0.04)],
        }),
      },
      finalReviewer: { review },
      costEstimator: {
        estimateUsd: ({ stage }) => (stage === "final_review" ? 0.03 : 0.001),
      },
    });

    const result = await service.run({
      runId: "review-precall-budget",
      objective: "parallel task",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.13 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Sol final review requires an estimated 0.03 USD");
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.11);
    expect(review).not.toHaveBeenCalled();
  });

  it("resumes only an uncertain read-only final review after the initial remote call fails", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: plan().tasks.map((task) => ({
        ...task,
        access: "readOnly" as const,
        ownedPaths: [],
      })),
      integration: { ...plan().integration, validation: [], finalReview: "always" },
    });
    const leaves = [
      { ...leaf("leaf-a"), changedFiles: [] },
      { ...leaf("leaf-b"), changedFiles: [] },
    ];
    const initialScheduler = {
      execute: vi.fn(async (...args: Parameters<DeterministicScheduler["execute"]>) => {
        await args[5]?.inspect(executionPlan, leaves);
        return {
          plan: executionPlan,
          patch: null,
          leaves,
          launchSkewMs: 3,
          peakConcurrency: 2,
          replanCount: 0,
          usage: leaves.flatMap((item) => item.usage),
        };
      }),
    };
    const initialIntegrate = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "Terra response awaiting review",
      threadId: "terra-readonly-integration",
      usage: [usage("terra", 0.03)],
    }));
    const initialReview = vi.fn(async () => {
      throw new Error("review transport disconnected after turn/start");
    });
    const initial = createService({
      store,
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner: {
        plan: async (request) => ({
          threadId: "sol-readonly-review",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [usage("sol", 0.02)],
        }),
      },
      scheduler: initialScheduler,
      integrator: { integrate: initialIntegrate },
      finalReviewer: { review: initialReview },
    });

    const uncertain = await initial.run({
      runId: "initial-readonly-review-uncertain",
      objective: "review read-only parallel work",
      cwd: "/workspace",
    });

    expect(uncertain).toMatchObject({
      status: "indeterminate",
      finalResponse: null,
      error: expect.stringContaining("Sol final review did not return a confirmed response"),
    });
    expect(store.load("initial-readonly-review-uncertain")?.integrationCheckpoint).toMatchObject({
      response: "Terra response awaiting review",
      integratorThreadId: "terra-readonly-integration",
    });

    const resumedScheduler = {
      execute: vi.fn(async () => Promise.reject(new Error("scheduler must not replay"))),
    };
    const resumedIntegrate = vi.fn(async () =>
      Promise.reject(new Error("Terra integration must not replay")),
    );
    const resumedReview = vi.fn(async () => ({
      approved: true,
      issues: [],
      threadId: "sol-readonly-review",
      usage: [usage("sol", 0.04)],
    }));
    const resumed = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("planning must not replay"))),
        restoreSession: (input) => structuredClone(input),
      },
      scheduler: resumedScheduler,
      integrator: { integrate: resumedIntegrate },
      finalReviewer: { review: resumedReview },
      recovery: finalReviewRecovery(leaves, false),
    });

    const completed = await resumed.resume("initial-readonly-review-uncertain");

    expect(completed).toMatchObject({
      status: "completed",
      finalResponse: "Terra response awaiting review",
    });
    expect(resumedReview).toHaveBeenCalledOnce();
    expect(resumedScheduler.execute).not.toHaveBeenCalled();
    expect(resumedIntegrate).not.toHaveBeenCalled();
    expect(store.load("initial-readonly-review-uncertain")?.integrationCheckpoint).toBeUndefined();
  });

  it("discards isolated writer patches when the final Sol review rejects the result", async () => {
    const store = createStore();
    const executionPlan = plan({
      risk: "high",
      integration: {
        ...plan().integration,
        finalReview: "riskTriggered",
      },
    });
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const service = createService({
      store,
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner: {
        plan: async (request) => ({
          threadId: "sol-review-reject",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [],
        }),
      },
      scheduler: {
        execute: async (...args) => {
          await args[5]?.inspect(executionPlan, leaves);
          return {
            plan: executionPlan,
            patch: null,
            leaves,
            launchSkewMs: 1,
            peakConcurrency: 2,
            replanCount: 0,
            usage: leaves.flatMap((item) => item.usage),
          };
        },
      },
      integrator: {
        integrate: async () => ({
          status: "completed",
          response: "integrated",
          threadId: "terra-review-reject",
          usage: [],
        }),
      },
      finalReviewer: {
        review: async () => ({
          approved: false,
          issues: ["unsafe final result"],
          threadId: "sol-review-reject",
          usage: [],
        }),
      },
      workspace,
    });

    const result = await service.run({
      runId: "review-rejects-patches",
      objective: "high-risk parallel task",
      cwd: "/workspace",
    });

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("unsafe") });
    expect(workspace.integrate).not.toHaveBeenCalled();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    expect(store.load("review-rejects-patches")?.workspaceCommitState).toBe("pending");
  });

  it("never applies successful writer patches when a sibling leaf fails", async () => {
    const executionPlan = plan();
    const completed = leaf("leaf-a");
    const failed: LeafResult = {
      ...leaf("leaf-b"),
      status: "failed",
      summary: "leaf-b failed",
      confidence: 0,
      changedFiles: [],
      error: "implementation failed",
      failureKind: "reasoning",
    };
    const integrate = vi.fn(async () => Promise.reject(new Error("must not integrate")));
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      prepareValidation: vi.fn(async () => "/workspace/candidate"),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner: {
        plan: async (request) => ({
          threadId: "sol-partial-failure",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [],
        }),
      },
      scheduler: {
        execute: async () => ({
          plan: executionPlan,
          patch: null,
          leaves: [completed, failed],
          launchSkewMs: 1,
          peakConcurrency: 2,
          replanCount: 0,
          usage: [...completed.usage, ...failed.usage],
        }),
      },
      integrator: { integrate },
      workspace,
    });

    const result = await service.run({
      runId: "failed-sibling-no-partial-commit",
      objective: "implement two modules",
      cwd: "/workspace",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("leaf-b");
    expect(integrate).not.toHaveBeenCalled();
    expect(workspace.prepareValidation).not.toHaveBeenCalled();
    expect(workspace.integrate).not.toHaveBeenCalled();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("applies completed writer patches even when textual Terra integration is disabled", async () => {
    const executionPlan = plan();
    const leaves = [leaf("leaf-a"), leaf("leaf-b")];
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const integrate = vi.fn(async () => Promise.reject(new Error("must not integrate")));
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner: {
        plan: async (request) => ({
          threadId: "sol-no-text-integration",
          request,
          limits,
          initialPlan: executionPlan,
          plan: executionPlan,
          patch: null,
          replanCount: 0,
          usage: [],
        }),
      },
      scheduler: {
        execute: async () => ({
          plan: executionPlan,
          patch: null,
          leaves,
          launchSkewMs: 1,
          peakConcurrency: 2,
          replanCount: 0,
          usage: leaves.flatMap((item) => item.usage),
        }),
      },
      integrator: { integrate },
      workspace,
    });

    const result = await service.run({
      runId: "no-text-integration",
      objective: "implement two modules",
      cwd: "/workspace",
      integrate: false,
    });

    expect(result.status).toBe("completed");
    expect(integrate).not.toHaveBeenCalled();
    expect(workspace.integrate).toHaveBeenCalledOnce();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("replans once from Terra integration issues and preserves successful leaves", async () => {
    const initialTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [initialTask],
      integration: {
        objective: "integrate",
        requiredOutputs: ["working result"],
        validation: [],
        finalReview: "never",
      },
    });
    const follow = {
      ...initialTask,
      id: "leaf-follow",
      objective: "supply missing output",
      ownedPaths: ["src/follow.ts"],
      dependsOn: [initialTask.id],
    };
    const patch = {
      protocolVersion: 1 as const,
      planId: executionPlan.planId,
      reason: "repair missing output",
      operations: [{ op: "add" as const, task: follow }],
    };
    const plannerSession: PlannerSession = {
      threadId: "sol-integration-replan",
      request: { objective: "complete output", cwd: "/workspace" },
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0,
      usage: [usage("sol", 0.03)],
    };
    const replanHandler = {
      replan: vi.fn(async () => {
        plannerSession.usage.push(usage("sol", 0.06));
        return patch;
      }),
      answer: async () => "answer",
    };
    const planner = {
      plan: vi.fn(async () => plannerSession),
      createReplanHandler: vi.fn(() => replanHandler),
      getSession: vi.fn(() => plannerSession),
    };
    const runLeaf = vi.fn(async ({ task: item }: { task: typeof initialTask }) => ({
      ...leaf(item.id),
      changedFiles: [...item.ownedPaths],
    }));
    const scheduler = new DeterministicScheduler({ runLeaf }, replanHandler);
    const integrate = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed",
        response: "missing output",
        threadId: "terra-integration-1",
        usage: [],
        planIssues: [
          {
            type: "contract_incomplete",
            taskIds: [initialTask.id],
            summary: "working result is missing",
          },
        ],
      })
      .mockResolvedValueOnce({
        status: "completed",
        response: "integrated after patch",
        threadId: "terra-integration-2",
        usage: [],
        planIssues: [],
      });
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner,
      scheduler,
      integrator: { integrate },
    });

    const result = await service.run({
      runId: "integration-replan",
      objective: "complete output",
      cwd: "/workspace",
    });

    expect(result.status).toBe("completed");
    expect(result.finalResponse).toBe("integrated after patch");
    expect(result.patch).toEqual(patch);
    expect(result.leaves.map((item) => item.taskId)).toEqual(["leaf-a", "leaf-follow"]);
    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(integrate).toHaveBeenCalledTimes(2);
    expect(replanHandler.replan).toHaveBeenCalledTimes(1);
    expect(result.metrics?.usageByStage).toMatchObject({
      planning: { estimatedCostUsd: 0.03 },
      replan: { estimatedCostUsd: 0.06 },
      finalReview: { usage: [], estimatedCostUsd: 0 },
    });
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.13);
  });

  it("reserves a PlanPatch before invoking the Sol continuation", async () => {
    const initialTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [initialTask],
      integration: { ...plan().integration, validation: [], finalReview: "never" },
    });
    const plannerSession: PlannerSession = {
      threadId: "sol-plan-patch-budget",
      request: { objective: "repair output", cwd: "/workspace" },
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0,
      usage: [usage("sol", 0.01)],
    };
    const replan = vi.fn(async () => null);
    const handler = { replan, answer: async () => "answer" };
    const planner = {
      plan: vi.fn(async () => plannerSession),
      createReplanHandler: vi.fn(() => handler),
      getSession: vi.fn(() => plannerSession),
    };
    const scheduler = new DeterministicScheduler(
      { runLeaf: async () => leaf(initialTask.id) },
      handler,
    );
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner,
      scheduler,
      integrator: {
        integrate: async () => ({
          status: "completed",
          response: "missing output",
          threadId: "terra-integration",
          usage: [],
          planIssues: [
            {
              type: "contract_incomplete",
              taskIds: [initialTask.id],
              summary: "required output is missing",
            },
          ],
        }),
      },
      costEstimator: {
        estimateUsd: ({ stage }) => (stage === "plan_patch" ? 0.05 : 0),
      },
    });

    const result = await service.run({
      runId: "plan-patch-precall-budget",
      objective: "repair output",
      cwd: "/workspace",
      limits: { maxCostUsd: 0.07 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Sol PlanPatch requires an estimated 0.05 USD");
    expect(result.metrics?.estimatedCostUsd).toBeCloseTo(0.03);
    expect(replan).not.toHaveBeenCalled();
  });

  it("reserves a planner answer before forwarding a leaf question to Sol", async () => {
    const initialTask = plan().tasks[0]!;
    const executionPlan = plan({ tasks: [initialTask] });
    const plannerSession: PlannerSession = {
      threadId: "sol-answer-budget",
      request: { objective: "answer leaf", cwd: "/workspace" },
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0,
      usage: [usage("sol", 0.01)],
    };
    const answer = vi.fn(async () => "answer");
    const handler = { replan: async () => null, answer };
    const planner = {
      plan: vi.fn(async () => plannerSession),
      createReplanHandler: vi.fn(() => handler),
      getSession: vi.fn(() => plannerSession),
    };
    const scheduler = new DeterministicScheduler(
      {
        runLeaf: async (_input, postMessage) => {
          await postMessage({
            type: "question",
            fromTaskId: initialTask.id,
            toTaskId: "planner",
            body: "Which interface should I use?",
          });
          return leaf(initialTask.id);
        },
      },
      handler,
    );
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner,
      scheduler,
      costEstimator: {
        estimateUsd: ({ stage }) => (stage === "planner_answer" ? 0.05 : 0),
      },
    });

    const result = await service.run({
      runId: "planner-answer-precall-budget",
      objective: "answer leaf",
      cwd: "/workspace",
      integrate: false,
      limits: { maxCostUsd: 0.04 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Sol planner answer requires an estimated 0.05 USD");
    expect(answer).not.toHaveBeenCalled();
  });

  it("replans once when aggregate validation fails before workspace integration", async () => {
    const initialTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [initialTask],
      integration: {
        objective: "integrate",
        requiredOutputs: ["working result"],
        validation: [{ command: "npm test" }],
        finalReview: "never",
      },
    });
    const repair = {
      ...initialTask,
      id: "leaf-repair",
      objective: "repair aggregate test failure",
      ownedPaths: ["src/repair.ts"],
      dependsOn: [initialTask.id],
    };
    const patch = {
      protocolVersion: 1 as const,
      planId: executionPlan.planId,
      reason: "repair aggregate validation",
      operations: [{ op: "add" as const, task: repair }],
    };
    const plannerSession: PlannerSession = {
      threadId: "sol-validator-replan",
      request: { objective: "repair validation", cwd: "/workspace" },
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0,
      usage: [],
    };
    const replanHandler = {
      replan: vi.fn(async (_plan, triggers) => {
        expect(triggers).toEqual([
          expect.objectContaining({
            type: "validator_failure",
            taskIds: [initialTask.id],
            summary: expect.stringContaining("npm test: exit code 1"),
          }),
        ]);
        return patch;
      }),
      answer: async () => "answer",
    };
    const planner = {
      plan: vi.fn(async () => plannerSession),
      createReplanHandler: vi.fn(() => replanHandler),
      getSession: vi.fn(() => plannerSession),
    };
    const runLeaf = vi.fn(async ({ task: item }: { task: typeof initialTask }) => ({
      ...leaf(item.id),
      changedFiles: [...item.ownedPaths],
    }));
    const scheduler = new DeterministicScheduler({ runLeaf }, replanHandler);
    const validate = vi
      .fn()
      .mockResolvedValueOnce([
        { command: "npm test", status: "failed" as const, summary: "exit code 1" },
      ])
      .mockResolvedValueOnce([{ command: "npm test", status: "passed" as const, summary: "ok" }]);
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      prepareValidation: vi.fn(async () => "/workspace/aggregate"),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "parallelizable" }) },
      planner,
      scheduler,
      integrator: {
        integrate: vi.fn(async (): Promise<AgentOutcome> => ({
          status: "completed",
          response: "integrated",
          threadId: "terra-validator-replan",
          usage: [],
          planIssues: [],
        })),
      },
      validator: { validate },
      workspace,
    });

    const result = await service.run({
      runId: "aggregate-validator-replan",
      objective: "repair validation",
      cwd: "/workspace",
    });

    expect(result.status).toBe("completed");
    expect(result.patch).toEqual(patch);
    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ baseCwd: "/workspace/aggregate" }),
    );
    expect(replanHandler.replan).toHaveBeenCalledOnce();
    expect(workspace.integrate).toHaveBeenCalledOnce();
  });

  it("fails the batch when deterministic integration validation fails", async () => {
    const executionPlan = plan({
      tasks: [plan().tasks[0]!],
      integration: {
        objective: "integrate",
        requiredOutputs: ["working result"],
        validation: [{ command: "npm test" }],
        finalReview: "never",
      },
    });
    const planner: Pick<PlannerService, "plan"> = {
      plan: async (request) => ({
        threadId: "sol-validation",
        request,
        limits,
        initialPlan: executionPlan,
        plan: executionPlan,
        patch: null,
        replanCount: 0,
        usage: [],
      }),
    };
    const completedLeaves = [leaf("leaf-a")];
    const integrate = vi.fn(async () => ({
      status: "completed" as const,
      response: "looks integrated",
      threadId: "terra-validation",
      usage: [],
    }));
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "planned" }) },
      planner,
      scheduler: {
        execute: async () => ({
          plan: executionPlan,
          patch: null,
          leaves: completedLeaves,
          launchSkewMs: null,
          peakConcurrency: 1,
          replanCount: 0,
          usage: completedLeaves.flatMap((item) => item.usage),
        }),
      },
      integrator: {
        integrate,
      },
      validator: {
        validate: async ({ specs }) =>
          specs.map((spec) => ({
            command: spec.command,
            status: "failed",
            summary: "exit code 1",
          })),
      },
    });

    const result = await service.run({
      runId: "integration-validator-failure",
      objective: "integrate with tests",
      cwd: "/workspace",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("integration validation failed");
    expect(integrate).not.toHaveBeenCalled();
  });

  it("submits in the background and keeps a matching runId idempotent", async () => {
    let finish: ((value: string) => void) | undefined;
    const directExecutor: DirectExecutor = {
      execute: vi.fn(
        async () =>
          new Promise<AgentOutcome>((resolve) => {
            finish = (value) => {
              resolve({
                status: "completed",
                response: value,
                threadId: "terra-direct",
                usage: [],
              });
            };
          }),
      ),
    };
    const service = createService({ directExecutor });
    const request = {
      runId: "background-1",
      objective: "background task",
      cwd: "/workspace",
    };

    const submitted = await service.submit(request);
    expect(submitted.status).toBe("pending");
    await vi.waitFor(() => expect(directExecutor.execute).toHaveBeenCalledTimes(1));
    const duplicate = await service.submit(request);
    expect(["pending", "running"]).toContain(duplicate.status);
    expect(directExecutor.execute).toHaveBeenCalledTimes(1);
    await expect(service.submit({ ...request, objective: "a different task" })).rejects.toThrow(
      "different request",
    );

    finish?.("background result");
    await vi.waitFor(() => expect(service.status("background-1").status).toBe("completed"));
    expect(service.status("background-1").finalResponse).toBe("background result");
  });

  it("waits for an externally active run through snapshot events", async () => {
    const store = createStore();
    let finish: ((value: string) => void) | undefined;
    const directExecutor: DirectExecutor = {
      execute: vi.fn(
        async () =>
          new Promise<AgentOutcome>((resolve) => {
            finish = (value) =>
              resolve({
                status: "completed",
                response: value,
                threadId: "terra-external",
                usage: [],
              });
          }),
      ),
    };
    const producer = createService({ store, directExecutor });
    const observer = createService({ store });
    await producer.submit({
      runId: "external-wait-1",
      objective: "foreground-equivalent detached task",
      cwd: "/workspace",
    });
    await vi.waitFor(() => expect(directExecutor.execute).toHaveBeenCalledOnce());

    const waiting = observer.waitForSettlement("external-wait-1");
    finish?.("external result");

    await expect(waiting).resolves.toMatchObject({
      runId: "external-wait-1",
      status: "completed",
      finalResponse: "external result",
    });
  });

  it.each([
    {
      status: "waiting_input" as const,
      needsAction: "provide credentials",
      error: "credentials are missing",
    },
    {
      status: "indeterminate" as const,
      needsAction: undefined,
      error: "remote state is uncertain",
    },
  ])("settles an event-driven wait on $status", async ({ status, needsAction, error }) => {
    const store = createStore();
    let finish: ((outcome: AgentOutcome) => void) | undefined;
    const producer = createService({
      store,
      directExecutor: {
        execute: vi.fn(
          async () =>
            new Promise<AgentOutcome>((resolve) => {
              finish = resolve;
            }),
        ),
      },
    });
    const observer = createService({ store });
    await producer.submit({
      runId: `external-${status}`,
      objective: "finish outside the observing MCP process",
      cwd: "/workspace",
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    const waiting = observer.waitForSettlement(`external-${status}`);
    finish?.({
      status,
      response: null,
      threadId: null,
      usage: [],
      ...(needsAction === undefined ? {} : { needsAction }),
      error,
    });

    await expect(waiting).resolves.toMatchObject({ status, error });
  });

  it("cancels a local run through its shared AbortSignal", async () => {
    const directExecutor: DirectExecutor = {
      execute: vi.fn(
        async ({ signal }) =>
          new Promise<AgentOutcome>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const service = createService({ directExecutor });
    const running = service.run({
      runId: "cancel-1",
      objective: "long task",
      cwd: "/workspace",
    });
    await vi.waitFor(() => expect(directExecutor.execute).toHaveBeenCalledTimes(1));

    const cancelled = await service.cancel("cancel-1");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("run cancelled");
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
  });

  it("routes cancellation to an active service through an atomic control request", async () => {
    const store = createStore();
    const directExecutor: DirectExecutor = {
      execute: vi.fn(
        async ({ signal }) =>
          new Promise<AgentOutcome>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const owner = createService({ store, directExecutor, controlPollMs: 5 });
    const otherProcess = createService({ store, directExecutor, controlPollMs: 5 });
    const running = owner.run({
      runId: "controlled-cancel",
      objective: "long detached task",
      cwd: "/workspace",
    });
    await vi.waitFor(() => expect(directExecutor.execute).toHaveBeenCalledOnce());

    const cancelled = await otherProcess.cancel("controlled-cancel");

    expect(cancelled).toMatchObject({ status: "cancelled", error: "run cancelled" });
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(existsSync(join(store.jobDirectory("controlled-cancel"), "cancel-request.json"))).toBe(
      false,
    );
  });

  it("preserves the workspace when an active writer cancellation is indeterminate", async () => {
    const executionPlan = plan({ tasks: [plan().tasks[0]!] });
    const planner: Pick<PlannerService, "plan"> = {
      plan: vi.fn(async (request): Promise<PlannerSession> => ({
        threadId: "planner-writer",
        request,
        limits,
        initialPlan: executionPlan,
        plan: executionPlan,
        patch: null,
        replanCount: 0,
        usage: [],
      })),
    };
    const uncertainWriter: LeafResult = {
      ...leaf("leaf-a"),
      status: "indeterminate",
      summary: "writer cancellation is unconfirmed",
      failureKind: "unknown",
    };
    const scheduler: Pick<DeterministicScheduler, "execute"> = {
      execute: vi.fn(
        async (_runId, _plan, _limits, signal): Promise<ScheduleResult> =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  plan: executionPlan,
                  patch: null,
                  leaves: [uncertainWriter],
                  launchSkewMs: null,
                  peakConcurrency: 1,
                  replanCount: 0,
                  usage: [],
                }),
              { once: true },
            );
          }),
      ),
    };
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const service = createService({
      admission: { decide: () => ({ route: "fanout", reason: "writer task" }) },
      planner,
      scheduler,
      workspace,
    });
    const running = service.run({
      runId: "uncertain-active-writer",
      objective: "edit one module",
      cwd: "/workspace",
    });
    await vi.waitFor(() => expect(scheduler.execute).toHaveBeenCalledOnce());

    const cancelled = await service.cancel("uncertain-active-writer");

    expect(cancelled.status).toBe("indeterminate");
    expect(cancelled.error).toContain("workspace and recovery state were preserved");
    expect(workspace.cleanup).not.toHaveBeenCalled();
    await expect(running).resolves.toMatchObject({ status: "indeterminate" });
  });

  it("uses nonterminal remoteTurns as cancellation authority and preserves an uncertain writer", async () => {
    const store = createStore();
    const seed = createService({
      store,
      directExecutor: {
        execute: async () => ({
          status: "waiting_input",
          response: null,
          threadId: null,
          usage: [],
          needsAction: "park",
        }),
      },
    });
    await seed.run({ runId: "remote-writer", objective: "edit module", cwd: "/workspace" });
    const snapshot = store.load("remote-writer") as JobSnapshot;
    const writer: RemoteTurnRef = {
      role: "leaf",
      taskId: "leaf-a",
      threadId: "writer-thread",
      turnId: "writer-turn",
      access: "workspaceWrite",
      state: "running",
      updatedAt: "2026-08-28T00:00:01.000Z",
    };
    snapshot.result.status = "running";
    snapshot.result.plan = plan({ tasks: [plan().tasks[0]!] });
    snapshot.remoteTurns = [writer];
    snapshot.coordinatorThreadId = null;
    snapshot.plannerThreadId = null;
    snapshot.integratorThreadId = null;
    store.save(snapshot);
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async () => {
        throw new Error("not used");
      }),
      cancel: vi.fn(async () => ({
        remoteTurns: [writer],
        allTerminal: false,
        reasons: ["writer remained running"],
      })),
    };
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const service = createService({ store, recovery, workspace });

    const cancelled = await service.cancel("remote-writer");

    expect(cancelled.status).toBe("indeterminate");
    expect(cancelled.error).toContain("writer remained running");
    expect(recovery.cancel).toHaveBeenCalledWith({
      snapshot: expect.objectContaining({ remoteTurns: [writer] }),
    });
    expect(workspace.cleanup).not.toHaveBeenCalled();
    expect(store.load("remote-writer")?.remoteTurns).toEqual([writer]);
  });

  it("cleans the workspace only after every persisted remote turn is confirmed terminal", async () => {
    const store = createStore();
    const seed = createService({
      store,
      directExecutor: {
        execute: async () => ({
          status: "waiting_input",
          response: null,
          threadId: null,
          usage: [],
          needsAction: "park",
        }),
      },
    });
    await seed.run({ runId: "confirmed-writer", objective: "edit module", cwd: "/workspace" });
    const snapshot = store.load("confirmed-writer") as JobSnapshot;
    const writer: RemoteTurnRef = {
      role: "leaf",
      taskId: "leaf-a",
      threadId: "writer-thread",
      turnId: "writer-turn",
      access: "workspaceWrite",
      state: "running",
      updatedAt: "2026-08-28T00:00:01.000Z",
    };
    const terminalWriter: RemoteTurnRef = {
      ...writer,
      state: "terminal",
      updatedAt: "2099-01-01T00:00:00.000Z",
    };
    snapshot.result.status = "running";
    snapshot.result.plan = plan({ tasks: [plan().tasks[0]!] });
    snapshot.remoteTurns = [writer];
    store.save(snapshot);
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async () => {
        throw new Error("not used");
      }),
      cancel: vi.fn(async () => ({
        remoteTurns: [terminalWriter],
        allTerminal: true,
        reasons: [],
      })),
    };
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const service = createService({ store, recovery, workspace });

    const cancelled = await service.cancel("confirmed-writer");

    expect(cancelled.status).toBe("cancelled");
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    expect(store.load("confirmed-writer")?.remoteTurns).toEqual([terminalWriter]);
  });

  it("continues a waiting direct task on its persisted Terra thread", async () => {
    const store = createStore();
    const execute = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "waiting_input",
      response: null,
      threadId: "terra-direct-waiting",
      usage: [usage("terra", 0.01)],
      needsAction: "provide credentials",
      error: "credentials are missing",
      waitingTurn: {
        threadId: "terra-direct-waiting",
        previousTurnId: "direct-turn-waiting",
        cwd: "/workspace",
        capabilities: [],
      },
    }));
    const resumeDirect = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "continued direct result",
      threadId: "terra-direct-waiting",
      usage: [usage("terra", 0.02)],
    }));
    const directExecutor: DirectExecutor = { execute, resumeDirect };
    const initialService = createService({ store, directExecutor });
    const waiting = await initialService.run({
      runId: "resume-direct-continuation",
      objective: "use the protected source",
      cwd: "/workspace",
    });
    expect(waiting.status).toBe("waiting_input");
    const persisted = store.load("resume-direct-continuation")!;
    expect(persisted.waitingInputCheckpoint).toMatchObject({
      kind: "direct",
      turn: {
        threadId: "terra-direct-waiting",
        previousTurnId: "direct-turn-waiting",
      },
    });

    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot }) => ({
        result: {
          ...structuredClone(snapshot.result),
          status: "running",
          finalResponse: null,
        },
        continuation: {
          initialLeaves: [],
          workspaceWritersMayHaveRun: false,
          waitingInput: structuredClone(snapshot.waitingInputCheckpoint!),
        },
      })),
    };
    const service = createService({ store, directExecutor, recovery });

    const result = await service.resume("resume-direct-continuation", "credentials configured");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "continued direct result",
      metrics: {
        usageByStage: { direct: { estimatedCostUsd: 0.03 } },
        estimatedCostUsd: 0.03,
      },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(resumeDirect).toHaveBeenCalledOnce();
    expect(resumeDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: expect.objectContaining({ threadId: "terra-direct-waiting" }),
        userInput: "credentials configured",
      }),
    );
    expect(store.load("resume-direct-continuation")?.waitingInputCheckpoint).toBeUndefined();
  });

  it("resumes only a permission-blocked leaf and preserves completed work", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [{ ...plan().tasks[0]!, access: "readOnly", ownedPaths: [] }],
      integration: { ...plan().integration, validation: [], finalReview: "never" },
    });
    const blocked = {
      ...leaf("leaf-a"),
      status: "blocked" as const,
      summary: "permission required",
      confidence: 0,
      changedFiles: [],
      threadId: "leaf-thread-waiting",
      turnId: "leaf-turn-waiting",
      error: "grant repository access",
      failureKind: "permission" as const,
    };
    const snapshot = resumableFanoutSnapshot("resume-permission-leaf", executionPlan, [blocked]);
    snapshot.result.status = "waiting_input";
    snapshot.result.needsAction = "grant repository access";
    snapshot.remoteTurns = [
      {
        role: "leaf",
        taskId: "leaf-a",
        attempt: 1,
        threadId: "leaf-thread-waiting",
        turnId: "leaf-turn-waiting",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:01:00.000Z",
      },
    ];
    snapshot.waitingInputCheckpoint = {
      kind: "leaves",
      planId: executionPlan.planId,
      leaves: [
        {
          taskId: "leaf-a",
          threadId: "leaf-thread-waiting",
          previousTurnId: "leaf-turn-waiting",
          attempt: 1,
          needsAction: "grant repository access",
        },
      ],
      updatedAt: "2026-08-28T00:01:01.000Z",
    };
    store.save(snapshot);
    const restoreSession = vi.fn((input: PlannerSession): PlannerSession => structuredClone(input));
    const runLeaf = vi.fn(async ({ continuation }: Parameters<LeafExecutor["runLeaf"]>[0]) => {
      expect(continuation).toEqual({
        threadId: "leaf-thread-waiting",
        previousTurnId: "leaf-turn-waiting",
        userInput: "access granted",
      });
      return { ...leaf("leaf-a"), changedFiles: [] };
    });
    const scheduler = new DeterministicScheduler(
      { runLeaf },
      {
        replan: async () => null,
        answer: async () => "answer",
      },
    );
    const integrate = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "integrated after leaf continuation",
      threadId: "terra-integration",
      usage: [usage("terra", 0.03)],
    }));
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "running",
          finalResponse: null,
        },
        continuation: {
          initialLeaves: [structuredClone(blocked)],
          workspaceWritersMayHaveRun: false,
          waitingInput: structuredClone(persisted.waitingInputCheckpoint!),
        },
      })),
    };
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession,
      },
      scheduler,
      integrator: { integrate },
      recovery,
    });

    const result = await service.resume("resume-permission-leaf", "access granted");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "integrated after leaf continuation",
      leaves: [{ taskId: "leaf-a", status: "completed" }],
      metrics: {
        usageByStage: { leaves: { estimatedCostUsd: 0.04 } },
      },
    });
    expect(runLeaf).toHaveBeenCalledOnce();
    expect(integrate).toHaveBeenCalledOnce();
    expect(store.load("resume-permission-leaf")?.waitingInputCheckpoint).toBeUndefined();
  });

  it("retains and resumes the same writer workspace for a permission-blocked leaf", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [plan().tasks[0]!],
      integration: { ...plan().integration, validation: [], finalReview: "never" },
    });
    const plannerSession: PlannerSession = {
      threadId: "sol-writer-waiting",
      request: { objective: "continue protected writer", cwd: "/workspace" },
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0,
      usage: [],
    };
    const blocked: LeafResult = {
      ...leaf("leaf-a"),
      status: "blocked",
      summary: "repository permission required",
      confidence: 0,
      changedFiles: [],
      threadId: "writer-thread-waiting",
      turnId: "writer-turn-waiting",
      error: "grant repository permission",
      failureKind: "permission",
    };
    const initialWorkspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const initialScheduler = new DeterministicScheduler(
      {
        runLeaf: async () => {
          store.recordRemoteTurn("resume-writer-permission", {
            role: "leaf",
            taskId: "leaf-a",
            attempt: 1,
            threadId: blocked.threadId!,
            turnId: blocked.turnId,
            access: "workspaceWrite",
            state: "terminal",
            updatedAt: blocked.completedAt,
          });
          return structuredClone(blocked);
        },
      },
      { replan: async () => null, answer: async () => "answer" },
    );
    const initialService = createService({
      store,
      admission: { decide: () => ({ route: "planned_single", reason: "writer" }) },
      planner: { plan: async () => structuredClone(plannerSession) },
      scheduler: initialScheduler,
      workspace: initialWorkspace,
    });

    const waiting = await initialService.run({
      runId: "resume-writer-permission",
      objective: "continue protected writer",
      cwd: "/workspace",
    });

    expect(waiting.status).toBe("waiting_input");
    expect(initialWorkspace.prepare).toHaveBeenCalledOnce();
    expect(initialWorkspace.integrate).not.toHaveBeenCalled();
    expect(initialWorkspace.cleanup).not.toHaveBeenCalled();
    const persisted = store.load("resume-writer-permission")!;
    expect(persisted.workspaceCommitState).toBe("pending");
    expect(persisted.waitingInputCheckpoint).toMatchObject({
      kind: "leaves",
      leaves: [{ taskId: "leaf-a", threadId: "writer-thread-waiting" }],
    });

    const order: string[] = [];
    const resume = vi.fn(async () => {
      order.push("workspace-resume");
    });
    const prepareValidation = vi.fn(async () => {
      order.push("workspace-validate");
      return "/workspace/.agent-trio/recovered-candidate";
    });
    const integrateWorkspace = vi.fn(async () => {
      order.push("workspace-commit");
    });
    const cleanup = vi.fn(async () => {
      order.push("workspace-cleanup");
    });
    const runLeaf = vi.fn(async ({ continuation }: Parameters<LeafExecutor["runLeaf"]>[0]) => {
      order.push("leaf-continue");
      expect(continuation).toEqual({
        threadId: "writer-thread-waiting",
        previousTurnId: "writer-turn-waiting",
        userInput: "permission granted",
      });
      return {
        ...leaf("leaf-a"),
        threadId: "writer-thread-waiting",
        turnId: "writer-turn-continued",
        changedFiles: ["src/a.ts"],
      };
    });
    const scheduler = new DeterministicScheduler(
      { runLeaf },
      { replan: async () => null, answer: async () => "answer" },
    );
    const integrate = vi.fn(async ({ request }): Promise<AgentOutcome> => {
      order.push("terra-integrate");
      expect(request.cwd).toBe("/workspace/.agent-trio/recovered-candidate");
      return {
        status: "completed",
        response: "writer continuation complete",
        threadId: "terra-writer-integration",
        usage: [],
      };
    });
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot }) => ({
        result: { ...structuredClone(snapshot.result), status: "running", finalResponse: null },
        continuation: {
          initialLeaves: [structuredClone(blocked)],
          workspaceWritersMayHaveRun: true,
          waitingInput: structuredClone(snapshot.waitingInputCheckpoint!),
        },
      })),
    };
    const resumedService = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession: (state) => structuredClone(state),
      },
      scheduler,
      integrator: { integrate },
      recovery,
      workspace: {
        prepare: vi.fn(async () => Promise.reject(new Error("must not prepare a new worktree"))),
        resume,
        prepareValidation,
        integrate: integrateWorkspace,
        cleanup,
      },
    });

    const result = await resumedService.resume("resume-writer-permission", "permission granted");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "writer continuation complete",
      leaves: [{ taskId: "leaf-a", status: "completed" }],
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(runLeaf).toHaveBeenCalledOnce();
    expect(integrateWorkspace).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "workspace-resume",
      "leaf-continue",
      "workspace-validate",
      "terra-integrate",
      "workspace-commit",
      "workspace-cleanup",
    ]);
    expect(store.load("resume-writer-permission")).toMatchObject({
      workspaceCommitState: "applied",
      result: { status: "completed" },
    });
    expect(store.load("resume-writer-permission")?.waitingInputCheckpoint).toBeUndefined();
  });

  it("continues waiting Terra integration without rerunning leaves or ordinary integration", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [{ ...plan().tasks[0]!, access: "readOnly", ownedPaths: [] }],
      integration: { ...plan().integration, validation: [], finalReview: "never" },
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("resume-waiting-integration", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.result.status = "waiting_input";
    snapshot.result.needsAction = "provide the missing source";
    snapshot.usageByStage!.integration = {
      usage: [usage("terra", 0.03)],
      estimatedCostUsd: 0.03,
    };
    snapshot.waitingInputCheckpoint = {
      kind: "integration",
      planId: executionPlan.planId,
      turn: {
        threadId: "terra-integration-waiting",
        previousTurnId: "integration-turn-waiting",
        cwd: "/workspace",
        needsAction: "provide the missing source",
        capabilities: [],
        updatedAt: "2026-08-28T00:01:01.000Z",
      },
      leafIdentities: [
        {
          taskId: recoveredLeaf.taskId,
          threadId: recoveredLeaf.threadId,
          turnId: recoveredLeaf.turnId,
          completedAt: recoveredLeaf.completedAt,
        },
      ],
    };
    store.save(snapshot);
    const restoreSession = vi.fn((input: PlannerSession): PlannerSession => structuredClone(input));
    const runLeaf = vi.fn(async () => Promise.reject(new Error("leaf must not rerun")));
    const scheduler = new DeterministicScheduler(
      { runLeaf },
      {
        replan: async () => null,
        answer: async () => "answer",
      },
    );
    const integrate = vi.fn(async () => Promise.reject(new Error("integrate must not rerun")));
    const resumeIntegration = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "continued integration result",
      threadId: "terra-integration-waiting",
      usage: [usage("terra", 0.04)],
    }));
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "running",
          finalResponse: null,
        },
        continuation: {
          initialLeaves: [structuredClone(recoveredLeaf)],
          workspaceWritersMayHaveRun: false,
          waitingInput: structuredClone(persisted.waitingInputCheckpoint!),
        },
      })),
    };
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession,
      },
      scheduler,
      integrator: { integrate, resumeIntegration },
      recovery,
    });

    const result = await service.resume("resume-waiting-integration", "source is now available");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "continued integration result",
      metrics: {
        usageByStage: { integration: { estimatedCostUsd: 0.07 } },
        estimatedCostUsd: 0.12,
      },
    });
    expect(runLeaf).not.toHaveBeenCalled();
    expect(integrate).not.toHaveBeenCalled();
    expect(resumeIntegration).toHaveBeenCalledOnce();
    expect(resumeIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: expect.objectContaining({
          threadId: "terra-integration-waiting",
        }),
        userInput: "source is now available",
      }),
    );
    expect(store.load("resume-waiting-integration")?.waitingInputCheckpoint).toBeUndefined();
  });

  it("retains a writer workspace while Terra integration waits and commits after continuation", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [plan().tasks[0]!],
      integration: { ...plan().integration, validation: [], finalReview: "never" },
    });
    const completedWriter = { ...leaf("leaf-a"), changedFiles: ["src/a.ts"] };
    const plannerSession: PlannerSession = {
      threadId: "sol-integration-waiting-writer",
      request: { objective: "continue Terra writer integration", cwd: "/workspace" },
      limits,
      initialPlan: executionPlan,
      plan: executionPlan,
      patch: null,
      replanCount: 0,
      usage: [],
    };
    const initialWorkspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      prepareValidation: vi.fn(async () => "/workspace/.agent-trio/initial-candidate"),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const initialScheduler = new DeterministicScheduler(
      { runLeaf: async () => structuredClone(completedWriter) },
      { replan: async () => null, answer: async () => "answer" },
    );
    const integrate = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "waiting_input",
      response: null,
      threadId: "terra-writer-waiting",
      usage: [usage("terra", 0.01)],
      needsAction: "provide protected source",
      error: "protected source is missing",
      waitingTurn: {
        threadId: "terra-writer-waiting",
        previousTurnId: "terra-writer-turn-waiting",
        cwd: "/workspace/.agent-trio/initial-candidate",
        capabilities: [],
      },
    }));
    const initialService = createService({
      store,
      admission: { decide: () => ({ route: "planned_single", reason: "writer" }) },
      planner: { plan: async () => structuredClone(plannerSession) },
      scheduler: initialScheduler,
      integrator: { integrate },
      workspace: initialWorkspace,
    });

    const waiting = await initialService.run({
      runId: "resume-writer-integration",
      objective: "continue Terra writer integration",
      cwd: "/workspace",
    });

    expect(waiting.status).toBe("waiting_input");
    expect(initialWorkspace.integrate).not.toHaveBeenCalled();
    expect(initialWorkspace.cleanup).not.toHaveBeenCalled();
    const persisted = store.load("resume-writer-integration")!;
    expect(persisted.waitingInputCheckpoint).toMatchObject({
      kind: "integration",
      turn: { threadId: "terra-writer-waiting" },
    });

    const order: string[] = [];
    const resumeIntegration = vi.fn(async ({ request }): Promise<AgentOutcome> => {
      order.push("terra-continue");
      expect(request.cwd).toBe("/workspace/.agent-trio/resumed-candidate");
      return {
        status: "completed",
        response: "Terra continuation complete",
        threadId: "terra-writer-waiting",
        usage: [usage("terra", 0.02)],
      };
    });
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => Promise.reject(new Error("must not prepare a new worktree"))),
      resume: vi.fn(async () => {
        order.push("workspace-resume");
      }),
      prepareValidation: vi.fn(async () => {
        order.push("workspace-validate");
        return "/workspace/.agent-trio/resumed-candidate";
      }),
      integrate: vi.fn(async () => {
        order.push("workspace-commit");
      }),
      cleanup: vi.fn(async () => {
        order.push("workspace-cleanup");
      }),
    };
    const runLeaf = vi.fn(async () => Promise.reject(new Error("leaf must not rerun")));
    const scheduler = new DeterministicScheduler(
      { runLeaf },
      { replan: async () => null, answer: async () => "answer" },
    );
    const ordinaryIntegrate = vi.fn(async () =>
      Promise.reject(new Error("ordinary integration must not rerun")),
    );
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot }) => ({
        result: { ...structuredClone(snapshot.result), status: "running", finalResponse: null },
        continuation: {
          initialLeaves: [structuredClone(completedWriter)],
          workspaceWritersMayHaveRun: true,
          waitingInput: structuredClone(snapshot.waitingInputCheckpoint!),
        },
      })),
    };
    const resumedService = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession: (state) => structuredClone(state),
      },
      scheduler,
      integrator: { integrate: ordinaryIntegrate, resumeIntegration },
      recovery,
      workspace,
    });

    const result = await resumedService.resume(
      "resume-writer-integration",
      "protected source supplied",
    );

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "Terra continuation complete",
    });
    expect(runLeaf).not.toHaveBeenCalled();
    expect(ordinaryIntegrate).not.toHaveBeenCalled();
    expect(resumeIntegration).toHaveBeenCalledOnce();
    expect(workspace.integrate).toHaveBeenCalledOnce();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "workspace-resume",
      "workspace-validate",
      "terra-continue",
      "workspace-commit",
      "workspace-cleanup",
    ]);
  });

  it("resumes unstarted DAG nodes from the persisted planner thread and recovered leaves", async () => {
    const store = createStore();
    const basePlan = plan();
    const executionPlan = plan({
      tasks: [
        {
          ...basePlan.tasks[0]!,
          access: "readOnly",
          ownedPaths: [],
          validation: [{ command: "validate leaf-a" }],
        },
        {
          ...basePlan.tasks[1]!,
          access: "readOnly",
          ownedPaths: [],
          dependsOn: ["leaf-a"],
          validation: [{ command: "validate leaf-b" }],
        },
      ],
      integration: {
        objective: "integrate recovered work",
        requiredOutputs: ["working result"],
        validation: [{ command: "validate aggregate" }],
        finalReview: "never",
      },
    });
    const recoveredLeaf = {
      ...leaf("leaf-a"),
      changedFiles: [],
      validation: [{ command: "validate leaf-a", status: "passed" as const, summary: "ok" }],
    };
    const snapshot = resumableFanoutSnapshot("resume-fanout", executionPlan, [recoveredLeaf]);
    store.save(snapshot);

    const planNewWork = vi.fn(async () => {
      throw new Error("planning must not be replayed");
    });
    let restoredSession: PlannerSession | null = null;
    const restoreSession = vi.fn((input: PlannerSession): PlannerSession => {
      restoredSession = structuredClone(input);
      return structuredClone(input);
    });
    const replanHandler = {
      replan: vi.fn(async () => null),
      answer: async () => "answer",
    };
    const planner = {
      plan: planNewWork,
      restoreSession,
      createReplanHandler: vi.fn(() => replanHandler),
      getSession: vi.fn(() => restoredSession),
    };
    const leafValidator = vi.fn(async (_taskId: string) => undefined);
    const runLeaf = vi.fn(
      async ({
        task: item,
        dependencies,
      }: {
        task: ExecutionPlan["tasks"][number];
        dependencies: LeafResult[];
      }) => {
        expect(item.id).toBe("leaf-b");
        expect(dependencies).toEqual([expect.objectContaining({ taskId: "leaf-a" })]);
        await leafValidator(item.id);
        return {
          ...leaf(item.id),
          changedFiles: [],
          validation: [{ command: "validate leaf-b", status: "passed" as const, summary: "ok" }],
        };
      },
    );
    const scheduler = new DeterministicScheduler({ runLeaf }, replanHandler);
    const integrate = vi.fn(async (): Promise<AgentOutcome> => ({
      status: "completed",
      response: "integrated after crash",
      threadId: "terra-integration-resume",
      usage: [usage("terra", 0.03)],
      planIssues: [],
    }));
    const validate = vi.fn(async () => [
      { command: "validate aggregate", status: "passed" as const, summary: "ok" },
    ]);
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      prepareValidation: vi.fn(async () => "/workspace/recovered-validation"),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "running",
          leaves: [structuredClone(recoveredLeaf)],
          finalResponse: null,
        },
        plannerThreadId: "sol-planner-resume",
        continuation: {
          initialLeaves: [structuredClone(recoveredLeaf)],
          workspaceWritersMayHaveRun: false,
        },
      })),
    };
    const service = createService({
      store,
      planner,
      scheduler,
      integrator: { integrate },
      recovery,
      validator: { validate },
      workspace,
    });

    const result = await service.resume("resume-fanout");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "integrated after crash",
      leaves: [
        { taskId: "leaf-a", validation: recoveredLeaf.validation },
        { taskId: "leaf-b", status: "completed" },
      ],
    });
    expect(planNewWork).not.toHaveBeenCalled();
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "resume-fanout",
        threadId: "sol-planner-resume",
      }),
    );
    expect(runLeaf).toHaveBeenCalledOnce();
    expect(leafValidator).toHaveBeenCalledExactlyOnceWith("leaf-b");
    expect(integrate).toHaveBeenCalledOnce();
    expect(workspace.prepareValidation).toHaveBeenCalledWith(
      "resume-fanout",
      expect.arrayContaining([
        expect.objectContaining({ taskId: "leaf-a" }),
        expect.objectContaining({ taskId: "leaf-b" }),
      ]),
    );
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ baseCwd: "/workspace/recovered-validation" }),
    );
    expect(workspace.integrate).toHaveBeenCalledOnce();
    expect(result.metrics).toMatchObject({
      startedAt: "2026-08-28T00:00:00.000Z",
      planningMs: 17,
      usageByStage: {
        admission: { estimatedCostUsd: 0.01 },
        planning: { estimatedCostUsd: 0.02 },
        leaves: { estimatedCostUsd: 0.04 },
        integration: { estimatedCostUsd: 0.03 },
      },
    });
  });

  it("resumes only a missing Sol final review from the durable integration checkpoint", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [
        {
          ...plan().tasks[0]!,
          access: "readOnly",
          ownedPaths: [],
        },
      ],
      integration: {
        objective: "integrate recovered work",
        requiredOutputs: ["working result"],
        validation: [{ command: "validate aggregate" }],
        finalReview: "always",
      },
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const validation = [
      { command: "validate aggregate", status: "passed" as const, summary: "ok" },
    ];
    const snapshot = resumableFanoutSnapshot("resume-missing-final-review", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.integratorThreadId = "terra-integration-resume";
    snapshot.usageByStage!.integration = {
      usage: [usage("terra", 0.03)],
      estimatedCostUsd: 0.03,
    };
    snapshot.integrationCheckpoint = {
      planId: executionPlan.planId,
      leafIdentities: [
        {
          taskId: recoveredLeaf.taskId,
          threadId: recoveredLeaf.threadId,
          turnId: recoveredLeaf.turnId,
          completedAt: recoveredLeaf.completedAt,
        },
      ],
      response: "Terra response before the crash",
      validation,
      integratorThreadId: "terra-integration-resume",
      launchSkewMs: 9,
      peakConcurrency: 1,
      replanCount: 0,
      updatedAt: "2026-08-28T00:01:01.000Z",
    };
    store.save(snapshot);

    const restoreSession = vi.fn((input: PlannerSession): PlannerSession => structuredClone(input));
    const scheduler = { execute: vi.fn(async () => Promise.reject(new Error("not used"))) };
    const integrate = vi.fn(async () => Promise.reject(new Error("not used")));
    const review = vi.fn(async () => ({
      approved: true,
      issues: [],
      threadId: "sol-planner-resume",
      usage: [usage("sol", 0.04)],
    }));
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "running",
          leaves: [structuredClone(recoveredLeaf)],
          finalResponse: null,
        },
        plannerThreadId: "sol-planner-resume",
        integratorThreadId: "terra-integration-resume",
        continuation: {
          initialLeaves: [structuredClone(recoveredLeaf)],
          workspaceWritersMayHaveRun: false,
          finalReview: {
            integratedResponse: "Terra response before the crash",
            integrationValidation: structuredClone(validation),
            integratorThreadId: "terra-integration-resume",
            launchSkewMs: 9,
            peakConcurrency: 1,
            replanCount: 0,
          },
        },
      })),
    };
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession,
      },
      scheduler,
      integrator: { integrate },
      finalReviewer: { review },
      recovery,
    });

    const result = await service.resume("resume-missing-final-review");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "Terra response before the crash",
      metrics: {
        launchSkewMs: 9,
        peakConcurrency: 1,
        usageByStage: {
          integration: { estimatedCostUsd: 0.03 },
          finalReview: { estimatedCostUsd: 0.04 },
        },
        estimatedCostUsd: 0.12,
      },
    });
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        integratedResponse: "Terra response before the crash",
        integrationValidation: validation,
        leaves: [expect.objectContaining({ taskId: "leaf-a" })],
        plannerThreadId: "sol-planner-resume",
      }),
    );
    expect(scheduler.execute).not.toHaveBeenCalled();
    expect(integrate).not.toHaveBeenCalled();
    expect(store.load("resume-missing-final-review")?.integrationCheckpoint).toBeUndefined();
  });

  it.each([
    {
      name: "uses a replacement response when Sol rejects Terra",
      review: {
        approved: false,
        issues: ["material factual error"],
        replacementResponse: "corrected Sol response",
      },
      expectedStatus: "completed" as const,
      expectedResponse: "corrected Sol response",
      expectedError: undefined,
    },
    {
      name: "fails when Sol rejects Terra without a safe replacement",
      review: {
        approved: false,
        issues: ["material factual error"],
      },
      expectedStatus: "failed" as const,
      expectedResponse: null,
      expectedError: "material factual error",
    },
  ])("$name during final-review continuation", async (testCase) => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [{ ...plan().tasks[0]!, access: "readOnly", ownedPaths: [] }],
      integration: { ...plan().integration, validation: [], finalReview: "always" },
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot(
      `resume-review-${testCase.expectedStatus}`,
      executionPlan,
      [recoveredLeaf],
    );
    snapshot.integrationCheckpoint = {
      planId: executionPlan.planId,
      leafIdentities: [
        {
          taskId: recoveredLeaf.taskId,
          threadId: recoveredLeaf.threadId,
          turnId: recoveredLeaf.turnId,
          completedAt: recoveredLeaf.completedAt,
        },
      ],
      response: "incorrect Terra response",
      validation: [],
      integratorThreadId: "terra-integration-resume",
      launchSkewMs: null,
      peakConcurrency: 1,
      replanCount: 0,
      updatedAt: "2026-08-28T00:01:01.000Z",
    };
    store.save(snapshot);
    const review = vi.fn(async () => ({
      ...testCase.review,
      threadId: "sol-planner-resume",
      usage: [usage("sol", 0.04)],
    }));
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession: (input) => structuredClone(input),
      },
      scheduler: { execute: vi.fn(async () => Promise.reject(new Error("not used"))) },
      integrator: { integrate: vi.fn(async () => Promise.reject(new Error("not used"))) },
      finalReviewer: { review },
      recovery: {
        reattach: vi.fn(async ({ snapshot: persisted }) => ({
          result: {
            ...structuredClone(persisted.result),
            status: "running",
            leaves: [structuredClone(recoveredLeaf)],
            finalResponse: null,
          },
          continuation: {
            initialLeaves: [structuredClone(recoveredLeaf)],
            workspaceWritersMayHaveRun: false,
            finalReview: {
              integratedResponse: "incorrect Terra response",
              integrationValidation: [],
              integratorThreadId: "terra-integration-resume",
              launchSkewMs: null,
              peakConcurrency: 1,
              replanCount: 0,
            },
          },
        })),
      },
    });

    const result = await service.resume(`resume-review-${testCase.expectedStatus}`);

    expect(result.status).toBe(testCase.expectedStatus);
    expect(result.finalResponse).toBe(testCase.expectedResponse);
    if (testCase.expectedError === undefined) {
      expect(result.error).toBeUndefined();
    } else {
      expect(result.error).toContain(testCase.expectedError);
    }
    expect(review).toHaveBeenCalledOnce();
  });

  it("commits a recovered writer workspace only after the resumed final review approves", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [plan().tasks[0]!],
      integration: { ...plan().integration, validation: [], finalReview: "always" },
    });
    const recoveredLeaf = leaf("leaf-a");
    const snapshot = resumableFanoutSnapshot("resume-writer-final-review", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.workspaceCommitState = "pending";
    snapshot.integrationCheckpoint = {
      planId: executionPlan.planId,
      leafIdentities: [
        {
          taskId: recoveredLeaf.taskId,
          threadId: recoveredLeaf.threadId,
          turnId: recoveredLeaf.turnId,
          completedAt: recoveredLeaf.completedAt,
        },
      ],
      response: "Terra response after writer validation",
      validation: [],
      integratorThreadId: "terra-integration-resume",
      launchSkewMs: null,
      peakConcurrency: 1,
      replanCount: 0,
      updatedAt: "2026-08-28T00:01:01.000Z",
    };
    store.save(snapshot);
    const integrateWorkspace = vi.fn(async () => undefined);
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      prepareValidation: vi.fn(async () => "/workspace/.agent-trio/candidate"),
      integrate: integrateWorkspace,
      cleanup: vi.fn(async () => undefined),
    };
    const review = vi.fn(async () => ({
      approved: true,
      issues: [],
      threadId: "sol-planner-resume",
      usage: [usage("sol", 0.04)],
    }));
    const scheduler = { execute: vi.fn(async () => Promise.reject(new Error("not used"))) };
    const integrate = vi.fn(async () => Promise.reject(new Error("not used")));
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession: (input) => structuredClone(input),
      },
      scheduler,
      integrator: { integrate },
      finalReviewer: { review },
      workspace,
      recovery: {
        reattach: vi.fn(async ({ snapshot: persisted }) => ({
          result: {
            ...structuredClone(persisted.result),
            status: "running",
            leaves: [structuredClone(recoveredLeaf)],
            finalResponse: null,
          },
          continuation: {
            initialLeaves: [structuredClone(recoveredLeaf)],
            workspaceWritersMayHaveRun: true,
            finalReview: {
              integratedResponse: "Terra response after writer validation",
              integrationValidation: [],
              integratorThreadId: "terra-integration-resume",
              launchSkewMs: null,
              peakConcurrency: 1,
              replanCount: 0,
            },
          },
        })),
      },
    });

    const result = await service.resume("resume-writer-final-review");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "Terra response after writer validation",
    });
    expect(workspace.prepare).not.toHaveBeenCalled();
    expect(workspace.resume).toHaveBeenCalledOnce();
    expect(workspace.prepareValidation).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ cwd: "/workspace/.agent-trio/candidate" }),
      }),
    );
    expect(integrateWorkspace).toHaveBeenCalledOnce();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    expect(integrateWorkspace.mock.invocationCallOrder[0]).toBeGreaterThan(
      review.mock.invocationCallOrder[0]!,
    );
    expect(scheduler.execute).not.toHaveBeenCalled();
    expect(integrate).not.toHaveBeenCalled();
    expect(store.load("resume-writer-final-review")).toMatchObject({
      workspaceCommitState: "applied",
      result: { status: "completed" },
    });
    expect(store.load("resume-writer-final-review")?.integrationCheckpoint).toBeUndefined();
  });

  it("retains a recovered writer workspace across an uncertain final review and resumes exactly that stage", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [plan().tasks[0]!],
      integration: { ...plan().integration, validation: [], finalReview: "always" },
    });
    const recoveredLeaf = leaf("leaf-a");
    const snapshot = resumableFanoutSnapshot("resume-writer-review-uncertain", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.workspaceCommitState = "pending";
    snapshot.integrationCheckpoint = {
      planId: executionPlan.planId,
      leafIdentities: [
        {
          taskId: recoveredLeaf.taskId,
          threadId: recoveredLeaf.threadId,
          turnId: recoveredLeaf.turnId,
          completedAt: recoveredLeaf.completedAt,
        },
      ],
      response: "validated Terra writer response",
      validation: [],
      integratorThreadId: "terra-writer-integration",
      launchSkewMs: 2,
      peakConcurrency: 1,
      replanCount: 0,
      updatedAt: "2026-08-28T00:01:01.000Z",
    };
    store.save(snapshot);

    const resumeWorkspace = vi.fn(async () => undefined);
    const prepareValidation = vi.fn(async () => "/workspace/.agent-trio/candidate");
    const integrateWorkspace = vi.fn(async () => undefined);
    const cleanupWorkspace = vi.fn(async () => undefined);
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      resume: resumeWorkspace,
      prepareValidation,
      integrate: integrateWorkspace,
      cleanup: cleanupWorkspace,
    };
    const scheduler = {
      execute: vi.fn(async () => Promise.reject(new Error("scheduler must not replay"))),
    };
    const terraIntegrate = vi.fn(async () =>
      Promise.reject(new Error("Terra integration must not replay")),
    );
    const recovery = finalReviewRecovery([recoveredLeaf], true);
    const failedReview = vi.fn(async () => {
      throw new Error("review response was lost");
    });
    const firstResume = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("planning must not replay"))),
        restoreSession: (input) => structuredClone(input),
      },
      scheduler,
      integrator: { integrate: terraIntegrate },
      finalReviewer: { review: failedReview },
      workspace,
      recovery,
    });

    const uncertain = await firstResume.resume("resume-writer-review-uncertain");

    expect(uncertain).toMatchObject({
      status: "indeterminate",
      finalResponse: null,
      error: expect.stringContaining("Sol final review did not return a confirmed response"),
    });
    expect(resumeWorkspace).toHaveBeenCalledOnce();
    expect(prepareValidation).toHaveBeenCalledOnce();
    expect(integrateWorkspace).not.toHaveBeenCalled();
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(store.load("resume-writer-review-uncertain")).toMatchObject({
      workspaceCommitState: "pending",
      result: { status: "indeterminate" },
      integrationCheckpoint: { response: "validated Terra writer response" },
    });

    const successfulReview = vi.fn(async () => ({
      approved: true,
      issues: [],
      threadId: "sol-planner-resume",
      usage: [usage("sol", 0.04)],
    }));
    const secondResume = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("planning must not replay"))),
        restoreSession: (input) => structuredClone(input),
      },
      scheduler,
      integrator: { integrate: terraIntegrate },
      finalReviewer: { review: successfulReview },
      workspace,
      recovery,
    });

    const completed = await secondResume.resume("resume-writer-review-uncertain");

    expect(completed).toMatchObject({
      status: "completed",
      finalResponse: "validated Terra writer response",
    });
    expect(successfulReview).toHaveBeenCalledOnce();
    expect(resumeWorkspace).toHaveBeenCalledTimes(2);
    expect(prepareValidation).toHaveBeenCalledTimes(2);
    expect(integrateWorkspace).toHaveBeenCalledOnce();
    expect(cleanupWorkspace).toHaveBeenCalledOnce();
    expect(scheduler.execute).not.toHaveBeenCalled();
    expect(terraIntegrate).not.toHaveBeenCalled();
    expect(store.load("resume-writer-review-uncertain")).toMatchObject({
      workspaceCommitState: "applied",
      result: { status: "completed" },
    });
    expect(store.load("resume-writer-review-uncertain")?.integrationCheckpoint).toBeUndefined();
  });

  it("never lets resumed Sol approval override failed deterministic validation", async () => {
    const store = createStore();
    const executionPlan = plan({
      tasks: [plan().tasks[0]!],
      integration: {
        ...plan().integration,
        validation: [{ command: "npm test" }],
        finalReview: "always",
      },
    });
    const recoveredLeaf = leaf("leaf-a");
    const failedValidation = [
      { command: "npm test", status: "failed" as const, summary: "tests failed" },
    ];
    const snapshot = resumableFanoutSnapshot("resume-rejected-writer-validation", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.workspaceCommitState = "pending";
    snapshot.integrationCheckpoint = {
      planId: executionPlan.planId,
      leafIdentities: [
        {
          taskId: recoveredLeaf.taskId,
          threadId: recoveredLeaf.threadId,
          turnId: recoveredLeaf.turnId,
          completedAt: recoveredLeaf.completedAt,
        },
      ],
      response: "Terra response despite failed tests",
      validation: failedValidation,
      integratorThreadId: "terra-integration-resume",
      launchSkewMs: null,
      peakConcurrency: 1,
      replanCount: 0,
      updatedAt: "2026-08-28T00:01:01.000Z",
    };
    store.save(snapshot);
    const integrateWorkspace = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const review = vi.fn(async () => ({
      approved: true,
      issues: [],
      threadId: "sol-planner-resume",
      usage: [usage("sol", 0.04)],
    }));
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession: (input) => structuredClone(input),
      },
      scheduler: { execute: vi.fn(async () => Promise.reject(new Error("not used"))) },
      integrator: { integrate: vi.fn(async () => Promise.reject(new Error("not used"))) },
      finalReviewer: { review },
      workspace: {
        prepare: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        prepareValidation: vi.fn(async () => "/workspace/.agent-trio/candidate"),
        integrate: integrateWorkspace,
        cleanup,
      },
      recovery: {
        reattach: vi.fn(async ({ snapshot: persisted }) => ({
          result: {
            ...structuredClone(persisted.result),
            status: "running",
            leaves: [structuredClone(recoveredLeaf)],
            finalResponse: null,
          },
          continuation: {
            initialLeaves: [structuredClone(recoveredLeaf)],
            workspaceWritersMayHaveRun: true,
            finalReview: {
              integratedResponse: "Terra response despite failed tests",
              integrationValidation: structuredClone(failedValidation),
              integratorThreadId: "terra-integration-resume",
              launchSkewMs: null,
              peakConcurrency: 1,
              replanCount: 0,
            },
          },
        })),
      },
    });

    const result = await service.resume("resume-rejected-writer-validation");

    expect(result).toMatchObject({
      status: "failed",
      finalResponse: null,
      error: "integration validation failed: npm test: tests failed",
    });
    expect(review).toHaveBeenCalledOnce();
    expect(integrateWorkspace).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(store.load("resume-rejected-writer-validation")).toMatchObject({
      workspaceCommitState: "pending",
      result: { status: "failed" },
    });
    expect(store.load("resume-rejected-writer-validation")?.integrationCheckpoint).toBeUndefined();
  });

  it("applies the original deadline before recovery reattachment", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("expired-before-reattach", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.request = { ...snapshot.request, limits: { deadlineMs: 1_000 } };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    snapshot.startedAt = "2026-08-28T00:00:00.000Z";
    store.save(snapshot);
    const reattach = vi.fn(async () => Promise.reject(new Error("must not reattach")));
    const service = createService({
      store,
      recovery: { reattach },
      now: () => new Date("2026-08-28T00:00:02.000Z"),
    });

    const result = await service.resume("expired-before-reattach");

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("deadline") });
    expect(reattach).not.toHaveBeenCalled();
  });

  it("checks persisted usage against maxCostUsd before recovery reattachment", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("over-budget-before-reattach", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.request = { ...snapshot.request, limits: { maxCostUsd: 0.04 } };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    store.save(snapshot);
    const reattach = vi.fn(async () => Promise.reject(new Error("must not reattach")));
    const service = createService({ store, recovery: { reattach } });

    const result = await service.resume("over-budget-before-reattach");

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("above maxCostUsd=0.04"),
    });
    expect(reattach).not.toHaveBeenCalled();
  });

  it("fails closed when a recovered non-leaf turn has no usage under maxCostUsd", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("missing-review-usage", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.request = { ...snapshot.request, limits: { maxCostUsd: 0.5 } };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    snapshot.remoteTurns = [
      {
        role: "finalReview",
        threadId: "sol-planner-resume",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:01:01.000Z",
      },
    ];
    store.save(snapshot);
    const reattach = vi.fn(async () => Promise.reject(new Error("must not reattach")));
    const service = createService({ store, recovery: { reattach } });

    const result = await service.resume("missing-review-usage");

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("finalReview:review-turn"),
    });
    expect(reattach).not.toHaveBeenCalled();
  });

  it("does not hide an unaccounted continuation turn behind existing stage usage", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("missing-continuation-usage", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.request = { ...snapshot.request, limits: { maxCostUsd: 0.5 } };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    snapshot.usageByStage!.finalReview = {
      usage: [usage("sol", 0.02)],
      estimatedCostUsd: 0.02,
    };
    snapshot.remoteTurns = [
      {
        role: "finalReview",
        threadId: "sol-planner-resume",
        turnId: "review-turn-initial",
        access: "readOnly",
        state: "terminal",
        usage: [usage("sol", 0.02)],
        updatedAt: "2026-08-28T00:01:01.000Z",
      },
      {
        role: "finalReview",
        threadId: "sol-planner-resume",
        turnId: "review-turn-continuation",
        access: "readOnly",
        state: "terminal",
        updatedAt: "2026-08-28T00:01:02.000Z",
      },
    ];
    store.save(snapshot);
    const reattach = vi.fn(async () => Promise.reject(new Error("must not reattach")));
    const service = createService({ store, recovery: { reattach } });

    const result = await service.resume("missing-continuation-usage");

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("finalReview:review-turn-continuation"),
    });
    expect(reattach).not.toHaveBeenCalled();
  });

  it("hydrates terminal checkpoint usage before evaluating recovery cost", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("checkpointed-review-usage", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.request = { ...snapshot.request, limits: { maxCostUsd: 0.5 } };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    snapshot.remoteTurns = [
      {
        role: "finalReview",
        threadId: "sol-planner-resume",
        turnId: "review-turn",
        access: "readOnly",
        state: "terminal",
        usage: [usage("sol", 0.02)],
        updatedAt: "2026-08-28T00:01:01.000Z",
      },
    ];
    store.save(snapshot);
    const reattach = vi.fn(async ({ snapshot: persisted }) => ({
      result: {
        ...structuredClone(persisted.result),
        status: "completed" as const,
        finalResponse: "recovered review",
      },
    }));
    const service = createService({ store, recovery: { reattach } });

    const result = await service.resume("checkpointed-review-usage");

    expect(result).toMatchObject({
      status: "completed",
      metrics: {
        estimatedCostUsd: 0.07,
        usageByStage: { finalReview: { estimatedCostUsd: 0.02 } },
      },
    });
    expect(reattach).toHaveBeenCalledOnce();
  });

  it("adds later continuation usage to a nonempty stage exactly once", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("deduplicate-review-usage", executionPlan, [
      recoveredLeaf,
    ]);
    snapshot.request = { ...snapshot.request, limits: { maxCostUsd: 0.5 } };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    snapshot.usageByStage!.finalReview = {
      usage: [usage("sol", 0.02)],
      estimatedCostUsd: 0.02,
    };
    snapshot.remoteTurns = [
      {
        role: "finalReview",
        threadId: "sol-planner-resume",
        turnId: "review-turn-initial",
        access: "readOnly",
        state: "terminal",
        usage: [usage("sol", 0.02)],
        updatedAt: "2026-08-28T00:01:01.000Z",
      },
      {
        role: "finalReview",
        threadId: "sol-planner-resume",
        turnId: "review-turn-continuation",
        access: "readOnly",
        state: "terminal",
        usage: [usage("sol", 0.03)],
        updatedAt: "2026-08-28T00:01:02.000Z",
      },
    ];
    store.save(snapshot);
    let recoveryCount = 0;
    const reattach = vi.fn(async ({ snapshot: persisted }) => {
      recoveryCount += 1;
      return {
        result: {
          ...structuredClone(persisted.result),
          status: recoveryCount === 1 ? ("waiting_input" as const) : ("completed" as const),
          finalResponse: recoveryCount === 1 ? null : "recovered review",
          ...(recoveryCount === 1 ? { needsAction: "retry transport" } : {}),
        },
      };
    });
    const service = createService({ store, recovery: { reattach } });

    const waiting = await service.resume("deduplicate-review-usage");
    expect(waiting).toMatchObject({
      status: "waiting_input",
      metrics: {
        estimatedCostUsd: 0.1,
        usageByStage: { finalReview: { estimatedCostUsd: 0.05 } },
      },
    });
    expect(store.load("deduplicate-review-usage")?.accountedUsageTurnKeys).toHaveLength(2);

    const completed = await service.resume("deduplicate-review-usage");
    expect(completed).toMatchObject({
      status: "completed",
      finalResponse: "recovered review",
      metrics: {
        estimatedCostUsd: 0.1,
        usageByStage: { finalReview: { estimatedCostUsd: 0.05 } },
      },
    });
    expect(reattach).toHaveBeenCalledTimes(2);
    expect(store.load("deduplicate-review-usage")?.accountedUsageTurnKeys).toHaveLength(2);
  });

  it("synthesizes planner and accounting state for legacy snapshots", async () => {
    const store = createStore();
    const baseTask = plan().tasks[0]!;
    const executionPlan = plan({
      tasks: [{ ...baseTask, access: "readOnly", ownedPaths: [] }],
    });
    const recoveredLeaf = { ...leaf("leaf-a"), changedFiles: [] };
    const snapshot = resumableFanoutSnapshot("legacy-resume", executionPlan, [recoveredLeaf]);
    snapshot.request = { ...snapshot.request, integrate: false };
    snapshot.requestHash = hashRunRequest(snapshot.request);
    const stagedUsage = structuredClone(snapshot.usageByStage!);
    const legacyUsage = Object.values(stagedUsage).flatMap((stage) => stage.usage);
    snapshot.result.metrics = {
      startedAt: "2026-08-27T23:59:00.000Z",
      completedAt: snapshot.updatedAt,
      elapsedMs: 120_000,
      planningMs: 12,
      integrationMs: 3,
      launchSkewMs: null,
      peakConcurrency: 1,
      replanCount: 0,
      userInterventionCount: 0,
      usage: legacyUsage,
      estimatedCostUsd: 0.05,
      usageByStage: stagedUsage,
    };
    delete snapshot.plannerSession;
    delete snapshot.startedAt;
    delete snapshot.planningMs;
    delete snapshot.integrationMs;
    delete snapshot.usageByStage;
    store.save(snapshot);

    let restoredSession: PlannerSession | null = null;
    const restoreSession = vi.fn((input: PlannerSession): PlannerSession => {
      restoredSession = structuredClone(input);
      return structuredClone(input);
    });
    const runLeaf = vi.fn(async () => recoveredLeaf);
    const replanHandler = { replan: async () => null, answer: async () => "answer" };
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "running",
          leaves: [structuredClone(recoveredLeaf)],
          finalResponse: null,
        },
        continuation: {
          initialLeaves: [structuredClone(recoveredLeaf)],
          workspaceWritersMayHaveRun: false,
        },
      })),
    };
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession,
        getSession: vi.fn(() => restoredSession),
      },
      scheduler: new DeterministicScheduler({ runLeaf }, replanHandler),
      recovery,
    });

    const result = await service.resume("legacy-resume");

    expect(result.status).toBe("completed");
    expect(runLeaf).not.toHaveBeenCalled();
    expect(restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "legacy-resume",
        threadId: "sol-planner-resume",
        initialPlan: executionPlan,
        plan: executionPlan,
        patch: null,
        replanCount: 0,
        usage: [expect.objectContaining({ tier: "sol", estimatedCostUsd: 0.02 })],
      }),
    );
    expect(result.metrics).toMatchObject({
      startedAt: "2026-08-27T23:59:00.000Z",
      planningMs: 12,
      integrationMs: 3,
      estimatedCostUsd: 0.05,
    });
  });

  it("finishes indeterminate before scheduling when a writer workspace cannot resume", async () => {
    const store = createStore();
    const executionPlan = plan({ tasks: [plan().tasks[0]!] });
    const recoveredWriter = leaf("leaf-a");
    const snapshot = resumableFanoutSnapshot("resume-writer-without-workspace", executionPlan, [
      recoveredWriter,
    ]);
    store.save(snapshot);
    const restoreSession = vi.fn((input: PlannerSession): PlannerSession => structuredClone(input));
    const scheduler = { execute: vi.fn(async () => Promise.reject(new Error("not used"))) };
    const workspace: WorkspaceController = {
      prepare: vi.fn(async () => undefined),
      integrate: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "running",
          leaves: [structuredClone(recoveredWriter)],
          finalResponse: null,
        },
        continuation: {
          initialLeaves: [structuredClone(recoveredWriter)],
          workspaceWritersMayHaveRun: true,
        },
      })),
    };
    const service = createService({
      store,
      planner: {
        plan: vi.fn(async () => Promise.reject(new Error("not used"))),
        restoreSession,
      },
      scheduler,
      recovery,
      workspace,
    });

    const result = await service.resume("resume-writer-without-workspace");

    expect(result.status).toBe("indeterminate");
    expect(result.error).toContain("no persistent recovery capability");
    expect(result.metrics?.usageByStage?.leaves.estimatedCostUsd).toBe(0.02);
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(scheduler.execute).not.toHaveBeenCalled();
    expect(workspace.prepare).not.toHaveBeenCalled();
    expect(workspace.integrate).not.toHaveBeenCalled();
    expect(workspace.cleanup).not.toHaveBeenCalled();
  });

  it("materializes checkpointed metrics for a terminal reattachment", async () => {
    const store = createStore();
    const recoveredLeaf = leaf("leaf-a");
    const snapshot = resumableFanoutSnapshot(
      "terminal-reattachment-metrics",
      plan({ tasks: [plan().tasks[0]!] }),
      [recoveredLeaf],
    );
    snapshot.workspaceCommitState = "applied";
    store.save(snapshot);
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "completed",
          finalResponse: "already integrated",
        },
      })),
    };
    const service = createService({ store, recovery });

    const result = await service.resume("terminal-reattachment-metrics");

    expect(result).toMatchObject({
      status: "completed",
      finalResponse: "already integrated",
      metrics: {
        startedAt: "2026-08-28T00:00:00.000Z",
        planningMs: 17,
        usageByStage: {
          admission: { estimatedCostUsd: 0.01 },
          planning: { estimatedCostUsd: 0.02 },
          leaves: { estimatedCostUsd: 0.02 },
        },
        estimatedCostUsd: 0.05,
      },
    });
    expect(store.load("terminal-reattachment-metrics")).toMatchObject({
      startedAt: "2026-08-28T00:00:00.000Z",
      planningMs: 17,
      result: { metrics: { estimatedCostUsd: 0.05 } },
    });
  });

  it("rejects a recovered completed writer result without an applied commit marker", async () => {
    const store = createStore();
    const snapshot = resumableFanoutSnapshot(
      "terminal-review-pending-workspace",
      plan({ tasks: [plan().tasks[0]!] }),
      [leaf("leaf-a")],
    );
    snapshot.workspaceCommitState = "pending";
    store.save(snapshot);
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot: persisted }) => ({
        result: {
          ...structuredClone(persisted.result),
          status: "completed",
          finalResponse: "review approved before the crash",
        },
      })),
    };
    const service = createService({ store, recovery });

    const result = await service.resume("terminal-review-pending-workspace");

    expect(result.status).toBe("indeterminate");
    expect(result.finalResponse).toBeNull();
    expect(result.error).toContain("not durably marked as applied");
    expect(store.load("terminal-review-pending-workspace")?.workspaceCommitState).toBe("pending");
  });

  it("preserves checkpointed timing and usage when reattachment fails", async () => {
    const store = createStore();
    const snapshot = resumableFanoutSnapshot(
      "failed-reattachment-metrics",
      plan({ tasks: [plan().tasks[0]!] }),
      [leaf("leaf-a")],
    );
    store.save(snapshot);
    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async () => Promise.reject(new Error("remote observation failed"))),
    };
    const service = createService({ store, recovery });

    const result = await service.resume("failed-reattachment-metrics");

    expect(result).toMatchObject({
      status: "indeterminate",
      error: "remote observation failed",
      metrics: {
        startedAt: "2026-08-28T00:00:00.000Z",
        planningMs: 17,
        usageByStage: {
          admission: { estimatedCostUsd: 0.01 },
          planning: { estimatedCostUsd: 0.02 },
          leaves: { estimatedCostUsd: 0.02 },
        },
        estimatedCostUsd: 0.05,
      },
    });
  });

  it("resumes waiting work only through a reattachment adapter", async () => {
    const store = createStore();
    const directExecutor: DirectExecutor = {
      execute: vi.fn(async (): Promise<AgentOutcome> => ({
        status: "waiting_input",
        response: null,
        threadId: "terra-waiting",
        usage: [],
        needsAction: "grant workspace permission",
      })),
    };
    const initial = createService({ store, directExecutor });
    const waiting = await initial.run({
      runId: "resume-1",
      objective: "edit protected file",
      cwd: "/workspace",
    });
    expect(waiting.status).toBe("waiting_input");

    const noRecovery = createService({ store, directExecutor });
    await expect(noRecovery.resume("resume-1")).rejects.toMatchObject({
      code: "reattach_unavailable",
    });
    expect(directExecutor.execute).toHaveBeenCalledTimes(1);

    const recovery: RecoveryAdapter = {
      reattach: vi.fn(async ({ snapshot }) => ({
        result: {
          ...snapshot.result,
          status: "completed",
          finalResponse: "resumed safely",
          needsAction: undefined,
          error: undefined,
        } as BatchResult,
      })),
    };
    const resumedService = createService({ store, directExecutor, recovery });
    const resumed = await resumedService.resume("resume-1");
    expect(resumed).toMatchObject({ status: "completed", finalResponse: "resumed safely" });
    expect(recovery.reattach).toHaveBeenCalledTimes(1);
    expect(directExecutor.execute).toHaveBeenCalledTimes(1);
  });
});
