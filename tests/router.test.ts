import { describe, expect, it } from "vitest";
import type { ExecutionPlan, HostSemanticPlan, RunRequest } from "../src/core/contracts.js";
import { LocalRouteOptimizer, recommendDirectTier } from "../src/core/router.js";

const PRICE_TABLE = {
  "gpt-5.6-sol": {
    inputPerMillionUsd: 4,
    cachedInputPerMillionUsd: 0.4,
    outputPerMillionUsd: 20,
  },
  "gpt-5.6-terra": {
    inputPerMillionUsd: 2,
    cachedInputPerMillionUsd: 0.2,
    outputPerMillionUsd: 12,
  },
  "gpt-5.6-luna": {
    inputPerMillionUsd: 0.2,
    cachedInputPerMillionUsd: 0.02,
    outputPerMillionUsd: 1.2,
  },
} as const;

const signal = new AbortController().signal;

function hostPlan(count: number, overrides: Partial<HostSemanticPlan> = {}): HostSemanticPlan {
  return {
    access: "readOnly",
    merge: "deterministic",
    risk: "low",
    tasks: Array.from({ length: count }, (_, index) => ({
      goal: `Analyze workstream ${String(index + 1)}`,
      paths: [],
      after: [],
      floor: null,
      expectedSeconds: 90,
    })),
    ...overrides,
  };
}

function plan(count = 2, overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    objective: "Analyze independent workstreams",
    domain: "coding",
    assumptions: [],
    tasks: Array.from({ length: count }, (_, index) => ({
      id: `leaf-${String(index + 1)}`,
      objective: `Analyze workstream ${String(index + 1)}`,
      domain: "coding" as const,
      tier: "luna" as const,
      effort: "low" as const,
      access: "readOnly" as const,
      ownedPaths: [],
      dependsOn: [],
      capabilities: [],
      validation: [],
      communicationWith: [],
      expectedSeconds: 90,
      difficulty: 0.2,
      ambiguity: 0.1,
      confidence: 0.9,
      critical: false,
      validatorStrength: "none" as const,
    })),
    integration: {
      objective: "Combine results",
      requiredOutputs: ["complete answer"],
      validation: [],
      finalReview: "never",
      aggregation: "deterministic",
    },
    risk: "low",
    origin: "sol",
    ...overrides,
  };
}

function decide(optimizer: LocalRouteOptimizer, request: RunRequest) {
  return optimizer.decide({ runId: "run", request, signal });
}

describe("LocalRouteOptimizer V3.5 profile routing", () => {
  const optimizer = new LocalRouteOptimizer();
  const priced = new LocalRouteOptimizer({ priceTable: PRICE_TABLE });

  it("treats explicit direct as a host-Sol single-agent decision", () => {
    expect(
      decide(optimizer, {
        objective: "Apply the tightly coupled fix",
        cwd: "/workspace",
        strategy: "direct",
        directTier: "terra",
      }),
    ).toMatchObject({
      route: "direct",
      routeSource: "host_sol",
      reason: "host Sol selected one execution agent",
    });
  });

  it.each([
    "fix one typo",
    "install GitHub CLI and verify",
    "安装 github-cli 并验证",
    "rewrite this paragraph",
  ])("uses the deterministic direct fast path only for clearly bounded work: %s", (objective) => {
    expect(decide(optimizer, { objective, cwd: "/workspace" })).toMatchObject({
      route: "direct",
      routeSource: "deterministic_direct",
    });
  });

  it("keeps a detailed but bounded rewrite out of the Sol planner", () => {
    const objective =
      "rewrite this paragraph while preserving every supplied number, confidence interval, " +
      "study limitation, and the requested 100-word bound; return only the revised paragraph ".repeat(
        2,
      );
    expect(objective.length).toBeGreaterThan(220);
    expect(decide(optimizer, { objective, cwd: "/workspace", domain: "paper" })).toMatchObject({
      route: "direct",
      routeSource: "deterministic_direct",
    });
  });

  it.each([
    "分析 C# 课程设计项目的架构、构建方式、主要模块和潜在问题",
    "Analyze the Beam repository, including architecture, runtime flow, tests, and defects",
    "理解 AnimeDiffusion 项目并解释模型、数据流、训练入口和推理入口",
    "调研 AUR 镜像并核查本机当前配置，然后给出修改方案",
  ])("sends semantically uncertain work to one adaptive internal Sol turn: %s", (objective) => {
    expect(decide(priced, { objective, cwd: "/workspace", profile: "quality" })).toMatchObject({
      route: "adaptive",
      routeSource: "internal_sol",
      suggestedMaxLeaves: 5,
    });
  });

  it("defaults balanced foreground planning to two leaves without three named units", () => {
    expect(
      decide(priced, {
        objective: "Analyze several independent modules",
        cwd: "/workspace",
        profile: "balanced",
      }),
    ).toMatchObject({ route: "adaptive", suggestedMaxLeaves: 2 });
  });

  it("does not use domain or prompt length as a fanout decision", () => {
    expect(
      decide(priced, {
        objective: "研究这个问题",
        cwd: "/workspace",
        domain: "autoResearch",
      }),
    ).toMatchObject({ route: "adaptive", routeSource: "internal_sol" });
    expect(
      decide(priced, {
        objective: "x".repeat(5_000),
        cwd: "/workspace",
        domain: "general",
      }),
    ).toMatchObject({ route: "adaptive", routeSource: "internal_sol" });
  });

  it.each([2, 3, 5])(
    "preserves a %i-leaf host Sol plan without lexical workload evidence",
    (count) => {
      const decision = decide(priced, {
        objective: "完成主模型已经划分的工作",
        cwd: "/workspace/含 空格/#repo",
        strategy: "fanout",
        profile: "quality",
        domain: "general",
        semanticPlan: hostPlan(count),
      });
      expect(decision).toMatchObject({
        route: "fanout",
        routeSource: "host_sol",
        suggestedMaxLeaves: count,
      });
      expect(decision.reason).not.toContain("strong evidence");
    },
  );

  it("keeps quality fanout when economic targets are missed", () => {
    const semanticPlan = hostPlan(2, {
      merge: "terra",
      tasks: hostPlan(2).tasks.map((task) => ({ ...task, floor: "terra" })),
    });
    const expensive = new LocalRouteOptimizer({
      maxCostRatio: 0.01,
      maxLatencyRatio: 0.01,
      priceTable: PRICE_TABLE,
    });

    const decision = decide(expensive, {
      objective: "Analyze two independent systems and synthesize them",
      cwd: "/workspace",
      profile: "quality",
      strategy: "fanout",
      semanticPlan,
    });

    expect(decision).toMatchObject({
      route: "fanout",
      routeSource: "host_sol",
      estimatedDirectCostUsd: expect.any(Number),
      estimatedFanoutCostUsd: expect.any(Number),
      estimatedDirectSeconds: expect.any(Number),
      estimatedFanoutSeconds: expect.any(Number),
    });
    expect(decision.reason).toContain("release target missed");
  });

  it("hard-downgrades balanced fanout that misses its economic limits", () => {
    const expensive = new LocalRouteOptimizer({
      maxCostRatio: 0.01,
      maxLatencyRatio: 0.01,
      priceTable: PRICE_TABLE,
    });
    const semanticPlan = hostPlan(2, {
      tasks: ["alpha", "beta"].map((unit) => ({
        goal: `[unit:${unit}] Analyze ${unit}`,
        paths: [],
        after: [],
        floor: null,
        expectedSeconds: 60,
      })),
    });

    expect(
      decide(expensive, {
        objective: "Analyze [unit:alpha] and [unit:beta] independently",
        cwd: "/workspace",
        profile: "balanced",
        strategy: "fanout",
        semanticPlan,
      }),
    ).toMatchObject({
      route: "direct",
      routeEvidence: "structural_cold_start",
      routeAdjustment: "downgraded_to_single",
      reason: expect.stringContaining("balanced fanout rejected"),
    });
  });

  it("uses three matching direct-Sol samples for Balanced economic admission", () => {
    const objective = "Analyze [unit:alpha] and [unit:beta] independently in read-only mode";
    const semanticPlan = hostPlan(2, {
      tasks: ["alpha", "beta"].map((unit) => ({
        goal: `[unit:${unit}] Analyze ${unit}`,
        paths: [],
        after: [],
        floor: null,
        expectedSeconds: 90,
      })),
    });
    const historical = new LocalRouteOptimizer({
      priceTable: PRICE_TABLE,
      historyStore: {
        readSnapshots: () => directSolHistory(objective, 3, 300, 1),
      },
    });

    expect(
      decide(historical, {
        objective,
        cwd: "/workspace",
        profile: "balanced",
        strategy: "fanout",
        semanticPlan,
      }),
    ).toMatchObject({
      route: "fanout",
      routeEvidence: "history",
      routeAdjustment: "none",
    });
  });

  it("does not treat fewer than three matching samples as history", () => {
    const objective = "Analyze [unit:alpha] and [unit:beta] independently in read-only mode";
    const sparse = new LocalRouteOptimizer({
      priceTable: PRICE_TABLE,
      historyStore: {
        readSnapshots: () => directSolHistory(objective, 2, 300, 1),
      },
    });
    const decision = decide(sparse, {
      objective,
      cwd: "/workspace",
      profile: "balanced",
      strategy: "fanout",
      semanticPlan: hostPlan(2, {
        tasks: ["alpha", "beta"].map((unit) => ({
          goal: `[unit:${unit}] Analyze ${unit}`,
          paths: [],
          after: [],
          floor: null,
          expectedSeconds: 90,
        })),
      }),
    });

    expect(decision.routeEvidence).not.toBe("history");
  });

  it("rejects vague cold-start plans and multiple Terra nodes", () => {
    expect(
      decide(priced, {
        objective: "Analyze architecture, risks, and tests",
        cwd: "/workspace",
        profile: "balanced",
        strategy: "fanout",
        semanticPlan: hostPlan(2),
      }),
    ).toMatchObject({
      route: "direct",
      routeEvidence: "unavailable",
      reason: expect.stringContaining("lacks distinct paths, sources"),
    });

    expect(
      decide(priced, {
        objective: "Analyze [unit:alpha] and [unit:beta]",
        cwd: "/workspace",
        profile: "balanced",
        strategy: "fanout",
        semanticPlan: hostPlan(2, {
          tasks: hostPlan(2).tasks.map((task) => ({ ...task, floor: "terra" })),
        }),
      }),
    ).toMatchObject({
      route: "direct",
      reason: "balanced plan requires more than one Terra execution node",
    });
  });

  it("requires a material three-leaf gain in balanced mode", () => {
    const semanticPlan = hostPlan(3, {
      tasks: [100, 31, 31].map((expectedSeconds, index) => ({
        goal: `[unit:${String(index)}] Analyze unit ${String(index)}`,
        paths: [],
        after: [],
        floor: null,
        expectedSeconds,
      })),
    });
    expect(
      decide(priced, {
        objective: "Analyze [unit:0], [unit:1], and [unit:2] independently",
        cwd: "/workspace",
        profile: "balanced",
        strategy: "fanout",
        semanticPlan,
      }),
    ).toMatchObject({
      route: "direct",
      reason: expect.stringContaining("20% critical-path gain"),
      routeAdjustment: "downgraded_to_single",
    });
  });

  it("rejects a host plan whose leaves do not exceed the minimum useful duration", () => {
    const semanticPlan = hostPlan(2, {
      tasks: hostPlan(2).tasks.map((task) => ({ ...task, expectedSeconds: 15 })),
    });
    expect(
      decide(priced, {
        objective: "Inspect two small items",
        cwd: "/workspace",
        profile: "quality",
        strategy: "fanout",
        semanticPlan,
      }),
    ).toMatchObject({
      route: "direct",
      routeSource: "host_sol",
      reason: "fanout plan contains a leaf that does not exceed 15 seconds",
    });
  });

  it("requires 90 seconds of serial work in balanced fanout", () => {
    const semanticPlan = hostPlan(2, {
      tasks: hostPlan(2).tasks.map((task) => ({ ...task, expectedSeconds: 40 })),
    });
    expect(
      decide(priced, {
        objective: "Inspect two medium items",
        cwd: "/workspace",
        profile: "balanced",
        strategy: "fanout",
        semanticPlan,
      }),
    ).toMatchObject({
      route: "direct",
      reason: "balanced fanout plan contains less than 90 seconds of serial work",
    });
  });

  it("rejects a final plan with no concurrently runnable leaves", () => {
    const sequential = plan(2);
    sequential.tasks[1]!.dependsOn = [sequential.tasks[0]!.id];

    expect(
      priced.assessPlan!({
        runId: "sequential",
        request: {
          objective: sequential.objective,
          cwd: "/workspace",
          strategy: "fanout",
        },
        plan: sequential,
        source: "internal",
        signal,
      }),
    ).toMatchObject({
      route: "direct",
      routeSource: "internal_sol",
      reason: "planned DAG has fewer than two concurrently runnable leaves",
    });
  });

  it("keeps an independent DAG when an uncertain latency projection misses the target", () => {
    const strictTargets = new LocalRouteOptimizer({
      maxCostRatio: 0.01,
      maxLatencyRatio: 0.01,
      priceTable: PRICE_TABLE,
    });
    expect(
      strictTargets.assessPlan!({
        runId: "parallel",
        request: { objective: "Analyze two workstreams", cwd: "/workspace", profile: "quality" },
        plan: plan(2),
        source: "internal",
        signal,
      }),
    ).toMatchObject({
      route: "fanout",
      routeSource: "internal_sol",
      reason: expect.stringContaining("release target missed"),
      estimatedDirectSeconds: expect.any(Number),
      estimatedFanoutSeconds: expect.any(Number),
    });
  });

  it("preserves the observed three-stream host plan despite a pessimistic direct baseline", () => {
    const semanticPlan = hostPlan(3, {
      merge: "terra",
      tasks: [75, 75, 90].map((expectedSeconds, index) => ({
        goal: `Analyze RainbowNekoEngine workstream ${String(index + 1)}`,
        paths: ["."],
        after: [],
        floor: index === 2 ? ("terra" as const) : ("luna" as const),
        expectedSeconds,
      })),
    });
    const executionPlan = plan(3, {
      tasks: semanticPlan.tasks.map((task, index) => ({
        ...plan(3).tasks[index]!,
        tier: task.floor ?? "luna",
        expectedSeconds: task.expectedSeconds,
      })),
      integration: { ...plan(3).integration, aggregation: "terra" },
    });

    const decision = priced.assessPlan!({
      runId: "rainbow-neko-host-plan",
      request: {
        objective: "系统分析 RainbowNekoEngine 的架构、模块、工程质量和风险",
        cwd: "/workspace/RainbowNekoEngine",
        profile: "quality",
        strategy: "fanout",
        semanticPlan,
      },
      plan: executionPlan,
      source: "host",
      signal,
    });

    expect(decision).toMatchObject({
      route: "fanout",
      routeSource: "host_sol",
      suggestedMaxLeaves: 3,
      reason: expect.stringContaining("release target missed"),
    });
    expect(decision.estimatedFanoutSeconds).toBeGreaterThan(
      decision.estimatedDirectSeconds ?? Number.POSITIVE_INFINITY,
    );
  });

  it("enforces an explicit maxCostUsd and missing pre-call pricing", () => {
    expect(
      decide(
        new LocalRouteOptimizer({
          modelMap: { luna: "unpriced-luna" },
          priceTable: PRICE_TABLE,
        }),
        {
          objective: "Analyze the repository",
          cwd: "/workspace",
          limits: { maxCostUsd: 1 },
        },
      ),
    ).toMatchObject({
      route: "direct",
      routeSource: "deterministic_direct",
      reason: expect.stringContaining("pre-call USD estimates"),
    });

    expect(
      decide(priced, {
        objective: "Analyze independent alpha and beta",
        cwd: "/workspace",
        strategy: "fanout",
        semanticPlan: hostPlan(2),
        limits: { maxCostUsd: 0.000001 },
      }),
    ).toMatchObject({
      route: "direct",
      routeSource: "host_sol",
      reason: expect.stringContaining("exceeds maxCostUsd"),
    });
  });

  it("keeps the sealed benchmark fanout override isolated from normal routing", () => {
    expect(
      decide(optimizer, {
        objective: "sealed task",
        cwd: "/workspace",
        constraints: ["agent-trio-benchmark:force-fanout"],
      }),
    ).toMatchObject({ route: "fanout", routeSource: "internal_sol" });
  });

  it("throws immediately when routing is aborted", () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() =>
      optimizer.decide({
        runId: "aborted",
        request: { objective: "Analyze a repository", cwd: "/workspace" },
        signal: controller.signal,
      }),
    ).toThrow("stop");
  });
});

function directSolHistory(
  objective: string,
  count: number,
  elapsedSeconds: number,
  costUsd: number,
): unknown[] {
  return Array.from({ length: count }, () => ({
    request: { objective, cwd: "/workspace" },
    result: {
      status: "completed",
      plan: null,
      metrics: {
        elapsedMs: elapsedSeconds * 1_000,
        usageByStage: {
          direct: { usage: [{ tier: "sol" }], estimatedCostUsd: costUsd },
        },
      },
    },
  }));
}

describe("direct tier recommendation", () => {
  it("honors the host Sol tier and defaults bounded work to Luna", () => {
    expect(
      recommendDirectTier({
        objective: "Fix a tightly coupled bug",
        cwd: "/workspace",
        strategy: "direct",
        directTier: "terra",
      }),
    ).toBe("terra");
    expect(recommendDirectTier({ objective: "fix one typo", cwd: "/workspace" })).toBe("luna");
    expect(
      recommendDirectTier({
        objective: "Install GitHub CLI",
        cwd: "/workspace",
        domain: "coding",
      }),
    ).toBe("luna");
  });

  it("uses Terra for difficult coupled reasoning and Luna for a rejected cheap host plan", () => {
    expect(
      recommendDirectTier({
        objective: "redesign the authentication security architecture",
        cwd: "/workspace",
        domain: "coding",
      }),
    ).toBe("terra");
    expect(
      recommendDirectTier({
        objective: "Audit two independent modules",
        cwd: "/workspace",
        semanticPlan: hostPlan(2),
      }),
    ).toBe("luna");
  });

  it.each([
    ["Resume an idempotent recovery checkpoint", "autoResearch"],
    ["Perform a code review and synthesize the findings", "coding"],
    ["Create one editable presentation", "office"],
    ["恢复事务状态并验证断点续跑", "general"],
  ] as const)(
    "uses Terra for stateful, review, and office direct work: %s",
    (objective, domain) => {
      expect(recommendDirectTier({ objective, cwd: "/workspace", domain })).toBe("terra");
    },
  );
});
