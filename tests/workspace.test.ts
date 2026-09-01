import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionPlan, LeafResult, LeafTask } from "../src/core/contracts.js";
import { DeterministicScheduler, type LeafExecutor } from "../src/core/scheduler.js";
import {
  applyPatchTransaction,
  assertDisjointPatchChanges,
  assertDisjointWriterOwnership,
  prepareWorkspace,
  validateOwnedPaths,
  WorkspaceRegistry,
} from "../src/core/workspace.js";
import type { IntegrationPatch } from "../src/core/workspace.js";

const roots: string[] = [];
const gitIntegrationIt = process.env["AGENT_TRIO_RUN_GIT_TESTS"] === "1" ? it : it.skip;
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writer(id: string, ownedPath: string): LeafTask {
  return {
    id,
    objective: id,
    domain: "coding",
    tier: "luna",
    effort: "medium",
    access: "workspaceWrite",
    ownedPaths: [ownedPath],
    dependsOn: [],
    capabilities: [],
    validation: [],
    communicationWith: [],
    expectedSeconds: 60,
    difficulty: 0.2,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
  };
}

function reader(id: string, dependsOn: string[]): LeafTask {
  return {
    ...writer(id, "."),
    access: "readOnly",
    ownedPaths: [],
    dependsOn,
  };
}

function plan(tasks: LeafTask[]): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan",
    objective: "edit",
    domain: "coding",
    assumptions: [],
    tasks,
    integration: {
      objective: "integrate",
      requiredOutputs: [],
      validation: [],
      finalReview: "riskTriggered",
    },
    risk: "medium",
  };
}

function result(taskId: string): LeafResult {
  return {
    taskId,
    status: "completed",
    summary: "done",
    confidence: 1,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: null,
    turnId: null,
    usage: [],
    startedAt: null,
    completedAt: new Date().toISOString(),
  };
}

function patch(taskId: string, ...changedPaths: string[]): IntegrationPatch {
  return { taskId, patchPath: `/patches/${taskId}.patch`, changedPaths };
}

function initializeGitRepository(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(root, path), contents);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Agent Trio",
      "-c",
      "user.email=agent@example.invalid",
      "commit",
      "-qm",
      "base",
    ],
    { cwd: root },
  );
}

function onlyChildDirectory(root: string): string {
  const child = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory());
  if (child === undefined) {
    throw new Error(`expected a child directory below ${root}`);
  }
  return join(root, child.name);
}

function workspaceStateDirectory(stateRoot: string): string {
  return onlyChildDirectory(onlyChildDirectory(stateRoot));
}

describe("workspace isolation", () => {
  gitIntegrationIt(
    "repairs a failed writer validator in the same worktree and integrates only the repaired patch",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
      roots.push(root);
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "validation"));
      initializeGitRepository(root, {
        "src/value.mjs": "export const value = 0;\n",
        "validation/value.test.mjs":
          'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../src/value.mjs";\ntest("value", () => assert.equal(value, 2));\n',
      });
      const task = {
        ...writer("writer", "src/value.mjs"),
        validation: [{ command: "node --test validation/value.test.mjs" }],
      };
      const executionPlan = plan([task]);
      const registry = new WorkspaceRegistry();
      await registry.prepare({
        runId: "validator-repair",
        request: { cwd: root },
        plan: executionPlan,
      });
      const gitCommonDir = realpathSync(join(root, ".git"));
      const calls: Array<{ attempt: number; tier: LeafTask["tier"]; cwd: string }> = [];
      const executor: LeafExecutor = {
        runLeaf: async ({ task: activeTask, dependencies, attempt, retry }) => {
          const cwd =
            retry === undefined
              ? await registry.prepareTask("validator-repair", activeTask, dependencies)
              : registry.cwdFor("validator-repair", activeTask);
          calls.push({ attempt, tier: activeTask.tier, cwd });
          writeFileSync(
            join(cwd, "src/value.mjs"),
            attempt === 1 ? "export const value = 1;\n" : "export const value = 2;\n",
          );
          let passed = true;
          try {
            execFileSync("node", ["--test", "validation/value.test.mjs"], { cwd });
          } catch {
            passed = false;
          }
          return {
            ...result(activeTask.id),
            status: passed ? "completed" : "failed",
            summary: passed ? "validator passed" : "validator failed",
            changedFiles: ["src/value.mjs"],
            validation: [
              {
                command: "node --test validation/value.test.mjs",
                status: passed ? "passed" : "failed",
                summary: passed ? "exit code 0" : "exit code 1",
              },
            ],
            ...(passed ? {} : { error: "exit code 1", failureKind: "validation" as const }),
          };
        },
      };

      try {
        const scheduled = await new DeterministicScheduler(executor, {
          replan: async () => null,
          answer: async () => "answer",
        }).execute("validator-repair", executionPlan, {
          maxConcurrent: 1,
          maxLeaves: 2,
          maxWaves: 1,
          maxSolLeaves: 1,
          maxReplans: 1,
        });

        expect(calls).toHaveLength(2);
        expect(calls.map(({ attempt, tier }) => ({ attempt, tier }))).toEqual([
          { attempt: 1, tier: "luna" },
          { attempt: 2, tier: "terra" },
        ]);
        expect(calls[1]?.cwd).toBe(calls[0]?.cwd);
        expect(calls[0]?.cwd.startsWith(`${gitCommonDir}/`)).toBe(false);
        expect(scheduled.leaves).toEqual([
          expect.objectContaining({ taskId: "writer", status: "completed" }),
        ]);

        await registry.integrate("validator-repair", scheduled.leaves);
        expect(readFileSync(join(root, "src/value.mjs"), "utf8")).toBe("export const value = 2;\n");
        expect(() =>
          execFileSync("node", ["--test", "validation/value.test.mjs"], { cwd: root }),
        ).not.toThrow();
      } finally {
        await registry.cleanup("validator-repair");
      }
    },
  );

  it("rejects run ids that could escape durable workspace state", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    const registry = new WorkspaceRegistry();
    await expect(
      registry.prepare({
        runId: "../outside",
        request: { cwd: root },
        plan: plan([]),
      }),
    ).rejects.toThrow("runId");
  });

  it("rejects paths escaping the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    expect(() => validateOwnedPaths(root, writer("a", "../outside"))).toThrow("escapes");
    expect(() => validateOwnedPaths(root, writer("a", "src/../outside"))).toThrow(
      "invalid owned path",
    );
  });

  it("requires disjoint ownership contracts for parallel writers", () => {
    expect(() =>
      assertDisjointWriterOwnership([writer("a", "src"), writer("b", "src/api/client.ts")]),
    ).toThrow("ownership overlaps");
    expect(() =>
      assertDisjointWriterOwnership([writer("a", "src/api"), writer("b", "src/ui")]),
    ).not.toThrow();
  });

  it("requires Git isolation for multiple writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    await expect(
      prepareWorkspace(plan([writer("a", "a.txt"), writer("b", "b.txt")]), root, "run"),
    ).rejects.toThrow("clean Git workspace");
  });

  it("does not rerun a replaced writer in a shared non-Git workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    writeFileSync(join(root, "a.txt"), "a0\n");
    writeFileSync(join(root, "b.txt"), "b0\n");
    const initial = writer("writer", "a.txt");
    const prepared = await prepareWorkspace(plan([initial]), root, "shared-writer");
    expect(await prepared.prepareTask(initial, [])).toBe(root);
    writeFileSync(join(root, "a.txt"), "partial\n");

    await expect(prepared.updatePlan(plan([writer("writer", "b.txt")]))).rejects.toThrow(
      "cannot replace a writer",
    );
    await expect(prepared.updatePlan(plan([initial, writer("second", "b.txt")]))).rejects.toThrow(
      "clean Git workspace",
    );
    await prepared.cleanup();
  });

  it("recovers cleanup_pending shared state as cleanup-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "agent-trio-state-"));
    roots.push(root, stateRoot);
    writeFileSync(join(root, "a.txt"), "a0\n");
    const task = writer("writer", "a.txt");
    const executionPlan = plan([task]);
    const crashedProcess = new WorkspaceRegistry({ stateRoot });
    await crashedProcess.prepare({
      runId: "shared-cleanup-crash",
      request: { cwd: root },
      plan: executionPlan,
    });
    await crashedProcess.prepareTask("shared-cleanup-crash", task, []);

    const sessionDirectory = workspaceStateDirectory(stateRoot);
    const manifestPath = join(sessionDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { phase: string };
    manifest.phase = "cleanup_pending";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const restartedProcess = new WorkspaceRegistry({ stateRoot });
    await restartedProcess.resume({
      runId: "shared-cleanup-crash",
      request: { cwd: root },
      plan: executionPlan,
      results: [result("writer")],
    });
    await expect(restartedProcess.prepareTask("shared-cleanup-crash", task, [])).rejects.toThrow(
      "pending cleanup",
    );
    await restartedProcess.cleanup("shared-cleanup-crash");
    expect(existsSync(sessionDirectory)).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a0\n");
  });

  it("rejects exact and directory-level patch overlap before integration", () => {
    expect(() =>
      assertDisjointPatchChanges([patch("a", "src/a.ts"), patch("b", "src/b.ts")]),
    ).not.toThrow();
    expect(() =>
      assertDisjointPatchChanges([patch("a", "src/a.ts"), patch("b", "src/a.ts")]),
    ).toThrow("patches overlap");
    expect(() =>
      assertDisjointPatchChanges([patch("a", "assets"), patch("b", "assets/icon.png")]),
    ).toThrow("patches overlap");
  });

  it("preflights the complete patch set and rolls back prior patches in reverse order", async () => {
    const operations: string[] = [];
    const patches = [patch("a", "a.txt"), patch("b", "b.txt"), patch("c", "c.txt")];

    await expect(
      applyPatchTransaction(patches, {
        preflight: async (pending) => {
          operations.push(`preflight:${pending.map((item) => item.taskId).join(",")}`);
        },
        apply: async (pending) => {
          operations.push(`apply:${pending.taskId}`);
          if (pending.taskId === "c") {
            throw new Error("unexpected apply failure");
          }
        },
        rollback: async (applied) => {
          operations.push(`rollback:${applied.taskId}`);
        },
      }),
    ).rejects.toThrow("applied patches were rolled back");
    expect(operations).toEqual([
      "preflight:a,b,c",
      "apply:a",
      "apply:b",
      "apply:c",
      "rollback:b",
      "rollback:a",
    ]);
  });

  it("does not mutate the workspace when set preflight fails", async () => {
    let applications = 0;
    await expect(
      applyPatchTransaction([patch("a", "a.txt"), patch("b", "b.txt")], {
        preflight: async () => {
          throw new Error("conflict");
        },
        apply: async () => {
          applications += 1;
        },
        rollback: async () => undefined,
      }),
    ).rejects.toThrow("conflict");
    expect(applications).toBe(0);
  });

  gitIntegrationIt("merges disjoint writer worktrees into a clean repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    writeFileSync(join(root, "a.txt"), "a0\n");
    writeFileSync(join(root, "b.txt"), "b0\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Agent Trio",
        "-c",
        "user.email=agent@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: root },
    );

    const prepared = await prepareWorkspace(
      plan([writer("a", "a.txt"), writer("b", "b.txt")]),
      root,
      "run",
    );
    const a = prepared.assignments.get("a");
    const b = prepared.assignments.get("b");
    expect(a?.isolated).toBe(true);
    expect(b?.isolated).toBe(true);
    await prepared.prepareTask(writer("a", "a.txt"), []);
    await prepared.prepareTask(writer("b", "b.txt"), []);
    writeFileSync(join(a?.cwd ?? "", "a.txt"), "a1\n");
    writeFileSync(join(b?.cwd ?? "", "b.txt"), "b1\n");
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Leaf",
        "-c",
        "user.email=leaf@example.invalid",
        "commit",
        "-qam",
        "leaf commit",
      ],
      { cwd: a?.cwd },
    );
    await prepared.integrate([result("a"), result("b")]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b1\n");
    await prepared.cleanup();
  });

  gitIntegrationIt("propagates changes between dependency-ordered isolated writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    mkdirSync(join(root, "src", "core"), { recursive: true });
    mkdirSync(join(root, "src", "ui"), { recursive: true });
    writeFileSync(join(root, "src", "core", "a.txt"), "a0\n");
    writeFileSync(join(root, "src", "core", "shared.txt"), "b0\n");
    writeFileSync(join(root, "src", "ui", "c.txt"), "c0\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Agent Trio",
        "-c",
        "user.email=agent@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: root },
    );
    const first = writer("a", "src/core");
    const second = { ...writer("b", "src/core/shared.txt"), dependsOn: ["a"] };
    const independent = writer("c", "src/ui");

    const prepared = await prepareWorkspace(
      plan([first, second, independent]),
      root,
      "ordered-overlap",
    );
    const a = prepared.assignments.get("a");
    const b = prepared.assignments.get("b");
    const c = prepared.assignments.get("c");
    expect(a?.worktreeRoot).not.toBe(b?.worktreeRoot);
    expect(c?.worktreeRoot).not.toBe(a?.worktreeRoot);
    await prepared.prepareTask(first, []);
    writeFileSync(join(a?.cwd ?? "", "src", "core", "a.txt"), "a1\n");
    writeFileSync(join(a?.cwd ?? "", "src", "core", "shared.txt"), "from-a\n");
    expect(() => prepared.cwdFor(second)).toThrow("prepareTask");
    await prepared.prepareTask(second, [result("a")]);
    expect(readFileSync(join(b?.cwd ?? "", "src", "core", "a.txt"), "utf8")).toBe("a1\n");
    expect(readFileSync(join(b?.cwd ?? "", "src", "core", "shared.txt"), "utf8")).toBe("from-a\n");
    writeFileSync(join(b?.cwd ?? "", "src", "core", "shared.txt"), "b1\n");
    await prepared.prepareTask(independent, []);
    writeFileSync(join(c?.cwd ?? "", "src", "ui", "c.txt"), "c1\n");

    await prepared.integrate([result("a"), result("b"), result("c")]);
    expect(readFileSync(join(root, "src", "core", "a.txt"), "utf8")).toBe("a1\n");
    expect(readFileSync(join(root, "src", "core", "shared.txt"), "utf8")).toBe("b1\n");
    expect(readFileSync(join(root, "src", "ui", "c.txt"), "utf8")).toBe("c1\n");
    await prepared.cleanup();
  });

  gitIntegrationIt("materializes a read-only join from independent writer snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    writeFileSync(join(root, "a.txt"), "a0\n");
    writeFileSync(join(root, "b.txt"), "b0\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Agent Trio",
        "-c",
        "user.email=agent@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: root },
    );
    const aTask = writer("a", "a.txt");
    const bTask = writer("b", "b.txt");
    const joinTask = reader("join", ["a", "b"]);
    const prepared = await prepareWorkspace(plan([aTask, bTask, joinTask]), root, "read-join");

    const aCwd = await prepared.prepareTask(aTask, []);
    const bCwd = await prepared.prepareTask(bTask, []);
    expect(aCwd).not.toBe(bCwd);
    writeFileSync(join(aCwd, "a.txt"), "a1\n");
    writeFileSync(join(bCwd, "b.txt"), "b1\n");

    const joinCwd = await prepared.prepareTask(joinTask, [result("a"), result("b")]);
    expect(joinCwd).not.toBe(aCwd);
    expect(joinCwd).not.toBe(bCwd);
    expect(readFileSync(join(joinCwd, "a.txt"), "utf8")).toBe("a1\n");
    expect(readFileSync(join(joinCwd, "b.txt"), "utf8")).toBe("b1\n");

    await prepared.integrate([result("a"), result("b"), result("join")]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b1\n");
    await prepared.cleanup();
  });

  gitIntegrationIt(
    "materializes aggregate validation without mutating the user's workspace",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
      roots.push(root);
      writeFileSync(join(root, "a.txt"), "a0\n");
      writeFileSync(join(root, "b.txt"), "b0\n");
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Agent Trio",
          "-c",
          "user.email=agent@example.invalid",
          "commit",
          "-qm",
          "base",
        ],
        { cwd: root },
      );
      const aTask = writer("a", "a.txt");
      const bTask = writer("b", "b.txt");
      const prepared = await prepareWorkspace(plan([aTask, bTask]), root, "aggregate-validation");

      const aCwd = await prepared.prepareTask(aTask, []);
      const bCwd = await prepared.prepareTask(bTask, []);
      writeFileSync(join(aCwd, "a.txt"), "a1\n");
      writeFileSync(join(bCwd, "b.txt"), "b1\n");

      const validationCwd = await prepared.prepareValidation([result("a"), result("b")]);
      expect(validationCwd).not.toBe(root);
      expect(readFileSync(join(validationCwd, "a.txt"), "utf8")).toBe("a1\n");
      expect(readFileSync(join(validationCwd, "b.txt"), "utf8")).toBe("b1\n");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a0\n");
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b0\n");

      await prepared.integrate([result("a"), result("b")]);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\n");
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b1\n");
      await prepared.cleanup();
    },
  );

  gitIntegrationIt(
    "keeps forked downstream writers isolated while inheriting their parent",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
      roots.push(root);
      writeFileSync(join(root, "base.txt"), "base0\n");
      writeFileSync(join(root, "left.txt"), "left0\n");
      writeFileSync(join(root, "right.txt"), "right0\n");
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Agent Trio",
          "-c",
          "user.email=agent@example.invalid",
          "commit",
          "-qm",
          "base",
        ],
        { cwd: root },
      );
      const parent = writer("parent", "base.txt");
      const left = { ...writer("left", "left.txt"), dependsOn: ["parent"] };
      const right = { ...writer("right", "right.txt"), dependsOn: ["parent"] };
      const prepared = await prepareWorkspace(plan([parent, left, right]), root, "writer-fork");

      const parentCwd = await prepared.prepareTask(parent, []);
      writeFileSync(join(parentCwd, "base.txt"), "base1\n");
      const [leftCwd, rightCwd] = await Promise.all([
        prepared.prepareTask(left, [result("parent")]),
        prepared.prepareTask(right, [result("parent")]),
      ]);
      expect(leftCwd).not.toBe(rightCwd);
      expect(readFileSync(join(leftCwd, "base.txt"), "utf8")).toBe("base1\n");
      expect(readFileSync(join(rightCwd, "base.txt"), "utf8")).toBe("base1\n");
      writeFileSync(join(leftCwd, "left.txt"), "left1\n");
      writeFileSync(join(rightCwd, "right.txt"), "right1\n");

      await prepared.integrate([result("parent"), result("left"), result("right")]);
      expect(readFileSync(join(root, "base.txt"), "utf8")).toBe("base1\n");
      expect(readFileSync(join(root, "left.txt"), "utf8")).toBe("left1\n");
      expect(readFileSync(join(root, "right.txt"), "utf8")).toBe("right1\n");
      await prepared.cleanup();
    },
  );

  gitIntegrationIt("assigns PlanPatch-added and replaced writers before they launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    roots.push(root);
    writeFileSync(join(root, "a.txt"), "a0\n");
    writeFileSync(join(root, "b.txt"), "b0\n");
    writeFileSync(join(root, "replacement.txt"), "r0\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Agent Trio",
        "-c",
        "user.email=agent@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: root },
    );
    const aTask = writer("a", "a.txt");
    const prepared = await prepareWorkspace(plan([aTask]), root, "patch-writer");
    const aCwd = await prepared.prepareTask(aTask, []);
    writeFileSync(join(aCwd, "a.txt"), "a1\n");

    const added = { ...writer("b", "b.txt"), dependsOn: ["a"] };
    await expect(prepared.prepareTask(added, [result("a")])).rejects.toThrow("updatePlan");
    await prepared.updatePlan(plan([aTask, added]));
    const firstAssignment = prepared.assignments.get("b")?.worktreeRoot;
    expect(() => prepared.cwdFor(added)).toThrow("prepareTask");

    const replacement = { ...writer("b", "replacement.txt"), dependsOn: ["a"] };
    await prepared.updatePlan(plan([aTask, replacement]));
    expect(prepared.assignments.get("b")?.worktreeRoot).not.toBe(firstAssignment);
    const replacementCwd = await prepared.prepareTask(replacement, [result("a")]);
    expect(replacementCwd).not.toBe(aCwd);
    expect(readFileSync(join(replacementCwd, "a.txt"), "utf8")).toBe("a1\n");
    writeFileSync(join(replacementCwd, "replacement.txt"), "r1\n");

    await prepared.integrate([result("a"), result("b")]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\n");
    expect(readFileSync(join(root, "replacement.txt"), "utf8")).toBe("r1\n");
    await prepared.cleanup();
  });

  gitIntegrationIt(
    "preserves an existing writer worktree when a PlanPatch changes only execution metadata",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
      roots.push(root);
      initializeGitRepository(root, { "a.txt": "a0\n" });
      const initial = writer("a", "a.txt");
      const prepared = await prepareWorkspace(plan([initial]), root, "metadata-replacement");
      const initialCwd = await prepared.prepareTask(initial, []);
      const initialWorktree = prepared.assignments.get("a")?.worktreeRoot;
      writeFileSync(join(initialCwd, "a.txt"), "partial repair\n");

      const replacement = {
        ...initial,
        objective: "finish the repair from current workspace state",
        tier: "terra" as const,
        effort: "medium" as const,
      };
      await prepared.updatePlan(plan([replacement]));
      const replacementCwd = prepared.cwdFor(replacement);

      expect(prepared.assignments.get("a")?.worktreeRoot).toBe(initialWorktree);
      expect(replacementCwd).toBe(initialCwd);
      expect(readFileSync(join(replacementCwd, "a.txt"), "utf8")).toBe("partial repair\n");
      await prepared.cleanup();
    },
  );

  gitIntegrationIt(
    "reattaches a completed writer after a process crash without replaying it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
      const stateRoot = mkdtempSync(join(tmpdir(), "agent-trio-state-"));
      roots.push(root, stateRoot);
      initializeGitRepository(root, { "a.txt": "a0\n" });
      const task = writer("writer", "a.txt");
      const executionPlan = plan([task]);

      const crashedProcess = new WorkspaceRegistry({ stateRoot });
      await crashedProcess.prepare({
        runId: "crash-resume",
        request: { cwd: root },
        plan: executionPlan,
      });
      const writerCwd = await crashedProcess.prepareTask("crash-resume", task, []);
      writeFileSync(join(writerCwd, "a.txt"), "written-before-crash\n");
      const preCrashCandidate = await crashedProcess.prepareValidation("crash-resume", [
        result("writer"),
      ]);
      expect(readFileSync(join(preCrashCandidate, "a.txt"), "utf8")).toBe("written-before-crash\n");

      const restartedProcess = new WorkspaceRegistry({ stateRoot });
      await restartedProcess.resume({
        runId: "crash-resume",
        request: { cwd: root },
        plan: executionPlan,
        results: [result("writer")],
      });
      expect(restartedProcess.cwdFor("crash-resume", task)).toBe(writerCwd);
      await expect(restartedProcess.prepareTask("crash-resume", task, [])).rejects.toThrow(
        "cannot be replayed",
      );
      const candidateCwd = await restartedProcess.prepareValidation("crash-resume", [
        result("writer"),
      ]);
      expect(readFileSync(join(candidateCwd, "a.txt"), "utf8")).toBe("written-before-crash\n");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a0\n");

      await restartedProcess.integrate("crash-resume", [result("writer")]);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("written-before-crash\n");
      await restartedProcess.cleanup("crash-resume");
    },
  );

  gitIntegrationIt("fails closed when the repository HEAD changes before recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "agent-trio-state-"));
    roots.push(root, stateRoot);
    initializeGitRepository(root, { "a.txt": "a0\n" });
    const task = writer("writer", "a.txt");
    const executionPlan = plan([task]);
    const registry = new WorkspaceRegistry({ stateRoot });
    await registry.prepare({
      runId: "head-changed",
      request: { cwd: root },
      plan: executionPlan,
    });
    const writerCwd = await registry.prepareTask("head-changed", task, []);
    writeFileSync(join(writerCwd, "a.txt"), "isolated-change\n");

    writeFileSync(join(root, "external.txt"), "external\n");
    execFileSync("git", ["add", "external.txt"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=External",
        "-c",
        "user.email=external@example.invalid",
        "commit",
        "-qm",
        "external commit",
      ],
      { cwd: root },
    );

    const restartedProcess = new WorkspaceRegistry({ stateRoot });
    await expect(
      restartedProcess.resume({
        runId: "head-changed",
        request: { cwd: root },
        plan: executionPlan,
        results: [result("writer")],
      }),
    ).rejects.toThrow("HEAD changed");
    await registry.cleanup("head-changed");
  });

  gitIntegrationIt("rejects legacy and redirected recovery manifests", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "agent-trio-state-"));
    roots.push(root, stateRoot);
    initializeGitRepository(root, { "a.txt": "a0\n" });
    const task = writer("writer", "a.txt");
    const executionPlan = plan([task]);
    const registry = new WorkspaceRegistry({ stateRoot });
    await registry.prepare({
      runId: "manifest-evidence",
      request: { cwd: root },
      plan: executionPlan,
    });
    await registry.prepareTask("manifest-evidence", task, []);
    const manifestPath = join(workspaceStateDirectory(stateRoot), "manifest.json");
    const originalManifest = readFileSync(manifestPath, "utf8");

    const legacyManifest = JSON.parse(originalManifest) as Record<string, unknown>;
    legacyManifest["schemaVersion"] = 0;
    writeFileSync(manifestPath, JSON.stringify(legacyManifest));
    await expect(
      new WorkspaceRegistry({ stateRoot }).resume({
        runId: "manifest-evidence",
        request: { cwd: root },
        plan: executionPlan,
        results: [result("writer")],
      }),
    ).rejects.toThrow("legacy or unsupported");

    const redirectedManifest = JSON.parse(originalManifest) as {
      worktrees: { worktreeRoot: string }[];
    };
    redirectedManifest.worktrees[0]!.worktreeRoot = root;
    writeFileSync(manifestPath, JSON.stringify(redirectedManifest));
    await expect(
      new WorkspaceRegistry({ stateRoot }).resume({
        runId: "manifest-evidence",
        request: { cwd: root },
        plan: executionPlan,
        results: [result("writer")],
      }),
    ).rejects.toThrow("worktree path is invalid");

    await registry.cleanup("manifest-evidence");
  });

  gitIntegrationIt("retains failed cleanup state so cleanup can be retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "agent-trio-state-"));
    roots.push(root, stateRoot);
    initializeGitRepository(root, { "a.txt": "a0\n" });
    const task = writer("writer", "a.txt");
    const registry = new WorkspaceRegistry({ stateRoot });
    await registry.prepare({
      runId: "cleanup-retry",
      request: { cwd: root },
      plan: plan([task]),
    });
    await registry.prepareTask("cleanup-retry", task, []);
    const sessionDirectory = workspaceStateDirectory(stateRoot);
    const manifestPath = join(sessionDirectory, "manifest.json");

    chmodSync(sessionDirectory, 0o500);
    try {
      await expect(registry.cleanup("cleanup-retry")).rejects.toThrow();
      expect(existsSync(manifestPath)).toBe(true);
    } finally {
      chmodSync(sessionDirectory, 0o700);
    }

    await registry.cleanup("cleanup-retry");
    expect(existsSync(sessionDirectory)).toBe(false);
  });

  gitIntegrationIt(
    "reattaches cleanup_pending state after a crash and only continues cleanup",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-trio-workspace-"));
      const stateRoot = mkdtempSync(join(tmpdir(), "agent-trio-state-"));
      roots.push(root, stateRoot);
      initializeGitRepository(root, { "a.txt": "a0\n", "b.txt": "b0\n" });
      const aTask = writer("a", "a.txt");
      const bTask = writer("b", "b.txt");
      const executionPlan = plan([aTask, bTask]);
      const crashedProcess = new WorkspaceRegistry({ stateRoot });
      await crashedProcess.prepare({
        runId: "cleanup-crash",
        request: { cwd: root },
        plan: executionPlan,
      });
      const aCwd = await crashedProcess.prepareTask("cleanup-crash", aTask, []);
      const bCwd = await crashedProcess.prepareTask("cleanup-crash", bTask, []);
      writeFileSync(join(aCwd, "a.txt"), "uncommitted-a\n");
      writeFileSync(join(bCwd, "b.txt"), "uncommitted-b\n");

      const sessionDirectory = workspaceStateDirectory(stateRoot);
      const manifestPath = join(sessionDirectory, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        phase: string;
        worktrees: { worktreeRoot: string }[];
      };
      manifest.phase = "cleanup_pending";
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const removedBeforeCrash = manifest.worktrees[0]!.worktreeRoot;
      execFileSync("git", ["worktree", "remove", "--force", removedBeforeCrash], {
        cwd: root,
      });
      expect(existsSync(removedBeforeCrash)).toBe(false);

      const restartedProcess = new WorkspaceRegistry({ stateRoot });
      await restartedProcess.resume({
        runId: "cleanup-crash",
        request: { cwd: root },
        plan: executionPlan,
        results: [result("a"), result("b")],
      });
      await expect(restartedProcess.prepareTask("cleanup-crash", bTask, [])).rejects.toThrow(
        "pending cleanup",
      );
      await expect(
        restartedProcess.integrate("cleanup-crash", [result("a"), result("b")]),
      ).rejects.toThrow("pending cleanup");

      await restartedProcess.cleanup("cleanup-crash");
      expect(existsSync(sessionDirectory)).toBe(false);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a0\n");
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b0\n");
      const remainingWorktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      });
      for (const workspace of manifest.worktrees) {
        expect(remainingWorktrees).not.toContain(workspace.worktreeRoot);
      }
    },
  );
});
