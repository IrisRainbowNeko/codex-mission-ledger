import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { startMonitorServer, type MonitorServer } from "../src/monitor/server.js";

const roots: string[] = [];
const servers: MonitorServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent Trio Monitor server", () => {
  it("serves snapshots and incrementally paged monitor events on loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-server-"));
    roots.push(root);
    const directory = join(root, "run-1");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "job.json"),
      JSON.stringify({
        request: { objective: "inspect the project" },
        result: { runId: "run-1", status: "running", plan: null, leaves: [] },
        remoteTurns: [],
        updatedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(directory, "monitor.jsonl"),
      [
        { type: "remote_turn", at: "2026-09-01T00:00:00.000Z" },
        {
          type: "app_server",
          at: "2026-09-01T00:00:01.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          method: "item/agentMessage/delta",
          data: { itemId: "message-1", delta: "hello" },
        },
        {
          type: "app_server",
          at: "2026-09-01T00:00:01.100Z",
          threadId: "thread-1",
          turnId: "turn-1",
          method: "item/agentMessage/delta",
          data: { itemId: "message-1", delta: " world" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const server = await startMonitorServer({ jobRoot: root, token: "secret", port: 0 });
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.port)}`;

    const page = await fetch(`${base}/runs/run-1?token=secret`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Agent Trio Monitor");
    const browserScript = await fetch(`${base}/assets/monitor.js?v=3.4.2-profile-1`);
    const browserScriptSource = await browserScript.text();
    expect(() => new Script(browserScriptSource)).not.toThrow();
    expect(browserScriptSource).toContain("buildConversationEvents");

    const snapshot = await fetch(`${base}/api/runs/run-1/snapshot?token=secret`);
    expect(await snapshot.json()).toMatchObject({
      request: { objective: "inspect the project" },
      result: { status: "running" },
    });

    const first = await fetch(`${base}/api/runs/run-1/events?token=secret&cursor=0`);
    const firstPage = (await first.json()) as {
      events: unknown[];
      nextCursor: number;
      hasMore: boolean;
    };
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.events[1]).toMatchObject({ data: { delta: "hello world" } });
    expect(firstPage.nextCursor).toBeGreaterThan(0);
    expect(firstPage.hasMore).toBe(false);

    const second = await fetch(
      `${base}/api/runs/run-1/events?token=secret&cursor=${String(firstPage.nextCursor)}`,
    );
    await expect(second.json()).resolves.toEqual({
      events: [],
      nextCursor: firstPage.nextCursor,
      hasMore: false,
    });
  });

  it("requires the per-job-root token for run data", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-auth-"));
    roots.push(root);
    const server = await startMonitorServer({ jobRoot: root, token: "secret", port: 0 });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${String(server.port)}/api/runs`);
    expect(response.status).toBe(401);
  });
});
