# Roadmap

## Phase 1: Native-tree MVP

Status: implemented in v0.1.0.

- Project-scoped Skill and profiles.
- Native Sol → Terra → Luna protocol.
- Local MCP control plane.
- State, leases, budgets, artifacts, evidence, audit.
- Hook guardrails.
- Automated tests and operating docs.

Exit criteria still pending:

- complete one real App native hierarchy;
- complete one real VS Code native hierarchy;
- record client/core/model compatibility.

## Phase 2: Operational hardening

- Structured stderr logs and OpenTelemetry.
- Online backup command and integrity checker.
- Artifact manifest validation and garbage-collection policy.
- SQLite migration fixtures and corruption recovery tests.
- Host-derived model/token/cost reconciliation.
- Mission-level cancellation and bulk descendant cancellation.
- Risk-based human approval records.
- Immutable execution-attempt records and single-use scoped spawn tickets.
- Integer-unit append-only budget/reservation ledger.
- Stronger SQLite `STRICT`/`CHECK` constraints and optional audit hash chaining.

## Phase 3: Adaptive routing

Status: first slice implemented (locked `mission.strategy` on create).

- Task-profile classifier for coupling, ambiguity, risk, and validator strength.
  Sol emits `MISSION_ROUTE`; the kernel stores `strategy`, `portrait`, and a
  workspace-relative `directorPlan` path and forbids the other topologies.
- Historical success/cost/latency metrics by capability pack.
- Data-driven model × effort selection.
- Fan-out limits based on expected utility.
- Stall detection and recovery recommendations.
- Benchmarks against Luna-only, Terra-only, Sol-only, and fixed hierarchy.

Quality targets must be defined on a representative cross-domain evaluation set,
not inferred from one software task.

## Phase 4: Capability packs

- Research and citation pack.
- Software engineering pack.
- Scientific/HPC experiment pack.
- Data/office pack.
- Writing/creative continuity pack.

Each pack must define:

- instructions;
- allowed tools;
- artifact schemas;
- validators;
- risk policy;
- benchmark tasks.

## Phase 5: Multi-host service

Only pursue when single-host limits are measured.

- Authenticated remote MCP transport.
- Service identities and authorization.
- Transactional network database.
- Shared object storage.
- Distributed lease fencing.
- Tenant quotas and encrypted backups.
- Durable external-workflow scheduler.

This phase does not imply that external workers can become first-class native
Codex UI children. That remains a separate Codex client capability.
