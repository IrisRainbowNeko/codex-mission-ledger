import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runRecoveryFaultInjectionProfile,
  type RecoveryFaultEvent,
} from "../scripts/run-real-benchmark.js";
import { hashBenchmarkBytes } from "../src/benchmark.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release recovery profile", () => {
  it("kills and restarts the process group without replaying the committed side effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-trio-recovery-test-"));
    roots.push(root);
    const artifact = await runRecoveryFaultInjectionProfile({
      evidenceRoot: root,
      implementation: "fixture",
      timeoutMs: 30_000,
    });

    expect(artifact.evidence).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      implementation: "fixture",
      checkpoint: { kind: "direct" },
      sideEffect: { invocationCount: 1 },
    });
    expect(artifact.evidence.initialProcess.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "worker" }),
        expect.objectContaining({ role: "app_server" }),
      ]),
    );
    expect(artifact.evidence.resumedProcess.workerPid).not.toBe(
      artifact.evidence.initialProcess.workerPid,
    );
    expect(artifact.evidence.events.map((event: RecoveryFaultEvent) => event.type)).toEqual([
      "worker_started",
      "checkpoint_observed",
      "fault_injected",
      "worker_restarted",
      "resume_completed",
      "side_effect_verified",
    ]);
    const bytes = await readFile(artifact.path);
    expect(hashBenchmarkBytes(bytes)).toBe(artifact.sha256);
    expect(bytes.byteLength).toBe(artifact.sizeBytes);
  }, 45_000);
});
