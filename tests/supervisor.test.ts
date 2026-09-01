import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { BatchResult } from "../src/core/contracts.js";
import {
  launchDetachedSupervisor,
  runSupervisorChild,
  type SubmitRequest,
  type SupervisorChildMessage,
} from "../src/supervisor.js";

function result(status: BatchResult["status"] = "pending"): BatchResult {
  return {
    protocolVersion: 1,
    runId: "run-1",
    status,
    plan: null,
    patch: null,
    leaves: [],
    finalResponse: status === "completed" ? "done" : null,
    metrics: null,
  };
}

function request(): SubmitRequest {
  return {
    action: "submit",
    runId: "run-1",
    objective: "do durable work",
    cwd: "/workspace",
  };
}

describe("durable supervisor", () => {
  it("acknowledges the persisted submit before waiting for the active run", async () => {
    const handle = vi
      .fn()
      .mockResolvedValueOnce(result("pending"))
      .mockResolvedValueOnce(result("completed"));
    const close = vi.fn();
    const sent: SupervisorChildMessage[] = [];

    await runSupervisorChild(
      async () => ({ service: { handle }, close }),
      (receive) => receive(request()),
      (message) => {
        sent.push(message);
      },
      () => undefined,
    );

    expect(sent).toEqual([{ type: "accepted", result: result("pending") }]);
    expect(handle).toHaveBeenNthCalledWith(1, request());
    expect(handle).toHaveBeenNthCalledWith(2, { action: "resume", runId: "run-1" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not resume a submit that already reached a parked or terminal state", async () => {
    const handle = vi.fn(async () => result("waiting_input"));

    await runSupervisorChild(
      async () => ({ service: { handle } }),
      (receive) => receive(request()),
      () => undefined,
      () => undefined,
    );

    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("returns the accepted snapshot from a detached child handshake", async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);

    const accepted = await launchDetachedSupervisor(request(), {
      modulePath: "/agent-trio/cli.js",
      execPath: "/usr/bin/node",
      execArgv: [],
      spawnProcess,
    });

    expect(accepted).toEqual(result("pending"));
    expect(child.sent).toEqual([request()]);
    expect(child.disconnected).toBe(true);
    expect(child.unrefed).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/agent-trio/cli.js"],
      expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    );
  });
});

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: unknown[] = [];
  disconnected = false;
  unrefed = false;

  send(message: unknown, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback(null);
    queueMicrotask(() => this.emit("message", { type: "accepted", result: result("pending") }));
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.disconnected = true;
  }

  unref(): void {
    this.unrefed = true;
  }

  kill(): boolean {
    return true;
  }
}
