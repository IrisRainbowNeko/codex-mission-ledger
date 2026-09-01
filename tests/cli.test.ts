import { describe, expect, it, vi } from "vitest";
import type { BenchmarkObservation } from "../src/benchmark.js";
import { runCli, runDefaultCli, type CliOutput } from "../src/cli.js";
import type { BatchResult } from "../src/core/contracts.js";

function result(overrides: Partial<BatchResult> = {}): BatchResult {
  return {
    protocolVersion: 1,
    runId: "run-1",
    status: "completed",
    plan: null,
    patch: null,
    leaves: [],
    finalResponse: "done",
    metrics: null,
    ...overrides,
  };
}

function capture(): { output: CliOutput; text: () => string } {
  let value = "";
  return {
    output: {
      write: (chunk) => {
        value += chunk;
      },
    },
    text: () => value,
  };
}

describe("agent-trio CLI", () => {
  it("builds a run request and writes the shared service result as JSON", async () => {
    const stdout = capture();
    const handle = vi.fn(async () => result());

    const exitCode = await runCli(
      [
        "run",
        "implement",
        "the feature",
        "--cwd",
        "project",
        "--run-id",
        "run-1",
        "--domain",
        "coding",
        "--constraint",
        "keep compatibility",
        "--skill",
        "documents=/opt/codex-skills/documents/SKILL.md",
        "--plugin",
        "browser@openai-bundled",
        "--max-concurrent",
        "3",
        "--max-cost-usd=1.25",
        "--no-integrate",
        "--json",
      ],
      { service: { handle }, stdout: stdout.output, cwd: "/workspace" },
    );

    expect(exitCode).toBe(0);
    expect(handle).toHaveBeenCalledWith({
      action: "run",
      objective: "implement the feature",
      cwd: "/workspace/project",
      runId: "run-1",
      domain: "coding",
      constraints: ["keep compatibility"],
      capabilities: [
        {
          kind: "skill",
          name: "documents",
          path: "/opt/codex-skills/documents/SKILL.md",
        },
        { kind: "plugin", name: "browser@openai-bundled" },
      ],
      limits: { maxConcurrent: 3, maxCostUsd: 1.25 },
      integrate: false,
    });
    expect(JSON.parse(stdout.text())).toMatchObject({ runId: "run-1", status: "completed" });
  });

  it.each(["status", "resume", "cancel"] as const)(
    "routes %s through AgentTrioService.handle",
    async (action) => {
      const stdout = capture();
      const handle = vi.fn(async () =>
        result({ status: action === "cancel" ? "cancelled" : "completed" }),
      );

      const exitCode = await runCli([action, "run-1"], {
        service: { handle },
        stdout: stdout.output,
      });

      expect(exitCode).toBe(0);
      expect(handle).toHaveBeenCalledWith({ action, runId: "run-1" });
      expect(stdout.text()).toContain(`Run: run-1\nStatus:`);
    },
  );

  it("passes an explicit delegated direct tier to the service", async () => {
    const handle = vi.fn(async () => result());

    const exitCode = await runCli(
      ["run", "solve the bounded case", "--strategy", "direct", "--direct-tier", "luna"],
      { service: { handle }, stdout: capture().output, cwd: "/workspace" },
    );

    expect(exitCode).toBe(0);
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "direct", directTier: "luna" }),
    );
  });

  it("rejects a direct tier without explicit direct strategy", async () => {
    const handle = vi.fn();
    const stderr = capture();

    const exitCode = await runCli(["run", "task", "--direct-tier", "luna"], {
      service: { handle },
      stderr: stderr.output,
      cwd: "/workspace",
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("--direct-tier requires --strategy direct");
    expect(handle).not.toHaveBeenCalled();
  });

  it("passes optional resume input through to AgentTrioService.handle", async () => {
    const stdout = capture();
    const handle = vi.fn(async () => result());

    const exitCode = await runCli(["resume", "run-1", "--input", "permission granted", "--json"], {
      service: { handle },
      stdout: stdout.output,
    });

    expect(exitCode).toBe(0);
    expect(handle).toHaveBeenCalledWith({
      action: "resume",
      runId: "run-1",
      input: "permission granted",
    });
  });

  it("accepts exactly 4 KiB of UTF-8 resume input and rejects the next byte", async () => {
    const exactBoundary = `${"\u754c".repeat(1_365)}a`;
    const handle = vi.fn(async () => result());

    const accepted = await runCli(["resume", "run-1", `--input=${exactBoundary}`], {
      service: { handle },
      stdout: capture().output,
    });
    expect(accepted).toBe(0);
    expect(handle).toHaveBeenCalledWith({
      action: "resume",
      runId: "run-1",
      input: exactBoundary,
    });

    handle.mockClear();
    const stderr = capture();
    const rejected = await runCli(["resume", "run-1", `--input=${exactBoundary}b`], {
      service: { handle },
      stderr: stderr.output,
    });
    expect(rejected).toBe(2);
    expect(stderr.text()).toContain("resume input must not exceed 4 KiB");
    expect(handle).not.toHaveBeenCalled();
  });

  it.each(["run", "submit", "status", "cancel"] as const)(
    "rejects --input for %s",
    async (action) => {
      const stderr = capture();
      const handle = vi.fn();
      const args =
        action === "run" || action === "submit"
          ? [action, "task", "--input", "not allowed"]
          : [action, "run-1", "--input", "not allowed"];

      const exitCode = await runCli(args, {
        service: { handle },
        stderr: stderr.output,
      });

      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("--input is only valid with resume");
      expect(handle).not.toHaveBeenCalled();
    },
  );

  it("reports usage errors without calling the service", async () => {
    const stderr = capture();
    const handle = vi.fn();

    const exitCode = await runCli(["submit", "--max-leaves", "0", "task"], {
      service: { handle },
      stderr: stderr.output,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("max-leaves must be an integer at least 1");
    expect(handle).not.toHaveBeenCalled();
  });

  it("evaluates benchmark JSON without invoking the runtime service", async () => {
    const stdout = capture();
    const handle = vi.fn();
    const observations: BenchmarkObservation[] = [
      observation("coding-cross-module", "direct_sol", 100, 1, "direct"),
      {
        ...observation("coding-cross-module", "v3", 50, 0.3, "fanout"),
        launchSkewMs: 100,
        plannerTurns: 1,
        leafCount: 2,
      },
      observation("coding-local-bugfix", "direct_sol", 100, 1, "direct"),
      observation("coding-local-bugfix", "v3", 105, 0.3, "direct"),
    ];

    const exitCode = await runCli(["benchmark", "observations.json", "--allow-partial", "--json"], {
      service: { handle },
      stdout: stdout.output,
      cwd: "/workspace",
      readTextFile: vi.fn(async (path) => {
        expect(path).toBe("/workspace/observations.json");
        return JSON.stringify({ observations });
      }),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ passed: true, pairCount: 2 });
    expect(handle).not.toHaveBeenCalled();
  });

  it("loads and closes the default runtime around one command", async () => {
    const stdout = capture();
    const close = vi.fn();
    const handle = vi.fn(async () => result());
    const createRuntime = vi.fn(async () => ({ service: { handle }, close }));

    const exitCode = await runDefaultCli(["status", "run-1", "--json"], {
      createRuntime,
      stdout: stdout.output,
    });

    expect(exitCode).toBe(0);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith({ action: "status", runId: "run-1" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not create the runtime for help", async () => {
    const stdout = capture();
    const createRuntime = vi.fn();

    const exitCode = await runDefaultCli(["--help"], {
      createRuntime,
      stdout: stdout.output,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Usage: agent-trio");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("hands durable submits to the detached supervisor after assigning a run id", async () => {
    const stdout = capture();
    const createRuntime = vi.fn();
    const launchSupervisor = vi.fn(async (request) =>
      result({ runId: request.runId, status: "pending", finalResponse: null }),
    );

    const exitCode = await runDefaultCli(["submit", "durable task", "--json"], {
      createRuntime,
      launchSupervisor,
      stdout: stdout.output,
      cwd: "/workspace",
    });

    expect(exitCode).toBe(0);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(launchSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "submit",
        objective: "durable task",
        cwd: "/workspace",
        runId: expect.any(String),
      }),
    );
    expect(JSON.parse(stdout.text())).toMatchObject({ status: "pending" });
  });
});

function observation(
  familyId: string,
  arm: "direct_sol" | "v3",
  elapsedMs: number,
  costUsd: number,
  route: "direct" | "delegated" | "fanout",
): BenchmarkObservation {
  return {
    familyId,
    instanceId: "instance-1",
    seed: "seed-1",
    arm,
    qualityScore: 100,
    elapsedMs,
    costUsd,
    route,
    protocolErrors: 0,
    userInterventions: 0,
    criticalFailures: [],
  };
}
