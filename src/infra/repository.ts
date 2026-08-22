import type { StatementResultingChanges } from "node:sqlite";
import { ControlPlaneError, assertCondition } from "../domain/errors.js";
import type {
  Artifact,
  AuditEvent,
  BudgetLimits,
  Claim,
  JsonObject,
  JsonValue,
  Mission,
  MissionPortrait,
  MissionStrategy,
  Review,
  Task,
  Usage,
} from "../domain/types.js";
import type { ControlPlaneDatabase } from "./database.js";

type Row = Record<string, unknown>;

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Corrupt database row: '${key}' is not a string.`);
  }
  return value;
}

function optionalString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Corrupt database row: '${key}' is not nullable text.`);
  }
  return value;
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Corrupt database row: '${key}' is not numeric.`);
  }
  return Number(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function parsePortrait(value: string): MissionPortrait | null {
  const parsed = parseJson<unknown>(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length === 0) {
    return null;
  }
  return parsed as MissionPortrait;
}

function json(value: JsonValue | BudgetLimits | Usage | string[] | MissionPortrait): string {
  return JSON.stringify(value);
}

function changed(result: StatementResultingChanges, entity: string): void {
  if (Number(result.changes) !== 1) {
    throw new ControlPlaneError(
      "conflict",
      `${entity} changed concurrently; reload it and retry with its latest version.`,
    );
  }
}

export class Repository {
  constructor(readonly database: ControlPlaneDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  insertMission(mission: Mission): void {
    this.database
      .prepare(
        `INSERT INTO missions(
          id, objective, constraints_json, success_criteria_json, risk, status,
          strategy, portrait_json, director_plan,
          budget_json, usage_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mission.id,
        mission.objective,
        json(mission.constraints),
        json(mission.successCriteria),
        mission.risk,
        mission.status,
        mission.strategy,
        json(mission.portrait ?? {}),
        mission.directorPlan,
        json(mission.budget),
        json(mission.usage),
        mission.version,
        mission.createdAt,
        mission.updatedAt,
      );
  }

  getMission(id: string): Mission | null {
    const row = this.database.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      Row | undefined;
    return row === undefined ? null : this.mapMission(row);
  }

  updateMission(mission: Mission, expectedVersion: number): void {
    const result = this.database
      .prepare(
        `UPDATE missions SET
          objective = ?, constraints_json = ?, success_criteria_json = ?, risk = ?,
          status = ?, strategy = ?, portrait_json = ?, director_plan = ?,
          budget_json = ?, usage_json = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        mission.objective,
        json(mission.constraints),
        json(mission.successCriteria),
        mission.risk,
        mission.status,
        mission.strategy,
        json(mission.portrait ?? {}),
        mission.directorPlan,
        json(mission.budget),
        json(mission.usage),
        mission.version,
        mission.updatedAt,
        mission.id,
        expectedVersion,
      );
    changed(result, "Mission");
  }

  insertTask(task: Task): void {
    this.database
      .prepare(
        `INSERT INTO tasks(
          id, mission_id, parent_task_id, objective, role, model, reasoning_effort,
          max_effort, capability_pack, status, dependencies_json,
          input_artifact_refs_json, allowed_tools_json, done_criteria_json,
          output_schema_json, risk, budget_json, usage_json, lease_owner, lease_token,
          lease_expires_at, producer_id, summary, unresolved_json, version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.missionId,
        task.parentTaskId,
        task.objective,
        task.role,
        task.model,
        task.reasoningEffort,
        task.maxEffort,
        task.capabilityPack,
        task.status,
        json(task.dependencies),
        json(task.inputArtifactRefs),
        json(task.allowedTools),
        json(task.doneCriteria),
        task.outputSchema === null ? null : json(task.outputSchema),
        task.risk,
        json(task.budget),
        json(task.usage),
        task.leaseOwner,
        task.leaseToken,
        task.leaseExpiresAt,
        task.producerId,
        task.summary,
        json(task.unresolved),
        task.version,
        task.createdAt,
        task.updatedAt,
      );
  }

  getTask(id: string): Task | null {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      Row | undefined;
    return row === undefined ? null : this.mapTask(row);
  }

  listTasks(missionId: string): Task[] {
    const rows = this.database
      .prepare("SELECT * FROM tasks WHERE mission_id = ? ORDER BY created_at, id")
      .all(missionId) as Row[];
    return rows.map((row) => this.mapTask(row));
  }

  listChildren(parentTaskId: string): Task[] {
    const rows = this.database
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at, id")
      .all(parentTaskId) as Row[];
    return rows.map((row) => this.mapTask(row));
  }

  listRootTasks(missionId: string): Task[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM tasks WHERE mission_id = ? AND parent_task_id IS NULL ORDER BY created_at, id",
      )
      .all(missionId) as Row[];
    return rows.map((row) => this.mapTask(row));
  }

  updateTask(task: Task, expectedVersion: number): void {
    const result = this.database
      .prepare(
        `UPDATE tasks SET
          objective = ?, role = ?, model = ?, reasoning_effort = ?, max_effort = ?,
          capability_pack = ?, status = ?, dependencies_json = ?,
          input_artifact_refs_json = ?, allowed_tools_json = ?, done_criteria_json = ?,
          output_schema_json = ?, risk = ?, budget_json = ?, usage_json = ?,
          lease_owner = ?, lease_token = ?, lease_expires_at = ?, producer_id = ?,
          summary = ?, unresolved_json = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        task.objective,
        task.role,
        task.model,
        task.reasoningEffort,
        task.maxEffort,
        task.capabilityPack,
        task.status,
        json(task.dependencies),
        json(task.inputArtifactRefs),
        json(task.allowedTools),
        json(task.doneCriteria),
        task.outputSchema === null ? null : json(task.outputSchema),
        task.risk,
        json(task.budget),
        json(task.usage),
        task.leaseOwner,
        task.leaseToken,
        task.leaseExpiresAt,
        task.producerId,
        task.summary,
        json(task.unresolved),
        task.version,
        task.updatedAt,
        task.id,
        expectedVersion,
      );
    changed(result, "Task");
  }

  insertArtifact(artifact: Artifact): Artifact {
    const existing = this.database
      .prepare("SELECT * FROM artifacts WHERE task_id = ? AND sha256 = ? AND kind = ?")
      .get(artifact.taskId, artifact.sha256, artifact.kind) as Row | undefined;
    if (existing !== undefined) {
      return this.mapArtifact(existing);
    }
    this.database
      .prepare(
        `INSERT INTO artifacts(
          id, mission_id, task_id, kind, mime_type, sha256, byte_length,
          storage_uri, metadata_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.missionId,
        artifact.taskId,
        artifact.kind,
        artifact.mimeType,
        artifact.sha256,
        artifact.byteLength,
        artifact.storageUri,
        json(artifact.metadata),
        artifact.createdBy,
        artifact.createdAt,
      );
    return artifact;
  }

  getArtifact(id: string): Artifact | null {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      Row | undefined;
    return row === undefined ? null : this.mapArtifact(row);
  }

  listArtifacts(missionId: string, taskId?: string): Artifact[] {
    const rows =
      taskId === undefined
        ? (this.database
            .prepare("SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at, id")
            .all(missionId) as Row[])
        : (this.database
            .prepare(
              "SELECT * FROM artifacts WHERE mission_id = ? AND task_id = ? ORDER BY created_at, id",
            )
            .all(missionId, taskId) as Row[]);
    return rows.map((row) => this.mapArtifact(row));
  }

  insertClaim(claim: Claim): void {
    this.database
      .prepare(
        `INSERT INTO claims(
          id, mission_id, task_id, statement, status, confidence, evidence_refs_json,
          artifact_id, producer_id, verifier_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        claim.id,
        claim.missionId,
        claim.taskId,
        claim.statement,
        claim.status,
        claim.confidence,
        json(claim.evidenceRefs),
        claim.artifactId,
        claim.producerId,
        claim.verifierId,
        claim.version,
        claim.createdAt,
        claim.updatedAt,
      );
  }

  listClaims(missionId: string, taskId?: string): Claim[] {
    const rows =
      taskId === undefined
        ? (this.database
            .prepare("SELECT * FROM claims WHERE mission_id = ? ORDER BY created_at, id")
            .all(missionId) as Row[])
        : (this.database
            .prepare(
              "SELECT * FROM claims WHERE mission_id = ? AND task_id = ? ORDER BY created_at, id",
            )
            .all(missionId, taskId) as Row[]);
    return rows.map((row) => this.mapClaim(row));
  }

  updateClaimsForTask(
    taskId: string,
    fromStatus: string,
    toStatus: string,
    verifierId: string,
    updatedAt: string,
  ): void {
    this.database
      .prepare(
        `UPDATE claims
         SET status = ?, verifier_id = ?, version = version + 1, updated_at = ?
         WHERE task_id = ? AND status = ?`,
      )
      .run(toStatus, verifierId, updatedAt, taskId, fromStatus);
  }

  insertReview(review: Review): void {
    this.database
      .prepare(
        `INSERT INTO reviews(
          id, mission_id, task_id, stage, reviewer_id, approved,
          evidence_refs_json, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        review.missionId,
        review.taskId,
        review.stage,
        review.reviewerId,
        review.approved ? 1 : 0,
        json(review.evidenceRefs),
        review.notes,
        review.createdAt,
      );
  }

  listReviews(missionId: string, taskId?: string): Review[] {
    const rows =
      taskId === undefined
        ? (this.database
            .prepare("SELECT * FROM reviews WHERE mission_id = ? ORDER BY created_at, id")
            .all(missionId) as Row[])
        : (this.database
            .prepare(
              "SELECT * FROM reviews WHERE mission_id = ? AND task_id = ? ORDER BY created_at, id",
            )
            .all(missionId, taskId) as Row[]);
    return rows.map((row) => this.mapReview(row));
  }

  appendEvent(event: Omit<AuditEvent, "sequence">): AuditEvent {
    const result = this.database
      .prepare(
        `INSERT INTO events(
          mission_id, task_id, type, actor_id, payload_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.missionId,
        event.taskId,
        event.type,
        event.actorId,
        json(event.payload),
        event.idempotencyKey,
        event.createdAt,
      );
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }

  listEvents(missionId: string, afterSequence: number, limit: number): AuditEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM events
         WHERE mission_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(missionId, afterSequence, limit) as Row[];
    return rows.map((row) => this.mapEvent(row));
  }

  getIdempotent<T>(key: string, operation: string, requestHash: string): T | null {
    const row = this.database.prepare("SELECT * FROM idempotency WHERE key = ?").get(key) as
      Row | undefined;
    if (row === undefined) {
      return null;
    }
    const storedOperation = requiredString(row, "operation");
    assertCondition(
      storedOperation === operation,
      "conflict",
      "Idempotency key was already used for another operation.",
      { key, existingOperation: storedOperation, requestedOperation: operation },
    );
    const storedRequestHash = requiredString(row, "request_hash");
    assertCondition(
      storedRequestHash === requestHash,
      "conflict",
      "Idempotency key was replayed with a different request payload.",
      { key, operation },
    );
    return parseJson<T>(requiredString(row, "response_json"));
  }

  saveIdempotent(
    key: string,
    operation: string,
    requestHash: string,
    response: JsonValue,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO idempotency(key, operation, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, operation, requestHash, JSON.stringify(response), createdAt);
  }

  private mapMission(row: Row): Mission {
    return {
      id: requiredString(row, "id"),
      objective: requiredString(row, "objective"),
      constraints: parseJson<string[]>(requiredString(row, "constraints_json")),
      successCriteria: parseJson<string[]>(requiredString(row, "success_criteria_json")),
      risk: requiredString(row, "risk") as Mission["risk"],
      status: requiredString(row, "status") as Mission["status"],
      strategy: (optionalString(row, "strategy") ?? "fanout") as MissionStrategy,
      portrait: parsePortrait(requiredString(row, "portrait_json")),
      directorPlan: optionalString(row, "director_plan"),
      budget: parseJson<BudgetLimits>(requiredString(row, "budget_json")),
      usage: parseJson<Usage>(requiredString(row, "usage_json")),
      version: requiredNumber(row, "version"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  private mapTask(row: Row): Task {
    const outputSchema = optionalString(row, "output_schema_json");
    return {
      id: requiredString(row, "id"),
      missionId: requiredString(row, "mission_id"),
      parentTaskId: optionalString(row, "parent_task_id"),
      objective: requiredString(row, "objective"),
      role: requiredString(row, "role") as Task["role"],
      model: requiredString(row, "model") as Task["model"],
      reasoningEffort: requiredString(row, "reasoning_effort") as Task["reasoningEffort"],
      maxEffort: requiredString(row, "max_effort") as Task["maxEffort"],
      capabilityPack: requiredString(row, "capability_pack"),
      status: requiredString(row, "status") as Task["status"],
      dependencies: parseJson<string[]>(requiredString(row, "dependencies_json")),
      inputArtifactRefs: parseJson<string[]>(requiredString(row, "input_artifact_refs_json")),
      allowedTools: parseJson<string[]>(requiredString(row, "allowed_tools_json")),
      doneCriteria: parseJson<string[]>(requiredString(row, "done_criteria_json")),
      outputSchema: outputSchema === null ? null : parseJson<JsonObject>(outputSchema),
      risk: requiredString(row, "risk") as Task["risk"],
      budget: parseJson<BudgetLimits>(requiredString(row, "budget_json")),
      usage: parseJson<Usage>(requiredString(row, "usage_json")),
      leaseOwner: optionalString(row, "lease_owner"),
      leaseToken: optionalString(row, "lease_token"),
      leaseExpiresAt: optionalString(row, "lease_expires_at"),
      producerId: optionalString(row, "producer_id"),
      summary: optionalString(row, "summary"),
      unresolved: parseJson<string[]>(requiredString(row, "unresolved_json")),
      version: requiredNumber(row, "version"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  private mapArtifact(row: Row): Artifact {
    return {
      id: requiredString(row, "id"),
      missionId: requiredString(row, "mission_id"),
      taskId: requiredString(row, "task_id"),
      kind: requiredString(row, "kind"),
      mimeType: requiredString(row, "mime_type"),
      sha256: requiredString(row, "sha256"),
      byteLength: requiredNumber(row, "byte_length"),
      storageUri: requiredString(row, "storage_uri"),
      metadata: parseJson<JsonObject>(requiredString(row, "metadata_json")),
      createdBy: requiredString(row, "created_by"),
      createdAt: requiredString(row, "created_at"),
    };
  }

  private mapClaim(row: Row): Claim {
    const confidenceValue = row["confidence"];
    return {
      id: requiredString(row, "id"),
      missionId: requiredString(row, "mission_id"),
      taskId: requiredString(row, "task_id"),
      statement: requiredString(row, "statement"),
      status: requiredString(row, "status") as Claim["status"],
      confidence:
        confidenceValue === null || confidenceValue === undefined ? null : Number(confidenceValue),
      evidenceRefs: parseJson<string[]>(requiredString(row, "evidence_refs_json")),
      artifactId: optionalString(row, "artifact_id"),
      producerId: requiredString(row, "producer_id"),
      verifierId: optionalString(row, "verifier_id"),
      version: requiredNumber(row, "version"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  private mapReview(row: Row): Review {
    return {
      id: requiredString(row, "id"),
      missionId: requiredString(row, "mission_id"),
      taskId: requiredString(row, "task_id"),
      stage: requiredString(row, "stage") as Review["stage"],
      reviewerId: requiredString(row, "reviewer_id"),
      approved: requiredNumber(row, "approved") === 1,
      evidenceRefs: parseJson<string[]>(requiredString(row, "evidence_refs_json")),
      notes: requiredString(row, "notes"),
      createdAt: requiredString(row, "created_at"),
    };
  }

  private mapEvent(row: Row): AuditEvent {
    return {
      sequence: requiredNumber(row, "sequence"),
      missionId: requiredString(row, "mission_id"),
      taskId: optionalString(row, "task_id"),
      type: requiredString(row, "type"),
      actorId: requiredString(row, "actor_id"),
      payload: parseJson<JsonObject>(requiredString(row, "payload_json")),
      idempotencyKey: optionalString(row, "idempotency_key"),
      createdAt: requiredString(row, "created_at"),
    };
  }
}
