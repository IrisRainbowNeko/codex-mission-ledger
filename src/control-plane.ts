import { createHash, randomUUID } from "node:crypto";
import { assertCondition } from "./domain/errors.js";
import {
  CANDIDATE_SUMMARY_MAX_CHARS,
  COLLAPSIBLE_GATE_RISKS,
  TERRA_PATH_STRATEGIES,
  addBudgets,
  addUsage,
  assertAssignmentPolicy,
  assertBudgetWithin,
  assertFanoutCoordinatorObjective,
  assertParentChildPolicy,
  assertRootRoleForStrategy,
  assertTransition,
  assertUsageWithin,
  dependenciesSatisfied,
  isTerminalTaskStatus,
  normalizeBudget,
  normalizeDirectorPlan,
  normalizePortrait,
  normalizeStrategy,
  normalizeUsage,
} from "./domain/policy.js";
import {
  ZERO_USAGE,
  type AgentRole,
  type Artifact,
  type BudgetLimits,
  type ChildStatus,
  type ChildrenStatus,
  type Claim,
  type JsonObject,
  type Mission,
  type MissionPortrait,
  type MissionStrategy,
  type ModelTier,
  type ReasoningEffort,
  type RecoverySnapshot,
  type Review,
  type RiskLevel,
  type Task,
  type TaskStatus,
  type Usage,
} from "./domain/types.js";
import type { ArtifactStore } from "./infra/artifact-store.js";
import type { Repository } from "./infra/repository.js";

export interface ControlPlaneOptions {
  defaultLeaseSeconds: number;
  maxLeaseSeconds: number;
  eventPageSize: number;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface MissionCreateInput {
  objective: string;
  constraints?: string[];
  successCriteria: string[];
  risk: RiskLevel;
  strategy?: MissionStrategy;
  portrait?: MissionPortrait;
  directorPlan?: string | null;
  budget?: BudgetLimits;
  actorId: string;
  idempotencyKey: string;
}

export interface TaskAllocateInput {
  missionId: string;
  parentTaskId?: string | null;
  expectedParentVersion?: number;
  parentLeaseToken?: string;
  objective: string;
  role: AgentRole;
  model: ModelTier;
  reasoningEffort: ReasoningEffort;
  maxEffort?: ReasoningEffort;
  capabilityPack: string;
  dependencies?: string[];
  inputArtifactRefs?: string[];
  allowedTools?: string[];
  doneCriteria: string[];
  outputSchema?: JsonObject | null;
  risk: RiskLevel;
  budget?: BudgetLimits;
  actorId: string;
  idempotencyKey: string;
}

export interface ClaimTaskInput {
  taskId: string;
  workerId: string;
  expectedVersion: number;
  leaseSeconds?: number;
  idempotencyKey: string;
}

export interface LeaseActionInput {
  taskId: string;
  workerId: string;
  leaseToken: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TaskHeartbeatInput extends LeaseActionInput {
  leaseSeconds?: number;
}

export interface TaskReleaseInput extends LeaseActionInput {
  reason: string;
}

export interface TaskBlockInput extends LeaseActionInput {
  reason: string;
}

export interface TaskFailInput extends LeaseActionInput {
  reason: string;
  usage?: Partial<Usage>;
}

export interface TaskCancelInput {
  taskId: string;
  actorId: string;
  expectedVersion: number;
  reason: string;
  expectedParentVersion?: number;
  parentLeaseToken?: string;
  idempotencyKey: string;
}

export interface TaskSupersedeInput extends TaskCancelInput {
  replacementTaskId: string;
}

export interface TaskEffortInput {
  taskId: string;
  actorId: string;
  expectedVersion: number;
  reasoningEffort: ReasoningEffort;
  reason: string;
  expectedParentVersion?: number;
  parentLeaseToken?: string;
  idempotencyKey: string;
}

export interface ArtifactPutInput {
  taskId: string;
  actorId: string;
  kind: string;
  mimeType: string;
  content: string;
  encoding: "utf8" | "base64";
  metadata?: JsonObject;
  idempotencyKey: string;
}

export interface ClaimInput {
  statement: string;
  confidence?: number | null;
  evidenceRefs?: string[];
  artifactId?: string | null;
}

export interface SubmitCandidateInput extends LeaseActionInput {
  summary: string;
  artifactRefs: string[];
  claims: ClaimInput[];
  unresolved?: string[];
  usage?: Partial<Usage>;
}

export interface ReviewInput {
  taskId: string;
  reviewerId: string;
  expectedVersion: number;
  approved: boolean;
  evidenceRefs?: string[];
  notes: string;
  idempotencyKey: string;
}

export interface CommitTaskInput {
  taskId: string;
  actorId: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface GateDecisionInput {
  taskId: string;
  expectedVersion: number;
  approved: boolean;
  evidenceRefs?: string[];
  notes: string;
}

export interface GateAndCommitInput {
  reviewerId: string;
  parentTaskId?: string | null;
  decisions: GateDecisionInput[];
  idempotencyKey: string;
}

export interface BudgetReportInput {
  missionId: string;
  taskId?: string | null;
  actorId: string;
  expectedMissionVersion: number;
  expectedTaskVersion?: number;
  usage: Partial<Usage>;
  idempotencyKey: string;
}

export interface MissionCloseInput {
  missionId: string;
  actorId: string;
  expectedVersion: number;
  acceptFailedTasks?: boolean;
  idempotencyKey: string;
}

export interface MissionDetails {
  mission: Mission;
  tasks: Task[];
  artifacts: Artifact[];
  claims: Claim[];
  reviews: Review[];
}

export interface CandidateResult {
  task: Task;
  claims: Claim[];
}

export interface ArtifactContent {
  artifact: Artifact;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
}

export class ControlPlane {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly repository: Repository,
    private readonly artifactStore: ArtifactStore,
    private readonly options: ControlPlaneOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  createMission(input: MissionCreateInput): Mission {
    this.assertText(input.objective, "objective");
    this.assertText(input.actorId, "actorId");
    this.assertStringArray(input.successCriteria, "successCriteria", true);
    this.assertStringArray(input.constraints ?? [], "constraints");
    const budget = normalizeBudget(input.budget);
    const strategy = normalizeStrategy(input.strategy);
    const portrait = normalizePortrait(input.portrait);
    const directorPlan = normalizeDirectorPlan(strategy, input.directorPlan);

    return this.idempotent("mission_create", input.idempotencyKey, input, () => {
      const now = this.now();
      const mission: Mission = {
        id: this.id("mis"),
        objective: input.objective.trim(),
        constraints: this.cleanStrings(input.constraints ?? []),
        successCriteria: this.cleanStrings(input.successCriteria),
        risk: input.risk,
        status: "active",
        strategy,
        portrait,
        directorPlan,
        budget,
        usage: { ...ZERO_USAGE },
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.repository.insertMission(mission);
      this.event(
        mission.id,
        null,
        "mission.created",
        input.actorId,
        {
          risk: mission.risk,
          strategy: mission.strategy,
          budget: mission.budget,
        },
        input.idempotencyKey,
      );
      return mission;
    });
  }

  getMission(missionId: string, includeDetails = true): Mission | MissionDetails {
    const mission = this.requireMission(missionId);
    if (!includeDetails) {
      return mission;
    }
    return {
      mission,
      tasks: this.repository.listTasks(missionId),
      artifacts: this.repository.listArtifacts(missionId),
      claims: this.repository.listClaims(missionId),
      reviews: this.repository.listReviews(missionId),
    };
  }

  closeMission(input: MissionCloseInput): Mission {
    return this.idempotent("mission_close", input.idempotencyKey, input, () =>
      this.closeMissionOnce(input, input.expectedVersion, true),
    );
  }

  allocateTask(input: TaskAllocateInput): Task {
    this.assertText(input.objective, "objective");
    this.assertText(input.capabilityPack, "capabilityPack");
    this.assertText(input.actorId, "actorId");
    this.assertStringArray(input.doneCriteria, "doneCriteria", true);
    this.assertStringArray(input.dependencies ?? [], "dependencies");
    this.assertStringArray(input.inputArtifactRefs ?? [], "inputArtifactRefs");
    this.assertStringArray(input.allowedTools ?? [], "allowedTools");
    const maxEffort = input.maxEffort ?? input.reasoningEffort;
    assertAssignmentPolicy(input.role, input.model, input.reasoningEffort, maxEffort);
    const budget = normalizeBudget(input.budget);

    return this.idempotent("task_allocate", input.idempotencyKey, input, () => {
      const mission = this.requireActiveMission(input.missionId);
      const parent =
        input.parentTaskId === undefined || input.parentTaskId === null
          ? null
          : this.requireTask(input.parentTaskId);
      if (parent !== null) {
        assertCondition(
          parent.missionId === mission.id,
          "validation_error",
          "Parent task belongs to another mission.",
          { missionId: mission.id, parentTaskId: parent.id },
        );
        assertCondition(
          parent.status === "running",
          "invalid_state",
          "A parent task must be running before it allocates children.",
          { parentTaskId: parent.id, parentStatus: parent.status },
        );
        assertCondition(
          input.expectedParentVersion !== undefined,
          "validation_error",
          "expectedParentVersion is required for a child allocation.",
          { parentTaskId: parent.id },
        );
        assertCondition(
          input.parentLeaseToken !== undefined,
          "validation_error",
          "parentLeaseToken is required for a child allocation.",
          { parentTaskId: parent.id },
        );
        this.assertLease(parent, input.actorId, input.parentLeaseToken);
        assertParentChildPolicy(parent.role, input.role);
      } else {
        assertRootRoleForStrategy(mission.strategy, input.role);
        this.assertRootAllocationLimits(mission, input.role);
      }
      if (input.role === "coordinator") {
        assertFanoutCoordinatorObjective(mission.strategy, input.objective.trim());
      }

      const dependencies = [...new Set(input.dependencies ?? [])];
      const dependencyTasks = dependencies.map((id) => this.requireTask(id));
      for (const dependency of dependencyTasks) {
        assertCondition(
          dependency.missionId === mission.id,
          "validation_error",
          "Task dependency belongs to another mission.",
          { dependencyTaskId: dependency.id, missionId: mission.id },
        );
      }

      const inputArtifactRefs = [...new Set(input.inputArtifactRefs ?? [])];
      this.assertArtifactsBelongToMission(inputArtifactRefs, mission.id);
      this.assertAllocationBudget(mission, parent, budget);

      const now = this.now();
      const status: TaskStatus = dependenciesSatisfied(
        dependencyTasks.map((dependency) => dependency.status),
      )
        ? "ready"
        : "proposed";
      const task: Task = {
        id: this.id("tsk"),
        missionId: mission.id,
        parentTaskId: parent?.id ?? null,
        objective: input.objective.trim(),
        role: input.role,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        maxEffort,
        capabilityPack: input.capabilityPack.trim(),
        status,
        dependencies,
        inputArtifactRefs,
        allowedTools: this.cleanStrings(input.allowedTools ?? []),
        doneCriteria: this.cleanStrings(input.doneCriteria),
        outputSchema: input.outputSchema ?? null,
        risk: input.risk,
        budget,
        usage: { ...ZERO_USAGE },
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        producerId: null,
        summary: null,
        unresolved: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.repository.insertTask(task);
      this.event(
        mission.id,
        task.id,
        "task.allocated",
        input.actorId,
        {
          parentTaskId: task.parentTaskId,
          role: task.role,
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          maxEffort: task.maxEffort,
          status: task.status,
          budget: task.budget,
        },
        input.idempotencyKey,
      );
      return task;
    });
  }

  getTask(taskId: string): Task {
    return this.requireTask(taskId);
  }

  claimTask(input: ClaimTaskInput): Task {
    this.assertText(input.workerId, "workerId");
    const leaseSeconds = this.leaseSeconds(input.leaseSeconds);

    return this.idempotent("task_claim", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.requireActiveMission(task.missionId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      const dependencyStatuses = task.dependencies.map((id) => this.requireTask(id).status);
      assertCondition(
        dependenciesSatisfied(dependencyStatuses),
        "invalid_state",
        "Task dependencies are not yet verified.",
        { taskId: task.id, dependencies: task.dependencies, dependencyStatuses },
      );

      const now = this.clock();
      const leaseExpired =
        task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) <= now.getTime();
      const reclaimable =
        leaseExpired &&
        (task.status === "leased" || task.status === "running" || task.status === "blocked");
      assertCondition(
        task.status === "ready" || reclaimable,
        "lease_conflict",
        "Task is not ready for a new lease.",
        {
          taskId: task.id,
          status: task.status,
          leaseOwner: task.leaseOwner,
          leaseExpiresAt: task.leaseExpiresAt,
        },
      );

      if (reclaimable) {
        this.event(task.missionId, task.id, "task.lease_expired", "control-plane", {
          previousOwner: task.leaseOwner,
          previousExpiry: task.leaseExpiresAt,
        });
      } else {
        assertTransition(task.status, "leased");
      }

      const updated: Task = {
        ...task,
        status: "leased",
        leaseOwner: input.workerId,
        leaseToken: this.id("lease"),
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
        version: task.version + 1,
        updatedAt: now.toISOString(),
      };
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.claimed",
        input.workerId,
        { leaseExpiresAt: updated.leaseExpiresAt },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  startTask(input: LeaseActionInput): Task {
    return this.idempotent("task_start", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertLease(task, input.workerId, input.leaseToken);
      assertTransition(task.status, "running");

      const updated = this.transitionTask(task, "running", {
        producerId: input.workerId,
      });
      this.repository.updateTask(updated, task.version);
      this.event(task.missionId, task.id, "task.started", input.workerId, {}, input.idempotencyKey);
      return updated;
    });
  }

  heartbeatTask(input: TaskHeartbeatInput): Task {
    const leaseSeconds = this.leaseSeconds(input.leaseSeconds);
    return this.idempotent("task_heartbeat", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertLease(task, input.workerId, input.leaseToken);
      assertCondition(
        task.status === "leased" || task.status === "running" || task.status === "blocked",
        "invalid_state",
        "Only leased, running, or blocked tasks can renew a lease.",
        { taskId: task.id, status: task.status },
      );

      const now = this.clock();
      const updated: Task = {
        ...task,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
        version: task.version + 1,
        updatedAt: now.toISOString(),
      };
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.heartbeat",
        input.workerId,
        { leaseExpiresAt: updated.leaseExpiresAt },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  releaseTask(input: TaskReleaseInput): Task {
    this.assertText(input.reason, "reason");
    return this.idempotent("task_release", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertLease(task, input.workerId, input.leaseToken);
      assertTransition(task.status, "ready");
      const updated = this.transitionTask(task, "ready", {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.released",
        input.workerId,
        { reason: input.reason.trim() },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  blockTask(input: TaskBlockInput): Task {
    this.assertText(input.reason, "reason");
    return this.idempotent("task_block", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertLease(task, input.workerId, input.leaseToken);
      assertTransition(task.status, "blocked");
      const updated = this.transitionTask(task, "blocked");
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.blocked",
        input.workerId,
        { reason: input.reason.trim() },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  failTask(input: TaskFailInput): Task {
    this.assertText(input.reason, "reason");
    const usageDelta = normalizeUsage(input.usage);
    return this.idempotent("task_fail", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      const mission = this.requireActiveMission(task.missionId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertLease(task, input.workerId, input.leaseToken);
      assertTransition(task.status, "failed");

      const taskUsage = addUsage(task.usage, usageDelta);
      const missionUsage = addUsage(mission.usage, usageDelta);
      assertUsageWithin(taskUsage, task.budget, `Task '${task.id}'`);
      assertUsageWithin(missionUsage, mission.budget, `Mission '${mission.id}'`);
      const now = this.now();
      const updatedTask = this.transitionTask(task, "failed", {
        usage: taskUsage,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        unresolved: [...task.unresolved, input.reason.trim()],
      });
      this.repository.updateTask(updatedTask, task.version);
      this.repository.updateMission(
        {
          ...mission,
          usage: missionUsage,
          version: mission.version + 1,
          updatedAt: now,
        },
        mission.version,
      );
      this.event(
        task.missionId,
        task.id,
        "task.failed",
        input.workerId,
        { reason: input.reason.trim(), usage: usageDelta },
        input.idempotencyKey,
      );
      return updatedTask;
    });
  }

  cancelTask(input: TaskCancelInput): Task {
    this.assertText(input.actorId, "actorId");
    this.assertText(input.reason, "reason");
    return this.idempotent("task_cancel", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.requireActiveMission(task.missionId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertDirectParentAuthority(task, input);
      assertTransition(task.status, "cancelled");
      const activeChildren = this.repository
        .listChildren(task.id)
        .filter((child) => !isTerminalTaskStatus(child.status));
      assertCondition(
        activeChildren.length === 0,
        "invalid_state",
        "Cancel direct children before cancelling their parent.",
        { taskId: task.id, activeChildIds: activeChildren.map((child) => child.id) },
      );

      const updated = this.transitionTask(task, "cancelled", {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        unresolved: [...task.unresolved, `Cancelled: ${input.reason.trim()}`],
      });
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.cancelled",
        input.actorId,
        { reason: input.reason.trim() },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  supersedeTask(input: TaskSupersedeInput): Task {
    this.assertText(input.actorId, "actorId");
    this.assertText(input.reason, "reason");
    return this.idempotent("task_supersede", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.requireActiveMission(task.missionId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertDirectParentAuthority(task, input);
      assertTransition(task.status, "superseded");

      const replacement = this.requireTask(input.replacementTaskId);
      assertCondition(
        replacement.id !== task.id &&
          replacement.missionId === task.missionId &&
          replacement.parentTaskId === task.parentTaskId,
        "validation_error",
        "Replacement task must be a different sibling in the same mission.",
        {
          taskId: task.id,
          replacementTaskId: replacement.id,
          parentTaskId: task.parentTaskId,
        },
      );
      assertCondition(
        replacement.status !== "failed" &&
          replacement.status !== "cancelled" &&
          replacement.status !== "superseded",
        "invalid_state",
        "Replacement task must remain viable.",
        { replacementTaskId: replacement.id, replacementStatus: replacement.status },
      );

      const updated = this.transitionTask(task, "superseded", {
        unresolved: [...task.unresolved, `Superseded: ${input.reason.trim()}`],
      });
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.superseded",
        input.actorId,
        { reason: input.reason.trim(), replacementTaskId: replacement.id },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  setTaskEffort(input: TaskEffortInput): Task {
    this.assertText(input.actorId, "actorId");
    this.assertText(input.reason, "reason");
    return this.idempotent("task_set_effort", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.requireActiveMission(task.missionId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertDirectParentAuthority(task, input);
      assertCondition(
        task.status === "ready",
        "invalid_state",
        "Reasoning effort can change only while the task is ready and unleased.",
        { taskId: task.id, status: task.status },
      );
      assertAssignmentPolicy(task.role, task.model, input.reasoningEffort, task.maxEffort);

      const updated: Task = {
        ...task,
        reasoningEffort: input.reasoningEffort,
        version: task.version + 1,
        updatedAt: this.now(),
      };
      this.repository.updateTask(updated, task.version);
      this.event(
        task.missionId,
        task.id,
        "task.effort_changed",
        input.actorId,
        {
          from: task.reasoningEffort,
          to: updated.reasoningEffort,
          maxEffort: task.maxEffort,
          reason: input.reason.trim(),
        },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  putArtifact(input: ArtifactPutInput): Artifact {
    this.assertText(input.actorId, "actorId");
    this.assertText(input.kind, "kind");
    this.assertText(input.mimeType, "mimeType");

    return this.idempotent("artifact_put", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.requireActiveMission(task.missionId);
      assertCondition(
        !isTerminalTaskStatus(task.status),
        "invalid_state",
        "Cannot add artifacts to a terminal task.",
        { taskId: task.id, status: task.status },
      );
      if (task.leaseOwner !== null) {
        assertCondition(
          task.leaseOwner === input.actorId,
          "forbidden",
          "Only the active lease owner may add production artifacts.",
          { taskId: task.id, leaseOwner: task.leaseOwner, actorId: input.actorId },
        );
      }

      const content =
        input.encoding === "base64"
          ? this.decodeBase64(input.content)
          : Buffer.from(input.content, "utf8");
      const stored = this.artifactStore.put(content);
      const artifact: Artifact = {
        id: this.id("art"),
        missionId: task.missionId,
        taskId: task.id,
        kind: input.kind.trim(),
        mimeType: input.mimeType.trim(),
        sha256: stored.sha256,
        byteLength: stored.byteLength,
        storageUri: stored.storageUri,
        metadata: input.metadata ?? {},
        createdBy: input.actorId,
        createdAt: this.now(),
      };
      const inserted = this.repository.insertArtifact(artifact);
      this.event(
        task.missionId,
        task.id,
        "artifact.stored",
        input.actorId,
        {
          artifactId: inserted.id,
          kind: inserted.kind,
          sha256: inserted.sha256,
          byteLength: inserted.byteLength,
        },
        input.idempotencyKey,
      );
      return inserted;
    });
  }

  getArtifact(
    artifactId: string,
    encoding: "utf8" | "base64" = "utf8",
    maxBytes = 64 * 1024,
  ): ArtifactContent {
    const artifact = this.requireArtifact(artifactId);
    const content = this.artifactStore.get(artifact.sha256);
    const readLength = Math.min(content.byteLength, Math.max(1, maxBytes));
    const selected = content.subarray(0, readLength);
    return {
      artifact,
      encoding,
      content: selected.toString(encoding),
      truncated: readLength < content.byteLength,
    };
  }

  submitCandidate(input: SubmitCandidateInput): CandidateResult {
    this.assertText(input.summary, "summary");
    assertCondition(
      input.summary.trim().length <= CANDIDATE_SUMMARY_MAX_CHARS,
      "validation_error",
      `'summary' must be at most ${CANDIDATE_SUMMARY_MAX_CHARS} characters so parents stay summary-only.`,
      {
        field: "summary",
        length: input.summary.trim().length,
        maxChars: CANDIDATE_SUMMARY_MAX_CHARS,
      },
    );
    this.assertStringArray(input.artifactRefs, "artifactRefs");
    this.assertStringArray(input.unresolved ?? [], "unresolved");
    const usageDelta = normalizeUsage(input.usage);

    return this.idempotent("result_submit_candidate", input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      const mission = this.requireActiveMission(task.missionId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      this.assertLease(task, input.workerId, input.leaseToken);
      assertTransition(task.status, "candidate");
      this.assertArtifactsBelongToTask(input.artifactRefs, task.id);

      const taskUsage = addUsage(task.usage, usageDelta);
      const missionUsage = addUsage(mission.usage, usageDelta);
      assertUsageWithin(taskUsage, task.budget, `Task '${task.id}'`);
      assertUsageWithin(missionUsage, mission.budget, `Mission '${mission.id}'`);

      const now = this.now();
      const claims = input.claims.map((claimInput) => {
        this.assertText(claimInput.statement, "claim.statement");
        if (claimInput.confidence !== undefined && claimInput.confidence !== null) {
          assertCondition(
            claimInput.confidence >= 0 && claimInput.confidence <= 1,
            "validation_error",
            "Claim confidence must be between zero and one.",
            { confidence: claimInput.confidence },
          );
        }
        const evidenceRefs = [...new Set(claimInput.evidenceRefs ?? [])];
        this.assertArtifactsBelongToMission(evidenceRefs, task.missionId);
        if (claimInput.artifactId !== undefined && claimInput.artifactId !== null) {
          const artifact = this.requireArtifact(claimInput.artifactId);
          assertCondition(
            artifact.taskId === task.id,
            "validation_error",
            "A claim's primary artifact must belong to its task.",
            { artifactId: artifact.id, taskId: task.id },
          );
        }
        const claim: Claim = {
          id: this.id("clm"),
          missionId: task.missionId,
          taskId: task.id,
          statement: claimInput.statement.trim(),
          status: "candidate",
          confidence: claimInput.confidence ?? null,
          evidenceRefs,
          artifactId: claimInput.artifactId ?? null,
          producerId: input.workerId,
          verifierId: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.repository.insertClaim(claim);
        return claim;
      });

      const updatedTask = this.transitionTask(task, "candidate", {
        usage: taskUsage,
        summary: input.summary.trim(),
        unresolved: this.cleanStrings(input.unresolved ?? []),
        producerId: input.workerId,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      this.repository.updateTask(updatedTask, task.version);
      const updatedMission: Mission = {
        ...mission,
        usage: missionUsage,
        version: mission.version + 1,
        updatedAt: now,
      };
      this.repository.updateMission(updatedMission, mission.version);
      this.event(
        task.missionId,
        task.id,
        "result.candidate_submitted",
        input.workerId,
        {
          artifactRefs: [...new Set(input.artifactRefs)],
          claimIds: claims.map((claim) => claim.id),
          usage: usageDelta,
        },
        input.idempotencyKey,
      );
      return { task: updatedTask, claims };
    });
  }

  checkResult(input: ReviewInput): Task {
    return this.reviewResult("check", input);
  }

  verifyResult(input: ReviewInput): Task {
    return this.reviewResult("verify", input);
  }

  commitTask(input: CommitTaskInput): Task {
    return this.idempotent("task_commit", input.idempotencyKey, input, () =>
      this.commitTaskMutation(input),
    );
  }

  childrenStatus(parentTaskId: string): ChildrenStatus {
    const parent = this.requireTask(parentTaskId);
    const children = this.repository.listChildren(parent.id);
    return {
      parentTaskId: parent.id,
      children: children.map((child) => this.toChildStatus(child)),
      allTerminal: children.every((child) => isTerminalTaskStatus(child.status)),
    };
  }

  gateAndCommitResults(input: GateAndCommitInput): { tasks: Task[] } {
    this.assertText(input.reviewerId, "reviewerId");
    assertCondition(
      input.decisions.length > 0,
      "validation_error",
      "results_gate_and_commit requires at least one decision.",
    );
    const decisionTaskIds = input.decisions.map((decision) => decision.taskId);
    assertCondition(
      new Set(decisionTaskIds).size === decisionTaskIds.length,
      "validation_error",
      "results_gate_and_commit decisions must use distinct taskIds.",
    );
    return this.idempotent("results_gate_and_commit", input.idempotencyKey, input, () => {
      const parent =
        input.parentTaskId !== undefined && input.parentTaskId !== null
          ? this.requireTask(input.parentTaskId)
          : null;
      const tasks: Task[] = [];
      for (const decision of input.decisions) {
        this.assertText(decision.notes, "notes");
        let task = this.requireTask(decision.taskId);
        this.assertVersion(task.version, decision.expectedVersion, "Task");
        if (parent !== null) {
          assertCondition(
            task.parentTaskId === parent.id,
            "validation_error",
            "Gated task is not a direct child of parentTaskId.",
            { parentTaskId: parent.id, taskId: task.id, actualParentTaskId: task.parentTaskId },
          );
        }
        const mission = this.requireMission(task.missionId);
        assertCondition(
          COLLAPSIBLE_GATE_RISKS.includes(task.risk) &&
            COLLAPSIBLE_GATE_RISKS.includes(mission.risk),
          "policy_violation",
          "results_gate_and_commit is only for low or medium risk. Use result_check, result_verify, and task_commit for high or critical work.",
          { taskId: task.id, taskRisk: task.risk, missionRisk: mission.risk },
        );

        if (task.status === "committed" && decision.approved) {
          tasks.push(task);
          continue;
        }

        assertCondition(
          isTerminalTaskStatus(task.status) === false || task.status === "verified",
          "invalid_state",
          "Wait until the child is candidate before gating; failed or cancelled children need a replacement spawn.",
          { taskId: task.id, status: task.status },
        );

        const reviewInput = (stage: "check" | "verify", expectedVersion: number): ReviewInput => {
          const review: ReviewInput = {
            taskId: task.id,
            reviewerId: input.reviewerId,
            expectedVersion,
            approved: decision.approved,
            notes: decision.notes,
            idempotencyKey: this.derivedIdempotencyKey(input.idempotencyKey, stage, task.id),
          };
          if (decision.evidenceRefs !== undefined) {
            review.evidenceRefs = decision.evidenceRefs;
          }
          return review;
        };

        if (!decision.approved) {
          assertCondition(
            task.status === "candidate",
            "invalid_state",
            "Rejection through results_gate_and_commit requires candidate status.",
            { taskId: task.id, status: task.status },
          );
          tasks.push(this.reviewResult("check", reviewInput("check", task.version)));
          continue;
        }

        assertCondition(
          task.status === "candidate" || task.status === "checked" || task.status === "verified",
          "invalid_state",
          "Wait first: results_gate_and_commit requires candidate (or already gated) children.",
          { taskId: task.id, status: task.status },
        );

        if (task.status === "candidate") {
          task = this.reviewResult("check", reviewInput("check", task.version));
        }
        if (task.status === "checked") {
          task = this.reviewResult("verify", reviewInput("verify", task.version));
        }
        if (task.status === "verified") {
          task = this.commitTaskMutation({
            taskId: task.id,
            actorId: input.reviewerId,
            expectedVersion: task.version,
            idempotencyKey: this.derivedIdempotencyKey(input.idempotencyKey, "commit", task.id),
          });
        }
        tasks.push(task);
      }
      return { tasks };
    });
  }

  private commitTaskMutation(input: CommitTaskInput): Task {
    const task = this.requireTask(input.taskId);
    this.assertVersion(task.version, input.expectedVersion, "Task");
    assertTransition(task.status, "committed");
    const activeChildren = this.repository
      .listChildren(task.id)
      .filter((child) => !isTerminalTaskStatus(child.status));
    assertCondition(
      activeChildren.length === 0,
      "invalid_state",
      "Task still owns non-terminal child tasks.",
      { taskId: task.id, activeChildIds: activeChildren.map((child) => child.id) },
    );

    const updated = this.transitionTask(task, "committed");
    this.repository.updateTask(updated, task.version);
    this.event(task.missionId, task.id, "task.committed", input.actorId, {}, input.idempotencyKey);
    this.promoteReadyDependents(task.missionId, input.actorId);
    return updated;
  }

  private toChildStatus(child: Task): ChildStatus {
    return {
      id: child.id,
      status: child.status,
      version: child.version,
      risk: child.risk,
      summary: child.summary,
      unresolved: child.unresolved,
      artifactRefs: this.repository
        .listArtifacts(child.missionId, child.id)
        .map((artifact) => artifact.id),
      producerId: child.producerId,
    };
  }

  reportBudget(input: BudgetReportInput): MissionDetails {
    const usageDelta = normalizeUsage(input.usage);
    return this.idempotent("budget_report", input.idempotencyKey, input, () => {
      const mission = this.requireActiveMission(input.missionId);
      this.assertVersion(mission.version, input.expectedMissionVersion, "Mission");
      const missionUsage = addUsage(mission.usage, usageDelta);
      assertUsageWithin(missionUsage, mission.budget, `Mission '${mission.id}'`);

      if (input.taskId !== undefined && input.taskId !== null) {
        const task = this.requireTask(input.taskId);
        assertCondition(
          task.missionId === mission.id,
          "validation_error",
          "Budget task belongs to another mission.",
          { missionId: mission.id, taskId: task.id },
        );
        assertCondition(
          input.expectedTaskVersion !== undefined,
          "validation_error",
          "expectedTaskVersion is required when reporting task usage.",
        );
        this.assertVersion(task.version, input.expectedTaskVersion, "Task");
        const taskUsage = addUsage(task.usage, usageDelta);
        assertUsageWithin(taskUsage, task.budget, `Task '${task.id}'`);
        this.repository.updateTask(
          {
            ...task,
            usage: taskUsage,
            version: task.version + 1,
            updatedAt: this.now(),
          },
          task.version,
        );
      }

      this.repository.updateMission(
        {
          ...mission,
          usage: missionUsage,
          version: mission.version + 1,
          updatedAt: this.now(),
        },
        mission.version,
      );
      this.event(
        mission.id,
        input.taskId ?? null,
        "budget.usage_reported",
        input.actorId,
        { usage: usageDelta },
        input.idempotencyKey,
      );
      return this.getMission(mission.id, true) as MissionDetails;
    });
  }

  recoverySnapshot(
    missionId: string,
    afterSequence = 0,
    eventLimit = this.options.eventPageSize,
  ): RecoverySnapshot {
    const mission = this.requireMission(missionId);
    const limit = Math.min(Math.max(1, eventLimit), this.options.eventPageSize);
    return {
      mission,
      tasks: this.repository.listTasks(missionId),
      artifacts: this.repository.listArtifacts(missionId),
      claims: this.repository.listClaims(missionId),
      reviews: this.repository.listReviews(missionId),
      events: this.repository.listEvents(missionId, Math.max(0, afterSequence), limit),
    };
  }

  private reviewResult(stage: "check" | "verify", input: ReviewInput): Task {
    this.assertText(input.reviewerId, "reviewerId");
    this.assertText(input.notes, "notes");
    const operation = stage === "check" ? "result_check" : "result_verify";

    return this.idempotent(operation, input.idempotencyKey, input, () => {
      const task = this.requireTask(input.taskId);
      this.assertVersion(task.version, input.expectedVersion, "Task");
      const requiredStatus = stage === "check" ? "candidate" : "checked";
      assertCondition(
        task.status === requiredStatus,
        "invalid_state",
        `${stage} requires task status '${requiredStatus}'.`,
        { taskId: task.id, status: task.status },
      );
      assertCondition(
        task.producerId !== input.reviewerId,
        "forbidden",
        "A producer cannot approve or reject its own result.",
        { taskId: task.id, producerId: task.producerId, reviewerId: input.reviewerId },
      );
      const evidenceRefs = [...new Set(input.evidenceRefs ?? [])];
      this.assertArtifactsBelongToMission(evidenceRefs, task.missionId);

      const review: Review = {
        id: this.id("rev"),
        missionId: task.missionId,
        taskId: task.id,
        stage,
        reviewerId: input.reviewerId,
        approved: input.approved,
        evidenceRefs,
        notes: input.notes.trim(),
        createdAt: this.now(),
      };
      this.repository.insertReview(review);

      const nextStatus: TaskStatus = input.approved
        ? stage === "check"
          ? "checked"
          : "verified"
        : "ready";
      assertTransition(task.status, nextStatus);
      const updated = this.transitionTask(task, nextStatus, {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      this.repository.updateTask(updated, task.version);
      this.repository.updateClaimsForTask(
        task.id,
        stage === "check" ? "candidate" : "checked",
        input.approved ? (stage === "check" ? "checked" : "verified") : "rejected",
        input.reviewerId,
        this.now(),
      );
      this.event(
        task.missionId,
        task.id,
        input.approved ? `result.${stage}_approved` : `result.${stage}_rejected`,
        input.reviewerId,
        { reviewId: review.id, evidenceRefs, notes: review.notes },
        input.idempotencyKey,
      );
      return updated;
    });
  }

  private promoteReadyDependents(missionId: string, actorId: string): void {
    for (const task of this.repository.listTasks(missionId)) {
      if (task.status !== "proposed") {
        continue;
      }
      const statuses = task.dependencies.map((id) => this.requireTask(id).status);
      if (!dependenciesSatisfied(statuses)) {
        continue;
      }
      assertTransition(task.status, "ready");
      const updated = this.transitionTask(task, "ready");
      this.repository.updateTask(updated, task.version);
      this.event(missionId, task.id, "task.dependencies_satisfied", actorId, {
        dependencies: task.dependencies,
      });
    }
  }

  private assertRootAllocationLimits(mission: Mission, childRole: AgentRole): void {
    const roots = this.repository.listRootTasks(mission.id);
    if (mission.strategy === "direct" && childRole === "operator") {
      const operators = roots.filter((task) => task.role === "operator");
      assertCondition(
        operators.length === 0,
        "policy_violation",
        "direct missions allow at most one root Luna operator.",
        { missionId: mission.id, existingRootOperatorIds: operators.map((task) => task.id) },
      );
    }
    if (mission.strategy === "pipeline" && childRole === "coordinator") {
      const coordinators = roots.filter((task) => task.role === "coordinator");
      assertCondition(
        coordinators.length === 0,
        "policy_violation",
        "pipeline missions allow one Terra coordinator; Luna children must use dependencies.",
        {
          missionId: mission.id,
          existingRootCoordinatorIds: coordinators.map((task) => task.id),
        },
      );
    }
  }

  private assertAllocationBudget(
    mission: Mission,
    parent: Task | null,
    requestedBudget: BudgetLimits,
  ): void {
    const siblings =
      parent === null
        ? this.repository.listRootTasks(mission.id)
        : this.repository.listChildren(parent.id);
    const countedChildren = siblings.filter(
      (task) =>
        task.status !== "failed" && task.status !== "cancelled" && task.status !== "superseded",
    );
    const ownerBudget = parent?.budget ?? mission.budget;
    const maxChildren = ownerBudget.maxChildren;
    if (maxChildren !== undefined) {
      assertCondition(
        countedChildren.length + 1 <= maxChildren,
        "budget_exceeded",
        "Child count exceeds the owner's maxChildren budget.",
        {
          ownerId: parent?.id ?? mission.id,
          existingChildren: countedChildren.length,
          maxChildren,
        },
      );
    }

    let consumed = this.usageAsBudget(parent?.usage ?? mission.usage);
    for (const sibling of siblings) {
      if (parent === null) {
        if (!isTerminalTaskStatus(sibling.status)) {
          consumed = addBudgets(consumed, this.remainingBudget(sibling.budget, sibling.usage));
        }
      } else {
        consumed = addBudgets(
          consumed,
          isTerminalTaskStatus(sibling.status)
            ? this.usageAsBudget(sibling.usage)
            : this.remainingBudget(sibling.budget, sibling.usage),
        );
      }
    }
    assertBudgetWithin(
      addBudgets(consumed, requestedBudget),
      ownerBudget,
      `Children of '${parent?.id ?? mission.id}'`,
    );
  }

  private usageAsBudget(usage: Usage): BudgetLimits {
    return {
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      wallClockSeconds: usage.wallClockSeconds,
      toolCalls: usage.toolCalls,
    };
  }

  private closeMissionOnce(
    input: MissionCloseInput,
    expectedVersion: number,
    allowVersionRetry: boolean,
  ): Mission {
    let mission = this.requireMission(input.missionId);
    if (mission.version !== expectedVersion) {
      assertCondition(
        allowVersionRetry,
        "conflict",
        "Mission version does not match expectedVersion.",
        { actualVersion: mission.version, expectedVersion },
      );
      return this.closeMissionOnce(input, mission.version, false);
    }
    assertCondition(
      mission.status === "active",
      "invalid_state",
      "Only an active mission can be closed.",
      { missionId: mission.id, status: mission.status },
    );

    this.finalizeCloseableCoordinator(mission, input.actorId, input.idempotencyKey);
    mission = this.requireMission(input.missionId);

    const tasks = this.repository.listTasks(mission.id);
    const active = tasks.filter((task) => !isTerminalTaskStatus(task.status));
    assertCondition(active.length === 0, "invalid_state", "Mission still has non-terminal tasks.", {
      activeTaskIds: active.map((task) => task.id),
    });
    if (input.acceptFailedTasks !== true) {
      const failed = tasks.filter((task) => task.status === "failed");
      assertCondition(
        failed.length === 0,
        "invalid_state",
        "Mission has failed tasks; explicitly accept them or supersede them.",
        { failedTaskIds: failed.map((task) => task.id) },
      );
    }

    const updated: Mission = {
      ...mission,
      status: "completed",
      version: mission.version + 1,
      updatedAt: this.now(),
    };
    this.repository.updateMission(updated, mission.version);
    this.event(
      mission.id,
      null,
      "mission.completed",
      input.actorId,
      { acceptedFailedTasks: input.acceptFailedTasks === true },
      input.idempotencyKey,
    );
    return updated;
  }

  private finalizeCloseableCoordinator(
    mission: Mission,
    actorId: string,
    idempotencyKey: string,
  ): void {
    if (!TERRA_PATH_STRATEGIES.includes(mission.strategy)) {
      return;
    }
    if (!COLLAPSIBLE_GATE_RISKS.includes(mission.risk)) {
      return;
    }

    const tasks = this.repository.listTasks(mission.id);
    const active = tasks.filter((task) => !isTerminalTaskStatus(task.status));
    if (active.length !== 1) {
      return;
    }
    const coordinator = active[0];
    if (
      coordinator === undefined ||
      coordinator.parentTaskId !== null ||
      coordinator.role !== "coordinator" ||
      !COLLAPSIBLE_GATE_RISKS.includes(coordinator.risk) ||
      (coordinator.status !== "candidate" &&
        coordinator.status !== "checked" &&
        coordinator.status !== "verified")
    ) {
      return;
    }

    const evidenceRefs = this.repository
      .listArtifacts(mission.id, coordinator.id)
      .map((artifact) => artifact.id);
    this.gateAndCommitResults({
      reviewerId: actorId,
      decisions: [
        {
          taskId: coordinator.id,
          expectedVersion: coordinator.version,
          approved: true,
          evidenceRefs,
          notes:
            "mission_close auto-finalized the root coordinator after all descendants were terminal.",
        },
      ],
      idempotencyKey: this.derivedIdempotencyKey(idempotencyKey, "close_gate", coordinator.id),
    });
  }

  private remainingBudget(budget: BudgetLimits, usage: Usage): BudgetLimits {
    const remaining: BudgetLimits = {};
    for (const [field, used] of [
      ["tokens", usage.tokens],
      ["costUsd", usage.costUsd],
      ["wallClockSeconds", usage.wallClockSeconds],
      ["toolCalls", usage.toolCalls],
    ] as const) {
      const limit = budget[field] as number | undefined;
      if (limit !== undefined) {
        remaining[field] = Math.max(0, limit - used);
      }
    }
    return remaining;
  }

  private requireMission(id: string): Mission {
    const mission = this.repository.getMission(id);
    assertCondition(mission !== null, "not_found", "Mission was not found.", { missionId: id });
    return mission;
  }

  private requireActiveMission(id: string): Mission {
    const mission = this.requireMission(id);
    assertCondition(mission.status === "active", "invalid_state", "Mission is not active.", {
      missionId: id,
      status: mission.status,
    });
    return mission;
  }

  private requireTask(id: string): Task {
    const task = this.repository.getTask(id);
    assertCondition(task !== null, "not_found", "Task was not found.", { taskId: id });
    return task;
  }

  private requireArtifact(id: string): Artifact {
    const artifact = this.repository.getArtifact(id);
    assertCondition(artifact !== null, "not_found", "Artifact was not found.", {
      artifactId: id,
    });
    return artifact;
  }

  private assertArtifactsBelongToMission(artifactIds: readonly string[], missionId: string): void {
    for (const artifactId of artifactIds) {
      const artifact = this.requireArtifact(artifactId);
      assertCondition(
        artifact.missionId === missionId,
        "validation_error",
        "Artifact belongs to another mission.",
        { artifactId, missionId },
      );
    }
  }

  private assertArtifactsBelongToTask(artifactIds: readonly string[], taskId: string): void {
    for (const artifactId of artifactIds) {
      const artifact = this.requireArtifact(artifactId);
      assertCondition(
        artifact.taskId === taskId,
        "validation_error",
        "Artifact belongs to another task.",
        { artifactId, taskId },
      );
    }
  }

  private assertLease(task: Task, workerId: string, leaseToken: string): void {
    assertCondition(
      task.leaseOwner === workerId && task.leaseToken === leaseToken,
      "lease_conflict",
      "Worker does not own the current task lease.",
      { taskId: task.id, workerId, leaseOwner: task.leaseOwner },
    );
    assertCondition(
      task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) > this.clock().getTime(),
      "lease_conflict",
      "Task lease has expired.",
      { taskId: task.id, leaseExpiresAt: task.leaseExpiresAt },
    );
  }

  private assertDirectParentAuthority(
    task: Task,
    input: {
      actorId: string;
      expectedParentVersion?: number;
      parentLeaseToken?: string;
    },
  ): void {
    if (task.parentTaskId === null) {
      return;
    }
    const parent = this.requireTask(task.parentTaskId);
    assertCondition(
      input.expectedParentVersion !== undefined,
      "validation_error",
      "expectedParentVersion is required for a child lifecycle decision.",
      { taskId: task.id, parentTaskId: parent.id },
    );
    assertCondition(
      input.parentLeaseToken !== undefined,
      "validation_error",
      "parentLeaseToken is required for a child lifecycle decision.",
      { taskId: task.id, parentTaskId: parent.id },
    );
    this.assertLease(parent, input.actorId, input.parentLeaseToken);
    assertCondition(
      parent.status === "running",
      "invalid_state",
      "Direct parent must be running for a child lifecycle decision.",
      { parentTaskId: parent.id, parentStatus: parent.status },
    );
  }

  private assertVersion(actual: number, expected: number, entity: string): void {
    assertCondition(
      actual === expected,
      "conflict",
      `${entity} version does not match expectedVersion.`,
      { actualVersion: actual, expectedVersion: expected },
    );
  }

  private transitionTask(task: Task, status: TaskStatus, changes: Partial<Task> = {}): Task {
    return {
      ...task,
      ...changes,
      id: task.id,
      missionId: task.missionId,
      parentTaskId: task.parentTaskId,
      status,
      version: task.version + 1,
      updatedAt: this.now(),
    };
  }

  private idempotent<T>(operation: string, key: string, request: unknown, action: () => T): T {
    this.assertText(key, "idempotencyKey");
    assertCondition(
      key.length <= 200,
      "validation_error",
      "idempotencyKey cannot exceed 200 characters.",
    );
    const requestHash = createHash("sha256").update(this.canonicalJson(request)).digest("hex");
    return this.repository.transaction(() => {
      const existing = this.repository.getIdempotent<T>(key, operation, requestHash);
      if (existing !== null) {
        return existing;
      }
      const response = action();
      this.repository.saveIdempotent(
        key,
        operation,
        requestHash,
        response as unknown as JsonObject,
        this.now(),
      );
      return response;
    });
  }

  private derivedIdempotencyKey(base: string, part: string, taskId: string): string {
    const key = `${base}:${part}:${taskId}`;
    if (key.length <= 200) {
      return key;
    }
    return createHash("sha256").update(key).digest("hex");
  }

  private canonicalJson(value: unknown): string {
    const normalize = (current: unknown): unknown => {
      if (
        current === null ||
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "boolean"
      ) {
        return current;
      }
      if (Array.isArray(current)) {
        return current.map((item) => normalize(item));
      }
      if (typeof current === "object") {
        return Object.fromEntries(
          Object.entries(current)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, item]) => [name, normalize(item)]),
        );
      }
      throw new TypeError(`Unsupported idempotency payload value: ${typeof current}`);
    };
    return JSON.stringify(normalize(value));
  }

  private event(
    missionId: string,
    taskId: string | null,
    type: string,
    actorId: string,
    payload: JsonObject,
    idempotencyKey: string | null = null,
  ): void {
    this.repository.appendEvent({
      missionId,
      taskId,
      type,
      actorId,
      payload,
      idempotencyKey,
      createdAt: this.now(),
    });
  }

  private leaseSeconds(requested: number | undefined): number {
    const seconds = requested ?? this.options.defaultLeaseSeconds;
    assertCondition(
      Number.isInteger(seconds) && seconds > 0 && seconds <= this.options.maxLeaseSeconds,
      "validation_error",
      "leaseSeconds must be a positive integer within the configured maximum.",
      { requested: seconds, maximum: this.options.maxLeaseSeconds },
    );
    return seconds;
  }

  private decodeBase64(value: string): Buffer {
    assertCondition(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
      "validation_error",
      "Artifact content is not valid canonical base64.",
    );
    return Buffer.from(value, "base64");
  }

  private assertText(value: string, field: string): void {
    assertCondition(
      typeof value === "string" && value.trim().length > 0,
      "validation_error",
      `'${field}' must be a non-empty string.`,
      { field },
    );
  }

  private assertStringArray(values: string[], field: string, requireNonEmpty = false): void {
    assertCondition(Array.isArray(values), "validation_error", `'${field}' must be an array.`, {
      field,
    });
    if (requireNonEmpty) {
      assertCondition(
        values.length > 0,
        "validation_error",
        `'${field}' must contain at least one item.`,
        { field },
      );
    }
    for (const value of values) {
      this.assertText(value, `${field}[]`);
    }
  }

  private cleanStrings(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => value.trim()))];
  }

  private id(prefix: string): string {
    return `${prefix}_${this.idFactory().replaceAll("-", "")}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
