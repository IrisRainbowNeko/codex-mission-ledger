import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSealedBenchmarkValidatorV1,
  RUNNER_CONTROLLED_NETWORK,
  runSealedBenchmarkValidator,
  SealedBenchmarkValidatorError,
  type SealedBenchmarkValidatorV1,
} from "../src/benchmark-validator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-trio-sealed-validator-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validator(
  overrides: Partial<SealedBenchmarkValidatorV1> = {},
): SealedBenchmarkValidatorV1 {
  return {
    schemaVersion: 1,
    runnerSandboxBoundary: { networkIsolation: RUNNER_CONTROLLED_NETWORK },
    commandChecks: [],
    requiredDeliverables: [{ id: "report", path: "report.txt" }],
    ...overrides,
  };
}

describe("parseSealedBenchmarkValidatorV1", () => {
  it("parses the strict v1 schema and preserves the runner-owned network boundary", () => {
    expect(parseSealedBenchmarkValidatorV1(validator())).toEqual(validator());
  });

  it.each([
    ["unknown root property", { ...validator(), surprise: true }, "unknown property 'surprise'"],
    ["unsupported version", { ...validator(), schemaVersion: 2 }, "schemaVersion must be 1"],
    [
      "missing boundary",
      { ...validator(), runnerSandboxBoundary: undefined },
      "runnerSandboxBoundary must be an object",
    ],
    [
      "absolute deliverable",
      validator({ requiredDeliverables: [{ id: "report", path: "/tmp/report.txt" }] }),
      "must be relative",
    ],
    [
      "traversing cwd",
      validator({
        commandChecks: [{ id: "test", argv: ["node"], cwd: "../outside" }],
        requiredDeliverables: [],
      }),
      "forbidden path segment",
    ],
    [
      "invalid regex",
      validator({
        commandChecks: [{ id: "test", argv: ["node"], output: { regex: ["("] } }],
        requiredDeliverables: [],
      }),
      "not a valid Unicode regular expression",
    ],
    [
      "invalid digest",
      validator({ requiredDeliverables: [{ id: "report", path: "report.txt", sha256: "abc" }] }),
      "lowercase hexadecimal SHA-256",
    ],
    [
      "non-boolean critical marker",
      validator({
        requiredDeliverables: [
          { id: "report", path: "report.txt", critical: "yes" as unknown as boolean },
        ],
      }),
      "critical must be boolean",
    ],
    [
      "duplicate ids",
      validator({ commandChecks: [{ id: "report", argv: ["node"] }] }),
      "ids must be unique",
    ],
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseSealedBenchmarkValidatorV1(value)).toThrow(message);
    expect(() => parseSealedBenchmarkValidatorV1(value)).toThrow(SealedBenchmarkValidatorError);
  });
});

describe("runSealedBenchmarkValidator", () => {
  it("runs argv directly, evaluates all text criteria, and verifies deliverable SHA-256", async () => {
    const workspace = await temporaryWorkspace();
    const packageDirectory = join(workspace, "package");
    await mkdir(packageDirectory);
    const contents = "sealed result\n";
    await writeFile(join(packageDirectory, "report.txt"), contents, "utf8");
    const digest = createHash("sha256").update(contents).digest("hex");
    const config = validator({
      commandChecks: [
        {
          id: "argv-check",
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeSync(1, process.argv.slice(1).join(' ') + '\\n'); require('node:fs').writeSync(2, 'cwd=' + process.cwd() + '\\n')",
            "literal && value",
          ],
          cwd: "package",
          timeoutMs: 2_000,
          output: {
            all: ["literal && value"],
            any: ["not present", "cwd="],
            regex: ["literal && value"],
          },
        },
      ],
      requiredDeliverables: [{ id: "report", path: "package/report.txt", sha256: digest }],
    });

    const result = await runSealedBenchmarkValidator(config, { workspace });

    expect(result).toMatchObject({
      score: 100,
      passedChecks: 2,
      totalChecks: 2,
      criticalFailures: [],
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        id: "argv-check",
        kind: "command",
        passed: true,
        exitCode: 0,
        timedOut: false,
        criteria: { all: true, any: true, regex: true },
      }),
      expect.objectContaining({
        id: "report",
        kind: "deliverable",
        passed: true,
        actualSha256: digest,
      }),
    ]);
  });

  it("scores ordinary failures without promoting them to critical failures", async () => {
    const workspace = await temporaryWorkspace();
    const config = validator({
      commandChecks: [
        {
          id: "bad-exit",
          argv: [process.execPath, "-e", "console.log('wrong'); process.exit(3)"],
          expectedExitCode: 0,
          output: { all: ["expected"] },
        },
      ],
      requiredDeliverables: [{ id: "missing", path: "missing.txt" }],
    });

    const result = await runSealedBenchmarkValidator(config, { workspace });

    expect(result.score).toBe(0);
    expect(result.criticalFailures).toEqual([]);
    expect(result.evidence[0]).toMatchObject({
      passed: false,
      critical: false,
      exitCode: 3,
      criteria: { all: false, any: true, regex: true },
    });
  });

  it("reports only failed checks and deliverables explicitly sealed as critical", async () => {
    const workspace = await temporaryWorkspace();
    const config = validator({
      commandChecks: [
        {
          id: "ordinary-test",
          argv: [process.execPath, "-e", "process.exit(1)"],
        },
        {
          id: "data-destruction",
          critical: true,
          argv: [process.execPath, "-e", "process.exit(1)"],
        },
      ],
      requiredDeliverables: [
        { id: "ordinary-report", path: "report.txt" },
        { id: "citation-integrity", path: "citations.json", critical: true },
      ],
    });

    const result = await runSealedBenchmarkValidator(config, { workspace });

    expect(result.score).toBe(0);
    expect(result.criticalFailures).toEqual([
      "data-destruction: expected exit code 0, received 1",
      "citation-integrity: required deliverable is missing",
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({ id: "ordinary-test", passed: false, critical: false }),
      expect.objectContaining({ id: "data-destruction", passed: false, critical: true }),
      expect.objectContaining({ id: "ordinary-report", passed: false, critical: false }),
      expect.objectContaining({ id: "citation-integrity", passed: false, critical: true }),
    ]);
  });

  it("terminates a command after its declared timeout", async () => {
    const workspace = await temporaryWorkspace();
    const config = validator({
      commandChecks: [
        {
          id: "timeout",
          argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          timeoutMs: 25,
        },
      ],
      requiredDeliverables: [],
    });

    const result = await runSealedBenchmarkValidator(config, { workspace });

    expect(result).toMatchObject({ score: 0, criticalFailures: [] });
    expect(result.evidence[0]).toMatchObject({ timedOut: true, passed: false });
  });

  it("runs commands through the runner-owned isolation wrapper", async () => {
    const workspace = await temporaryWorkspace();
    const commandWrapper = vi.fn((argv: readonly string[], cwd: string) => ({
      argv: [process.execPath, "-e", "require('node:fs').writeSync(1, 'wrapped\\n')"],
      cwd,
    }));
    const config = validator({
      commandChecks: [
        { id: "wrapped", argv: ["sealed-command", "argument"], output: { all: ["wrapped"] } },
      ],
      requiredDeliverables: [],
    });

    const result = await runSealedBenchmarkValidator(config, { workspace, commandWrapper });

    expect(result.score).toBe(100);
    expect(commandWrapper).toHaveBeenCalledWith(["sealed-command", "argument"], workspace);
    expect(result.evidence[0]).toMatchObject({ argv: ["sealed-command", "argument"] });
  });

  it("rejects deliverable and cwd symlinks that escape the workspace", async () => {
    const workspace = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await writeFile(join(outside, "report.txt"), "outside", "utf8");
    await symlink(outside, join(workspace, "escape"), "dir");

    await expect(
      runSealedBenchmarkValidator(
        validator({ requiredDeliverables: [{ id: "report", path: "escape/report.txt" }] }),
        { workspace },
      ),
    ).rejects.toThrow("deliverable path resolves outside the benchmark workspace");

    await expect(
      runSealedBenchmarkValidator(
        validator({
          commandChecks: [{ id: "cwd", argv: [process.execPath, "-e", ""], cwd: "escape" }],
          requiredDeliverables: [],
        }),
        { workspace },
      ),
    ).rejects.toThrow("command cwd resolves outside the benchmark workspace");
  });

  it("rejects missing deliverables beneath an escaping symlink", async () => {
    const workspace = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await symlink(outside, join(workspace, "escape"), "dir");

    await expect(
      runSealedBenchmarkValidator(
        validator({ requiredDeliverables: [{ id: "report", path: "escape/missing.txt" }] }),
        { workspace },
      ),
    ).rejects.toThrow("deliverable parent path resolves outside the benchmark workspace");
  });
});
