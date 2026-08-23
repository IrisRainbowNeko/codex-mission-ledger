import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ControlPlaneError, isControlPlaneError } from "../domain/errors.js";

const SCHEMA_VERSION = 3;

export function mapSqliteError(error: unknown, databasePath: string): unknown {
  if (isControlPlaneError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ERR_INVALID_STATE" || /database is not open/i.test(message)) {
    return new ControlPlaneError(
      "internal_error",
      `Control plane SQLite connection is closed at ${databasePath}: ${message}`,
      { databasePath, sqlite: message, sqliteCode: code },
    );
  }
  if (
    /SQLITE_READONLY|SQLITE_CANTOPEN|readonly database|attempt to write a readonly database|database is locked|unable to open database file/i.test(
      message,
    )
  ) {
    return new ControlPlaneError(
      "forbidden",
      `Control plane SQLite is not writable at ${databasePath}: ${message}. Codex sandboxes often treat ~/.codex as read-only; Mission Ledger for Codex stores the ledger under ~/.local/share/codex-mission-ledger or a temp directory.`,
      { databasePath, sqlite: message, sqliteCode: code },
    );
  }
  return error;
}

export class ControlPlaneDatabase {
  readonly path: string;
  readonly handle: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.handle = new DatabaseSync(path);
    try {
      this.configure();
      this.migrate();
    } catch (error) {
      try {
        this.handle.close();
      } catch {
        // The mapped error below is the one callers should see.
      }
      throw mapSqliteError(error, path);
    }
  }

  prepare(sql: string): StatementSync {
    return this.handle.prepare(sql);
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      try {
        return operation();
      } catch (error) {
        throw mapSqliteError(error, this.path);
      }
    }

    try {
      this.handle.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw mapSqliteError(error, this.path);
    }
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.handle.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.handle.exec("ROLLBACK");
      } catch {
        // Read-only connections can fail both COMMIT and ROLLBACK.
      }
      throw mapSqliteError(error, this.path);
    } finally {
      this.transactionDepth -= 1;
    }
  }

  close(): void {
    this.handle.close();
  }

  private configure(): void {
    this.handle.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    try {
      this.handle.exec("PRAGMA journal_mode = WAL;");
    } catch {
      // In-memory and read-only SQLite connections may not support WAL.
    }
  }

  private migrate(): void {
    this.transaction(() => {
      this.handle.exec(`
        CREATE TABLE IF NOT EXISTS schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const current = this.prepare("SELECT value FROM schema_metadata WHERE key = ?").get(
        "schema_version",
      ) as { value: string } | undefined;
      let currentVersion = current === undefined ? 0 : Number(current.value);
      if (currentVersion > SCHEMA_VERSION) {
        throw new Error(
          `Database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}.`,
        );
      }
      if (currentVersion < 1) {
        this.applyVersionOne();
        currentVersion = 1;
        this.setSchemaVersion(currentVersion);
      }
      if (currentVersion < 2) {
        this.applyVersionTwo();
        currentVersion = 2;
        this.setSchemaVersion(currentVersion);
      }
      if (currentVersion < 3) {
        this.applyVersionThree();
        currentVersion = 3;
        this.setSchemaVersion(currentVersion);
      }
    });
  }

  private setSchemaVersion(version: number): void {
    this.prepare(
      "INSERT INTO schema_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("schema_version", String(version));
  }

  private applyVersionOne(): void {
    this.handle.exec(`
      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        success_criteria_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        objective TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        max_effort TEXT NOT NULL,
        capability_pack TEXT NOT NULL,
        status TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        input_artifact_refs_json TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        done_criteria_json TEXT NOT NULL,
        output_schema_json TEXT,
        risk TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        producer_id TEXT,
        summary TEXT,
        unresolved_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX tasks_mission_idx ON tasks(mission_id);
      CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
      CREATE INDEX tasks_status_idx ON tasks(mission_id, status);

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        storage_uri TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, sha256, kind)
      );

      CREATE INDEX artifacts_mission_idx ON artifacts(mission_id);
      CREATE INDEX artifacts_task_idx ON artifacts(task_id);

      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL,
        evidence_refs_json TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        producer_id TEXT NOT NULL,
        verifier_id TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX claims_mission_idx ON claims(mission_id);
      CREATE INDEX claims_task_idx ON claims(task_id);
      CREATE INDEX claims_status_idx ON claims(mission_id, status);

      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        approved INTEGER NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        notes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX reviews_task_idx ON reviews(task_id, stage);

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX events_mission_idx ON events(mission_id, sequence);
      CREATE INDEX events_task_idx ON events(task_id, sequence);
      CREATE UNIQUE INDEX events_idempotency_idx
        ON events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE idempotency (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private applyVersionTwo(): void {
    this.handle.exec(`
      ALTER TABLE idempotency
        ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
    `);
  }

  private applyVersionThree(): void {
    this.handle.exec(`
      ALTER TABLE missions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'fanout';
      ALTER TABLE missions ADD COLUMN portrait_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE missions ADD COLUMN director_plan TEXT;
    `);
  }
}
