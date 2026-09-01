import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  IntegrationCheckpoint,
  JobSnapshot,
  RunRequest,
  WaitingInputCheckpoint,
} from "../src/core/contracts.js";
import { JobStore, assertMatchingRequest, hashRunRequest } from "../src/core/job-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function request(objective = "test"): RunRequest {
  return { objective, cwd: "/workspace", constraints: ["a"] };
}

function snapshot(rootRequest = request(), runId = "run-1"): JobSnapshot {
  return {
    protocolVersion: 1,
    requestHash: hashRunRequest(rootRequest),
    request: rootRequest,
    result: {
      protocolVersion: 1,
      runId,
      status: "pending",
      plan: null,
      patch: null,
      leaves: [],
      finalResponse: null,
      metrics: null,
    },
    remoteTurns: [],
    coordinatorThreadId: null,
    plannerThreadId: null,
    integratorThreadId: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function integrationCheckpoint(): IntegrationCheckpoint {
  return {
    planId: "plan-1",
    leafIdentities: [
      {
        taskId: "leaf-a",
        threadId: "leaf-thread",
        turnId: "leaf-turn",
        completedAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    response: "integrated response",
    validation: [{ command: "npm test", status: "passed", summary: "all tests passed" }],
    integratorThreadId: "terra-thread",
    launchSkewMs: 12.5,
    peakConcurrency: 2,
    replanCount: 1,
    updatedAt: "2026-08-28T00:00:01.000Z",
  };
}

function waitingInputCheckpoint(kind: WaitingInputCheckpoint["kind"]): WaitingInputCheckpoint {
  const turn = {
    threadId: `${kind}-thread`,
    previousTurnId: `${kind}-turn`,
    cwd: "/workspace",
    needsAction: "grant access",
    capabilities: [
      { kind: "skill" as const, name: "documents", path: "/opt/skills/documents" },
      { kind: "plugin" as const, name: "browser" },
    ],
    updatedAt: "2026-08-28T00:00:02.000Z",
  };
  if (kind === "admission" || kind === "direct") {
    return { kind, turn };
  }
  if (kind === "leaves") {
    return {
      kind,
      planId: "plan-1",
      leaves: [
        {
          taskId: "leaf-a",
          threadId: "leaf-thread",
          previousTurnId: "leaf-turn",
          attempt: 1,
          needsAction: "grant repository access",
        },
      ],
      updatedAt: "2026-08-28T00:00:02.000Z",
    };
  }
  return {
    kind,
    planId: "plan-1",
    turn,
    leafIdentities: integrationCheckpoint().leafIdentities,
  };
}

function writeRawSnapshot(store: JobStore, runId: string, value: unknown): void {
  const directory = store.jobDirectory(runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "job.json"), `${JSON.stringify(value)}\n`);
}

function mutableCheckpointSnapshot(runId: string): Record<string, unknown> {
  return structuredClone({
    ...snapshot(request(runId), runId),
    integrationCheckpoint: integrationCheckpoint(),
  }) as unknown as Record<string, unknown>;
}

function checkpointRecord(candidate: Record<string, unknown>): Record<string, unknown> {
  return candidate["integrationCheckpoint"] as Record<string, unknown>;
}

function mutableWaitingSnapshot(
  runId: string,
  kind: WaitingInputCheckpoint["kind"] = "direct",
): Record<string, unknown> {
  const candidate = snapshot(request(runId), runId);
  candidate.result.status = "waiting_input";
  candidate.result.needsAction = "grant access";
  candidate.waitingInputCheckpoint = waitingInputCheckpoint(kind);
  return structuredClone(candidate) as unknown as Record<string, unknown>;
}

function waitingCheckpointRecord(candidate: Record<string, unknown>): Record<string, unknown> {
  return candidate["waitingInputCheckpoint"] as Record<string, unknown>;
}

function waitingTurnRecord(candidate: Record<string, unknown>): Record<string, unknown> {
  return waitingCheckpointRecord(candidate)["turn"] as Record<string, unknown>;
}

describe("JobStore", () => {
  it("writes atomic snapshots and rejects a mismatched run request", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    store.save(snapshot());
    expect(store.load("run-1")).toEqual(snapshot());
    expect(() => assertMatchingRequest(snapshot(), request("different"))).toThrow(
      "different request",
    );
    store.save(snapshot(request("replacement")));
    expect(store.load("run-1")?.request.objective).toBe("replacement");
    expect(readdirSync(store.jobDirectory("run-1"))).toEqual(["job.json"]);
  });

  it("loads legacy snapshots without optional checkpoints and restores old defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const legacy = structuredClone(snapshot()) as unknown as Record<string, unknown>;
    delete legacy["remoteTurns"];
    delete legacy["coordinatorThreadId"];
    writeRawSnapshot(store, "run-1", legacy);

    expect(store.load("run-1")).toMatchObject({
      remoteTurns: [],
      coordinatorThreadId: null,
    });
    expect(store.load("run-1")?.integrationCheckpoint).toBeUndefined();
    expect(store.load("run-1")?.waitingInputCheckpoint).toBeUndefined();
  });

  it("rejects malformed active snapshots with a clear error", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const directory = store.jobDirectory("run-1");
    mkdirSync(directory);
    writeFileSync(join(directory, "job.json"), "{not-json\n");

    expect(() => store.load("run-1")).toThrow(
      "invalid snapshot for run run-1: job.json is not valid JSON",
    );
  });

  it("checkpoints remote turn ids without replacing the job result", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const checkpointed = snapshot();
    checkpointed.integrationCheckpoint = integrationCheckpoint();
    store.save(checkpointed);
    store.recordRemoteTurn("run-1", {
      role: "leaf",
      taskId: "leaf-a",
      threadId: "thread-a",
      turnId: "turn-a",
      access: "workspaceWrite",
      state: "running",
      updatedAt: "2026-08-28T00:00:01.000Z",
    });

    expect(store.load("run-1")).toMatchObject({
      result: { status: "pending" },
      integrationCheckpoint: integrationCheckpoint(),
      remoteTurns: [
        {
          role: "leaf",
          taskId: "leaf-a",
          threadId: "thread-a",
          turnId: "turn-a",
          state: "running",
        },
      ],
    });
  });

  it("round-trips and validates accounted remote usage turn keys", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const candidate = snapshot();
    candidate.accountedUsageTurnKeys = ['["finalReview",null,null,"planner-thread","review-turn"]'];
    store.save(candidate);

    expect(store.load("run-1")?.accountedUsageTurnKeys).toEqual(candidate.accountedUsageTurnKeys);
    store.recordRemoteTurn("run-1", {
      role: "finalReview",
      threadId: "planner-thread",
      turnId: "review-turn-2",
      access: "readOnly",
      state: "terminal",
      updatedAt: "2026-08-28T00:00:01.000Z",
    });
    expect(store.load("run-1")?.accountedUsageTurnKeys).toEqual(candidate.accountedUsageTurnKeys);

    for (const invalid of [
      ["duplicate", "duplicate"],
      [""],
      Array.from({ length: 513 }, (_, index) => `turn-${String(index)}`),
    ]) {
      const malformed = structuredClone(candidate) as unknown as Record<string, unknown>;
      malformed["accountedUsageTurnKeys"] = invalid;
      writeRawSnapshot(store, "run-1", malformed);
      expect(() => store.load("run-1")).toThrow("accountedUsageTurnKeys");
    }
  });

  it("round-trips every waiting input checkpoint variant", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);

    for (const kind of ["admission", "direct", "leaves", "integration"] as const) {
      const runId = `waiting-${kind}`;
      const candidate = snapshot(request(runId), runId);
      candidate.result.status = "waiting_input";
      candidate.result.needsAction = "grant access";
      candidate.waitingInputCheckpoint = waitingInputCheckpoint(kind);
      store.save(candidate);

      expect(store.load(runId)?.waitingInputCheckpoint).toEqual(waitingInputCheckpoint(kind));
    }
  });

  it("preserves a waiting input checkpoint while recording a remote turn", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const candidate = snapshot();
    candidate.result.status = "waiting_input";
    candidate.result.needsAction = "grant access";
    candidate.waitingInputCheckpoint = waitingInputCheckpoint("direct");
    store.save(candidate);

    store.recordRemoteTurn("run-1", {
      role: "direct",
      threadId: "direct-thread",
      turnId: "next-turn",
      access: "workspaceWrite",
      state: "running",
      updatedAt: "2026-08-28T00:00:03.000Z",
    });

    expect(store.load("run-1")?.waitingInputCheckpoint).toEqual(waitingInputCheckpoint("direct"));
  });

  it("validates every integration checkpoint field and its size bounds", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const cases: Array<{
      name: string;
      issue: string;
      mutate(candidate: Record<string, unknown>): void;
    }> = [
      {
        name: "checkpoint object",
        issue: "integrationCheckpoint must be an object",
        mutate: (candidate) => {
          candidate["integrationCheckpoint"] = null;
        },
      },
      {
        name: "plan id",
        issue: "integrationCheckpoint.planId",
        mutate: (candidate) => {
          checkpointRecord(candidate)["planId"] = "";
        },
      },
      {
        name: "leaf count",
        issue: "integrationCheckpoint.leafIdentities",
        mutate: (candidate) => {
          const identity = integrationCheckpoint().leafIdentities[0];
          checkpointRecord(candidate)["leafIdentities"] = Array.from(
            { length: 21 },
            () => identity,
          );
        },
      },
      {
        name: "leaf task id",
        issue: "integrationCheckpoint.leafIdentities[0].taskId",
        mutate: (candidate) => {
          const identities = checkpointRecord(candidate)["leafIdentities"] as Array<
            Record<string, unknown>
          >;
          identities[0]!["taskId"] = "x".repeat(129);
        },
      },
      {
        name: "leaf remote id",
        issue: "integrationCheckpoint.leafIdentities[0].threadId",
        mutate: (candidate) => {
          const identities = checkpointRecord(candidate)["leafIdentities"] as Array<
            Record<string, unknown>
          >;
          identities[0]!["threadId"] = "";
        },
      },
      {
        name: "leaf timestamp",
        issue: "integrationCheckpoint.leafIdentities[0].completedAt",
        mutate: (candidate) => {
          const identities = checkpointRecord(candidate)["leafIdentities"] as Array<
            Record<string, unknown>
          >;
          identities[0]!["completedAt"] = "2026-08-28";
        },
      },
      {
        name: "response",
        issue: "integrationCheckpoint.response",
        mutate: (candidate) => {
          checkpointRecord(candidate)["response"] = "x".repeat(200_001);
        },
      },
      {
        name: "validator count",
        issue: "integrationCheckpoint.validation",
        mutate: (candidate) => {
          checkpointRecord(candidate)["validation"] = Array.from({ length: 65 }, () => ({
            command: "test",
            status: "passed",
            summary: "ok",
          }));
        },
      },
      {
        name: "validator command",
        issue: "integrationCheckpoint.validation[0].command",
        mutate: (candidate) => {
          const validation = checkpointRecord(candidate)["validation"] as Array<
            Record<string, unknown>
          >;
          validation[0]!["command"] = "";
        },
      },
      {
        name: "validator status",
        issue: "integrationCheckpoint.validation[0].status",
        mutate: (candidate) => {
          const validation = checkpointRecord(candidate)["validation"] as Array<
            Record<string, unknown>
          >;
          validation[0]!["status"] = "unknown";
        },
      },
      {
        name: "validator summary",
        issue: "integrationCheckpoint.validation[0].summary",
        mutate: (candidate) => {
          const validation = checkpointRecord(candidate)["validation"] as Array<
            Record<string, unknown>
          >;
          validation[0]!["summary"] = "x".repeat(2_001);
        },
      },
      {
        name: "integrator id",
        issue: "integrationCheckpoint.integratorThreadId",
        mutate: (candidate) => {
          checkpointRecord(candidate)["integratorThreadId"] = "";
        },
      },
      {
        name: "launch skew",
        issue: "integrationCheckpoint.launchSkewMs",
        mutate: (candidate) => {
          checkpointRecord(candidate)["launchSkewMs"] = -1;
        },
      },
      {
        name: "peak concurrency",
        issue: "integrationCheckpoint.peakConcurrency",
        mutate: (candidate) => {
          checkpointRecord(candidate)["peakConcurrency"] = 1.5;
        },
      },
      {
        name: "replan count",
        issue: "integrationCheckpoint.replanCount",
        mutate: (candidate) => {
          checkpointRecord(candidate)["replanCount"] = 2;
        },
      },
      {
        name: "checkpoint timestamp",
        issue: "integrationCheckpoint.updatedAt",
        mutate: (candidate) => {
          checkpointRecord(candidate)["updatedAt"] = "not-a-date";
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const runId = `invalid-checkpoint-${String(index)}`;
      const candidate = mutableCheckpointSnapshot(runId);
      testCase.mutate(candidate);
      writeRawSnapshot(store, runId, candidate);
      expect(() => store.load(runId), testCase.name).toThrow(
        `invalid snapshot for run ${runId}: ${testCase.issue}`,
      );
    }
  });

  it("validates every waiting input checkpoint variant and its size bounds", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const cases: Array<{
      name: string;
      kind?: WaitingInputCheckpoint["kind"];
      issue: string;
      mutate(candidate: Record<string, unknown>): void;
    }> = [
      {
        name: "checkpoint object",
        issue: "waitingInputCheckpoint must be an object",
        mutate: (candidate) => {
          candidate["waitingInputCheckpoint"] = null;
        },
      },
      {
        name: "kind",
        issue: "waitingInputCheckpoint.kind",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["kind"] = "unknown";
        },
      },
      {
        name: "turn object",
        issue: "waitingInputCheckpoint.turn",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["turn"] = null;
        },
      },
      {
        name: "thread id",
        issue: "waitingInputCheckpoint.turn.threadId",
        mutate: (candidate) => {
          waitingTurnRecord(candidate)["threadId"] = "";
        },
      },
      {
        name: "previous turn id",
        issue: "waitingInputCheckpoint.turn.previousTurnId",
        mutate: (candidate) => {
          waitingTurnRecord(candidate)["previousTurnId"] = "x".repeat(4_097);
        },
      },
      {
        name: "cwd",
        issue: "waitingInputCheckpoint.turn.cwd",
        mutate: (candidate) => {
          waitingTurnRecord(candidate)["cwd"] = "x".repeat(4_097);
        },
      },
      {
        name: "needs action",
        issue: "waitingInputCheckpoint.turn.needsAction",
        mutate: (candidate) => {
          waitingTurnRecord(candidate)["needsAction"] = "x".repeat(16_001);
        },
      },
      {
        name: "capability count",
        issue: "waitingInputCheckpoint.turn.capabilities",
        mutate: (candidate) => {
          waitingTurnRecord(candidate)["capabilities"] = Array.from({ length: 17 }, () => ({
            kind: "plugin",
            name: "browser",
          }));
        },
      },
      {
        name: "capability kind",
        issue: "waitingInputCheckpoint.turn.capabilities[0].kind",
        mutate: (candidate) => {
          const capabilities = waitingTurnRecord(candidate)["capabilities"] as Array<
            Record<string, unknown>
          >;
          capabilities[0]!["kind"] = "tool";
        },
      },
      {
        name: "capability name",
        issue: "waitingInputCheckpoint.turn.capabilities[0].name",
        mutate: (candidate) => {
          const capabilities = waitingTurnRecord(candidate)["capabilities"] as Array<
            Record<string, unknown>
          >;
          capabilities[0]!["name"] = "";
        },
      },
      {
        name: "capability path",
        issue: "waitingInputCheckpoint.turn.capabilities[0].path",
        mutate: (candidate) => {
          const capabilities = waitingTurnRecord(candidate)["capabilities"] as Array<
            Record<string, unknown>
          >;
          capabilities[0]!["path"] = "x".repeat(4_097);
        },
      },
      {
        name: "turn timestamp",
        issue: "waitingInputCheckpoint.turn.updatedAt",
        mutate: (candidate) => {
          waitingTurnRecord(candidate)["updatedAt"] = "2026-08-28";
        },
      },
      {
        name: "leaves plan id",
        kind: "leaves",
        issue: "waitingInputCheckpoint.planId",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["planId"] = "";
        },
      },
      {
        name: "leaf count",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves",
        mutate: (candidate) => {
          const leaf = (
            waitingInputCheckpoint("leaves") as Extract<WaitingInputCheckpoint, { kind: "leaves" }>
          ).leaves[0];
          waitingCheckpointRecord(candidate)["leaves"] = Array.from({ length: 21 }, () => leaf);
        },
      },
      {
        name: "leaf object",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves[0]",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["leaves"] = [null];
        },
      },
      {
        name: "leaf task id",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves[0].taskId",
        mutate: (candidate) => {
          const leaves = waitingCheckpointRecord(candidate)["leaves"] as Array<
            Record<string, unknown>
          >;
          leaves[0]!["taskId"] = "";
        },
      },
      {
        name: "leaf thread id",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves[0].threadId",
        mutate: (candidate) => {
          const leaves = waitingCheckpointRecord(candidate)["leaves"] as Array<
            Record<string, unknown>
          >;
          leaves[0]!["threadId"] = "";
        },
      },
      {
        name: "leaf previous turn id",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves[0].previousTurnId",
        mutate: (candidate) => {
          const leaves = waitingCheckpointRecord(candidate)["leaves"] as Array<
            Record<string, unknown>
          >;
          leaves[0]!["previousTurnId"] = null;
        },
      },
      {
        name: "leaf attempt",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves[0].attempt",
        mutate: (candidate) => {
          const leaves = waitingCheckpointRecord(candidate)["leaves"] as Array<
            Record<string, unknown>
          >;
          leaves[0]!["attempt"] = 0;
        },
      },
      {
        name: "leaf needs action",
        kind: "leaves",
        issue: "waitingInputCheckpoint.leaves[0].needsAction",
        mutate: (candidate) => {
          const leaves = waitingCheckpointRecord(candidate)["leaves"] as Array<
            Record<string, unknown>
          >;
          leaves[0]!["needsAction"] = "";
        },
      },
      {
        name: "leaves timestamp",
        kind: "leaves",
        issue: "waitingInputCheckpoint.updatedAt",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["updatedAt"] = "not-a-date";
        },
      },
      {
        name: "integration plan id",
        kind: "integration",
        issue: "waitingInputCheckpoint.planId",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["planId"] = "x".repeat(129);
        },
      },
      {
        name: "integration leaf identities",
        kind: "integration",
        issue: "waitingInputCheckpoint.leafIdentities",
        mutate: (candidate) => {
          waitingCheckpointRecord(candidate)["leafIdentities"] = [];
        },
      },
      {
        name: "integration leaf timestamp",
        kind: "integration",
        issue: "waitingInputCheckpoint.leafIdentities[0].completedAt",
        mutate: (candidate) => {
          const identities = waitingCheckpointRecord(candidate)["leafIdentities"] as Array<
            Record<string, unknown>
          >;
          identities[0]!["completedAt"] = "tomorrow";
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const runId = `invalid-waiting-${String(index)}`;
      const candidate = mutableWaitingSnapshot(runId, testCase.kind);
      testCase.mutate(candidate);
      writeRawSnapshot(store, runId, candidate);
      expect(() => store.load(runId), testCase.name).toThrow(
        `invalid snapshot for run ${runId}: ${testCase.issue}`,
      );
    }
  });

  it("keeps distinct turns on a reused thread and replaces only the pending placeholder", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    store.save(snapshot());
    const base = {
      role: "planner" as const,
      threadId: "planner-thread",
      access: "readOnly" as const,
    };
    store.recordRemoteTurn("run-1", {
      ...base,
      turnId: null,
      state: "thread_started",
      updatedAt: "2026-08-28T00:00:01.000Z",
    });
    store.recordRemoteTurn("run-1", {
      ...base,
      turnId: "plan-turn",
      state: "terminal",
      updatedAt: "2026-08-28T00:00:02.000Z",
    });
    store.recordRemoteTurn("run-1", {
      ...base,
      turnId: null,
      state: "thread_started",
      updatedAt: "2026-08-28T00:00:03.000Z",
    });
    store.recordRemoteTurn("run-1", {
      ...base,
      turnId: "patch-turn",
      state: "running",
      updatedAt: "2026-08-28T00:00:04.000Z",
    });

    expect(store.load("run-1")?.remoteTurns).toEqual([
      expect.objectContaining({ turnId: "plan-turn", state: "terminal" }),
      expect.objectContaining({ turnId: "patch-turn", state: "running" }),
    ]);
  });

  it("durably appends complete event records", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    store.appendEvent("run-1", { type: "started", at: "2026-01-01T00:00:00.000Z" });
    store.appendEvent("run-1", {
      type: "finished",
      at: "2026-01-01T00:00:01.000Z",
      data: { ok: true },
    });

    const events = readFileSync(join(store.jobDirectory("run-1"), "events.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(events).toEqual([
      { type: "started", at: "2026-01-01T00:00:00.000Z" },
      { type: "finished", at: "2026-01-01T00:00:01.000Z", data: { ok: true } },
    ]);
  });

  it("reads only a bounded deterministic slice and skips corrupt snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    store.save(snapshot(request("newest"), "z-valid"));
    const corrupt = mutableCheckpointSnapshot("y-corrupt");
    const validation = checkpointRecord(corrupt)["validation"] as Array<Record<string, unknown>>;
    validation[0]!["status"] = "not-a-validator-status";
    writeRawSnapshot(store, "y-corrupt", corrupt);
    store.save(snapshot(request("older"), "x-valid"));
    const corruptWaiting = mutableWaitingSnapshot("w-corrupt-waiting");
    waitingTurnRecord(corruptWaiting)["updatedAt"] = "not-a-date";
    writeRawSnapshot(store, "w-corrupt-waiting", corruptWaiting);
    store.save(snapshot(request("oldest"), "v-valid"));

    expect(store.readSnapshots({ maxJobs: 2 }).map((item) => item.result.runId)).toEqual([
      "z-valid",
    ]);
    expect(store.readSnapshots({ maxJobs: 3 }).map((item) => item.result.runId)).toEqual([
      "z-valid",
      "x-valid",
    ]);
    expect(store.readSnapshots({ maxJobs: 5 }).map((item) => item.result.runId)).toEqual([
      "z-valid",
      "x-valid",
      "v-valid",
    ]);
    expect(() => store.readSnapshots({ maxJobs: 0 })).toThrow("maxJobs");
    expect(() => store.readSnapshots({ maxJobs: 1_025 })).toThrow("maxJobs");
  });

  it("uses stable object-key ordering and an exclusive lock", () => {
    expect(hashRunRequest({ cwd: "/x", objective: "a" })).toBe(
      hashRunRequest({ objective: "a", cwd: "/x" }),
    );
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const lock = store.acquire("run-1");
    expect(() => store.acquire("run-1")).toThrow("already active");
    lock.release();
    expect(() => store.acquire("run-1").release()).not.toThrow();
  });

  it("recovers a lock owned by a dead process", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const directory = store.jobDirectory("run-1");
    const path = join(directory, "job.lock");
    mkdirSync(directory);
    writeFileSync(
      path,
      `${JSON.stringify({
        token: "stale-owner",
        pid: Number.MAX_SAFE_INTEGER,
        createdAt: new Date(0).toISOString(),
      })}\n`,
    );

    const lock = store.acquire("run-1");
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("does not let an old owner remove a replacement lock", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-store-"));
    roots.push(root);
    const store = new JobStore(root);
    const lock = store.acquire("run-1");
    const path = join(store.jobDirectory("run-1"), "job.lock");
    rmSync(path);
    writeFileSync(
      path,
      `${JSON.stringify({
        token: "replacement-owner",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
    );

    lock.release();
    expect(JSON.parse(readFileSync(path, "utf8")) as unknown).toMatchObject({
      token: "replacement-owner",
    });
    expect(() => store.acquire("run-1")).toThrow("already active");
  });
});
