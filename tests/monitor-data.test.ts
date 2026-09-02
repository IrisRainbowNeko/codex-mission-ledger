import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMonitorData } from "../src/monitor/data.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("monitor data", () => {
  it("returns cursor-based event pages and wakes when the snapshot revision changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-data-"));
    roots.push(root);
    const directory = join(root, "run-1");
    mkdirSync(directory);
    const writeSnapshot = (status: string, updatedAt: string): void => {
      writeFileSync(
        join(directory, "job.json"),
        JSON.stringify({
          request: { objective: "inspect" },
          result: { status },
          updatedAt,
        }),
      );
    };
    writeSnapshot("running", "2026-09-02T00:00:00.000Z");
    writeFileSync(
      join(directory, "monitor.jsonl"),
      `${JSON.stringify({ type: "app_server", method: "item/completed" })}\n`,
    );

    const initial = await readMonitorData(root, "run-1", { cursor: 0 });
    expect(initial.events).toHaveLength(1);
    expect(initial.nextCursor).toBeGreaterThan(0);

    const startedAt = Date.now();
    const update = readMonitorData(root, "run-1", {
      cursor: initial.nextCursor,
      afterRevision: initial.revision,
      waitMs: 1_000,
    });
    setTimeout(() => writeSnapshot("running", "2026-09-02T00:00:01.000Z"), 25).unref();

    await expect(update).resolves.toMatchObject({
      events: [],
      revision: "2026-09-02T00:00:01.000Z",
    });
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it("advances over a legacy event larger than the requested page size", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-monitor-legacy-data-"));
    roots.push(root);
    const directory = join(root, "legacy");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "job.json"),
      JSON.stringify({ result: { status: "running" }, updatedAt: "revision" }),
    );
    writeFileSync(
      join(directory, "monitor.jsonl"),
      `${JSON.stringify({ type: "app_server", data: { text: "x".repeat(40_000) } })}\n`,
    );

    const update = await readMonitorData(root, "legacy", { cursor: 0, maxEventBytes: 1024 });
    expect(update.events).toHaveLength(1);
    expect(update.nextCursor).toBeGreaterThan(40_000);
    expect(update.hasMore).toBe(false);
  });
});
