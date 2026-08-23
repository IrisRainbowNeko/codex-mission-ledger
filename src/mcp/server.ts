import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type {
  ArtifactPutInput,
  BudgetReportInput,
  ClaimTaskInput,
  CommitTaskInput,
  GateAndCommitInput,
  LeaseActionInput,
  MissionCloseInput,
  MissionCreateInput,
  ReviewInput,
  SubmitCandidateInput,
  TaskAllocateInput,
  TaskBlockInput,
  TaskCancelInput,
  TaskEffortInput,
  TaskFailInput,
  TaskHeartbeatInput,
  TaskReleaseInput,
  TaskSupersedeInput,
} from "../control-plane.js";
import type { ControlPlane } from "../control-plane.js";
import { isControlPlaneError } from "../domain/errors.js";
import { mapSqliteError } from "../infra/database.js";
import {
  AGENT_ROLES,
  MISSION_STRATEGIES,
  MODEL_TIERS,
  PORTRAIT_LEVELS,
  REASONING_EFFORTS,
  RISK_LEVELS,
  VALIDATOR_STRENGTHS,
} from "../domain/types.js";

const id = z.string().trim().min(1).max(200);
const idempotencyKey = z.string().trim().min(8).max(200);
const text = z.string().trim().min(1).max(20_000);
const shortText = z.string().trim().min(1).max(500);
const stringList = z.array(z.string().trim().min(1).max(2_000)).max(500);
const risk = z.enum(RISK_LEVELS);
const strategy = z.enum(MISSION_STRATEGIES);
const portrait = z
  .object({
    ambiguity: z.enum(PORTRAIT_LEVELS),
    coupling: z.enum(PORTRAIT_LEVELS),
    parallelism: z.enum(PORTRAIT_LEVELS),
    validator: z.enum(VALIDATOR_STRENGTHS),
  })
  .strict();
const role = z.enum(AGENT_ROLES);
const model = z.enum(MODEL_TIERS);
const effort = z.enum(REASONING_EFFORTS);
const jsonObject = z.record(z.string(), z.json());
const budget = z
  .object({
    tokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    wallClockSeconds: z.number().nonnegative().optional(),
    toolCalls: z.number().nonnegative().optional(),
    maxChildren: z.number().int().nonnegative().optional(),
  })
  .strict();
const usage = z
  .object({
    tokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    wallClockSeconds: z.number().nonnegative().optional(),
    toolCalls: z.number().nonnegative().optional(),
  })
  .strict();
const leaseFields = {
  taskId: id,
  workerId: id,
  leaseToken: id,
  expectedVersion: z.number().int().positive(),
  idempotencyKey,
};
const reviewFields = {
  taskId: id,
  reviewerId: id,
  expectedVersion: z.number().int().positive(),
  approved: z.boolean(),
  evidenceRefs: z.array(id).max(500).optional(),
  notes: text,
  idempotencyKey,
};

function success(data: unknown) {
  const body = { ok: true, data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function failure(error: unknown) {
  const mapped = mapSqliteError(error, "control-plane sqlite");
  if (isControlPlaneError(mapped)) {
    const body = {
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        details: mapped.details,
      },
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      structuredContent: body,
      isError: true,
    };
  }

  console.error("Unexpected Mission Ledger for Codex control-plane error:", error);
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  const body = {
    ok: false,
    error: {
      code: "internal_error",
      message:
        message.length > 0
          ? `The control plane encountered an unexpected internal error: ${message}`
          : "The control plane encountered an unexpected internal error.",
      details: code.length > 0 ? { errorCode: code } : {},
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

function run(operation: () => unknown) {
  try {
    return success(operation());
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(controlPlane: ControlPlane): McpServer {
  const server = new McpServer({
    name: "Mission Ledger for Codex",
    version: "0.2.0",
  });

  server.registerTool(
    "mission_create",
    {
      title: "Create mission",
      description:
        "Create the durable mission record before spawning agents. strategy is locked at create (default fanout). directorPlan is required only for director_plan: a workspace-relative .md path to the plan file Sol wrote in the project folder. Forbidden otherwise.",
      inputSchema: z
        .object({
          objective: text,
          constraints: stringList.optional(),
          successCriteria: stringList.min(1),
          risk,
          strategy: strategy.optional(),
          portrait: portrait.optional(),
          directorPlan: z.string().max(200).optional(),
          budget: budget.optional(),
          actorId: id,
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.createMission(input as MissionCreateInput)),
  );

  server.registerTool(
    "mission_get",
    {
      title: "Get mission",
      description:
        "Read a mission and optionally its task, artifact, claim, and review state. Treat this result as authoritative over chat summaries. The mission row includes strategy, portrait, and directorPlan (workspace-relative plan file path) even when includeDetails is false.",
      inputSchema: z
        .object({
          missionId: id,
          includeDetails: z.boolean().default(true),
        })
        .strict(),
    },
    async ({ missionId, includeDetails }) =>
      run(() => controlPlane.getMission(missionId, includeDetails)),
  );

  server.registerTool(
    "mission_close",
    {
      title: "Close mission",
      description:
        "Complete a mission only after every task is terminal. Failed tasks require an explicit acceptance decision.",
      inputSchema: z
        .object({
          missionId: id,
          actorId: id,
          expectedVersion: z.number().int().positive(),
          acceptFailedTasks: z.boolean().optional(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.closeMission(input as MissionCloseInput)),
  );

  server.registerTool(
    "task_allocate",
    {
      title: "Allocate task",
      description:
        "Allocate a policy-checked work package before native spawn_agent. Put the returned task_id into the child's prompt. Root role depends on mission.strategy: fanout/director_plan/pipeline require Terra; direct allows one root Luna. fanout Terra objective max 2000 characters.",
      inputSchema: z
        .object({
          missionId: id,
          parentTaskId: id.nullable().optional(),
          expectedParentVersion: z.number().int().positive().optional(),
          parentLeaseToken: id.optional(),
          objective: text,
          role,
          model,
          reasoningEffort: effort,
          maxEffort: effort.optional(),
          capabilityPack: shortText,
          dependencies: z.array(id).max(500).optional(),
          inputArtifactRefs: z.array(id).max(500).optional(),
          allowedTools: stringList.optional(),
          doneCriteria: stringList.min(1),
          outputSchema: jsonObject.nullable().optional(),
          risk,
          budget: budget.optional(),
          actorId: id,
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.allocateTask(input as TaskAllocateInput)),
  );

  server.registerTool(
    "task_get",
    {
      title: "Get task",
      description:
        "Read the authoritative task version, lease, assignment, inputs, budget, and status before mutating it.",
      inputSchema: z.object({ taskId: id }).strict(),
    },
    async ({ taskId }) => run(() => controlPlane.getTask(taskId)),
  );

  server.registerTool(
    "children_status",
    {
      title: "List compact child status",
      description:
        "Read direct children of a coordinator task as compact status rows (ids, status, version, summary). Call once after wait_agent. Do not poll with task_get.",
      inputSchema: z.object({ parentTaskId: id }).strict(),
    },
    async ({ parentTaskId }) => run(() => controlPlane.childrenStatus(parentTaskId)),
  );

  server.registerTool(
    "task_claim",
    {
      title: "Claim task",
      description:
        "Atomically claim a ready task using optimistic versioning. The returned lease token is required for worker mutations.",
      inputSchema: z
        .object({
          taskId: id,
          workerId: id,
          expectedVersion: z.number().int().positive(),
          leaseSeconds: z.number().int().positive().optional(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.claimTask(input as ClaimTaskInput)),
  );

  server.registerTool(
    "task_start",
    {
      title: "Start task",
      description: "Move a leased task to running and establish its result producer.",
      inputSchema: z.object(leaseFields).strict(),
    },
    async (input) => run(() => controlPlane.startTask(input as LeaseActionInput)),
  );

  server.registerTool(
    "task_heartbeat",
    {
      title: "Renew task lease",
      description:
        "Renew an active lease. Use this during long tool calls; an expired lease may be reclaimed by another worker.",
      inputSchema: z
        .object({
          ...leaseFields,
          leaseSeconds: z.number().int().positive().optional(),
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.heartbeatTask(input as TaskHeartbeatInput)),
  );

  server.registerTool(
    "task_release",
    {
      title: "Release task",
      description:
        "Return a leased/running/blocked task to ready when the current worker cannot continue. Include a concrete reason.",
      inputSchema: z.object({ ...leaseFields, reason: text }).strict(),
    },
    async (input) => run(() => controlPlane.releaseTask(input as TaskReleaseInput)),
  );

  server.registerTool(
    "task_block",
    {
      title: "Block task",
      description:
        "Record a blocking dependency while retaining the lease. Continue heartbeats or release the task.",
      inputSchema: z.object({ ...leaseFields, reason: text }).strict(),
    },
    async (input) => run(() => controlPlane.blockTask(input as TaskBlockInput)),
  );

  server.registerTool(
    "task_fail",
    {
      title: "Fail task",
      description:
        "Record a definitive worker failure, clear its lease, and charge final usage. Future sibling allocation counts actual failed usage instead of the full reservation.",
      inputSchema: z
        .object({
          ...leaseFields,
          reason: text,
          usage: usage.optional(),
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.failTask(input as TaskFailInput)),
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel task",
      description:
        "Cancel a non-terminal task after its direct children are terminal. Child cancellation requires the running direct parent's version and lease token.",
      inputSchema: z
        .object({
          taskId: id,
          actorId: id,
          expectedVersion: z.number().int().positive(),
          reason: text,
          expectedParentVersion: z.number().int().positive().optional(),
          parentLeaseToken: id.optional(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.cancelTask(input as TaskCancelInput)),
  );

  server.registerTool(
    "task_supersede",
    {
      title: "Supersede failed task",
      description:
        "Link a failed task to a viable sibling replacement for audit and closure. Child supersession requires direct-parent authority.",
      inputSchema: z
        .object({
          taskId: id,
          replacementTaskId: id,
          actorId: id,
          expectedVersion: z.number().int().positive(),
          reason: text,
          expectedParentVersion: z.number().int().positive().optional(),
          parentLeaseToken: id.optional(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.supersedeTask(input as TaskSupersedeInput)),
  );

  server.registerTool(
    "task_set_effort",
    {
      title: "Set task reasoning effort",
      description:
        "Change model reasoning effort while a task is ready and unleased, within its recorded maximum. Child changes require direct-parent authority.",
      inputSchema: z
        .object({
          taskId: id,
          actorId: id,
          expectedVersion: z.number().int().positive(),
          reasoningEffort: effort,
          reason: text,
          expectedParentVersion: z.number().int().positive().optional(),
          parentLeaseToken: id.optional(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.setTaskEffort(input as TaskEffortInput)),
  );

  server.registerTool(
    "artifact_put",
    {
      title: "Store artifact",
      description:
        "Store bounded content in the content-addressed artifact store. Required fields are taskId, actorId, kind, mimeType, content, encoding, and idempotencyKey. Do not send missionId. Return artifact references instead of copying large content into agent messages.",
      inputSchema: z
        .object({
          taskId: id,
          actorId: id,
          kind: shortText,
          mimeType: shortText,
          content: z.string().max(8_000_000),
          encoding: z.enum(["utf8", "base64"]),
          metadata: jsonObject.optional(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.putArtifact(input as ArtifactPutInput)),
  );

  server.registerTool(
    "artifact_get",
    {
      title: "Read artifact",
      description:
        "Read a bounded prefix of an artifact by ID. Prefer targeted retrieval over loading full artifacts.",
      inputSchema: z
        .object({
          artifactId: id,
          encoding: z.enum(["utf8", "base64"]).default("utf8"),
          maxBytes: z.number().int().positive().max(1_000_000).default(65_536),
        })
        .strict(),
    },
    async ({ artifactId, encoding, maxBytes }) =>
      run(() => controlPlane.getArtifact(artifactId, encoding, maxBytes)),
  );

  server.registerTool(
    "result_submit_candidate",
    {
      title: "Submit candidate result",
      description:
        "Submit a worker result as candidate only. This closes the producer lease; a different reviewer must check it. artifactRefs must belong to this taskId — call artifact_put on the same task first, and do not attach child-task artifacts. Include actual usage when known. summary max 500 characters.",
      inputSchema: z
        .object({
          ...leaseFields,
          summary: shortText,
          artifactRefs: z.array(id).max(500),
          claims: z
            .array(
              z
                .object({
                  statement: text,
                  confidence: z.number().min(0).max(1).nullable().optional(),
                  evidenceRefs: z.array(id).max(500).optional(),
                  artifactId: id.nullable().optional(),
                })
                .strict(),
            )
            .max(500),
          unresolved: stringList.optional(),
          usage: usage.optional(),
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.submitCandidate(input as SubmitCandidateInput)),
  );

  server.registerTool(
    "result_check",
    {
      title: "Check candidate result",
      description:
        "Independently check a candidate. The reviewer cannot be the producer. Luna verifiers call this on review_target_task_id without claiming. Rejection returns the task to ready.",
      inputSchema: z.object(reviewFields).strict(),
    },
    async (input) => run(() => controlPlane.checkResult(input as ReviewInput)),
  );

  server.registerTool(
    "result_verify",
    {
      title: "Verify checked result",
      description:
        "Apply the second evidence gate to a checked result. Approval produces verified, not committed.",
      inputSchema: z.object(reviewFields).strict(),
    },
    async (input) => run(() => controlPlane.verifyResult(input as ReviewInput)),
  );

  server.registerTool(
    "task_commit",
    {
      title: "Commit verified task",
      description:
        "Commit a verified task after every direct child is terminal. This may unlock dependent tasks.",
      inputSchema: z
        .object({
          taskId: id,
          actorId: id,
          expectedVersion: z.number().int().positive(),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.commitTask(input as CommitTaskInput)),
  );

  server.registerTool(
    "results_gate_and_commit",
    {
      title: "Gate and commit low-risk children",
      description:
        "For low or medium risk only, record check and verify reviews then commit in one call. Does not skip gates. High or critical work must use luna-verifier plus result_check, result_verify, and task_commit. Children must already be candidate. On a direct mission, Sol (not the Luna producer) may be the reviewer without parentTaskId.",
      inputSchema: z
        .object({
          reviewerId: id,
          parentTaskId: id.optional(),
          decisions: z
            .array(
              z
                .object({
                  taskId: id,
                  expectedVersion: z.number().int().positive(),
                  approved: z.boolean(),
                  evidenceRefs: z.array(id).max(500).optional(),
                  notes: text,
                })
                .strict(),
            )
            .min(1)
            .max(500),
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.gateAndCommitResults(input as GateAndCommitInput)),
  );

  server.registerTool(
    "budget_report",
    {
      title: "Report resource usage",
      description:
        "Atomically add token, cost, wall-time, and tool-call usage to a mission and optionally a task. Hard limits are enforced.",
      inputSchema: z
        .object({
          missionId: id,
          taskId: id.nullable().optional(),
          actorId: id,
          expectedMissionVersion: z.number().int().positive(),
          expectedTaskVersion: z.number().int().positive().optional(),
          usage,
          idempotencyKey,
        })
        .strict(),
    },
    async (input) => run(() => controlPlane.reportBudget(input as BudgetReportInput)),
  );

  server.registerTool(
    "recovery_snapshot",
    {
      title: "Get recovery snapshot",
      description:
        "Read durable mission state and a bounded audit-event page after interruption, compaction, or client restart.",
      inputSchema: z
        .object({
          missionId: id,
          afterSequence: z.number().int().nonnegative().default(0),
          eventLimit: z.number().int().positive().max(1_000).optional(),
        })
        .strict(),
    },
    async ({ missionId, afterSequence, eventLimit }) =>
      run(() => controlPlane.recoverySnapshot(missionId, afterSequence, eventLimit)),
  );

  return server;
}
