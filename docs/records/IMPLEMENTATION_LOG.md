# Implementation log

## 2026-08-20 — v0.1.0 engineering MVP

### Objective

Implement the planned Sol → Terra → Luna architecture under
`hierarchical-codex`, preserving native Codex threads while adding a coded
control plane and software-engineering documentation.

### Scope completed

- TypeScript ESM project with strict compiler, ESLint, Prettier, Vitest, and
  production build.
- MCP v2 stdio server using `@modelcontextprotocol/server`.
- SQLite schema version 2 using Node's built-in SQLite.
- Mission/task state, direct role policy, model/effort policy, dependencies,
  budgets, leases, optimistic versions, and idempotency.
- Content-addressed artifact store.
- Candidate/check/verify/commit evidence lifecycle.
- Append-only event history and recovery snapshots.
- Idempotency request hashing to reject payload-changing replays.
- Codex project configuration, Skill in both `.codex/skills` and
  `.agents/skills`, root `AGENTS.md`, four Agent profiles, and three lifecycle
  hooks.
- User-global installer that merges `~/.codex` without pinning the default model
  or vetoing ordinary subagent spawns.
- Automated domain, integration, and Python-hook tests.
- Architecture, protocol, API, Codex integration, operations, security,
  development, test, roadmap, changelog, and ADR documentation.

### Primary decisions

1. Native Codex remains the only thread creator.
2. Code enforces state and policy around model-driven spawning.
3. Task IDs correlate native threads with durable state.
4. Agent profiles pin model but omit effort for per-task routing.
5. Luna is a strict leaf.
6. SQLite and local artifacts target a trusted single-host MVP.

### Runtime assumptions

- Node >=22.5 with `node:sqlite`.
- Python 3 for hooks.
- Trusted project-scoped Codex configuration.
- Codex host supports custom agents, native subagents, MCP, and hooks.
- Actual model/effort availability must be tested against the client bundle.

### Verification record

Final local verification on Node 26.7.0 and Python 3.12.8:

- Prettier check: passed.
- ESLint with zero warnings: passed.
- Strict TypeScript typecheck: passed.
- Vitest: 4 test files, 37 tests passed.
- Production TypeScript build: passed.
- Python hook compilation: passed.
- `npm run doctor`: all 9 runtime/integration checks passed.

No live Codex App/IDE native-tree test was run; that remains an explicit
deployment compatibility gate.

### Known gaps

- No real Codex App/IDE end-to-end run has been executed in this repository yet.
- Token/cost usage is reported, not host-metered.
- No distributed/multi-tenant deployment.
- No retention/garbage collection.
- Only the v1 → v2 migration has an upgrade fixture.
- No authenticated remote MCP transport.
- No immutable attempt/spawn-ticket identity layer; native actors are workflow
  identities rather than cryptographically attested principals.

### Source references used

- OpenAI Codex Subagents documentation.
- OpenAI Codex MCP configuration documentation.
- OpenAI Codex Hooks documentation.
- Model Context Protocol TypeScript SDK v2 documentation.
- Architecture research summarized in the project planning conversation.
