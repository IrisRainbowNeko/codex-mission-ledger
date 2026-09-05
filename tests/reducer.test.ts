import { describe, expect, it } from "vitest";
import type { ExecutionPlan, LeafResult } from "../src/core/contracts.js";
import { canAutomaticallyReduce, reduceLeafResults } from "../src/core/reducer.js";

function plan(): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "reduce-plan",
    objective: "inspect two files",
    domain: "coding",
    assumptions: [],
    tasks: ["a", "b"].map((id) => ({
      id,
      objective: `inspect ${id}`,
      domain: "coding" as const,
      tier: "luna" as const,
      effort: "low" as const,
      access: "readOnly" as const,
      ownedPaths: [],
      dependsOn: [],
      capabilities: [],
      validation: [],
      communicationWith: [],
      expectedSeconds: 60,
      difficulty: 0.1,
      ambiguity: 0.1,
      confidence: 0.9,
      critical: false,
    })),
    integration: {
      objective: "report",
      requiredOutputs: ["summary"],
      validation: [],
      finalReview: "never",
      aggregation: "deterministic",
    },
    risk: "low",
  };
}

function leaf(taskId: string, status: LeafResult["status"] = "completed"): LeafResult {
  return {
    taskId,
    status,
    summary: `${taskId} complete`,
    confidence: 0.9,
    findings: [{ text: "same finding", path: `src/${taskId}.ts` }],
    changedFiles: [],
    validation: [],
    citations: [{ title: "source", url: "https://example.com/source" }],
    artifacts: [{ path: `artifacts/${taskId}.json` }],
    messages: [],
    threadId: null,
    turnId: null,
    usage: [],
    startedAt: null,
    completedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("deterministic result reducer", () => {
  it("combines compact result metadata without a model call", () => {
    const result = reduceLeafResults(plan(), [leaf("a"), leaf("b")]);
    expect(result).toMatchObject({ status: "completed", threadId: null, usage: [] });
    expect(result.response).toContain("a: a complete");
    expect(result.response).toContain("b: b complete");
    expect(result.response).toContain("src/a.ts: same finding");
    expect(result.response).toContain("src/b.ts: same finding");
    expect(result.response).toContain("artifacts/a.json");
    expect(result.response).toContain("https://example.com/source");
  });

  it("does not discard sibling summaries when one leaf also reports a finding", () => {
    const first = leaf("a");
    first.findings = [];
    first.summary = "complete deliverable A";
    const second = leaf("b");
    second.summary = "complete deliverable B with all required facts";
    second.findings = [{ text: "complete deliverable B with all required...", path: "src/b.ts" }];

    const result = reduceLeafResults(plan(), [first, second]);

    expect(result.response).toContain("a: complete deliverable A");
    expect(result.response).toContain("b: complete deliverable B with all required facts");
    expect(result.response).not.toContain("src/b.ts");
  });

  it("orders findings by plan task rather than completion order", () => {
    const result = reduceLeafResults(plan(), [leaf("b"), leaf("a")]);
    expect(result.response!.indexOf("src/a.ts")).toBeLessThan(result.response!.indexOf("src/b.ts"));
  });

  it("fails closed when a leaf is incomplete", () => {
    expect(reduceLeafResults(plan(), [leaf("a", "blocked")])).toMatchObject({
      status: "failed",
      response: null,
    });
  });

  it("delivers the sole downstream writer result without repeating preparation summaries", () => {
    const candidate = plan();
    candidate.domain = "office";
    candidate.tasks[0]!.access = "readOnly";
    candidate.tasks[1]!.access = "workspaceWrite";
    candidate.tasks[1]!.dependsOn = ["a"];
    const result = reduceLeafResults(candidate, [leaf("a"), leaf("b")]);

    expect(result.response).not.toContain("a: a complete");
    expect(result.response).toContain("b: b complete");
    expect(result.response).toContain("artifacts/b.json");
    expect(result.response).not.toContain("artifacts/a.json");
  });

  it("automatically reduces only low-risk independent read-only results", () => {
    const candidate = plan();
    candidate.integration.aggregation = "auto";
    candidate.tasks = [
      {
        id: "a",
        objective: "inspect a",
        domain: "coding",
        tier: "luna",
        effort: "low",
        access: "readOnly",
        ownedPaths: [],
        dependsOn: [],
        capabilities: [],
        validation: [],
        communicationWith: [],
        expectedSeconds: 60,
        difficulty: 0.1,
        ambiguity: 0.1,
        confidence: 0.9,
        critical: false,
      },
    ];
    expect(canAutomaticallyReduce(candidate, [leaf("a")])).toBe(true);
    candidate.tasks[0]!.access = "workspaceWrite";
    expect(canAutomaticallyReduce(candidate, [leaf("a")])).toBe(false);
  });
});
