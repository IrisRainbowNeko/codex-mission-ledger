# Changelog

All notable changes are documented here. The project follows semantic
versioning once releases begin.

- Renamed the product-facing package and defaults to Mission Ledger for Codex
  (`codex-mission-ledger`). Legacy `hierarchical-codex` CLI bins, environment
  variables, state paths, installer markers, and manifests remain accepted for
  upgrade compatibility. The `hierarchical_codex` MCP key and `$agent-trio`
  trigger remain stable protocol identifiers.

## [Unreleased]

### Changed

- Sol/Terra wait recovery is one timeout check, not three 1-hour waits.
  Default mission risk is `medium` unless the user asked for irreversible
  damage. `result_submit_candidate` no longer rejects tool/time overage, and
  `mission_close` cancels stalled tasks whose lease has expired.
- User-global and project MCP config set
  `default_tools_approval_mode = "approve"` so Codex Guardian skips this
  local stdio ledger. Prompt text cannot authorize those tools.
- `mission_close` auto-finalizes one low/medium root Terra candidate on
  `fanout` / `director_plan` / `pipeline` after descendants are terminal, and
  retries a stale mission `expectedVersion` once. Sol no longer needs
  `results_gate_and_commit` to close those missions.
- Child allocate/cancel/supersede accept a stale `expectedParentVersion` when
  the parent lease is still valid.
- Parent-owned running siblings reserve remaining budget, not the full original
  reservation, so a replacement plus synthesizer can fit after a cancelled leaf.
- Terra `wait` hook allows VS Code cell yield (`cell_id` + `max_tokens`) and
  still denies timeout-style polls.

### Added

- Adaptive mission routing: `mission_create` locks `direct`, `fanout`
  (default), `director_plan`, or `pipeline` from a Sol `MISSION_ROUTE`
  portrait. `direct` allows one root Luna; `fanout` caps Terra objectives at
  2000 characters; `director_plan` stores a workspace-relative markdown path
  (`directorPlan`) to a plan file Sol wrote in the project folder;
  `pipeline` allows one Terra with serial Luna dependencies. Spawn policy
  permits Sol→Luna only when the ledger row is that direct root operator.

### Planned

- Historical success/cost router and remaining Phase 3 metrics.
- End-to-end compatibility matrix for Codex App, CLI, and VS Code.
- Host-authoritative token accounting.
- Retention and artifact garbage collection.
- Exported observability metrics.

## [0.2.0] - 2026-08-21

### Added

- Terra PreToolUse hook blocks coordinator babysitting (`wait`, `list_agents`,
  `send_message`, `followup_task`) and short `wait_agent` polls. Sol stays
  skill-only so ordinary root chats keep those tools.
- Compact `children_status` MCP tool for one post-wait child snapshot.
- `results_gate_and_commit` records check + verify + commit in one call for
  low/medium risk only. Gates are not skipped.
- Host token measurer: `npx tsx scripts/measure-host-tokens.ts <parent-session-id>`.

### Changed

- Coordinators are cheap: Terra spawn effort defaults to `high` (still may
  use `xhigh`/`max`). Terra sandbox is read-only; a Luna synthesizer writes
  the user-facing deliverable. Sol `artifact_get` / file I/O is out of the
  happy path. Target host token mass is Luna 82 · Terra 13 · Sol 5.
- `result_submit_candidate.summary` is capped at 500 characters. SubagentStop
  accepts only a compact `TASK_RESULT` block so `wait_agent` does not re-inject
  reports into parent transcripts.
- Luna verifier is default-off for low/medium deterministic work.
- Coordinator leases: default remains 15 minutes; maximum default is 4 hours
  so Terra can `wait_agent` without a heartbeat poll loop. Terra should pass
  `leaseSeconds=14400` on claim/start/pre-wait heartbeat.
- Luna verifier protocol is now one path: Terra does not allocate a verifier
  task; spawn with `review_target_task_id`, and the verifier only
  `result_check`s the producer candidate. Spawn policy requires that field.
- `artifact_put` and `result_submit_candidate` tool text now match the schema
  (no extra `missionId`; same-task artifact refs; report actual `usage`).
- User-install backups go to `~/.codex/hierarchical-codex/backups/` instead of
  sibling `.bak-*` folders under `skills/`, which Codex was loading.
- Skill invocation is `$agent-trio` (was `$prism` / `$sol-terra-luna`). Reinstall
  removes the old skill folders so Codex does not list both.

### Fixed

- Codex MCP sandboxes treat `~/.codex` as read-only, so `mission_create` failed
  with a generic `internal_error` (`attempt to write a readonly database`).
  User-global state now lives under `~/.local/share/hierarchical-codex`, the
  server falls back to a temp directory when that path is not writable, and
  SQLite write failures return `forbidden` with the database path.
- `serveStdio()` returns a connection handle, not a Promise. The MCP entrypoint
  awaited it and closed SQLite in `finally` before any tool call, so
  `mission_create` failed with `database is not open`.

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
