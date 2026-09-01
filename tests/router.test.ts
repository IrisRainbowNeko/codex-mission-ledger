import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRouteOptimizer, recommendDirectTier } from "../src/core/router.js";

const temporaryWorkspaces: string[] = [];

afterEach(() => {
  for (const workspace of temporaryWorkspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function readOnlyWorkspace(
  filesPerRoot: number,
  bytesPerFile = 128,
): {
  cwd: string;
  roots: string[];
} {
  const cwd = mkdtempSync(join(tmpdir(), "agent-trio-router-"));
  temporaryWorkspaces.push(cwd);
  const roots = ["data/alpha", "data/beta", "data/gamma"];
  for (const root of roots) {
    mkdirSync(join(cwd, root), { recursive: true });
    for (let index = 0; index < filesPerRoot; index += 1) {
      writeFileSync(join(cwd, root, `input-${String(index)}.txt`), "x".repeat(bytesPerFile));
    }
  }
  return { cwd, roots };
}

function researchHostPlan(roots: readonly string[]) {
  return {
    access: "readOnly" as const,
    merge: "deterministic" as const,
    risk: "low" as const,
    tasks: roots.map((root) => ({
      goal: `Prepare the complete evidence brief for ${root}`,
      paths: [root],
      after: [],
      floor: null,
      expectedSeconds: 60,
    })),
  };
}

describe("local route optimizer", () => {
  const optimizer = new LocalRouteOptimizer();
  const pricedOptimizer = new LocalRouteOptimizer({
    priceTable: {
      "gpt-5.6-sol": {
        inputPerMillionUsd: 4,
        cachedInputPerMillionUsd: 0.4,
        outputPerMillionUsd: 20,
      },
      "gpt-5.6-luna": {
        inputPerMillionUsd: 0.2,
        cachedInputPerMillionUsd: 0.02,
        outputPerMillionUsd: 1.2,
      },
      "gpt-5.6-terra": {
        inputPerMillionUsd: 2,
        cachedInputPerMillionUsd: 0.2,
        outputPerMillionUsd: 12,
      },
    },
  });
  const signal = new AbortController().signal;

  it("selects direct without a model for short coupled work", () => {
    expect(
      optimizer.decide({
        runId: "run",
        request: { objective: "fix one typo", cwd: "/workspace" },
        signal,
      }),
    ).toMatchObject({ route: "direct" });
  });

  it("keeps a small decomposable task direct when planning cannot repay its overhead", () => {
    expect(
      pricedOptimizer.decide({
        runId: "run",
        request: { objective: "inspect these independent modules in parallel", cwd: "/workspace" },
        signal,
      }),
    ).toMatchObject({ route: "direct" });
  });

  it("stays direct for an automatic candidate when pricing is unavailable", () => {
    expect(
      optimizer.decide({
        runId: "run",
        request: { objective: "inspect these independent modules in parallel", cwd: "/workspace" },
        signal,
      }),
    ).toMatchObject({ route: "direct" });
  });

  it("admits automatic fanout when a warm internal planner meets the cost gate", () => {
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
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
      },
    }).decide({
      runId: "run",
      request: {
        objective:
          "Research multiple independent sources in parallel and produce a comprehensive evidence table with citations, contradictions, methods, limitations, and a detailed synthesis for every workstream.",
        cwd: "/workspace",
        domain: "autoResearch",
      },
      signal,
    });
    expect(decision).toMatchObject({ route: "fanout", suggestedMaxLeaves: 5 });
    expect(decision).toEqual(
      expect.objectContaining({
        estimatedDirectCostUsd: expect.any(Number),
        estimatedFanoutCostUsd: expect.any(Number),
        estimatedDirectSeconds: expect.any(Number),
        estimatedFanoutSeconds: expect.any(Number),
      }),
    );
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
    expect(
      recommendDirectTier({
        objective:
          "Solve the three independent exact portfolios in data/alpha/, data/beta/, and data/gamma/ separately and in parallel. Return all three complete labeled deliverables.",
        cwd: "/workspace",
        domain: "algorithm",
        constraints: ["read-only benchmark: do not modify files"],
      }),
    ).toBe("luna");
  });

  it("keeps unprofiled independent algorithm partitions direct", () => {
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
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
      },
    }).decide({
      runId: "partitioned-algorithm",
      request: {
        objective:
          "Solve the three independent exact portfolios in data/alpha/, data/beta/, and data/gamma/ separately and in parallel. Return all three complete labeled deliverables; no unit depends on another and no cross-unit synthesis is required.",
        cwd: "/workspace",
        domain: "algorithm",
        constraints: ["read-only benchmark: do not modify files"],
      },
      signal,
    });

    expect(decision).toMatchObject({
      route: "direct",
      reason: "fanout candidate lacks strong evidence that every leaf exceeds 15 seconds",
    });
  });

  it("does not admit an App Server fanout that misses the latency gate", () => {
    const optimizer = new LocalRouteOptimizer({
      maxCostRatio: 0.9,
      priceTable: {
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
      },
    });
    const decision = optimizer.decide({
      runId: "run",
      request: {
        objective:
          "Research multiple independent sources in parallel and produce a comprehensive evidence table with citations, contradictions, methods, limitations, and a detailed synthesis for every workstream.",
        cwd: "/workspace",
        domain: "autoResearch",
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "direct" });
    expect(decision.estimatedFanoutCostUsd!).toBeLessThan(decision.estimatedDirectCostUsd! * 0.9);
    expect(decision.estimatedFanoutSeconds!).toBeGreaterThan(
      decision.estimatedDirectSeconds! * 0.7,
    );
  });

  it("uses matched durable direct Sol history instead of static domain constants", () => {
    const request = {
      objective:
        "Research multiple independent sources in parallel and produce a comprehensive evidence table with citations, contradictions, methods, limitations, and a detailed synthesis for every workstream.",
      cwd: "/workspace",
      domain: "autoResearch" as const,
    };
    const historyStore = {
      readSnapshots: () =>
        [40_000, 45_000, 50_000].map((elapsedMs, index) => ({
          request,
          result: {
            status: "completed",
            plan: null,
            metrics: {
              elapsedMs,
              usageByStage: {
                direct: {
                  usage: [{ tier: "sol" }],
                  estimatedCostUsd: 0.01 + index * 0.001,
                },
              },
            },
          },
        })),
    };
    const optimizer = new LocalRouteOptimizer({
      maxCostRatio: 0.9,
      historyStore,
      priceTable: {
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
      },
    });

    const decision = optimizer.decide({ runId: "historical", request, signal });

    expect(decision).toMatchObject({
      route: "direct",
      estimatedDirectSeconds: 45,
      estimatedDirectCostUsd: 0.011,
    });
  });

  it("keeps a small cold research request direct without a domain-inflated baseline", () => {
    const historyStore = { readSnapshots: () => [] };
    const optimizer = new LocalRouteOptimizer({
      historyStore,
      priceTable: {
        "gpt-5.6-sol": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
        "gpt-5.6-terra": { inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
        "gpt-5.6-luna": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
      },
    });

    const decision = optimizer.decide({
      runId: "cold",
      request: {
        objective: "Research several independent sources in parallel and synthesize them.",
        cwd: "/workspace",
        domain: "research",
      },
      signal,
    });

    expect(decision).toMatchObject({
      route: "direct",
      estimatedDirectCostUsd: expect.any(Number),
      estimatedFanoutCostUsd: expect.any(Number),
    });
    expect(decision.estimatedDirectSeconds!).toBeGreaterThanOrEqual(30);
    expect(decision.estimatedDirectSeconds!).toBeLessThanOrEqual(45);
    expect(decision.reason).not.toContain("lacks calibrated");
  });

  it("keeps three small profiled research roots direct despite inflated Sol durations", () => {
    const workspace = readOnlyWorkspace(4);
    const objective = [
      "Prepare three independent frozen-source decision briefs.",
      `The work roots are ${workspace.roots.join(", ")}.`,
      "For each root, quantify the decision, cite its source IDs, recommend a next step, and return a complete self-contained brief.",
      "Do not modify files.",
    ].join(" ");
    const decision = pricedOptimizer.decide({
      runId: "small-profiled-research",
      request: {
        objective,
        cwd: workspace.cwd,
        domain: "research",
        semanticPlan: researchHostPlan(workspace.roots),
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "direct" });
    expect(decision.reason).toContain("misses cost/time gate");
    expect(decision.estimatedDirectSeconds!).toBeGreaterThanOrEqual(38);
    expect(decision.estimatedDirectSeconds!).toBeLessThanOrEqual(55);
  });

  it("admits three large profiled read-only roots when cost and latency pass", () => {
    const workspace = readOnlyWorkspace(16, 4_096);
    const objective = [
      "Prepare three independent frozen-source decision briefs.",
      `The work roots are ${workspace.roots.join(", ")}.`,
      "For each root, quantify the decision, cite its source IDs, recommend a next step, and return a complete self-contained brief.",
      "Do not modify files.",
    ].join(" ");
    const decision = pricedOptimizer.decide({
      runId: "large-profiled-research",
      request: {
        objective,
        cwd: workspace.cwd,
        domain: "research",
        semanticPlan: researchHostPlan(workspace.roots),
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "fanout", suggestedMaxLeaves: 3 });
    expect(decision.estimatedFanoutSeconds!).toBeLessThanOrEqual(
      decision.estimatedDirectSeconds! * 0.7,
    );
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
  });

  it("preserves economic Responses fanout for three profiled coding roots", () => {
    const workspace = readOnlyWorkspace(10, 4_096);
    const objective = [
      "Implement three independent data-processing primitives.",
      `The independent package roots are ${workspace.roots.join(", ")}.`,
      "Implement every contract, run each existing validation test, and preserve all public APIs.",
    ].join(" ");
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
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
      },
    }).decide({
      runId: "large-profiled-coding",
      request: {
        objective,
        cwd: workspace.cwd,
        domain: "coding",
        limits: { maxLeaves: 3 },
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "fanout", suggestedMaxLeaves: 3 });
    expect(decision.estimatedFanoutSeconds!).toBeLessThanOrEqual(
      decision.estimatedDirectSeconds! * 0.7,
    );
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
  });

  it("admits a many-case review when its measured work repays Responses planning", () => {
    const workspace = readOnlyWorkspace(9, 64);
    const objective = [
      "Review three independent modules without modifying files.",
      `The independent roots are ${workspace.roots.join(", ")}.`,
      "For each of the nine cases, identify the exact defective expression, user-visible consequence, and minimal correction. Return every item marker.",
      "[unit:alpha] Review all three case directories under data/alpha/. Each case is a separate required deliverable.",
      "[unit:beta] Review all three case directories under data/beta/. Each case is a separate required deliverable.",
      "[unit:gamma] Review all three case directories under data/gamma/. Each case is a separate required deliverable.",
    ].join(" ");
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
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
      },
    }).decide({
      runId: "compact-review",
      request: {
        objective,
        cwd: workspace.cwd,
        domain: "coding",
        constraints: ["read-only benchmark: do not modify files"],
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "fanout", suggestedMaxLeaves: 5 });
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
    expect(decision.estimatedFanoutSeconds!).toBeLessThanOrEqual(
      decision.estimatedDirectSeconds! * 0.7,
    );
    expect(
      recommendDirectTier({
        objective,
        cwd: workspace.cwd,
        domain: "coding",
        constraints: ["read-only benchmark: do not modify files"],
      }),
    ).toBe("luna");
  });

  it("profiles coarse roots once when prompts also name nested output paths", () => {
    const workspace = readOnlyWorkspace(8, 2_048);
    const objective = [
      "Create three independent editable workbooks in parallel.",
      `Roots: ${workspace.roots.map((root) => `${root}/`).join(", ")}.`,
      ...workspace.roots.map(
        (root, index) =>
          `[unit:${String(index)}] Own only ${root}/ including ${root}/analysis.xlsx and ${root}/result.json.`,
      ),
      "For every root calculate and verify all rows before writing its workbook.",
    ].join(" ");
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
        "gpt-5.6-sol": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
        "gpt-5.6-terra": { inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
        "gpt-5.6-luna": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
      },
    }).decide({
      runId: "nested-output-roots",
      request: {
        objective,
        cwd: workspace.cwd,
        domain: "office",
        constraints: ["workspace-write benchmark: modify only requested deliverables"],
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "fanout" });
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
    expect(decision.estimatedFanoutSeconds!).toBeLessThanOrEqual(
      decision.estimatedDirectSeconds! * 0.7,
    );
  });

  it("keeps bounded 0/1 optimality checks on Luna", () => {
    const workspace = readOnlyWorkspace(4, 512);
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
        "gpt-5.6-sol": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
        "gpt-5.6-terra": { inputPerMillionUsd: 200, outputPerMillionUsd: 1_200 },
        "gpt-5.6-luna": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
      },
    }).decide({
      runId: "bounded-optimality-luna",
      request: {
        objective: [
          "Solve twelve exact independent 0/1 cases in three parallel roots.",
          `Roots: ${workspace.roots.map((root) => `${root}/`).join(", ")}.`,
          "Use an exhaustive or dynamic-programming optimality check for all four bounded cases in each root.",
        ].join(" "),
        cwd: workspace.cwd,
        domain: "algorithm",
        constraints: ["read-only benchmark: do not modify files"],
      },
      signal,
    });

    // The deliberately prohibitive Terra price makes admission possible only with Luna leaves.
    expect(decision).toMatchObject({ route: "fanout" });
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
  });

  it("does not reserve Terra integration for independent writer roots", () => {
    const workspace = readOnlyWorkspace(6, 1_024);
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
        "gpt-5.6-sol": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
        "gpt-5.6-terra": { inputPerMillionUsd: 200, outputPerMillionUsd: 1_200 },
        "gpt-5.6-luna": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
      },
    }).decide({
      runId: "independent-writers",
      request: {
        objective: [
          "Implement and test three independent writer partitions in parallel.",
          `The separate roots are ${workspace.roots.map((root) => `${root}/`).join(", ")}.`,
          "Each root owns its files and produces its own deterministic output without cross-root synthesis.",
        ].join(" "),
        cwd: workspace.cwd,
        domain: "coding",
        constraints: ["workspace-write benchmark: modify only requested deliverables"],
      },
      signal,
    });

    // A Terra merge would fail the cost gate under this table; fanout proves deterministic merge.
    expect(decision).toMatchObject({ route: "fanout" });
    expect(decision.estimatedFanoutCostUsd!).toBeLessThanOrEqual(
      decision.estimatedDirectCostUsd! * 0.4,
    );
  });

  it("does not apply small-root direct history to a larger workload bucket", () => {
    const small = readOnlyWorkspace(4);
    const large = readOnlyWorkspace(10, 1_024);
    const objectiveFor = (roots: readonly string[]) =>
      [
        "Prepare three independent frozen-source decision briefs.",
        `The work roots are ${roots.join(", ")}.`,
        "For each root, quantify the decision, cite source IDs, recommend next steps, and return complete self-contained briefs.",
        "Do not modify files.",
      ].join(" ");
    const smallRequest = {
      objective: objectiveFor(small.roots),
      cwd: small.cwd,
      domain: "research" as const,
    };
    const historyStore = {
      readSnapshots: () =>
        [40_000, 42_000, 44_000].map((elapsedMs) => ({
          request: smallRequest,
          result: {
            status: "completed",
            plan: null,
            metrics: {
              elapsedMs,
              usageByStage: {
                direct: { usage: [{ tier: "sol" }], estimatedCostUsd: 0.02 },
              },
            },
          },
        })),
    };
    const optimizer = new LocalRouteOptimizer({
      historyStore,
      priceTable: {
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
      },
    });
    const decision = optimizer.decide({
      runId: "large-history-bucket",
      request: {
        objective: objectiveFor(large.roots),
        cwd: large.cwd,
        domain: "research",
        semanticPlan: researchHostPlan(large.roots),
      },
      signal,
    });

    expect(decision.estimatedDirectSeconds!).toBeGreaterThan(60);
    expect(decision.estimatedDirectSeconds!).toBeLessThan(80);
    expect(decision.estimatedDirectSeconds).not.toBe(42);
  });

  it("accounts for the configured planner transport before automatic admission", () => {
    const request = {
      objective:
        "Research multiple independent sources in parallel and produce a comprehensive evidence table with citations, contradictions, methods, limitations, and a detailed synthesis for every workstream.",
      cwd: "/workspace",
      domain: "autoResearch" as const,
    };
    const appServer = pricedOptimizer.decide({ runId: "heavy", request, signal });
    const responses = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
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
      },
    }).decide({ runId: "light", request, signal });

    expect(responses.estimatedFanoutCostUsd).not.toBeCloseTo(appServer.estimatedFanoutCostUsd!, 12);
    expect(responses.estimatedFanoutSeconds!).toBeLessThan(appServer.estimatedFanoutSeconds!);
    expect(responses.estimatedDirectCostUsd).toBeCloseTo(appServer.estimatedDirectCostUsd!, 12);
  });

  it("accounts for expected integration and replanning without changing the direct baseline", () => {
    const request = {
      objective:
        "Research multiple independent sources in parallel and produce a comprehensive evidence table with citations, contradictions, methods, limitations, and a detailed synthesis for every workstream.",
      cwd: "/workspace",
      domain: "autoResearch" as const,
    };
    const conservative = pricedOptimizer.decide({ runId: "full", request, signal });
    const reduced = pricedOptimizer.decide({
      runId: "reduced",
      request: { ...request, integrate: false, limits: { maxReplans: 0 } },
      signal,
    });

    expect(conservative.estimatedDirectCostUsd).toBeCloseTo(reduced.estimatedDirectCostUsd!, 12);
    expect(conservative.estimatedFanoutCostUsd!).toBeGreaterThan(reduced.estimatedFanoutCostUsd!);
  });

  it("rejects explicit fanout when economics cannot be established", () => {
    expect(
      optimizer.decide({
        runId: "run",
        request: { objective: "one task", cwd: "/workspace", strategy: "fanout" },
        signal,
      }),
    ).toMatchObject({ route: "direct" });
  });

  it("retains a valid final plan for an explicitly forced diagnostic fanout", () => {
    const plan = {
      protocolVersion: 1 as const,
      planId: "forced-plan",
      objective: "inspect independent modules",
      domain: "coding" as const,
      assumptions: [],
      tasks: ["alpha", "beta"].map((id) => ({
        id,
        objective: `inspect ${id}`,
        domain: "coding" as const,
        access: "readOnly" as const,
        ownedPaths: [`src/${id}.ts`],
        dependsOn: [],
        tier: "luna" as const,
        effort: "low" as const,
        difficulty: 0.2,
        ambiguity: 0.1,
        confidence: 0.9,
        critical: false,
        expectedSeconds: 45,
        capabilities: [],
        validation: [],
        communicationWith: [],
      })),
      integration: {
        objective: "combine results",
        requiredOutputs: ["answer"],
        validation: [],
        finalReview: "never" as const,
        aggregation: "deterministic" as const,
      },
      risk: "low" as const,
    };

    expect(
      pricedOptimizer.assessPlan!({
        runId: "forced",
        request: {
          objective: plan.objective,
          cwd: "/workspace",
          constraints: ["agent-trio-benchmark:force-fanout"],
        },
        plan,
        source: "internal",
        signal,
      }),
    ).toMatchObject({ route: "fanout", suggestedMaxLeaves: 2 });
  });

  it("rejects a short semantic plan supplied by the calling Sol", () => {
    const semanticPlan = {
      access: "readOnly" as const,
      merge: "deterministic" as const,
      risk: "low" as const,
      tasks: ["alpha", "beta"].map((id) => ({
        goal: `inspect ${id}`,
        paths: [],
        after: [],
        floor: null,
        expectedSeconds: 10,
      })),
    };
    expect(
      optimizer.decide({
        runId: "run",
        request: { objective: "inspect two modules", cwd: "/workspace", semanticPlan },
        signal,
      }),
    ).toMatchObject({
      route: "direct",
      reason: "fanout plan contains a leaf that does not exceed 15 seconds",
    });
  });

  it("does not let an unprofiled host plan bypass workload admission", () => {
    const semanticPlan = {
      access: "readOnly" as const,
      merge: "deterministic" as const,
      risk: "low" as const,
      tasks: Array.from({ length: 5 }, (_, index) => ({
        goal: `inspect module ${String(index + 1)}`,
        paths: [`src/module-${String(index + 1)}.ts`],
        after: [],
        floor: null,
        expectedSeconds: 90,
      })),
    };

    expect(
      pricedOptimizer.decide({
        runId: "run",
        request: {
          objective: `inspect five independent modules and produce a comprehensive implementation and validation report ${"detail ".repeat(300)}`,
          cwd: "/workspace",
          domain: "autoResearch",
          strategy: "fanout",
          semanticPlan,
        },
        signal,
      }),
    ).toMatchObject({
      route: "direct",
      reason: "fanout candidate lacks strong evidence that every leaf exceeds 15 seconds",
    });
  });

  it("prices a host plan from its task tier mix including the root Sol turn", () => {
    const semanticPlan = {
      access: "readOnly" as const,
      merge: "deterministic" as const,
      risk: "low" as const,
      tasks: [
        {
          goal: "inspect alpha",
          paths: [],
          after: [],
          floor: "terra" as const,
          expectedSeconds: 90,
        },
        {
          goal: "inspect beta",
          paths: [],
          after: [],
          floor: null,
          expectedSeconds: 90,
        },
      ],
    };
    const mixed = pricedOptimizer.decide({
      runId: "mixed",
      request: {
        objective: `inspect independent alpha and beta ${"detail ".repeat(300)}`,
        cwd: "/workspace",
        domain: "autoResearch",
        semanticPlan,
      },
      signal,
    });
    const allLuna = pricedOptimizer.decide({
      runId: "luna",
      request: {
        objective: `inspect independent alpha and beta ${"detail ".repeat(300)}`,
        cwd: "/workspace",
        domain: "autoResearch",
        semanticPlan: {
          access: semanticPlan.access,
          merge: semanticPlan.merge,
          risk: semanticPlan.risk,
          tasks: semanticPlan.tasks.map((task) => ({ ...task, floor: null })),
        },
      },
      signal,
    });
    const terraMerge = pricedOptimizer.decide({
      runId: "terra-merge",
      request: {
        objective: `inspect independent alpha and beta ${"detail ".repeat(300)}`,
        cwd: "/workspace",
        domain: "autoResearch",
        semanticPlan: {
          access: semanticPlan.access,
          merge: "terra",
          risk: semanticPlan.risk,
          tasks: semanticPlan.tasks.map((task) => ({ ...task, floor: null })),
        },
      },
      signal,
    });

    expect(mixed.estimatedFanoutCostUsd).toEqual(expect.any(Number));
    expect(mixed.estimatedFanoutCostUsd!).toBeGreaterThan(allLuna.estimatedFanoutCostUsd!);
    expect(terraMerge.estimatedFanoutCostUsd!).toBeGreaterThan(allLuna.estimatedFanoutCostUsd!);
    expect(allLuna.estimatedFanoutCostUsd!).toBeLessThan(allLuna.estimatedDirectCostUsd!);
  });

  it("calibrates an implausibly high host duration without changing its DAG", () => {
    const decision = pricedOptimizer.decide({
      runId: "calibrated-host-duration",
      request: {
        objective: `Audit every small TypeScript module and report each independent defect with one failing example and a minimal correction. ${"module contract detail ".repeat(30)}`,
        cwd: "/workspace",
        domain: "coding",
        semanticPlan: {
          access: "readOnly",
          merge: "deterministic",
          risk: "low",
          tasks: ["first half", "second half"].map((goal) => ({
            goal,
            paths: [],
            after: [],
            floor: null,
            expectedSeconds: 180,
          })),
        },
      },
      signal,
    });

    expect(decision).toMatchObject({ route: "direct" });
    expect(decision.estimatedFanoutSeconds!).toBeGreaterThan(
      decision.estimatedDirectSeconds! * 0.7,
    );
    expect(decision.reason).toContain("lacks strong evidence");
  });

  it("does not inflate the cold direct coding baseline to justify fanout", () => {
    const decision = new LocalRouteOptimizer({
      plannerTransport: "responses",
      priceTable: {
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
      },
    }).decide({
      runId: "coding-cold",
      request: {
        objective:
          "Implement three independent data-processing primitives in separate package roots, run each existing test, and preserve all public contracts.",
        cwd: "/workspace",
        domain: "coding",
      },
      signal,
    });

    expect(decision.estimatedDirectCostUsd!).toBeGreaterThan(0.02);
    expect(decision.estimatedDirectCostUsd!).toBeLessThan(0.05);
    expect(decision).toMatchObject({ route: "direct" });
    expect(decision.reason).toContain("lacks strong evidence");
  });

  it("uses Luna for bounded direct work and Terra for high-risk work", () => {
    const independentWorkspace = readOnlyWorkspace(1).cwd;
    expect(recommendDirectTier({ objective: "fix one typo", cwd: "/workspace" })).toBe("luna");
    expect(
      recommendDirectTier({
        objective: "redesign the authentication security architecture",
        cwd: "/workspace",
        domain: "coding",
      }),
    ).toBe("terra");
    expect(
      recommendDirectTier({ objective: "prove the bound", cwd: "/workspace", domain: "algorithm" }),
    ).toBe("terra");
    expect(
      recommendDirectTier({
        objective: "Reconcile five bounded exact-subset fixtures.",
        cwd: "/workspace",
        domain: "algorithm",
        constraints: ["read-only benchmark: do not modify files"],
      }),
    ).toBe("luna");
    expect(
      recommendDirectTier({
        objective: "Audit many modules after fanout admission was rejected.",
        cwd: "/workspace",
        domain: "coding",
        semanticPlan: {
          access: "readOnly",
          merge: "deterministic",
          risk: "low",
          tasks: ["alpha", "beta"].map((goal) => ({
            goal,
            paths: [],
            after: [],
            floor: null,
            expectedSeconds: 90,
          })),
        },
      }),
    ).toBe("luna");
    expect(
      recommendDirectTier({
        objective:
          "Reconcile the supplied frozen vendor records, calculate exact totals, and write a concise risk dossier.",
        cwd: "/workspace",
        domain: "autoResearch",
        constraints: ["read-only benchmark: do not modify files"],
      }),
    ).toBe("luna");
    expect(
      recommendDirectTier({
        objective:
          "Run three independent local data pipelines under data/alpha/, data/beta/, and data/gamma/; each root owns its JSON and Markdown outputs.",
        cwd: independentWorkspace,
        domain: "autoResearch",
      }),
    ).toBe("luna");
    expect(
      recommendDirectTier({
        objective: "Browse live sources and perform a statistical meta-analysis.",
        cwd: "/workspace",
        domain: "research",
        constraints: ["read-only workspace"],
      }),
    ).toBe("terra");
    expect(
      recommendDirectTier({
        objective: "Rewrite one paragraph, preserve every number, and do not add claims.",
        cwd: "/workspace",
        domain: "paper",
      }),
    ).toBe("luna");
    expect(
      recommendDirectTier({
        objective: "Review the full paper and verify every citation and statistical claim.",
        cwd: "/workspace",
        domain: "paper",
      }),
    ).toBe("terra");
  });
});
