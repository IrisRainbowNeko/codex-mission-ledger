import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCatalog } from "../src/core/capabilities.js";
import type { JobSnapshot, LeafResult, LeafTask, RunRequest } from "../src/core/contracts.js";
import { hashRunRequest } from "../src/core/job-store.js";
import {
  mergeHistoricalLatencies,
  summarizeHistoricalLeafLatencies,
  WorkspacePlannerContextProvider,
} from "../src/core/planner-context.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkspacePlannerContextProvider", () => {
  it("builds a bounded index and excludes the Agent Trio project skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-planner-context-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    const capabilities: CapabilityCatalog = {
      listSkills: async () => [
        {
          name: "agent-trio",
          path: root,
          enabled: true,
          pluginId: null,
          source: "repo",
        },
        {
          name: "documents",
          path: root,
          enabled: true,
          pluginId: null,
          source: "system",
        },
      ],
      listPlugins: async () => [{ id: "browser", enabled: true }],
    };
    const provider = new WorkspacePlannerContextProvider({
      capabilities,
      economics: [{ tier: "luna", model: "gpt-5.6-luna", latencyP50Seconds: 20 }],
    });

    const context = await provider.load({ objective: "inspect", cwd: root });

    expect(context.workspaceKind).toBe("directory");
    expect(context.workspaceFiles).toEqual(expect.arrayContaining(["index.ts", "package.json"]));
    expect(context.keyFiles).toEqual([{ path: "package.json", excerpt: '{"name":"fixture"}\n' }]);
    expect(context.capabilities).toEqual([
      { kind: "skill", name: "documents", source: "system" },
      { kind: "plugin", name: "browser" },
    ]);
    expect(context.economics[0]?.latencyP50Seconds).toBe(20);
  });

  it("retains paths for duplicate names and source identity for plugin-backed skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-planner-context-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    const repoBrowser = join(root, "repo-browser", "SKILL.md");
    const pluginBrowser = join(root, "plugin-browser", "SKILL.md");
    const capabilities: CapabilityCatalog = {
      listSkills: async () => [
        {
          name: "documents",
          path: join(root, "system-documents", "SKILL.md"),
          enabled: true,
          pluginId: null,
          source: "system",
        },
        {
          name: "browser",
          path: repoBrowser,
          enabled: true,
          pluginId: null,
          source: "repo",
        },
        {
          name: "browser",
          path: pluginBrowser,
          enabled: true,
          pluginId: "browser@openai-bundled",
          source: "system",
        },
        {
          name: "browser",
          path: pluginBrowser,
          enabled: true,
          pluginId: "browser@openai-bundled",
          source: "system",
        },
        {
          name: "ordinary",
          path: join(root, "hierarchical-codex", "skills", "ordinary", "SKILL.md"),
          enabled: true,
          pluginId: null,
          source: "repo",
        },
        {
          name: "hidden-owner",
          path: join(root, "hidden-owner", "SKILL.md"),
          enabled: true,
          pluginId: "hierarchical_codex@personal",
          source: "user",
        },
      ],
      listPlugins: async () => [
        { id: "browser@openai-bundled", enabled: true },
        { id: "agent-trio@personal", enabled: true },
      ],
    };
    const provider = new WorkspacePlannerContextProvider({ capabilities });

    const context = await provider.load({ objective: "inspect", cwd: root });

    expect(context.capabilities).toEqual([
      { kind: "skill", name: "documents", source: "system" },
      { kind: "skill", name: "browser", path: repoBrowser, source: "repo" },
      {
        kind: "skill",
        name: "browser",
        path: pluginBrowser,
        source: "system",
        pluginId: "browser@openai-bundled",
      },
      { kind: "skill", name: "ordinary", source: "repo" },
      { kind: "plugin", name: "browser@openai-bundled" },
    ]);
  });

  it("merges bounded successful leaf percentiles while ignoring malformed samples", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-planner-context-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    const tasks = [
      historyTask("luna-10", "luna"),
      historyTask("luna-20", "luna"),
      historyTask("luna-30", "luna"),
      historyTask("luna-ignored-cap", "luna"),
      historyTask("terra-15", "terra"),
      historyTask("failed-sol", "sol"),
      historyTask("missing-start", "sol"),
      historyTask("backwards", "sol"),
    ];
    const snapshot = historySnapshot("history-1", tasks, [
      completedLeaf("luna-10", 10),
      completedLeaf("luna-20", 20),
      completedLeaf("luna-30", 30),
      completedLeaf("luna-ignored-cap", 900),
      completedLeaf("terra-15", 15),
      { ...completedLeaf("failed-sol", 50), status: "failed" },
      { ...completedLeaf("missing-start", 50), startedAt: null },
      {
        ...completedLeaf("backwards", 50),
        startedAt: "2026-08-28T00:01:00.000Z",
        completedAt: "2026-08-28T00:00:00.000Z",
      },
      completedLeaf("unknown-task", 500),
      completedLeaf("luna-10", 700),
    ]);
    const malformed = { result: { plan: null, leaves: null } } as unknown as JobSnapshot;

    const summary = summarizeHistoricalLeafLatencies([snapshot, malformed], 3);
    expect(summary).toEqual([
      {
        tier: "luna",
        sampleCount: 3,
        latencyP50Seconds: 20,
        latencyP95Seconds: 30,
      },
      {
        tier: "terra",
        sampleCount: 1,
        latencyP50Seconds: 15,
        latencyP95Seconds: 15,
      },
    ]);
    expect(
      mergeHistoricalLatencies(
        [
          {
            tier: "luna",
            model: "luna-priced",
            uncachedInputPerMillion: 2,
            outputPerMillion: 8,
          },
          { tier: "terra", model: "terra-priced", latencyP50Seconds: 99 },
          { tier: "sol", model: "sol-priced", latencyP50Seconds: 77 },
        ],
        summary,
      ),
    ).toEqual([
      {
        tier: "luna",
        model: "luna-priced",
        uncachedInputPerMillion: 2,
        outputPerMillion: 8,
        latencyP50Seconds: 20,
        latencyP95Seconds: 30,
      },
      {
        tier: "terra",
        model: "terra-priced",
        latencyP50Seconds: 15,
        latencyP95Seconds: 15,
      },
      { tier: "sol", model: "sol-priced", latencyP50Seconds: 77 },
    ]);

    const readSnapshots = vi.fn(() => [snapshot, malformed]);
    const provider = new WorkspacePlannerContextProvider({
      economics: [
        {
          tier: "luna",
          model: "luna-priced",
          uncachedInputPerMillion: 2,
          outputPerMillion: 8,
        },
      ],
      historyStore: { readSnapshots },
      historyMaxJobs: 7,
      historyMaxSamplesPerTier: 3,
    });

    const context = await provider.load({ objective: "plan", cwd: root });
    expect(readSnapshots).toHaveBeenCalledWith({ maxJobs: 7 });
    expect(context.economics).toEqual([
      {
        tier: "luna",
        model: "luna-priced",
        uncachedInputPerMillion: 2,
        outputPerMillion: 8,
        latencyP50Seconds: 20,
        latencyP95Seconds: 30,
      },
    ]);
  });
});

function historyTask(id: string, tier: LeafTask["tier"]): LeafTask {
  return {
    id,
    objective: id,
    domain: "coding",
    tier,
    effort: tier === "luna" ? "medium" : "high",
    access: "readOnly",
    ownedPaths: [],
    dependsOn: [],
    capabilities: [],
    validation: [],
    communicationWith: [],
    expectedSeconds: 60,
    difficulty: 0.4,
    ambiguity: 0.2,
    confidence: 0.9,
    critical: false,
  };
}

function completedLeaf(taskId: string, durationSeconds: number): LeafResult {
  const startedAt = Date.parse("2026-08-28T00:00:00.000Z");
  return {
    taskId,
    status: "completed",
    summary: "complete",
    confidence: 0.9,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: "thread-history",
    turnId: "turn-history",
    usage: [],
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + durationSeconds * 1_000).toISOString(),
  };
}

function historySnapshot(runId: string, tasks: LeafTask[], leaves: LeafResult[]): JobSnapshot {
  const request: RunRequest = { objective: "historical run", cwd: "/workspace" };
  return {
    protocolVersion: 1,
    requestHash: hashRunRequest(request),
    request,
    result: {
      protocolVersion: 1,
      runId,
      status: "completed",
      plan: {
        protocolVersion: 1,
        planId: `plan-${runId}`,
        objective: request.objective,
        domain: "coding",
        assumptions: [],
        tasks,
        integration: {
          objective: "summarize",
          requiredOutputs: ["summary"],
          validation: [],
          finalReview: "never",
        },
        risk: "low",
      },
      patch: null,
      leaves,
      finalResponse: "done",
      metrics: null,
    },
    remoteTurns: [],
    coordinatorThreadId: null,
    plannerThreadId: null,
    integratorThreadId: null,
    updatedAt: "2026-08-28T01:00:00.000Z",
  };
}
