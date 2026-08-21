import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneError } from "../src/domain/errors.js";
import {
  baseMissionInput,
  createTestHarness,
  lunaTaskInput,
  terraTaskInput,
  type TestHarness,
} from "./helpers.js";

describe("ControlPlane", () => {
  let harness: TestHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("makes mission creation idempotent and enforces role/model/effort policy", () => {
    harness = createTestHarness();
    const { controlPlane, repository } = harness;

    const mission = controlPlane.createMission(baseMissionInput());
    const replayed = controlPlane.createMission(baseMissionInput());
    expect(replayed.id).toBe(mission.id);
    expect(repository.listEvents(mission.id, 0, 50)).toHaveLength(1);
    expect(() =>
      controlPlane.createMission({
        ...baseMissionInput(),
        objective: "A different request using the same idempotency key",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "conflict",
      }),
    );

    const terra = controlPlane.allocateTask(terraTaskInput(mission.id));
    expect(terra).toMatchObject({
      status: "ready",
      role: "coordinator",
      model: "terra",
      reasoningEffort: "high",
      maxEffort: "max",
    });
    expect(() =>
      controlPlane.allocateTask(
        lunaTaskInput(
          mission.id,
          terra.id,
          terra.version,
          "lease_not_started",
          "task:child-before-parent-start:1",
        ),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "invalid_state",
      }),
    );
    const raisedEffort = controlPlane.setTaskEffort({
      taskId: terra.id,
      actorId: "sol-root",
      expectedVersion: terra.version,
      reasoningEffort: "max",
      reason: "The cell has high-coupling integration risk.",
      idempotencyKey: "effort:terra:max:1",
    });
    expect(raisedEffort.reasoningEffort).toBe("max");

    expect(() =>
      controlPlane.allocateTask({
        ...terraTaskInput(mission.id, "task:bad-root:1"),
        role: "operator",
        model: "luna",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "policy_violation",
      }),
    );

    const cheapTerra = controlPlane.allocateTask({
      ...terraTaskInput(mission.id, "task:terra-high:1"),
      reasoningEffort: "high",
      maxEffort: "high",
      budget: { tokens: 500, costUsd: 5, wallClockSeconds: 500, toolCalls: 50 },
    });
    expect(cheapTerra.reasoningEffort).toBe("high");
    expect(cheapTerra.maxEffort).toBe("high");
  });

  it("uses optimistic versions, expiring leases, and stable idempotent lease replay", () => {
    harness = createTestHarness();
    const { controlPlane, advance } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const task = controlPlane.allocateTask(terraTaskInput(mission.id));

    const claimed = controlPlane.claimTask({
      taskId: task.id,
      workerId: "terra-a",
      expectedVersion: task.version,
      leaseSeconds: 60,
      idempotencyKey: "claim:terra-a:1",
    });
    const replayed = controlPlane.claimTask({
      taskId: task.id,
      workerId: "terra-a",
      expectedVersion: task.version,
      leaseSeconds: 60,
      idempotencyKey: "claim:terra-a:1",
    });
    expect(replayed.leaseToken).toBe(claimed.leaseToken);

    expect(() =>
      controlPlane.startTask({
        taskId: task.id,
        workerId: "terra-a",
        leaseToken: claimed.leaseToken!,
        expectedVersion: task.version,
        idempotencyKey: "start:stale:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "conflict",
      }),
    );

    advance(61_000);
    const reclaimed = controlPlane.claimTask({
      taskId: task.id,
      workerId: "terra-b",
      expectedVersion: claimed.version,
      leaseSeconds: 60,
      idempotencyKey: "claim:terra-b:1",
    });
    expect(reclaimed.leaseOwner).toBe("terra-b");
    expect(reclaimed.leaseToken).not.toBe(claimed.leaseToken);
  });

  it("runs candidate, independent check, verification, commit, and dependency release", () => {
    harness = createTestHarness();
    const { controlPlane } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const terra = controlPlane.allocateTask(terraTaskInput(mission.id));
    const terraClaim = controlPlane.claimTask({
      taskId: terra.id,
      workerId: "terra-1",
      expectedVersion: terra.version,
      idempotencyKey: "claim:terra:workflow:1",
    });
    const terraRunning = controlPlane.startTask({
      taskId: terra.id,
      workerId: "terra-1",
      leaseToken: terraClaim.leaseToken!,
      expectedVersion: terraClaim.version,
      idempotencyKey: "start:terra:workflow:1",
    });
    const luna = controlPlane.allocateTask(
      lunaTaskInput(mission.id, terra.id, terraRunning.version, terraRunning.leaseToken!),
    );
    const dependent = controlPlane.allocateTask({
      ...lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:dependent:1",
      ),
      objective: "Consume the first committed artifact",
      dependencies: [luna.id],
      budget: {
        tokens: 1_000,
        costUsd: 10,
        wallClockSeconds: 1_000,
        toolCalls: 100,
      },
    });
    expect(dependent.status).toBe("proposed");
    expect(() =>
      controlPlane.setTaskEffort({
        taskId: luna.id,
        actorId: "terra-1",
        expectedVersion: luna.version,
        expectedParentVersion: terraRunning.version,
        parentLeaseToken: terraRunning.leaseToken!,
        reasoningEffort: "max",
        reason: "Attempt to exceed the recorded xhigh maximum.",
        idempotencyKey: "effort:luna:too-high:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "policy_violation",
      }),
    );

    const claimed = controlPlane.claimTask({
      taskId: luna.id,
      workerId: "luna-producer-a",
      expectedVersion: luna.version,
      idempotencyKey: "claim:luna:1",
    });
    const running = controlPlane.startTask({
      taskId: luna.id,
      workerId: "luna-producer-a",
      leaseToken: claimed.leaseToken!,
      expectedVersion: claimed.version,
      idempotencyKey: "start:luna:1",
    });
    const artifact = controlPlane.putArtifact({
      taskId: luna.id,
      actorId: "luna-producer-a",
      kind: "report",
      mimeType: "text/plain",
      content: "verified candidate payload",
      encoding: "utf8",
      metadata: { format: "test" },
      idempotencyKey: "artifact:luna:1",
    });
    const candidate = controlPlane.submitCandidate({
      taskId: luna.id,
      workerId: "luna-producer-a",
      leaseToken: running.leaseToken!,
      expectedVersion: running.version,
      summary: "Produced the bounded artifact.",
      artifactRefs: [artifact.id],
      claims: [
        {
          statement: "The payload was produced.",
          confidence: 0.9,
          evidenceRefs: [artifact.id],
          artifactId: artifact.id,
        },
      ],
      usage: { tokens: 100, costUsd: 0.1, toolCalls: 2, wallClockSeconds: 5 },
      idempotencyKey: "candidate:luna:1",
    });
    expect(candidate.task.status).toBe("candidate");

    expect(() =>
      controlPlane.submitCandidate({
        taskId: luna.id,
        workerId: "luna-producer-a",
        leaseToken: running.leaseToken!,
        expectedVersion: running.version,
        summary: "x".repeat(501),
        artifactRefs: [artifact.id],
        claims: [],
        idempotencyKey: "candidate:luna:too-long:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "validation_error",
      }),
    );

    expect(() =>
      controlPlane.checkResult({
        taskId: luna.id,
        reviewerId: "luna-producer-a",
        expectedVersion: candidate.task.version,
        approved: true,
        evidenceRefs: [artifact.id],
        notes: "Self approval is forbidden.",
        idempotencyKey: "check:self:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "forbidden",
      }),
    );

    const checked = controlPlane.checkResult({
      taskId: luna.id,
      reviewerId: "luna-verifier-b",
      expectedVersion: candidate.task.version,
      approved: true,
      evidenceRefs: [artifact.id],
      notes: "Artifact content and done criteria match.",
      idempotencyKey: "check:luna:1",
    });
    const verified = controlPlane.verifyResult({
      taskId: luna.id,
      reviewerId: "terra-parent",
      expectedVersion: checked.version,
      approved: true,
      evidenceRefs: [artifact.id],
      notes: "Independent check and deterministic evidence passed.",
      idempotencyKey: "verify:luna:1",
    });
    const committed = controlPlane.commitTask({
      taskId: luna.id,
      actorId: "terra-parent",
      expectedVersion: verified.version,
      idempotencyKey: "commit:luna:1",
    });

    expect(committed.status).toBe("committed");
    expect(controlPlane.getTask(dependent.id).status).toBe("ready");
    const details = controlPlane.getMission(mission.id, true);
    expect("claims" in details && details.claims[0]?.status).toBe("verified");
  });

  it("rejects oversubscribed child budgets and over-limit reported usage", () => {
    harness = createTestHarness();
    const { controlPlane } = harness;
    const mission = controlPlane.createMission({
      ...baseMissionInput(),
      budget: {
        tokens: 100,
        costUsd: 10,
        wallClockSeconds: 100,
        toolCalls: 10,
        maxChildren: 1,
      },
    });
    const terra = controlPlane.allocateTask({
      ...terraTaskInput(mission.id),
      budget: {
        tokens: 80,
        costUsd: 8,
        wallClockSeconds: 80,
        toolCalls: 8,
        maxChildren: 1,
      },
    });

    expect(() =>
      controlPlane.allocateTask({
        ...terraTaskInput(mission.id, "task:second-root:1"),
        budget: { tokens: 1 },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "budget_exceeded",
      }),
    );

    const claimed = controlPlane.claimTask({
      taskId: terra.id,
      workerId: "terra-a",
      expectedVersion: terra.version,
      idempotencyKey: "claim:budget:1",
    });
    const running = controlPlane.startTask({
      taskId: terra.id,
      workerId: "terra-a",
      leaseToken: claimed.leaseToken!,
      expectedVersion: claimed.version,
      idempotencyKey: "start:budget:1",
    });
    expect(() =>
      controlPlane.submitCandidate({
        taskId: terra.id,
        workerId: "terra-a",
        leaseToken: running.leaseToken!,
        expectedVersion: running.version,
        summary: "Too expensive",
        artifactRefs: [],
        claims: [],
        usage: { tokens: 81 },
        idempotencyKey: "candidate:over-budget:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "budget_exceeded",
      }),
    );
    expect(controlPlane.getTask(terra.id).status).toBe("running");
  });

  it("stores artifacts by content hash and returns bounded reads", () => {
    harness = createTestHarness(64);
    const { controlPlane } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const task = controlPlane.allocateTask(terraTaskInput(mission.id));
    const claim = controlPlane.claimTask({
      taskId: task.id,
      workerId: "terra-a",
      expectedVersion: task.version,
      idempotencyKey: "claim:artifact:1",
    });
    controlPlane.startTask({
      taskId: task.id,
      workerId: "terra-a",
      leaseToken: claim.leaseToken!,
      expectedVersion: claim.version,
      idempotencyKey: "start:artifact:1",
    });
    const artifact = controlPlane.putArtifact({
      taskId: task.id,
      actorId: "terra-a",
      kind: "note",
      mimeType: "text/plain",
      content: "0123456789",
      encoding: "utf8",
      idempotencyKey: "artifact:bounded:1",
    });
    const read = controlPlane.getArtifact(artifact.id, "utf8", 4);
    expect(read.content).toBe("0123");
    expect(read.truncated).toBe(true);

    expect(() =>
      controlPlane.putArtifact({
        taskId: task.id,
        actorId: "terra-a",
        kind: "oversized",
        mimeType: "text/plain",
        content: "x".repeat(65),
        encoding: "utf8",
        idempotencyKey: "artifact:oversized:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "validation_error",
      }),
    );
  });

  it("converts a failed child reservation to actual usage for a bounded replacement", () => {
    harness = createTestHarness();
    const { controlPlane } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const terra = controlPlane.allocateTask({
      ...terraTaskInput(mission.id),
      budget: { tokens: 200, maxChildren: 1 },
    });
    const terraClaim = controlPlane.claimTask({
      taskId: terra.id,
      workerId: "terra-1",
      expectedVersion: terra.version,
      idempotencyKey: "claim:terra:tight-budget:1",
    });
    const terraRunning = controlPlane.startTask({
      taskId: terra.id,
      workerId: "terra-1",
      leaseToken: terraClaim.leaseToken!,
      expectedVersion: terraClaim.version,
      idempotencyKey: "start:terra:tight-budget:1",
    });
    const first = controlPlane.allocateTask({
      ...lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:tight-first:1",
      ),
      budget: { tokens: 200 },
    });
    const firstClaim = controlPlane.claimTask({
      taskId: first.id,
      workerId: "luna-tight",
      expectedVersion: first.version,
      idempotencyKey: "claim:luna:tight:1",
    });
    const firstRunning = controlPlane.startTask({
      taskId: first.id,
      workerId: "luna-tight",
      leaseToken: firstClaim.leaseToken!,
      expectedVersion: firstClaim.version,
      idempotencyKey: "start:luna:tight:1",
    });
    controlPlane.failTask({
      taskId: first.id,
      workerId: "luna-tight",
      leaseToken: firstRunning.leaseToken!,
      expectedVersion: firstRunning.version,
      reason: "Bounded failed attempt",
      usage: { tokens: 20 },
      idempotencyKey: "fail:luna:tight:1",
    });

    const replacement = controlPlane.allocateTask({
      ...lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:tight-replacement:1",
      ),
      budget: { tokens: 180 },
    });
    expect(replacement.status).toBe("ready");
  });

  it("records failure and requires direct-parent authority to supersede or cancel", () => {
    harness = createTestHarness();
    const { controlPlane } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const terra = controlPlane.allocateTask(terraTaskInput(mission.id));
    const terraClaim = controlPlane.claimTask({
      taskId: terra.id,
      workerId: "terra-1",
      expectedVersion: terra.version,
      idempotencyKey: "claim:terra:recovery:1",
    });
    const terraRunning = controlPlane.startTask({
      taskId: terra.id,
      workerId: "terra-1",
      leaseToken: terraClaim.leaseToken!,
      expectedVersion: terraClaim.version,
      idempotencyKey: "start:terra:recovery:1",
    });
    const failedAttempt = controlPlane.allocateTask(
      lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:failed-attempt:1",
      ),
    );
    const lunaClaim = controlPlane.claimTask({
      taskId: failedAttempt.id,
      workerId: "luna-failed",
      expectedVersion: failedAttempt.version,
      idempotencyKey: "claim:luna:failed:1",
    });
    const lunaRunning = controlPlane.startTask({
      taskId: failedAttempt.id,
      workerId: "luna-failed",
      leaseToken: lunaClaim.leaseToken!,
      expectedVersion: lunaClaim.version,
      idempotencyKey: "start:luna:failed:1",
    });
    const failed = controlPlane.failTask({
      taskId: failedAttempt.id,
      workerId: "luna-failed",
      leaseToken: lunaRunning.leaseToken!,
      expectedVersion: lunaRunning.version,
      reason: "The required external input is irrecoverably invalid.",
      usage: { tokens: 50, toolCalls: 1 },
      idempotencyKey: "fail:luna:1",
    });
    expect(failed.status).toBe("failed");
    expect(failed.leaseToken).toBeNull();

    const replacement = controlPlane.allocateTask(
      lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:replacement:1",
      ),
    );
    expect(() =>
      controlPlane.supersedeTask({
        taskId: failed.id,
        replacementTaskId: replacement.id,
        actorId: "not-the-parent",
        expectedVersion: failed.version,
        expectedParentVersion: terraRunning.version,
        parentLeaseToken: terraRunning.leaseToken!,
        reason: "Unauthorized attempt",
        idempotencyKey: "supersede:unauthorized:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "lease_conflict",
      }),
    );

    const superseded = controlPlane.supersedeTask({
      taskId: failed.id,
      replacementTaskId: replacement.id,
      actorId: "terra-1",
      expectedVersion: failed.version,
      expectedParentVersion: terraRunning.version,
      parentLeaseToken: terraRunning.leaseToken!,
      reason: "A corrected sibling attempt now owns the work.",
      idempotencyKey: "supersede:luna:1",
    });
    expect(superseded.status).toBe("superseded");

    const cancellable = controlPlane.allocateTask({
      ...lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:cancel:1",
      ),
      budget: { tokens: 500, toolCalls: 20 },
    });
    const cancelled = controlPlane.cancelTask({
      taskId: cancellable.id,
      actorId: "terra-1",
      expectedVersion: cancellable.version,
      expectedParentVersion: terraRunning.version,
      parentLeaseToken: terraRunning.leaseToken!,
      reason: "The branch is no longer needed.",
      idempotencyKey: "cancel:luna:1",
    });
    expect(cancelled.status).toBe("cancelled");
  });

  it("returns compact children_status and gates low-risk candidates in one call", () => {
    harness = createTestHarness();
    const { controlPlane, repository } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const terra = controlPlane.allocateTask(terraTaskInput(mission.id));
    const terraClaim = controlPlane.claimTask({
      taskId: terra.id,
      workerId: "terra-1",
      expectedVersion: terra.version,
      leaseSeconds: 300,
      idempotencyKey: "claim:terra:gate:1",
    });
    const terraRunning = controlPlane.startTask({
      taskId: terra.id,
      workerId: "terra-1",
      leaseToken: terraClaim.leaseToken!,
      expectedVersion: terraClaim.version,
      idempotencyKey: "start:terra:gate:1",
    });

    const first = produceLunaCandidate(
      controlPlane,
      mission.id,
      terra.id,
      terraRunning.version,
      terraRunning.leaseToken!,
      "one",
    );
    const second = produceLunaCandidate(
      controlPlane,
      mission.id,
      terra.id,
      terraRunning.version,
      terraRunning.leaseToken!,
      "two",
    );
    const status = controlPlane.childrenStatus(terra.id);
    expect(status.parentTaskId).toBe(terra.id);
    expect(status.allTerminal).toBe(false);
    expect(status.children).toHaveLength(2);
    expect(status.children[0]).toEqual(
      expect.objectContaining({
        id: first.task.id,
        status: "candidate",
        summary: "Produced the bounded artifact.",
        producerId: "luna-producer-one",
      }),
    );
    expect(status.children[0]?.artifactRefs).toEqual([first.artifactId]);
    expect(JSON.stringify(status)).not.toContain("verified candidate payload");

    const gated = controlPlane.gateAndCommitResults({
      reviewerId: "terra-1",
      parentTaskId: terra.id,
      decisions: [
        {
          taskId: first.task.id,
          expectedVersion: first.task.version,
          approved: true,
          evidenceRefs: [first.artifactId],
          notes: "Summary, claims, and hashes match done criteria.",
        },
        {
          taskId: second.task.id,
          expectedVersion: second.task.version,
          approved: true,
          evidenceRefs: [second.artifactId],
          notes: "Summary, claims, and hashes match done criteria.",
        },
      ],
      idempotencyKey: "gate:batch:1",
    });
    expect(gated.tasks.map((task) => task.status)).toEqual(["committed", "committed"]);
    expect(repository.listReviews(mission.id).filter((review) => review.stage === "check")).toHaveLength(
      2,
    );
    expect(repository.listReviews(mission.id).filter((review) => review.stage === "verify")).toHaveLength(
      2,
    );

    const replayed = controlPlane.gateAndCommitResults({
      reviewerId: "terra-1",
      parentTaskId: terra.id,
      decisions: [
        {
          taskId: first.task.id,
          expectedVersion: first.task.version,
          approved: true,
          evidenceRefs: [first.artifactId],
          notes: "Summary, claims, and hashes match done criteria.",
        },
        {
          taskId: second.task.id,
          expectedVersion: second.task.version,
          approved: true,
          evidenceRefs: [second.artifactId],
          notes: "Summary, claims, and hashes match done criteria.",
        },
      ],
      idempotencyKey: "gate:batch:1",
    });
    expect(replayed.tasks.map((task) => task.id)).toEqual(gated.tasks.map((task) => task.id));
    expect(controlPlane.childrenStatus(terra.id).allTerminal).toBe(true);
  });

  it("rejects results_gate_and_commit for producers, high risk, and non-terminal children", () => {
    harness = createTestHarness();
    const { controlPlane } = harness;
    const mission = controlPlane.createMission(baseMissionInput());
    const terra = controlPlane.allocateTask(terraTaskInput(mission.id));
    const terraClaim = controlPlane.claimTask({
      taskId: terra.id,
      workerId: "terra-1",
      expectedVersion: terra.version,
      idempotencyKey: "claim:terra:gate-deny:1",
    });
    const terraRunning = controlPlane.startTask({
      taskId: terra.id,
      workerId: "terra-1",
      leaseToken: terraClaim.leaseToken!,
      expectedVersion: terraClaim.version,
      idempotencyKey: "start:terra:gate-deny:1",
    });
    const candidate = produceLunaCandidate(
      controlPlane,
      mission.id,
      terra.id,
      terraRunning.version,
      terraRunning.leaseToken!,
      "deny",
    );

    expect(() =>
      controlPlane.gateAndCommitResults({
        reviewerId: "luna-producer-deny",
        parentTaskId: terra.id,
        decisions: [
          {
            taskId: candidate.task.id,
            expectedVersion: candidate.task.version,
            approved: true,
            evidenceRefs: [candidate.artifactId],
            notes: "Producer self-approval.",
          },
        ],
        idempotencyKey: "gate:producer:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "forbidden",
      }),
    );

    const highMission = controlPlane.createMission({
      ...baseMissionInput("mission:create:high:1"),
      risk: "high",
    });
    const highTerra = controlPlane.allocateTask(terraTaskInput(highMission.id, "task:terra:high:1"));
    const highClaim = controlPlane.claimTask({
      taskId: highTerra.id,
      workerId: "terra-high",
      expectedVersion: highTerra.version,
      idempotencyKey: "claim:terra:high:1",
    });
    const highRunning = controlPlane.startTask({
      taskId: highTerra.id,
      workerId: "terra-high",
      leaseToken: highClaim.leaseToken!,
      expectedVersion: highClaim.version,
      idempotencyKey: "start:terra:high:1",
    });
    const highChild = produceLunaCandidate(
      controlPlane,
      highMission.id,
      highTerra.id,
      highRunning.version,
      highRunning.leaseToken!,
      "high",
      "terra-high",
    );
    expect(() =>
      controlPlane.gateAndCommitResults({
        reviewerId: "terra-high",
        parentTaskId: highTerra.id,
        decisions: [
          {
            taskId: highChild.task.id,
            expectedVersion: highChild.task.version,
            approved: true,
            evidenceRefs: [highChild.artifactId],
            notes: "High-risk must use separate gates.",
          },
        ],
        idempotencyKey: "gate:high:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "policy_violation",
      }),
    );

    const runningChild = controlPlane.allocateTask({
      ...lunaTaskInput(
        mission.id,
        terra.id,
        terraRunning.version,
        terraRunning.leaseToken!,
        "task:luna:still-running:1",
      ),
      budget: { tokens: 400, costUsd: 4, wallClockSeconds: 400, toolCalls: 40 },
    });
    expect(() =>
      controlPlane.gateAndCommitResults({
        reviewerId: "terra-1",
        parentTaskId: terra.id,
        decisions: [
          {
            taskId: runningChild.id,
            expectedVersion: runningChild.version,
            approved: true,
            notes: "Still running.",
          },
        ],
        idempotencyKey: "gate:running:1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({
        code: "invalid_state",
      }),
    );
  });
});

function produceLunaCandidate(
  controlPlane: TestHarness["controlPlane"],
  missionId: string,
  parentTaskId: string,
  expectedParentVersion: number,
  parentLeaseToken: string,
  label: string,
  parentActorId = "terra-1",
) {
  const luna = controlPlane.allocateTask({
    ...lunaTaskInput(
      missionId,
      parentTaskId,
      expectedParentVersion,
      parentLeaseToken,
      `task:luna:${label}:1`,
    ),
    actorId: parentActorId,
    budget: { tokens: 400, costUsd: 4, wallClockSeconds: 400, toolCalls: 40 },
  });
  const claimed = controlPlane.claimTask({
    taskId: luna.id,
    workerId: `luna-producer-${label}`,
    expectedVersion: luna.version,
    idempotencyKey: `claim:luna:${label}:1`,
  });
  const running = controlPlane.startTask({
    taskId: luna.id,
    workerId: `luna-producer-${label}`,
    leaseToken: claimed.leaseToken!,
    expectedVersion: claimed.version,
    idempotencyKey: `start:luna:${label}:1`,
  });
  const artifact = controlPlane.putArtifact({
    taskId: luna.id,
    actorId: `luna-producer-${label}`,
    kind: "report",
    mimeType: "text/plain",
    content: "verified candidate payload",
    encoding: "utf8",
    idempotencyKey: `artifact:luna:${label}:1`,
  });
  const candidate = controlPlane.submitCandidate({
    taskId: luna.id,
    workerId: `luna-producer-${label}`,
    leaseToken: running.leaseToken!,
    expectedVersion: running.version,
    summary: "Produced the bounded artifact.",
    artifactRefs: [artifact.id],
    claims: [
      {
        statement: "The payload was produced.",
        confidence: 0.9,
        evidenceRefs: [artifact.id],
        artifactId: artifact.id,
      },
    ],
    usage: { tokens: 20, costUsd: 0.02, toolCalls: 1, wallClockSeconds: 1 },
    idempotencyKey: `candidate:luna:${label}:1`,
  });
  return { task: candidate.task, artifactId: artifact.id };
}
