import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../src/core/job-store.js";
import { AgentTrioMonitorRuntime } from "../src/monitor/runtime.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentTrioMonitorRuntime", () => {
  it("uses one deterministic loopback URL and launches the detached monitor once", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-runtime-"));
    roots.push(root);
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: null,
      signalCode: null,
      disconnect: vi.fn(function (this: { connected: boolean }) {
        this.connected = false;
      }),
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => {
      setImmediate(() => child.emit("message", { type: "ready", port: 45_991 }));
      return child;
    }) as unknown as typeof spawn;
    const runtime = new AgentTrioMonitorRuntime({
      jobRoot: root,
      store: new JobStore(root),
      env: {
        NODE_ENV: "test",
        AGENT_TRIO_MONITOR: "1",
        AGENT_TRIO_MONITOR_PORT: "45991",
      },
      daemonModulePath: "/opt/agent-trio/monitor-daemon.js",
      spawnProcess,
    });

    await runtime.ensureStarted();
    const first = runtime.urlForRun("run-1");
    const second = runtime.urlForRun("run-1");
    expect(first).toBe(second);
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:45991\/runs\/run-1\?token=.{32,}$/u);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [...process.execArgv, "/opt/agent-trio/monitor-daemon.js"],
      expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    );
    await runtime.close();
  });

  it("can be disabled without attaching listeners or creating a URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-disabled-"));
    roots.push(root);
    const runtime = new AgentTrioMonitorRuntime({
      jobRoot: root,
      store: new JobStore(root),
      env: { AGENT_TRIO_MONITOR: "0" },
      spawnProcess: vi.fn() as unknown as typeof spawn,
    });

    expect(runtime.enabled).toBe(false);
    expect(runtime.urlForRun("run-1")).toBeUndefined();
    await runtime.close();
  });

  it("inherits test mode when a caller supplies only partial environment overrides", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-partial-env-"));
    roots.push(root);
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    const runtime = new AgentTrioMonitorRuntime({
      jobRoot: root,
      store: new JobStore(root),
      env: { AGENT_TRIO_MONITOR_PORT: "45992" },
      spawnProcess,
    });

    expect(runtime.enabled).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    await runtime.close();
  });
});
