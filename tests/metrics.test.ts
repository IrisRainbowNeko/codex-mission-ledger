import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareSessionMetrics,
  estimateModelCost,
  groupSessionTrees,
  loadCodexSessionTrees,
  loadCodexSessionThreads,
  parseModelPrices,
  parseSessionJsonl,
  selectSessionTree,
  summarizeSessionTree,
} from "../src/metrics.js";

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function fixture(
  id: string,
  sessionId: string,
  parentThreadId: string | null,
  role: string | null,
  model: string,
  startedAt: string,
  events: ReadonlyArray<{
    at: string;
    input: number;
    cached: number;
    output: number;
  }>,
  endedAt: string,
): string {
  const meta: Record<string, unknown> = {
    id,
    session_id: sessionId,
    timestamp: startedAt,
  };
  if (parentThreadId !== null) {
    meta["parent_thread_id"] = parentThreadId;
  }
  if (role !== null) {
    meta["agent_role"] = role;
  }
  return [
    line(startedAt, "session_meta", meta),
    line(startedAt, "turn_context", { model }),
    ...events.map((event) =>
      line(event.at, "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: event.input,
            cached_input_tokens: event.cached,
            output_tokens: event.output,
            total_tokens: event.input + event.output,
          },
        },
      }),
    ),
    line(endedAt, "event_msg", { type: "task_complete" }),
  ].join("\n");
}

const ROOT = fixture(
  "root",
  "root",
  null,
  null,
  "gpt-5.6-sol",
  "2026-01-01T00:00:00.000Z",
  [
    { at: "2026-01-01T00:00:01.000Z", input: 100, cached: 40, output: 10 },
    { at: "2026-01-01T00:00:08.000Z", input: 150, cached: 60, output: 20 },
  ],
  "2026-01-01T00:00:10.000Z",
);

const CHILD = fixture(
  "child",
  "root",
  "root",
  "terra-coordinator",
  "gpt-5.6-terra",
  "2026-01-01T00:00:02.000Z",
  [{ at: "2026-01-01T00:00:05.000Z", input: 80, cached: 30, output: 12 }],
  "2026-01-01T00:00:06.000Z",
);

const SIBLING = fixture(
  "sibling",
  "root",
  "root",
  "luna-worker",
  "gpt-5.6-luna",
  "2026-01-01T00:00:04.000Z",
  [{ at: "2026-01-01T00:00:05.000Z", input: 20, cached: 10, output: 4 }],
  "2026-01-01T00:00:08.000Z",
);

const GRANDCHILD = fixture(
  "grandchild",
  "root",
  "child",
  "luna-producer",
  "gpt-5.6-luna",
  "2026-01-01T00:00:03.000Z",
  [
    { at: "2026-01-01T00:00:04.000Z", input: 50, cached: 25, output: 8 },
    { at: "2026-01-01T00:00:09.000Z", input: 70, cached: 35, output: 15 },
  ],
  "2026-01-01T00:00:09.000Z",
);

const OTHER = fixture(
  "other",
  "other",
  null,
  null,
  "gpt-5.4",
  "2026-01-02T00:00:00.000Z",
  [{ at: "2026-01-02T00:00:01.000Z", input: 20, cached: 0, output: 5 }],
  "2026-01-02T00:00:02.000Z",
);

describe("Codex session metrics", () => {
  let temporaryRoot: string | null = null;

  afterEach(() => {
    if (temporaryRoot !== null) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  });

  it("parses cumulative host token snapshots without double counting", () => {
    const parsed = parseSessionJsonl(`${ROOT}\nnot-json`, "root.jsonl");

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("root");
    expect(parsed?.modelNames).toEqual(["gpt-5.6-sol"]);
    expect(parsed?.tokens).toEqual({
      cachedInputTokens: 60,
      uncachedInputTokens: 90,
      outputTokens: 20,
      totalTokens: 170,
    });
    expect(parsed?.elapsedMs).toBe(10_000);
    expect(parsed?.turnCount).toBe(1);
    expect(parsed?.malformedLineCount).toBe(1);
  });

  it("accounts for cache-write input tokens in cumulative deltas and pricing", () => {
    const content = [
      line("2026-01-03T00:00:00.000Z", "session_meta", { id: "cache-write" }),
      line("2026-01-03T00:00:00.000Z", "turn_context", { model: "cache-model" }),
      line("2026-01-03T00:00:01.000Z", "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 10,
            output_tokens: 20,
          },
        },
      }),
      line("2026-01-03T00:00:02.000Z", "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 60,
            cache_write_input_tokens: 20,
            output_tokens: 30,
          },
        },
      }),
    ].join("\n");

    const parsed = parseSessionJsonl(content);
    expect(parsed?.tokens).toEqual({
      cachedInputTokens: 60,
      cacheWriteInputTokens: 20,
      uncachedInputTokens: 70,
      outputTokens: 30,
      totalTokens: 180,
    });

    const prices = parseModelPrices({
      "cache-model": {
        uncachedInput: 1,
        cachedInput: 2,
        cacheWriteInput: 3,
        output: 4,
      },
    });
    expect(parsed).not.toBeNull();
    expect(estimateModelCost(parsed!.tokensByModel, prices)).toMatchObject({
      total: (70 + 60 * 2 + 20 * 3 + 30 * 4) / 1_000_000,
      complete: true,
    });
  });

  it("groups a root with nested descendants and excludes another session", () => {
    const threads = [
      parseSessionJsonl(ROOT, "root.jsonl"),
      parseSessionJsonl(CHILD, "child.jsonl"),
      parseSessionJsonl(GRANDCHILD, "grandchild.jsonl"),
      parseSessionJsonl(OTHER, "other.jsonl"),
    ].filter((thread) => thread !== null);

    expect(selectSessionTree(threads, "root").map((thread) => thread.id)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
    expect([...groupSessionTrees(threads).keys()]).toEqual(["other", "root"]);
  });

  it("summarizes elapsed time, tiers, model names, and estimated cost", () => {
    const threads = [ROOT, CHILD, GRANDCHILD]
      .map((content, index) => parseSessionJsonl(content, `${index}.jsonl`))
      .filter((thread) => thread !== null);
    const prices = parseModelPrices({
      models: {
        "gpt-5.6-sol": {
          uncachedInputPerMillion: 10,
          cachedInputPerMillion: 1,
          outputPerMillion: 30,
        },
        "gpt-5.6-terra": { uncachedInput: 2, cachedInput: 0.2, output: 8 },
        "gpt-5.6-luna": {
          uncached_input_per_million: 1,
          cached_input_per_million: 0.1,
          output_per_million: 4,
        },
      },
    });

    const summary = summarizeSessionTree("root", threads, prices);

    expect(summary.threadCount).toBe(3);
    expect(summary.elapsedMs).toBe(10_000);
    expect(summary.modelNames).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(summary.tokens).toEqual({
      cachedInputTokens: 125,
      uncachedInputTokens: 175,
      outputTokens: 47,
      totalTokens: 347,
    });
    expect(summary.tokensByTier.sol.totalTokens).toBe(170);
    expect(summary.tokensByTier.terra.totalTokens).toBe(92);
    expect(summary.tokensByTier.luna.totalTokens).toBe(85);
    expect(summary.tokensByTier.other.totalTokens).toBe(0);
    expect(summary.estimatedCost?.complete).toBe(true);
    expect(summary.estimatedCost?.total).toBeCloseTo(0.0018605, 10);
  });

  it("measures root wakeups, direct-child launch skew, and effective parallelism", () => {
    const threads = [ROOT, CHILD, SIBLING]
      .map((content) => parseSessionJsonl(content))
      .filter((thread) => thread !== null);

    const summary = summarizeSessionTree("root", threads);

    expect(summary.rootTurnCount).toBe(1);
    expect(summary.totalTurnCount).toBe(3);
    expect(summary.directChildCount).toBe(2);
    expect(summary.directChildLaunchSkewMs).toBe(2_000);
    expect(summary.directChildElapsedMs).toBe(8_000);
    expect(summary.directChildParallelIntervalMs).toBe(6_000);
    expect(summary.directChildEffectiveParallelism).toBeCloseTo(4 / 3, 10);
  });

  it("loads deterministic fixtures from active and archived session directories", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "codex-metrics-test-"));
    const active = join(temporaryRoot, "sessions", "2026", "01", "01");
    const archived = join(temporaryRoot, "archived_sessions");
    mkdirSync(active, { recursive: true });
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(active, "root.jsonl"), ROOT);
    writeFileSync(join(active, "child.jsonl"), CHILD);
    writeFileSync(join(archived, "grandchild.jsonl"), GRANDCHILD);
    writeFileSync(join(archived, "other.jsonl"), OTHER);

    const loaded = loadCodexSessionThreads(temporaryRoot);
    const selected = loadCodexSessionTrees(temporaryRoot, ["root"]);

    expect(loaded.map((thread) => thread.id)).toEqual(["child", "grandchild", "other", "root"]);
    expect(selected.map((thread) => thread.id)).toEqual(["child", "grandchild", "root"]);
    expect(summarizeSessionTree("root", selected).threadCount).toBe(3);
  });

  it("reports speedup and candidate-to-baseline token ratios", () => {
    const candidateThreads = [ROOT, CHILD, GRANDCHILD]
      .map((content) => parseSessionJsonl(content))
      .filter((thread) => thread !== null);
    const candidate = summarizeSessionTree("root", candidateThreads);
    const baselineThread = parseSessionJsonl(
      fixture(
        "baseline",
        "baseline",
        null,
        null,
        "gpt-5.6-sol",
        "2026-01-01T00:00:00.000Z",
        [{ at: "2026-01-01T00:00:10.000Z", input: 300, cached: 100, output: 47 }],
        "2026-01-01T00:00:20.000Z",
      ),
    );
    expect(baselineThread).not.toBeNull();
    const baseline = summarizeSessionTree(
      "baseline",
      [baselineThread].filter((row) => row !== null),
    );

    expect(compareSessionMetrics(candidate, baseline)).toEqual({
      speedRatio: 2,
      tokenRatio: 1,
      solTokenRatio: 170 / 347,
      costRatio: null,
    });
  });
});
