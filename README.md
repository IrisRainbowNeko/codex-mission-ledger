# hierarchical-codex

`hierarchical-codex` is a deterministic MCP control plane for native Codex
subagents. Codex still creates UI-visible Sol → Terra → Luna threads with
`spawn_agent`; this project supplies the durable state, policy gates, budgets,
artifacts, evidence workflow, and recovery protocol around those threads.

Status: engineering MVP. The control plane, Codex project integration, hooks,
tests, and operating documentation are implemented. Validate model availability
and the exact Codex core version on every target App/IDE deployment.

## Design choice

The project follows one explicit route:

> Model-driven spawning; code-enforced constraints.

```text
Codex native execution plane
  spawn_agent / wait_agent / send_message / Subagents UI
                  |
                  | task_id in TaskEnvelope
                  v
TypeScript MCP control plane
  SQLite task ledger / leases / budgets / artifacts / evidence / audit
                  ^
                  |
Codex Skills + Profiles + Hooks
  orchestration policy / model-effort routing / spawn veto / stop checks
```

MCP and hooks do not create native threads. The Sol or Terra model calls native
`spawn_agent`; code validates and records the surrounding workflow.

## Implemented capabilities

- Mission and task ledgers with optimistic versions.
- Direct-parent role policy: Sol director → Terra coordinator → Luna leaf.
- Model/effort matrix:
  - Sol: `high`, `xhigh`, `max`
  - Terra: `xhigh`, `max`
  - Luna: `high`, `xhigh`, `max`
- Dependency-aware readiness and bounded child allocation.
- Expiring worker leases, heartbeats, release, and safe reclamation.
- Hierarchical token, cost, wall-time, tool-call, and child-count budgets.
- Content-addressed artifact storage with bounded reads.
- Candidate → checked → verified → committed evidence gates.
- Producer/reviewer separation.
- Request-hashed idempotent mutations and append-only audit events.
- Recovery snapshots after restart or context compaction.
- Project-scoped Codex Skill, Agent profiles, MCP configuration, and hooks.

## Requirements

- Node.js 22.5 or newer. Node 26 is used in development.
- Python 3.10 or newer for Codex lifecycle hooks.
- Codex 0.148.0 or newer is the recommended production baseline, with native
  multi-agent tools, custom agents, MCP, and hooks.
- A trusted Codex project so `.codex/config.toml` and project hooks are loaded.

## Quick start

```bash
cd "/mnt/tools/others/codes/web project/hierarchical-codex"
npm install
npm run check
npm run doctor
```

Then:

1. Open **this repository root** in Codex App, Codex CLI, or the Codex VS Code
   extension. `npm run doctor` does not install the skill into ChatGPT; the App
   must use this folder as its workspace.
2. Trust the project when prompted. Untrusted projects hide `.codex` skills.
3. Start a **new** root conversation with `gpt-5.6-sol` (skills load at startup).
4. Type `$` and select `prism`, or invoke `$prism <mission>`.
   If the picker is empty, `AGENTS.md` still instructs the root Sol.
5. Inspect native child activity in the Subagents UI and durable state through
   the MCP tools.

To use the full stack from **other folders** in the VS Code Codex extension or
CLI, run `npm run install:user` after `npm run build`. See
[docs/USER_INSTALL.md](docs/USER_INSTALL.md). Do not copy this repo's
`.codex/config.toml` into `~/.codex`; that would pin Sol as the default model
and block ordinary subagents.

The project MCP configuration launches `node dist/cli.js` with the repository
root as its working directory. Run `npm run build` after source changes.

## Development commands

```bash
npm run dev          # Run the stdio MCP server from TypeScript
npm run doctor       # Validate runtime and Codex integration files
npm run test         # Unit and integration tests
npm run typecheck    # Strict TypeScript checks
npm run lint         # ESLint
npm run format       # Prettier
npm run build        # Compile dist/
npm run check          # Full local quality gate
npm run install:user   # Install skill, agents, hooks, and MCP into ~/.codex
npm run doctor:user    # Verify the user-global install
npm run uninstall:user # Remove the managed user-global files
```

The MCP server writes protocol messages to stdout. Application logging must use
stderr; stdout logging corrupts stdio MCP transport.

## Runtime state

By default, state is project-local and ignored by Git:

```text
.hierarchical-codex/
├── control-plane.sqlite
└── artifacts/
    └── <sha-prefix>/<sha256>
```

User-global install (`npm run install:user`) stores the ledger at
`~/.local/share/hierarchical-codex/` so Codex MCP sandboxes can write it.
If that directory is not writable, the server falls back to a temp path and
logs the chosen home on stderr.

Configuration environment variables:

- `HIERARCHICAL_CODEX_HOME`
- `HIERARCHICAL_CODEX_DB`
- `HIERARCHICAL_CODEX_ARTIFACTS`
- `HIERARCHICAL_CODEX_MAX_ARTIFACT_BYTES`
- `HIERARCHICAL_CODEX_DEFAULT_LEASE_SECONDS`
- `HIERARCHICAL_CODEX_MAX_LEASE_SECONDS`
- `HIERARCHICAL_CODEX_EVENT_PAGE_SIZE`

## MCP tools

Mission:

- `mission_create`
- `mission_get`
- `mission_close`

Task and lease:

- `task_allocate`
- `task_get`
- `task_claim`
- `task_start`
- `task_heartbeat`
- `task_release`
- `task_block`
- `task_fail`
- `task_cancel`
- `task_supersede`
- `task_set_effort`
- `task_commit`

Artifacts and evidence:

- `artifact_put`
- `artifact_get`
- `result_submit_candidate`
- `result_check`
- `result_verify`

Accounting and recovery:

- `budget_report`
- `recovery_snapshot`

See [docs/API.md](docs/API.md) for contracts and [docs/PROTOCOL.md](docs/PROTOCOL.md)
for the orchestration sequence.

## Repository structure

```text
.agents/skills/             Codex orchestration Skill
.codex/agents/              Sol/Terra/Luna custom profiles
.codex/hooks/               Python policy gates
.codex/config.toml          MCP and native agent configuration
src/domain/                 State and policy definitions
src/infra/                  SQLite repository and artifact storage
src/mcp/                    MCP tool registration
tests/                      Control-plane, policy, and hook tests
docs/                       Architecture, protocol, operations, ADRs, records
```

## Important boundaries

- External MCP code cannot call the internal native `spawn_agent` registry.
- Hooks can deny, rewrite, or add context, but `SubagentStart` cannot prevent a
  subagent after creation.
- Native UI state is observational; SQLite is the durable workflow source.
- This MVP is single-host. SQLite serializes mutations but is not a distributed
  consensus system.
- Token usage is reported by agents/hosts; the MCP server cannot independently
  meter model tokens.
- The repository is currently `UNLICENSED`; add an explicit license before
  external distribution.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Protocol](docs/PROTOCOL.md)
- [MCP API](docs/API.md)
- [Codex integration](docs/CODEX_INTEGRATION.md)
- [User-global VS Code / CLI install](docs/USER_INSTALL.md)
- [Operations](docs/OPERATIONS.md)
- [Security model](docs/SECURITY.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Test strategy](docs/TESTING.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Implementation record](docs/records/IMPLEMENTATION_LOG.md)
- [Architecture decisions](docs/adr/)
