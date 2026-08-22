import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "../src/domain/errors.js";
import { ControlPlaneDatabase } from "../src/infra/database.js";

describe("database migrations", () => {
  it("upgrades schema v1 idempotency records with request hashes", () => {
    const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-migration-"));
    const path = join(directory, "control-plane.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '1');
        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO idempotency(key, operation, response_json, created_at)
        VALUES ('legacy-key', 'mission_create', '{}', '2026-08-20T00:00:00.000Z');
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
      `);
      legacy.close();

      const upgraded = new ControlPlaneDatabase(path);
      const version = upgraded
        .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
        .get() as { value: string };
      const row = upgraded
        .prepare("SELECT request_hash FROM idempotency WHERE key = 'legacy-key'")
        .get() as { request_hash: string };
      expect(version.value).toBe("3");
      expect(row.request_hash).toBe("");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades schema v2 missions to fanout strategy", () => {
    const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-migration-v3-"));
    const path = join(directory, "control-plane.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '2');
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
        INSERT INTO missions(
          id, objective, constraints_json, success_criteria_json, risk, status,
          budget_json, usage_json, version, created_at, updated_at
        ) VALUES (
          'mis_legacy', 'old mission', '[]', '["done"]', 'low', 'active',
          '{}', '{"tokens":0,"costUsd":0,"wallClockSeconds":0,"toolCalls":0}',
          1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
        );
        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          request_hash TEXT NOT NULL DEFAULT ''
        );
      `);
      legacy.close();

      const upgraded = new ControlPlaneDatabase(path);
      const version = upgraded
        .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
        .get() as { value: string };
      const row = upgraded
        .prepare(
          "SELECT strategy, portrait_json, director_plan FROM missions WHERE id = 'mis_legacy'",
        )
        .get() as { strategy: string; portrait_json: string; director_plan: string | null };
      expect(version.value).toBe("3");
      expect(row.strategy).toBe("fanout");
      expect(row.portrait_json).toBe("{}");
      expect(row.director_plan).toBeNull();
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps read-only sqlite writes to a forbidden control-plane error", () => {
    const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-readonly-"));
    const path = join(directory, "control-plane.sqlite");
    try {
      const writable = new ControlPlaneDatabase(path);
      writable.close();
      chmodSync(path, 0o444);
      try {
        const readonly = new ControlPlaneDatabase(path);
        try {
          expect(() =>
            readonly.transaction(() => {
              readonly.handle.exec("CREATE TABLE readonly_probe(id INTEGER)");
            }),
          ).toThrow(ControlPlaneError);
        } finally {
          readonly.close();
        }
      } catch (error) {
        expect(error).toBeInstanceOf(ControlPlaneError);
        expect((error as ControlPlaneError).code).toBe("forbidden");
        expect((error as ControlPlaneError).message).toContain(path);
      }
    } finally {
      try {
        chmodSync(path, 0o644);
      } catch {
        // The file may already be gone.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps a closed sqlite connection to a control-plane error", () => {
    const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-closed-"));
    const path = join(directory, "control-plane.sqlite");
    try {
      const database = new ControlPlaneDatabase(path);
      database.close();
      expect(() =>
        database.transaction(() => {
          database.handle.exec("CREATE TABLE closed_probe(id INTEGER)");
        }),
      ).toThrow(/connection is closed|database is not open/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
