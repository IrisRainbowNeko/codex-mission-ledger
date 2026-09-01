import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseValidationCommand,
  runAppServerValidators,
  ValidationCommandError,
  type CommandExecParams,
  type CommandExecPort,
  type CommandExecResponse,
  type RequestOptions,
} from "../src/app-server/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-trio-validator-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("parseValidationCommand", () => {
  it("parses quoted, escaped, concatenated, and empty arguments without a shell", () => {
    expect(
      parseValidationCommand(`tool 'two words' "three\\" words" plain\\ value pre'fix' ""`),
    ).toEqual(["tool", "two words", 'three" words', "plain value", "prefix", ""]);
  });

  it.each([
    ["npm test && npm run lint", "shell operator '&'"],
    ["echo $(date)", "command substitution"],
    ["npm 'test", "unterminated single quote"],
    ["   ", "must name an executable"],
  ])("rejects ambiguous command %j", (command, expectedMessage) => {
    expect(() => parseValidationCommand(command)).toThrow(expectedMessage);
    expect(() => parseValidationCommand(command)).toThrow(ValidationCommandError);
  });
});

describe("runAppServerValidators", () => {
  it("runs read-only validators concurrently while preserving declared result order", async () => {
    const baseCwd = await temporaryWorkspace();
    const releases = new Map<string, () => void>();
    const completed: string[] = [];
    let active = 0;
    let maxActive = 0;
    const commandExec = vi.fn(async (params: CommandExecParams): Promise<CommandExecResponse> => {
      const name = params.command[1];
      if (name === undefined) {
        throw new Error("missing validator name");
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(name, resolve));
      active -= 1;
      completed.push(name);
      return { exitCode: 0, stdout: `${name} complete`, stderr: "" };
    });

    const run = runAppServerValidators({
      appServer: { commandExec },
      specs: [{ command: "validate first" }, { command: "validate second" }],
      baseCwd,
      access: "readOnly",
      signal: new AbortController().signal,
    });

    try {
      await vi.waitFor(() => expect(commandExec).toHaveBeenCalledTimes(2));
      expect(maxActive).toBe(2);
    } finally {
      releases.get("second")?.();
    }
    await vi.waitFor(() => expect(completed).toEqual(["second"]));
    releases.get("first")?.();

    const results = await run;
    expect(completed).toEqual(["second", "first"]);
    expect(results.map((result) => result.command)).toEqual(["validate first", "validate second"]);
    expect(results.map((result) => result.summary)).toEqual([
      "exit code 0\nstdout:\nfirst complete",
      "exit code 0\nstdout:\nsecond complete",
    ]);
  });

  it("runs workspace-write validators serially", async () => {
    const baseCwd = await temporaryWorkspace();
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    const commandExec = vi.fn(async (params: CommandExecParams): Promise<CommandExecResponse> => {
      const name = params.command[1];
      if (name === undefined) {
        throw new Error("missing validator name");
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(name, resolve));
      active -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const run = runAppServerValidators({
      appServer: { commandExec },
      specs: [{ command: "validate first" }, { command: "validate second" }],
      baseCwd,
      access: "workspaceWrite",
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(commandExec).toHaveBeenCalledTimes(1));
    expect(releases.has("second")).toBe(false);
    releases.get("first")?.();
    await vi.waitFor(() => expect(commandExec).toHaveBeenCalledTimes(2));
    releases.get("second")?.();

    await expect(run).resolves.toHaveLength(2);
    expect(maxActive).toBe(1);
  });

  it("uses real exit codes, resolved cwd values, timeouts, and a read-only sandbox", async () => {
    const baseCwd = await temporaryWorkspace();
    await mkdir(join(baseCwd, "packages", "api"), { recursive: true });
    const resolvedBase = await realpath(baseCwd);
    const resolvedApi = await realpath(join(baseCwd, "packages", "api"));
    const responses: CommandExecResponse[] = [
      { exitCode: 0, stdout: "types are valid\n", stderr: "" },
      { exitCode: 2, stdout: "", stderr: "tests failed\n" },
    ];
    const calls: { params: CommandExecParams; options: RequestOptions | undefined }[] = [];
    const appServer: CommandExecPort = {
      commandExec: async (params, options) => {
        calls.push({ params, options });
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("unexpected command");
        }
        return response;
      },
    };
    const signal = new AbortController().signal;

    const results = await runAppServerValidators({
      appServer,
      specs: [
        { command: "npm run typecheck", timeoutMs: 12_000 },
        { command: `npx vitest run "tests/api test.ts"`, cwd: "packages/api" },
      ],
      baseCwd,
      access: "readOnly",
      signal,
    });

    expect(calls).toEqual([
      {
        params: {
          command: ["npm", "run", "typecheck"],
          cwd: resolvedBase,
          timeoutMs: 12_000,
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
        options: { signal, timeoutMs: 0 },
      },
      {
        params: {
          command: ["npx", "vitest", "run", "tests/api test.ts"],
          cwd: resolvedApi,
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
        options: { signal, timeoutMs: 0 },
      },
    ]);
    expect(results).toEqual([
      {
        command: "npm run typecheck",
        status: "passed",
        summary: "exit code 0\nstdout:\ntypes are valid",
      },
      {
        command: `npx vitest run "tests/api test.ts"`,
        status: "failed",
        summary: "exit code 2\nstderr:\ntests failed",
      },
    ]);
  });

  it("limits workspace-write commands to the trusted workspace without network access", async () => {
    const baseCwd = await temporaryWorkspace();
    const resolvedBase = await realpath(baseCwd);
    const commandExec = vi.fn(async (): Promise<CommandExecResponse> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await runAppServerValidators({
      appServer: { commandExec },
      specs: [{ command: "npm test" }],
      baseCwd,
      access: "workspaceWrite",
      signal: new AbortController().signal,
    });

    expect(commandExec).toHaveBeenCalledWith(
      {
        command: ["npm", "test"],
        cwd: resolvedBase,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [resolvedBase],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
      expect.objectContaining({ timeoutMs: 0 }),
    );
  });

  it("fails closed when cwd traversal or a symlink escapes the trusted workspace", async () => {
    const root = await temporaryWorkspace();
    const baseCwd = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(baseCwd);
    await mkdir(outside);
    await symlink(outside, join(baseCwd, "escape"), "dir");
    const commandExec = vi.fn(async (): Promise<CommandExecResponse> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const results = await runAppServerValidators({
      appServer: { commandExec },
      specs: [
        { command: "npm test", cwd: "../outside" },
        { command: "npm test", cwd: "escape" },
      ],
      baseCwd,
      access: "readOnly",
      signal: new AbortController().signal,
    });

    expect(commandExec).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        status: "failed",
        summary: expect.stringContaining("outside the trusted workspace"),
      }),
      expect.objectContaining({
        status: "failed",
        summary: expect.stringContaining("outside the trusted workspace"),
      }),
    ]);
  });

  it("turns parse and transport errors into failed evidence and continues", async () => {
    const baseCwd = await temporaryWorkspace();
    const commandExec = vi.fn(async (): Promise<CommandExecResponse> => {
      throw new Error("transport unavailable");
    });

    const results = await runAppServerValidators({
      appServer: { commandExec },
      specs: [{ command: "npm test && npm run lint" }, { command: "npm test" }],
      baseCwd,
      access: "readOnly",
      signal: new AbortController().signal,
    });

    expect(commandExec).toHaveBeenCalledOnce();
    expect(results.map((result) => result.status)).toEqual(["failed", "failed"]);
    expect(results[0]?.summary).toContain("shell operator '&'");
    expect(results[1]?.summary).toContain("transport unavailable");
  });

  it("propagates cancellation instead of recording a validator failure", async () => {
    const baseCwd = await temporaryWorkspace();
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    const commandExec = vi.fn(async (): Promise<CommandExecResponse> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await expect(
      runAppServerValidators({
        appServer: { commandExec },
        specs: [{ command: "npm test" }],
        baseCwd,
        access: "readOnly",
        signal: controller.signal,
      }),
    ).rejects.toThrow("run cancelled");
    expect(commandExec).not.toHaveBeenCalled();
  });
});
