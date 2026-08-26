# Architecture

## Context

The system must preserve native Codex subagent threads and UI while adding
controls that language-model prompts cannot reliably enforce: durable state,
concurrency, idempotency, budgets, evidence gates, and recovery.

The chosen split is:

- Codex native tools are the execution plane.
- The TypeScript MCP server is the deterministic control plane.
- Skills and Agent profiles are the policy plane.
- Hooks are synchronous guardrails around model actions.

## Component view

```text
User
  |
  v
Sol root thread ---------------------------------------+
  | native spawn_agent / wait_agent                    |
  v                                                    |
Terra coordinator threads                              |
  | native spawn_agent / wait_agent                    | Codex native tree
  v                                                    |
Luna producer/verifier leaf threads -------------------+
  |
  | MCP tool calls carrying mission_id/task_id/version/lease
  v
Mission Ledger for Codex MCP server
  |
  +-- ControlPlane service
  |    +-- state-transition policy
  |    +-- role/model/effort policy
  |    +-- lease and optimistic concurrency policy
  |    +-- budget and evidence policy
  |
  +-- SQLite Repository
  |    +-- missions / tasks / reviews / claims
  |    +-- audit events / idempotency records
  |
  +-- Content-addressed ArtifactStore
       +-- SHA-256 object paths
       +-- bounded writes and reads
```

Codex App, CLI, and VS Code use the project MCP configuration. The control plane
does not need to know how the UI renders a thread.

## Stable responsibility layers

### Sol director

- Emits a no-tool `MISSION_ROUTE`, then locks `mission.strategy` on create.
- Converts the user request into a mission contract.
- Allocates total risk and budget.
- On `fanout` / `director_plan` / `pipeline`, creates Terra cells.
- On `direct`, allocates one root Luna and reviews it (not as producer).
- Writes one bounded markdown plan in the project folder when strategy is
  `director_plan`, and stores that relative path on the mission.
- Resolves cross-cell conflict and performs final acceptance.
- Does not babysit children with `list_agents` / `wait` / `send_message`.

### Terra coordinator

- Owns one integration boundary.
- Builds its local task DAG.
- Allocates and waits for direct Luna children.
- Curates minimum context and tool permissions.
- Integrates committed artifacts.
- Replans or escalates bounded failures.

### Luna producer/verifier

- Operates on one bounded leaf or one independent review.
- Uses tools heavily and reports artifacts/evidence.
- Cannot create children.
- Cannot approve its own output.

### Deterministic control plane

- Owns facts about task state, leases, versions, budgets, artifacts, and audit.
- Rejects invalid transitions regardless of model instructions.
- Does not decide mission semantics or create Codex threads.

## Three graphs

The architecture intentionally separates three relationships.

### Authority tree

Defines lifecycle ownership:

```text
Sol
└── Terra
    └── Luna
```

Only the direct native parent waits, retries, verifies, and commits its child.

### Task DAG

Defines data/work dependencies. It may cross sibling ordering boundaries through
committed artifact references, but it never changes authority ownership.

### Evidence graph

Claims reference artifacts and validation evidence. Claim status progresses
independently of chat messages.

Conflating these graphs causes cross-layer completion bugs and unclear
accountability.

## Communication channels

### Native command channel

`spawn_agent`, `wait_agent`, and direct child completion. Terra coordinators
must not `send_message` or `followup_task`; recovery is a replacement spawn.
This channel controls thread lifecycle and is visible in Codex.

### Evidence blackboard

MCP artifacts, claims, reviews, task status, and dependencies. It shares
structured facts without copying full transcripts.

### Append-only audit

SQLite events record mutations, actor identity, payload, idempotency key, and
time. Recovery consumes this channel; it is not automatically injected into
model context.

## Persistence model

SQLite uses:

- foreign keys;
- write-ahead logging when available;
- `BEGIN IMMEDIATE` transactions;
- optimistic entity versions;
- unique idempotency records bound to canonical request hashes;
- a partial unique index on event idempotency keys.

The content store writes immutable SHA-256 objects atomically. SQLite stores
metadata and references, not artifact bodies.

Primary records:

- `missions`: objective, success criteria, risk, total budget and usage.
- `tasks`: hierarchy, assignment, dependencies, lease, state, budget and usage.
- `artifacts`: immutable content metadata.
- `claims`: evidence-linked assertions and validation status.
- `reviews`: independent check/verify decisions.
- `events`: ordered audit history.
- `idempotency`: successful mutation responses for exact replay.

## State machine

```text
proposed ──dependencies satisfied──> ready
ready ──claim──> leased ──start──> running
running ──submit──> candidate
candidate ──independent check──> checked
checked ──parent verification──> verified
verified ──commit──> committed
```

Supporting transitions:

- running/leased → blocked to park an external job (training, remote eval); the
  lease is cleared so the Codex thread can exit;
- blocked → leased to resume the same `task_id`;
- leased/running/blocked → ready for release or rejected rework;
- ready/leased/running/blocked → failed or cancelled;
- failed → superseded;
- candidate/checked → ready after rejection.

`committed`, `cancelled`, and `superseded` are terminal. A parent cannot commit
while a direct child is non-terminal.

## Concurrency model

Every mutation that depends on prior state carries `expectedVersion`.

Worker execution additionally requires:

- worker ID;
- opaque lease token;
- unexpired lease timestamp.

Allocating a child also requires the running parent's current version and lease
token, preventing another actor from consuming its child budget.

An expired lease can be reclaimed with the latest task version. A stale worker
cannot submit because the token and version no longer match.

Idempotency protects retried mutations, not arbitrary semantic duplicates. The
same key must be reused only for the exact same operation.

## Token placement

Host `token_count` (cached input included) is the cost signal. Target worker
share is Luna 82 · Terra 13 · Sol 5. Coordinators spawn and gate; Luna reads,
writes, and synthesizes. Child finals are `TASK_RESULT` IDs so `wait_agent`
does not re-inject reports into Sol/Terra transcripts. Guardian approval
threads are host overhead and are reported separately from Luna 82.

## Budget model

Mission budget constrains root tasks. Each task budget constrains its direct
children and its own actual usage.

Tracked dimensions:

- tokens;
- USD cost;
- wall-clock seconds;
- tool calls;
- maximum direct children.

Sibling reservations cannot exceed the direct owner's budget. Reported usage
updates task and mission totals atomically.

Active children reserve their configured budgets. After a child becomes
terminal, allocation accounting uses its actual usage instead of its full
reservation. Mission accounting avoids double-counting active-task usage by
reserving only each active root task's remaining budget.

The control plane validates reported data but cannot independently meter Codex
tokens. Host-side metering is a future integration.

## Evidence model

The producer records candidate claims. A different actor performs `result_check`.
The direct parent performs `result_verify` and `task_commit`.

The service enforces producer/reviewer separation. It does not claim that two
model identities are statistically independent; deterministic tools and primary
sources remain preferred.

## Failure and recovery

After interruption:

1. Read `recovery_snapshot`.
2. Reconcile current native agents with task leases.
3. Reclaim only expired leases.
4. Replay exact uncertain mutations with their original idempotency keys.
5. Create a new attempt/key when strategy changes.

Recovery escalation:

1. Correct with new evidence.
2. Independent Luna attempt.
3. Terra changes decomposition or tools.
4. Raise effort within the task maximum.
5. Ask Sol for a bounded decision.
6. Require human approval for unresolved irreversible risk.

## Scalability boundary

This implementation is intentionally single-host:

- SQLite serializes writers.
- Artifacts are on one local filesystem.
- Native Codex threads are owned by one Codex host.

A distributed version would require a transactional database, shared object
storage, lease fencing across hosts, authenticated service identity, and an
explicit consistency model. Replacing SQLite alone is insufficient.
