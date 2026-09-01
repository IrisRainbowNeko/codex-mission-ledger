# Contributing

Agent Trio V3 is performance-sensitive orchestration infrastructure. Changes should improve
measured speed, cost, quality, correctness, or recovery without adding coordination ceremony.

Read `docs/ARCHITECTURE.md` and `docs/BENCHMARKING.md` before changing admission, planning, model
routing, scheduling, App Server transport, or benchmark gates.

## Development Checks

```bash
npm install
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run doctor -- --project-only
```

`npm run check` runs the formatting check, lint, type checking, tests, and build as one command.
CI uses `doctor --project-only` because it must not depend on a globally installed Codex binary.
Before release, run the full doctor on the target host to verify exact `codex-cli 0.151.0`
compatibility.

## Change Requirements

Every behavior change needs focused tests and a changelog entry. Keep edits scoped, preserve user
worktrees and user configuration, and never commit job snapshots, private task artifacts, pricing
credentials, or provider secrets.

Changes to the App Server adapter must cover multiplexed requests, out-of-order events,
fail-closed approvals/input, thread and turn checkpoints, interruption, and process cleanup.
Do not loosen the exact schema pin without a reviewed compatibility update and fixtures for the
new version.

Changes to planning or routing need same-task paired evidence against direct Sol. Fixed token-share
targets, a comparison with an older Agent Trio version, and one anecdotal run are not sufficient.
Do not state that an acceptance target has passed unless the complete frozen suite and every
per-domain gate pass.

## Architectural Boundaries

Preserve these boundaries unless a measured design change explicitly replaces them:

- Sol owns complex semantic planning and at most one `PlanPatch`.
- Terra owns fast admission, the direct path, and ordinary integration.
- Scheduler code owns DAG readiness, concurrent launch, joins, budgets, messages, recovery, and
  cancellation.
- Desktop exposes one `agent_trio` MCP tool; CLI exposes the matching commands plus `benchmark`.
- Child threads cannot invoke Agent Trio, native collaboration, or project orchestration
  instructions.
- Plugins are opt-in, capability-scoped, and process-isolated.
- There is no mission ledger, SQLite workflow, lease, heartbeat, mandatory reviewer, or internal
  user continuation gate.

Do not add a second public lifecycle tool for a scheduler-internal operation. Extend the
`agent_trio` request or result contract when a public change is genuinely necessary, and version
the protocol when compatibility requires it.

## Workspaces And Recovery

Parallel writers require a clean Git repository and disjoint owned paths. Tests for workspace
changes must verify preflight, ownership enforcement, rollback, and cleanup. Never solve uncertain
writer recovery by automatically replaying a turn that may already have caused side effects.

Snapshot format changes need migration or explicit compatibility handling. Preserve atomic write,
private file mode, `fsync`, request-hash idempotency, and process-lock behavior.

## Installation

User installation is an explicit operation, never a test setup step. It may register only
`[mcp_servers.agent_trio]`; it must not select a root model or install skills, profiles, hooks, or a
global `AGENTS.md` block.

Installation changes must:

- preserve unrelated TOML, JSON, and Markdown;
- back up every legacy path before removal;
- cover install, migration, verification, and uninstall with temporary-home tests;
- never write to the real `~/.codex` during CI or local unit tests.

Pull requests should summarize the user-visible outcome, protocol or snapshot compatibility,
validation performed, benchmark impact when applicable, and rollback considerations.
