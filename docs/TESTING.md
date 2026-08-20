# Test strategy

## Goals

Tests prioritize defects that would violate workflow authority or produce
unrecoverable state:

- illegal hierarchy/model/effort assignments;
- stale concurrent mutation;
- duplicate side effects;
- expired-worker submission;
- budget oversubscription;
- self-approval;
- evidence-gate bypass;
- missing artifact content;
- hook policy drift.

## Automated suites

### Domain policy

`tests/policy.test.ts`

- allowed model/effort matrix;
- role/model compatibility;
- direct parent-child edges;
- evidence-state transitions;
- forbidden transition shortcuts.

### Control-plane integration

`tests/control-plane.test.ts`

- mission idempotency;
- allocation policy;
- optimistic versions;
- lease replay, expiry, and reclamation;
- candidate/check/verify/commit workflow;
- producer/reviewer separation;
- dependency readiness after commit;
- child-budget reservation;
- actual usage enforcement;
- content-addressed artifacts and bounded reads.

Tests use real in-memory SQLite and a temporary artifact directory.

### Codex hooks

`tests/hooks.test.ts`

- compliant Sol → Terra spawn;
- Luna spawn rejection;
- invalid effort rejection;
- required V2 `fork_turns: none` and accepted V1 `fork_context: false`;
- mixed V1/V2 fork rejection;
- required task ID;
- start-context injection;
- one-time incomplete-stop continuation;
- valid terminal handoff.

Hooks run in real Python subprocesses.

## Local quality gate

```bash
npm run check
```

Order:

1. Prettier check
2. ESLint
3. TypeScript
4. Vitest
5. production build

Also run:

```bash
npm run doctor
```

## Manual MCP smoke test

1. Build the project.
2. Start a supported MCP inspector or Codex host with `.codex/config.toml`.
3. Confirm all configured tools are listed.
4. Create a mission.
5. Allocate, claim, start, and release one task.
6. Restart the MCP process.
7. Read a recovery snapshot and confirm state persisted.

Do not use ordinary stdout logging while testing stdio transport.

## Native Codex compatibility test

Perform this after every Codex App/CLI/IDE update:

1. Start a new Sol root thread.
2. Invoke `$prism`.
3. Create a Terra child at `xhigh`.
4. Have Terra create Luna children at `high`, `xhigh`, and `max`.
5. Confirm all children are visible in the native UI.
6. Confirm Luna cannot spawn.
7. Confirm invalid effort and non-`none` fork are blocked.
8. Complete one producer candidate.
9. Complete an independent verifier check.
10. Verify and commit through the direct parent.
11. Restart the client and recover from MCP state.

Record:

- client and Codex core version;
- effective model/effort where visible;
- hook payload samples with sensitive fields removed;
- pass/fail and known UI inconsistencies.

## Failure-injection backlog

High-priority future tests:

- process termination during each transaction boundary;
- artifact write succeeds but SQLite insert fails;
- SQLite insert succeeds and client loses response;
- concurrent task claims from separate processes;
- database busy timeout;
- malformed/corrupt persisted JSON;
- disk full and permission errors;
- many-page event recovery;
- migration from every supported schema version;
- real host token-meter reconciliation.

## Performance tests

The MVP targets correctness, not throughput. Before multi-project deployment,
measure:

- allocation/claim/heartbeat latency;
- write contention with maximum native concurrency;
- recovery snapshot size and latency;
- event growth per task;
- artifact deduplication ratio;
- WAL checkpoint and backup impact.

Performance changes must not weaken transaction or evidence invariants.
