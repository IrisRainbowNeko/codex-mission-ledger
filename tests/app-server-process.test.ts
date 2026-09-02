import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerConnectionFactory, type SpawnCodex } from "../src/app-server/index.js";
import { buildPluginIsolationArgs } from "../src/app-server/plugin-isolation.js";

const temporaryRoots: string[] = [];

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function childProcess(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("codex app-server process transport", () => {
  it("launches one stdio transport process and closes it through EOF", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const serverChild = childProcess();
    const spawnProcess: SpawnCodex = (command, args) => {
      calls.push({ command, args });
      serverChild.stdin.once("finish", () => {
        serverChild.exitCode = 0;
        serverChild.emit("exit", 0, null);
        serverChild.emit("close", 0, null);
      });
      return serverChild as unknown as ChildProcess;
    };
    const factory = createCodexAppServerConnectionFactory({
      codexPath: "/opt/codex",
      spawnProcess,
      extraArgs: ["--strict-config"],
    });

    const connection = await factory();
    expect(calls).toEqual([
      {
        command: "/opt/codex",
        args: ["app-server", "--stdio", "--strict-config"],
      },
    ]);
    await connection.close();
    expect(serverChild.kill).not.toHaveBeenCalled();
  });

  it("builds proxy arguments and starts one process", async () => {
    const serverChild = childProcess();
    const spawnProcess = vi.fn<SpawnCodex>((_command, _args) => {
      serverChild.stdin.once("finish", () => {
        serverChild.exitCode = 0;
        serverChild.emit("exit", 0, null);
        serverChild.emit("close", 0, null);
      });
      return serverChild as unknown as ChildProcess;
    });
    const factory = createCodexAppServerConnectionFactory({
      transport: "proxy",
      socketPath: "/tmp/codex.sock",
      spawnProcess,
    });

    const connection = await factory();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
      "app-server",
      "proxy",
      "--sock",
      "/tmp/codex.sock",
    ]);
    await connection.close();
  });

  it("passes an exact plugin allowlist to an isolated App Server process", async () => {
    const serverChild = childProcess();
    const spawnProcess = vi.fn<SpawnCodex>((_command, _args) => {
      serverChild.stdin.once("finish", () => {
        serverChild.exitCode = 0;
        serverChild.emit("exit", 0, null);
        serverChild.emit("close", 0, null);
      });
      return serverChild as unknown as ChildProcess;
    });
    const isolationArgs = buildPluginIsolationArgs(
      [
        { id: "browser@openai-bundled", enabled: true },
        { id: "documents@openai-primary-runtime", enabled: true },
      ],
      {
        plugins: [{ kind: "plugin", name: "browser@openai-bundled" }],
        skills: [],
        requiresIsolatedProcess: true,
      },
    );
    const factory = createCodexAppServerConnectionFactory({
      spawnProcess,
      extraArgs: isolationArgs,
    });

    const connection = await factory();
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
      "app-server",
      "--stdio",
      "--enable",
      "plugins",
      "-c",
      'plugins."browser@openai-bundled".enabled=true',
      "-c",
      'plugins."documents@openai-primary-runtime".enabled=false',
    ]);
    await connection.close();
  });

  it("does not finish forced close until the old process reports closed", async () => {
    vi.useFakeTimers();
    const serverChild = childProcess();
    serverChild.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          serverChild.signalCode = "SIGKILL";
          serverChild.emit("exit", null, "SIGKILL");
          serverChild.emit("close", null, "SIGKILL");
        });
      }
      return true;
    });
    const spawnProcess: SpawnCodex = () => serverChild as unknown as ChildProcess;
    const factory = createCodexAppServerConnectionFactory({
      closeTimeoutMs: 0,
      spawnProcess,
    });
    const connection = await factory();

    const closing = connection.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;

    expect(serverChild.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(serverChild.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(serverChild.signalCode).toBe("SIGKILL");
  });

  it("uses one instruction-free temporary CODEX_HOME across reconnects and disposes it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-trio-process-parent-"));
    temporaryRoots.push(parent);
    const children = [childProcess(), childProcess()];
    const environments: Array<NodeJS.ProcessEnv | undefined> = [];
    let index = 0;
    const spawnProcess = vi.fn<SpawnCodex>((_command, _args, options) => {
      environments.push(options.env);
      const child = children[index++];
      if (child === undefined) {
        throw new Error("unexpected third process");
      }
      child.stdin.once("finish", () => {
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    });
    const factory = createCodexAppServerConnectionFactory({
      spawnProcess,
      codexHomeIsolation: { mode: "temporary", parentDirectory: parent },
    });

    const first = await factory();
    const firstHome = environments[0]?.["CODEX_HOME"];
    expect(firstHome).toBeDefined();
    expect(firstHome).toBe(factory.isolatedCodexHome);
    const isolatedConfig = readFileSync(join(firstHome!, "config.toml"), "utf8");
    expect(isolatedConfig).toContain("project_doc_max_bytes = 0");
    expect(isolatedConfig).toContain("[agents]\nenabled = false");
    expect(isolatedConfig).toContain("[features]\nmulti_agent = false");
    await first.close();

    const second = await factory();
    expect((environments[1] ?? {})["CODEX_HOME"]).toBe(firstHome);
    await second.close();
    expect(existsSync(firstHome!)).toBe(true);

    await factory.dispose();
    expect(existsSync(firstHome!)).toBe(false);
    await factory.dispose();
  });

  it("supports an explicit projected home by symlinking only caller-selected files", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "agent-trio-process-source-"));
    const parent = mkdtempSync(join(tmpdir(), "agent-trio-process-parent-"));
    temporaryRoots.push(sourceHome, parent);
    const authPath = join(sourceHome, "auth.json");
    const configPath = join(sourceHome, "config.toml");
    writeFileSync(authPath, '{"OPENAI_API_KEY":"test-only"}\n', { mode: 0o600 });
    writeFileSync(configPath, 'model_provider = "example"\n', { mode: 0o600 });
    writeFileSync(join(sourceHome, "AGENTS.md"), "MISSION_ROUTE\n");

    const child = childProcess();
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    const spawnProcess = vi.fn<SpawnCodex>(() => child as unknown as ChildProcess);
    const factory = createCodexAppServerConnectionFactory({
      spawnProcess,
      extraArgs: ["--strict-config"],
      env: { CUSTOM_AUTH_ENV: "present" },
      isolatedAgentTrioMcpServer: {
        command: "/usr/bin/node",
        args: ["/tmp/bridge.mjs"],
        env: { AGENT_TRIO_BENCHMARK_SOCKET: "/tmp/bridge.sock" },
        startupTimeoutSec: 20,
        toolTimeoutSec: 600,
      },
      codexHomeIsolation: {
        mode: "projected",
        sourceHome,
        parentDirectory: parent,
        files: ["auth.json", "config.toml"],
      },
    });

    const connection = await factory();
    const call = spawnProcess.mock.calls[0];
    const projectedHome = call?.[2].env?.["CODEX_HOME"];
    expect(projectedHome).toBe(factory.isolatedCodexHome);
    expect(readlinkSync(join(projectedHome!, "auth.json"))).toBe(authPath);
    expect(readlinkSync(join(projectedHome!, "config.toml"))).toBe(configPath);
    expect(call?.[2].env).toMatchObject({ CUSTOM_AUTH_ENV: "present" });
    expect(call?.[1]).toContain("project_doc_max_bytes=0");
    expect(call?.[1]).toContain("agents.enabled=false");
    expect(call?.[1]).toContain("features.multi_agent=false");
    expect(call?.[1]).toContain("features.hooks=false");
    expect(call?.[1]).toContain("skills.config=[]");
    expect(call?.[1]).toContain(
      'mcp_servers.agent_trio={command="agent-trio-disabled",enabled=false}',
    );
    const disabledIndex = call?.[1].indexOf(
      'mcp_servers.agent_trio={command="agent-trio-disabled",enabled=false}',
    );
    const enabledIndex = call?.[1].findIndex((argument) =>
      argument.startsWith('mcp_servers.agent_trio={command="/usr/bin/node"'),
    );
    expect(disabledIndex).toBeGreaterThan(-1);
    expect(enabledIndex).toBeGreaterThan(disabledIndex ?? -1);
    expect(call?.[1][enabledIndex ?? -1]).toContain(
      'AGENT_TRIO_BENCHMARK_SOCKET="/tmp/bridge.sock"',
    );
    expect(call?.[1][enabledIndex ?? -1]).toContain('default_tools_approval_mode="approve"');

    await connection.close();
    await factory.dispose();
    expect(existsSync(authPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(projectedHome!)).toBe(false);
  });

  it("accepts temporary mode with sourceHome as a projected-mode compatibility shorthand", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "agent-trio-process-source-"));
    const parent = mkdtempSync(join(tmpdir(), "agent-trio-process-parent-"));
    temporaryRoots.push(sourceHome, parent);
    const authPath = join(sourceHome, "auth.json");
    writeFileSync(authPath, "{}\n", { mode: 0o600 });
    const child = childProcess();
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    const spawnProcess = vi.fn<SpawnCodex>(() => child as unknown as ChildProcess);
    const factory = createCodexAppServerConnectionFactory({
      spawnProcess,
      codexHomeIsolation: {
        mode: "temporary",
        sourceHome,
        parentDirectory: parent,
        files: ["auth.json"],
      },
    });

    const connection = await factory();
    const projectedHome = factory.isolatedCodexHome;
    expect(projectedHome).toBeDefined();
    expect(readlinkSync(join(projectedHome!, "auth.json"))).toBe(authPath);
    await connection.close();
    await factory.dispose();
  });

  it("keeps inherited CODEX_HOME untouched when isolation is explicitly disabled", async () => {
    const child = childProcess();
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    const spawnProcess = vi.fn<SpawnCodex>(() => child as unknown as ChildProcess);
    const factory = createCodexAppServerConnectionFactory({
      spawnProcess,
      env: { CODEX_HOME: "/caller-owned-home", KEEP: "yes" },
      codexHomeIsolation: { mode: "inherit" },
    });

    const connection = await factory();
    expect(spawnProcess.mock.calls[0]?.[2].env).toEqual({
      CODEX_HOME: "/caller-owned-home",
      KEEP: "yes",
    });
    expect(factory.isolatedCodexHome).toBeNull();
    await connection.close();
    await factory.dispose();
  });

  it("rejects ambiguous projected-home settings before spawning", () => {
    expect(() =>
      createCodexAppServerConnectionFactory({
        codexHomeIsolation: { mode: "projected", sourceHome: "/source", path: "/target" },
      }),
    ).toThrow("cannot specify path or configToml");
    expect(() =>
      createCodexAppServerConnectionFactory({
        codexHomeIsolation: { mode: "explicit", path: "relative-home" },
      }),
    ).toThrow("requires an absolute path");
  });
});
