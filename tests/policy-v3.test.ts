import { describe, expect, it } from "vitest";
import type { ExecutionPlan, LeafResult, LeafTask } from "../src/core/contracts.js";
import type { PolicyError } from "../src/core/policy.js";
import {
  assertTierEffort,
  classifyValidatorFailure,
  detectReplanTriggers,
  evaluateFanoutAdmission,
  evaluatePlannedExecutionAdmission,
  evaluateTierAssignment,
  normalizeExecutionLimits,
  normalizeExecutionLimitsForMode,
  rebalanceExecutionPlan,
  recommendEffort,
  recommendEffectiveTier,
  recommendTier,
} from "../src/core/policy.js";

function leaf(id: string, overrides: Partial<LeafTask> = {}): LeafTask {
  return {
    id,
    objective: `Complete ${id}`,
    domain: "coding",
    tier: "luna",
    effort: "medium",
    access: "workspaceWrite",
    ownedPaths: [`src/${id}.ts`],
    dependsOn: [],
    capabilities: [],
    validation: [{ command: `npm test -- ${id}` }],
    communicationWith: [],
    expectedSeconds: 90,
    difficulty: 0.25,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
    ...overrides,
  };
}

function plan(tasks: LeafTask[], overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-policy",
    objective: "Implement independent modules",
    domain: "coding",
    assumptions: [],
    tasks,
    integration: {
      objective: "Integrate and verify",
      requiredOutputs: ["working implementation"],
      validation: [{ command: "npm test" }],
      finalReview: "riskTriggered",
    },
    risk: "medium",
    ...overrides,
  };
}

function result(taskId: string, overrides: Partial<LeafResult> = {}): LeafResult {
  return {
    taskId,
    status: "completed",
    summary: `${taskId} complete`,
    confidence: 0.9,
    findings: [],
    changedFiles: [`src/${taskId}.ts`],
    validation: [{ command: "npm test", status: "passed", summary: "ok" }],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: `thread-${taskId}`,
    turnId: `turn-${taskId}`,
    usage: [],
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:01:00.000Z",
    ...overrides,
  };
}

describe("V3 execution policy", () => {
  it("normalizes deterministic defaults and rejects unsafe overrides", () => {
    expect(normalizeExecutionLimits()).toEqual({
      maxConcurrent: 5,
      maxLeaves: 8,
      maxWaves: 3,
      maxSolLeaves: 1,
      maxReplans: 1,
    });
    expect(normalizeExecutionLimits({ maxLeaves: 4, maxReplans: 0, deadlineMs: 5_000 })).toEqual(
      expect.objectContaining({ maxLeaves: 4, maxReplans: 0, deadlineMs: 5_000 }),
    );
    expect(() => normalizeExecutionLimits({ maxConcurrent: 0 })).toThrowError(
      expect.objectContaining<Partial<PolicyError>>({ code: "invalid_limit" }),
    );
    expect(() => normalizeExecutionLimits({ maxReplans: 2 })).toThrowError(
      expect.objectContaining<Partial<PolicyError>>({ code: "limit_exceeded" }),
    );
    expect(() => normalizeExecutionLimits({ maxSolLeaves: 2 })).toThrowError(
      expect.objectContaining<Partial<PolicyError>>({ code: "limit_exceeded" }),
    );
    expect(() => normalizeExecutionLimitsForMode("foreground", { maxLeaves: 9 })).toThrowError(
      expect.objectContaining<Partial<PolicyError>>({ code: "limit_exceeded" }),
    );
    expect(normalizeExecutionLimitsForMode("durable", { maxLeaves: 20 }).maxLeaves).toBe(20);
    expect(normalizeExecutionLimitsForMode("foreground", {}, "balanced")).toMatchObject({
      maxConcurrent: 3,
      maxLeaves: 3,
    });
    expect(normalizeExecutionLimitsForMode("durable", {}, "balanced").maxLeaves).toBe(5);
    expect(() =>
      normalizeExecutionLimitsForMode("foreground", { maxLeaves: 4 }, "balanced"),
    ).toThrowError(expect.objectContaining<Partial<PolicyError>>({ code: "limit_exceeded" }));
  });

  it("pins supported effort ranges to each tier", () => {
    expect(() => assertTierEffort("luna", "low")).not.toThrow();
    expect(() => assertTierEffort("luna", "medium")).not.toThrow();
    expect(() => assertTierEffort("terra", "high")).not.toThrow();
    expect(() => assertTierEffort("sol", "xhigh")).not.toThrow();
    expect(() => assertTierEffort("luna", "high")).toThrowError(
      expect.objectContaining<Partial<PolicyError>>({ code: "invalid_tier_effort" }),
    );
    expect(() => assertTierEffort("sol", "low")).toThrowError(
      expect.objectContaining<Partial<PolicyError>>({ code: "invalid_tier_effort" }),
    );
  });

  it("recommends the cheapest sufficient tier and an explicit supported effort", () => {
    expect(recommendTier({ difficulty: 0.1, ambiguity: 0.1 })).toBe("luna");
    expect(recommendTier({ difficulty: 0.55, ambiguity: 0.2 })).toBe("terra");
    expect(recommendTier({ difficulty: 0.4, ambiguity: 0.81 })).toBe("sol");
    expect(recommendTier({ difficulty: 0.1, ambiguity: 0.1, critical: true })).toBe("terra");
    expect(recommendEffort("luna", { difficulty: 0.1, ambiguity: 0.1 })).toBe("low");
    expect(recommendEffort("terra", { difficulty: 0.7, ambiguity: 0.2 })).toBe("high");
    expect(recommendEffort("sol", { difficulty: 0.95, ambiguity: 0.3 })).toBe("xhigh");
    expect(evaluateTierAssignment("luna", { difficulty: 0.9, ambiguity: 0.2 })).toMatchObject({
      valid: false,
      reason: "tier_too_low",
      recommended: "sol",
    });
    expect(evaluateTierAssignment("sol", { difficulty: 0.1, ambiguity: 0.1 })).toMatchObject({
      valid: false,
      reason: "unnecessary_sol",
      recommended: "luna",
    });
  });

  it("keeps bounded validated leaves on Luna even when the parent task is complex", () => {
    expect(
      recommendEffectiveTier({
        tier: "terra",
        difficulty: 0.55,
        ambiguity: 0.25,
        critical: true,
        validation: [{ command: "npm test" }],
        validatorStrength: "strong",
        domain: "coding",
      }),
    ).toBe("luna");
    expect(
      recommendEffectiveTier({
        tier: "terra",
        minTier: "terra",
        difficulty: 0.4,
        ambiguity: 0.2,
        critical: false,
        validation: [],
        validatorStrength: "none",
        domain: "coding",
      }),
    ).toBe("terra");
  });

  it("spends Luna reasoning on coding writers and exact algorithms while keeping mechanical work cheap", () => {
    const rebalanced = rebalanceExecutionPlan(
      plan([
        leaf("writer", { effort: "low", difficulty: 0.1, validation: [] }),
        leaf("reader", {
          effort: "medium",
          access: "readOnly",
          ownedPaths: [],
          difficulty: 0.3,
          validation: [],
        }),
        leaf("algorithm", {
          domain: "algorithm",
          effort: "low",
          access: "readOnly",
          ownedPaths: [],
          difficulty: 0.2,
          validation: [],
        }),
        leaf("office-writer", {
          domain: "office",
          effort: "medium",
          difficulty: 0.2,
          ambiguity: 0.1,
          validation: [],
        }),
      ]),
    );

    expect(rebalanced.tasks).toEqual([
      expect.objectContaining({ id: "writer", tier: "luna", effort: "medium" }),
      expect.objectContaining({ id: "reader", tier: "luna", effort: "low" }),
      expect.objectContaining({ id: "algorithm", tier: "luna", effort: "medium" }),
      expect.objectContaining({ id: "office-writer", tier: "terra", effort: "medium" }),
    ]);
  });

  it("keeps stateful recovery and review leaves above Luna", () => {
    for (const objective of [
      "Resume an idempotent recovery checkpoint",
      "Perform the paper review and synthesize the findings",
      "恢复事务状态并验证断点续跑",
    ]) {
      expect(
        recommendEffectiveTier({
          tier: "luna",
          difficulty: 0.2,
          ambiguity: 0.1,
          critical: false,
          validation: [],
          validatorStrength: "none",
          domain: "general",
          objective,
          capabilities: [],
        }),
      ).toBe("terra");
    }
  });

  it("admits only fanout that beats serial work with long, independent ready packages", () => {
    const admitted = evaluateFanoutAdmission([leaf("a"), leaf("b"), leaf("c")]);
    expect(admitted).toMatchObject({
      admitted: true,
      directSeconds: 270,
      estimatedFanoutSeconds: 120,
      readyTaskCount: 3,
      reasons: [],
    });

    const short = evaluateFanoutAdmission([leaf("a", { expectedSeconds: 15 }), leaf("b")]);
    expect(short.admitted).toBe(false);
    expect(short.reasons).toContain("short_task");

    const sequential = evaluateFanoutAdmission([leaf("a"), leaf("b", { dependsOn: ["a"] })]);
    expect(sequential.admitted).toBe(false);
    expect(sequential.reasons).toEqual(
      expect.arrayContaining(["insufficient_ready_tasks", "no_time_saving"]),
    );
  });

  it("rejects fanout that is faster than direct but misses the 70 percent target", () => {
    const result = evaluateFanoutAdmission(
      [leaf("a", { expectedSeconds: 60 }), leaf("b", { expectedSeconds: 60 })],
      {
        directSeconds: 100,
        planningSeconds: 5,
        launchSeconds: 2,
        integrationSeconds: 5,
      },
    );

    expect(result.estimatedFanoutSeconds).toBe(72);
    expect(result).toMatchObject({ admitted: false, reasons: ["no_time_saving"] });
  });

  it("can defer economic timing and minimum-work gates while retaining DAG checks", () => {
    const deferred = evaluateFanoutAdmission(
      [leaf("a", { expectedSeconds: 10 }), leaf("b", { expectedSeconds: 10 })],
      { deferEconomics: true },
    );
    expect(deferred).toMatchObject({ admitted: true, readyTaskCount: 2, reasons: [] });

    const overlapping = evaluateFanoutAdmission(
      [
        leaf("a", { expectedSeconds: 10, ownedPaths: ["src/core"] }),
        leaf("b", { expectedSeconds: 10, ownedPaths: ["src/core/a.ts"] }),
      ],
      { deferEconomics: true },
    );
    expect(overlapping).toMatchObject({ admitted: false });
    expect(overlapping.reasons).toContain("ownership_overlap");
  });

  it("admits exactly one leaf only on the planned_single route", () => {
    const single = leaf("hard", {
      tier: "sol",
      effort: "high",
      expectedSeconds: 20,
      difficulty: 0.9,
    });

    expect(evaluatePlannedExecutionAdmission([single], "planned_single")).toEqual({
      route: "planned_single",
      admitted: true,
      reasons: [],
      taskCount: 1,
    });
    expect(evaluatePlannedExecutionAdmission([single], "fanout")).toMatchObject({
      route: "fanout",
      admitted: false,
      reasons: expect.arrayContaining(["too_few_tasks", "short_task"]),
    });
    expect(evaluatePlannedExecutionAdmission([single, leaf("other")], "planned_single")).toEqual({
      route: "planned_single",
      admitted: false,
      reasons: ["not_exactly_one_task"],
      taskCount: 2,
    });
  });

  it("rejects fanout writers whose owned paths overlap", () => {
    const decision = evaluateFanoutAdmission([
      leaf("a", { ownedPaths: ["src/core"] }),
      leaf("b", { ownedPaths: ["src/core/planner.ts"] }),
    ]);
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("ownership_overlap");

    const readers = evaluateFanoutAdmission([
      leaf("a", { access: "readOnly", ownedPaths: ["src/core"] }),
      leaf("b", { access: "readOnly", ownedPaths: ["src/core"] }),
    ]);
    expect(readers.admitted).toBe(true);
  });

  it("allows overlapping writers when the plan orders them explicitly", () => {
    const decision = evaluateFanoutAdmission(
      [
        leaf("a", { ownedPaths: ["src/core"], expectedSeconds: 90 }),
        leaf("b", {
          ownedPaths: ["src/core/planner.ts"],
          dependsOn: ["a"],
          expectedSeconds: 90,
        }),
        leaf("c", { ownedPaths: ["src/ui"], expectedSeconds: 90 }),
      ],
      { directSeconds: 400 },
    );

    expect(decision.admitted).toBe(true);
    expect(decision.reasons).not.toContain("ownership_overlap");
  });

  it("admits a short preparation stage followed by two long parallel leaves", () => {
    const decision = evaluateFanoutAdmission([
      leaf("prepare", { expectedSeconds: 10, access: "readOnly", ownedPaths: [] }),
      leaf("a", { dependsOn: ["prepare"], expectedSeconds: 90 }),
      leaf("b", { dependsOn: ["prepare"], expectedSeconds: 90 }),
    ]);

    expect(decision.admitted).toBe(true);
    expect(decision.readyTaskCount).toBe(2);
    expect(decision.reasons).not.toContain("short_task");
    expect(decision.reasons).not.toContain("insufficient_ready_tasks");
  });

  it("derives replan triggers from terminal evidence without consulting a model", () => {
    const activePlan = plan(
      [
        leaf("a", { critical: true, expectedSeconds: 30 }),
        leaf("b", { critical: true, ownedPaths: ["src/b.ts"] }),
      ],
      { risk: "medium" },
    );
    const results = [
      result("a", {
        status: "blocked",
        failureKind: "contract",
        summary: "API contract is missing",
        confidence: 0.3,
        changedFiles: ["src/outside.ts"],
        messages: [
          {
            id: "m1",
            type: "blocker",
            fromTaskId: "a",
            toTaskId: "planner",
            body: "Need contract",
            blocking: true,
            createdAt: "2026-08-28T00:04:00.000Z",
          },
        ],
        completedAt: "2026-08-28T00:02:00.000Z",
      }),
      result("b", {
        confidence: 0.69,
        validation: [{ command: "npm test", status: "failed", summary: "failed" }],
      }),
    ];

    const triggers = detectReplanTriggers(activePlan, results, {
      observedAt: "2026-08-28T00:05:00.000Z",
      executionComplete: true,
      missingRequiredOutputs: ["API implementation"],
      conflicts: [{ taskIds: ["a", "b"], summary: "incompatible API assumptions" }],
    });
    expect(triggers.map((trigger) => trigger.type)).toEqual([
      "contract_incomplete",
      "critical_blocker",
      "result_conflict",
      "validator_failure",
      "low_confidence",
      "scope_change",
    ]);
    expect(triggers.every((trigger) => trigger.observedAt === "2026-08-28T00:05:00.000Z")).toBe(
      true,
    );
  });

  it("does not reinterpret routine terminal states as semantic replan evidence", () => {
    const activePlan = plan([
      leaf("reasoning", { critical: true }),
      leaf("transient", { critical: true }),
      leaf("permission", { critical: true }),
      leaf("cancelled", { critical: true }),
      leaf("indeterminate", { critical: true }),
      leaf("dependency", { critical: true }),
      leaf("skipped", { critical: true }),
    ]);
    const results = [
      result("reasoning", {
        status: "failed",
        confidence: 0,
        failureKind: "reasoning",
        error: "ordinary reasoning failure",
      }),
      result("transient", {
        status: "failed",
        confidence: 0,
        failureKind: "transient",
        error: "ordinary transient failure",
      }),
      result("permission", {
        status: "blocked",
        confidence: 0,
        failureKind: "permission",
        error: "waiting for external permission",
        messages: [
          {
            id: "permission-blocker",
            type: "blocker",
            fromTaskId: "permission",
            toTaskId: "planner",
            body: "Need external permission",
            blocking: true,
            createdAt: "2026-08-28T00:00:30.000Z",
          },
        ],
      }),
      result("cancelled", {
        status: "cancelled",
        confidence: 0,
        failureKind: "unknown",
        error: "deadline elapsed",
      }),
      result("indeterminate", {
        status: "indeterminate",
        confidence: 0,
        failureKind: "unknown",
        error: "turn outcome is unknown",
      }),
      result("dependency", {
        status: "blocked",
        confidence: 0,
        failureKind: "contract",
        error: "dependency reasoning did not complete",
        summary: "dependency reasoning did not complete",
        threadId: null,
        turnId: null,
      }),
      result("skipped", {
        validation: [{ command: "npm test", status: "skipped", summary: "not applicable" }],
        messages: [
          {
            id: "resolved-blocker",
            type: "blocker",
            fromTaskId: "skipped",
            toTaskId: "planner",
            body: "This blocker was resolved before completion",
            blocking: true,
            createdAt: "2026-08-28T00:00:30.000Z",
          },
        ],
      }),
    ];

    expect(
      detectReplanTriggers(activePlan, results, {
        observedAt: "2026-08-28T00:05:00.000Z",
        executionComplete: true,
      }),
    ).toEqual([]);
  });

  it("recognizes only deterministic validator failure evidence", () => {
    const activePlan = plan([leaf("adapter"), leaf("reported"), leaf("reasoning")]);
    const failedValidation = [
      { command: "npm test", status: "failed" as const, summary: "exit 1" },
    ];
    const triggers = detectReplanTriggers(
      activePlan,
      [
        result("adapter", {
          status: "failed",
          failureKind: "validation",
          error: "deterministic validator failed",
          validation: failedValidation,
        }),
        result("reported", { validation: failedValidation }),
        result("reasoning", {
          status: "failed",
          failureKind: "reasoning",
          error: "reasoning failed",
          validation: failedValidation,
        }),
      ],
      { observedAt: "2026-08-28T00:05:00.000Z" },
    );

    expect(triggers).toEqual([
      expect.objectContaining({
        type: "validator_failure",
        taskIds: ["adapter", "reported"],
      }),
    ]);
  });

  it("classifies only declared, pure validator failures as mechanical repairs", () => {
    const mechanicalTask = leaf("mechanical", {
      validation: [{ command: "npm test -- mechanical" }],
    });
    const mechanical = result("mechanical", {
      validation: [{ command: "npm test -- mechanical", status: "failed", summary: "exit 1" }],
    });
    const semantic = result("mechanical", {
      validation: [{ command: "npm test", status: "failed", summary: "exit 1" }],
    });
    const mixedFailure = result("mechanical", {
      status: "failed",
      failureKind: "reasoning",
      validation: [{ command: "npm test -- mechanical", status: "failed", summary: "exit 1" }],
    });

    expect(classifyValidatorFailure(mechanicalTask, mechanical)).toBe("mechanical");
    expect(classifyValidatorFailure(mechanicalTask, semantic)).toBe("semantic");
    expect(classifyValidatorFailure(mechanicalTask, mixedFailure)).toBe("semantic");
    expect(
      classifyValidatorFailure(
        leaf("self-tested", { validation: [] }),
        result("self-tested", {
          status: "failed",
          failureKind: "validation",
          validation: [],
        }),
      ),
    ).toBe("semantic");
    expect(
      detectReplanTriggers(plan([mechanicalTask]), [mechanical], {
        observedAt: "2026-08-28T00:05:00.000Z",
      }),
    ).toEqual([]);
    expect(
      detectReplanTriggers(plan([mechanicalTask]), [mechanical], {
        observedAt: "2026-08-28T00:05:00.000Z",
        validatorRepairAttempts: new Map([["mechanical", 2]]),
      }),
    ).toEqual([expect.objectContaining({ type: "validator_failure", taskIds: ["mechanical"] })]);
  });

  it("uses strict confidence and 30 percent deviation boundaries", () => {
    const activePlan = plan([
      leaf("confidence-edge", { critical: true }),
      leaf("confidence-over", { critical: true }),
      leaf("duration-edge", { expectedSeconds: 100 }),
      leaf("duration-over", { expectedSeconds: 100 }),
      leaf("cost-edge", { expectedCostUsd: 1 }),
      leaf("cost-over", { expectedCostUsd: 1 }),
    ]);
    const pricedUsage = (estimatedCostUsd: number) => [
      {
        model: "gpt-5.6-luna",
        tier: "luna" as const,
        effort: "medium",
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCostUsd,
      },
    ];
    const results = [
      result("confidence-edge", { confidence: 0.7 }),
      result("confidence-over", { confidence: 0.699 }),
      result("duration-edge", { completedAt: "2026-08-28T00:02:10.000Z" }),
      result("duration-over", { completedAt: "2026-08-28T00:02:10.001Z" }),
      result("cost-edge", { usage: pricedUsage(1.3) }),
      result("cost-over", { usage: pricedUsage(1.300_001) }),
    ];

    expect(
      detectReplanTriggers(activePlan, results, {
        observedAt: "2026-08-28T00:05:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({ type: "low_confidence", taskIds: ["confidence-over"] }),
      expect.objectContaining({
        type: "budget_deviation",
        taskIds: ["cost-over", "duration-over"],
      }),
    ]);
  });

  it("records terminal budget deviations without requesting an unusable plan patch", () => {
    const activePlan = plan([
      leaf("duration-over", { expectedSeconds: 30 }),
      leaf("cost-over", { expectedCostUsd: 0.01 }),
    ]);
    const results = [
      result("duration-over", { completedAt: "2026-08-28T00:00:40.000Z" }),
      result("cost-over", {
        usage: [
          {
            model: "gpt-5.6-luna",
            tier: "luna",
            effort: "low",
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            estimatedCostUsd: 0.02,
          },
        ],
      }),
    ];

    expect(
      detectReplanTriggers(activePlan, results, {
        observedAt: "2026-08-28T00:05:00.000Z",
        executionComplete: true,
      }),
    ).toEqual([]);
  });

  it("flags an unvalidated completed critical result only on a high-risk plan", () => {
    const activePlan = plan([leaf("a", { critical: true })], { risk: "high" });
    const triggers = detectReplanTriggers(
      activePlan,
      [result("a", { validation: [{ command: "npm test", status: "skipped", summary: "n/a" }] })],
      { observedAt: "2026-08-28T00:05:00.000Z", executionComplete: true },
    );
    expect(triggers.map((trigger) => trigger.type)).toContain("unvalidated_high_risk");
  });
});
