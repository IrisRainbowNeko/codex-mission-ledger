import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control-plane.js";
import { ArtifactStore } from "../src/infra/artifact-store.js";
import { ControlPlaneDatabase } from "../src/infra/database.js";
import { Repository } from "../src/infra/repository.js";

export interface TestHarness {
  controlPlane: ControlPlane;
  repository: Repository;
  database: ControlPlaneDatabase;
  advance(milliseconds: number): void;
  cleanup(): void;
}

export function createTestHarness(maxArtifactBytes = 1024 * 1024): TestHarness {
  const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-test-"));
  const database = new ControlPlaneDatabase(":memory:");
  const repository = new Repository(database);
  const artifactStore = new ArtifactStore(join(directory, "artifacts"), maxArtifactBytes);
  let time = Date.parse("2026-08-20T00:00:00.000Z");
  let sequence = 0;
  const controlPlane = new ControlPlane(repository, artifactStore, {
    defaultLeaseSeconds: 60,
    maxLeaseSeconds: 300,
    eventPageSize: 500,
    clock: () => new Date(time),
    idFactory: () => `test${String(++sequence).padStart(8, "0")}`,
  });

  return {
    controlPlane,
    repository,
    database,
    advance(milliseconds: number) {
      time += milliseconds;
    },
    cleanup() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function baseMissionInput(idempotencyKey = "mission:create:1") {
  return {
    objective: "Deliver a verified result",
    constraints: ["Use direct parent-child ownership"],
    successCriteria: ["Every produced task is committed"],
    risk: "medium" as const,
    budget: {
      tokens: 10_000,
      costUsd: 100,
      wallClockSeconds: 10_000,
      toolCalls: 1_000,
      maxChildren: 4,
    },
    actorId: "sol-root",
    idempotencyKey,
  };
}

export function terraTaskInput(missionId: string, idempotencyKey = "task:terra:1") {
  return {
    missionId,
    objective: "Own and integrate one coherent workstream",
    role: "coordinator" as const,
    model: "terra" as const,
    reasoningEffort: "xhigh" as const,
    maxEffort: "max" as const,
    capabilityPack: "software",
    doneCriteria: ["Integrated output is verified"],
    risk: "medium" as const,
    budget: {
      tokens: 6_000,
      costUsd: 60,
      wallClockSeconds: 6_000,
      toolCalls: 600,
      maxChildren: 4,
    },
    actorId: "sol-root",
    idempotencyKey,
  };
}

export function lunaTaskInput(
  missionId: string,
  parentTaskId: string,
  expectedParentVersion: number,
  parentLeaseToken: string,
  idempotencyKey = "task:luna:1",
) {
  return {
    missionId,
    parentTaskId,
    expectedParentVersion,
    parentLeaseToken,
    objective: "Produce one bounded artifact",
    role: "operator" as const,
    model: "luna" as const,
    reasoningEffort: "high" as const,
    maxEffort: "xhigh" as const,
    capabilityPack: "software",
    doneCriteria: ["Artifact is stored", "Claim cites the artifact"],
    risk: "low" as const,
    budget: {
      tokens: 2_000,
      costUsd: 20,
      wallClockSeconds: 2_000,
      toolCalls: 200,
    },
    actorId: "terra-1",
    idempotencyKey,
  };
}
