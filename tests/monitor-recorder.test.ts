import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AppServer,
  AppServerNotification,
  NotificationHandler,
} from "../src/app-server/types.js";
import { JobStore } from "../src/core/job-store.js";
import { MonitorRecorder } from "../src/monitor/recorder.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class NotificationSource {
  readonly handlers = new Set<NotificationHandler>();

  readonly server = {
    onNotification: (
      methodOrHandler: string | NotificationHandler,
      handler?: NotificationHandler,
    ) => {
      const selected = typeof methodOrHandler === "string" ? handler! : methodOrHandler;
      this.handlers.add(selected);
      return () => this.handlers.delete(selected);
    },
  } as unknown as AppServer;

  emit(notification: AppServerNotification): void {
    for (const handler of this.handlers) {
      void handler(notification);
    }
  }
}

describe("MonitorRecorder", () => {
  it("maps App Server events to the registered run and flushes a bounded JSONL timeline", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-recorder-"));
    roots.push(root);
    const store = new JobStore(root);
    const source = new NotificationSource();
    const recorder = new MonitorRecorder(store, { flushMs: 5 });
    recorder.attach(source.server);
    recorder.recordRemoteTurn("run-1", {
      role: "leaf",
      taskId: "leaf-1",
      threadId: "thread-1",
      turnId: null,
      access: "readOnly",
      state: "thread_started",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });

    source.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "work" },
    });
    source.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "message-1", type: "agentMessage", text: "working together" },
      },
      emittedAtMs: Date.parse("2026-09-01T00:00:01.100Z"),
    });
    source.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "unregistered", turnId: "turn-x", delta: "ignored" },
    });
    await recorder.close();

    const events = readFileSync(join(store.jobDirectory("run-1"), "monitor.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "remote_turn",
      role: "leaf",
      taskId: "leaf-1",
      threadId: "thread-1",
    });
    expect(events[1]).toMatchObject({
      type: "app_server",
      role: "leaf",
      taskId: "leaf-1",
      threadId: "thread-1",
      turnId: "turn-1",
      method: "item/agentMessage/delta",
      data: { itemId: "message-1", delta: "work" },
    });
    expect(events[2]).toMatchObject({
      type: "app_server",
      role: "leaf",
      taskId: "leaf-1",
      threadId: "thread-1",
      turnId: "turn-1",
      method: "item/completed",
      data: {
        item: { id: "message-1", type: "agentMessage" },
      },
    });
    expect(events[2]).not.toHaveProperty("data.item.text");
  });

  it("coalesces token deltas without blocking lifecycle events", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-bounded-"));
    roots.push(root);
    const store = new JobStore(root);
    const recorder = new MonitorRecorder(store, {
      flushMs: 60_000,
      maxPendingBytes: 2_048,
      maxLogBytes: 4_096,
    });
    recorder.recordRemoteTurn("bounded", {
      role: "leaf",
      taskId: "leaf",
      threadId: "thread",
      turnId: null,
      access: "readOnly",
      state: "thread_started",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    for (let index = 0; index < 100; index += 1) {
      recorder.recordNotification("bounded", {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "x",
        },
      });
    }
    recorder.recordNotification("bounded", {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn-1", status: "completed" } },
    });
    await recorder.close();

    const log = readFileSync(join(store.jobDirectory("bounded"), "monitor.jsonl"), "utf8");
    const events = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(4_096);
    expect(log).toContain('"type":"remote_turn"');
    expect(log).toContain('"method":"turn/completed"');
    expect(events.filter((event) => event["method"] === "item/agentMessage/delta")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        data: { itemId: "message-1", delta: "x".repeat(100) },
      }),
    );
  });

  it("enforces the serialized event limit after JSON escaping", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-event-limit-"));
    roots.push(root);
    const store = new JobStore(root);
    const recorder = new MonitorRecorder(store, {
      flushMs: 60_000,
      maxLogBytes: 1024 * 1024,
    });
    recorder.recordNotification("escaped", {
      method: "item/completed",
      params: {
        threadId: "thread",
        item: { id: "message", type: "agentMessage", text: "\\".repeat(100_000) },
      },
    });
    await recorder.close();

    const lines = readFileSync(join(store.jobDirectory("escaped"), "monitor.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(`${lines[0]}\n`, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(lines[0]!) as Record<string, unknown>).toMatchObject({
      data: { truncated: true },
    });
  });
});
