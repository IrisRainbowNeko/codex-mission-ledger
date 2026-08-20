# Changelog

All notable changes are documented here. The project follows semantic
versioning once releases begin.

## [Unreleased]

### Changed

- Luna verifier protocol is now one path: Terra does not allocate a verifier
  task; spawn with `review_target_task_id`, and the verifier only
  `result_check`s the producer candidate. Spawn policy requires that field.
- `artifact_put` and `result_submit_candidate` tool text now match the schema
  (no extra `missionId`; same-task artifact refs; report actual `usage`).
- User-install backups go to `~/.codex/hierarchical-codex/backups/` instead of
  sibling `.bak-*` folders under `skills/`, which Codex was loading.
- Skill invocation is `$prism` (was `$sol-terra-luna`). Reinstall removes the
  old skill folders so Codex does not list both.

### Fixed

- Codex MCP sandboxes treat `~/.codex` as read-only, so `mission_create` failed
  with a generic `internal_error` (`attempt to write a readonly database`).
  User-global state now lives under `~/.local/share/hierarchical-codex`, the
  server falls back to a temp directory when that path is not writable, and
  SQLite write failures return `forbidden` with the database path.
- `serveStdio()` returns a connection handle, not a Promise. The MCP entrypoint
  awaited it and closed SQLite in `finally` before any tool call, so
  `mission_create` failed with `database is not open`.

### Planned

- End-to-end compatibility matrix for Codex App, CLI, and VS Code.
- Host-authoritative token accounting.
- Retention and artifact garbage collection.
- Exported observability metrics.

## [0.1.0] - 2026-08-20

### Added

- Native-Codex hierarchical orchestration Skill.
- Sol, Terra, Luna producer, and Luna verifier Agent profiles.
- Spawn-policy, subagent-start, and durable-stop hooks.
- TypeScript MCP v2 stdio server.
- SQLite mission/task/evidence/audit schema.
- Direct parent-child role and model/effort policy.
- Optimistic versions, leases, heartbeats, reclaim, and idempotency.
- Explicit fail, cancel, and supersede lifecycle operations.
- Parent-authorized per-task reasoning-effort adjustment.
- Hierarchical budget reservation and reported usage enforcement.
- Content-addressed artifact storage.
- Candidate/check/verify/commit evidence gates.
- Dependency readiness and recovery snapshots.
- Automated policy, control-plane, and hook tests.
- Doctor command and complete engineering documentation.
- Dual skill discovery paths (`.codex/skills` and `.agents/skills`) plus root `AGENTS.md`.
- User-global installer for Codex CLI / VS Code (`npm run install:user`) with
  idempotent TOML merge, an install manifest, and hook-trust documentation.
- V1/V2-aware no-context fork validation and fail-closed malformed hook input.
- Idempotency request hashes with a schema v1 → v2 migration.

### Security

- Bounded artifact input and reads.
- No arbitrary filesystem artifact registration.
- Producer/reviewer separation.
- Strict Luna leaf enforcement at the spawn hook.
