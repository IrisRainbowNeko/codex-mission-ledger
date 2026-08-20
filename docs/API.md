# MCP API

## Conventions

Every tool returns a JSON object in both MCP text content and structured content:

```json
{
  "ok": true,
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "conflict",
    "message": "Task version does not match expectedVersion.",
    "details": {}
  }
}
```

Mutations require an idempotency key. Versioned mutations reject stale writes.
Replaying a key with a different canonical request hash is a conflict.

## Shared types

### Risk

`low | medium | high | critical`

### Role

`director | coordinator | operator | verifier | advisor`

### Model

`sol | terra | luna`

### Reasoning effort

`high | xhigh | max`

Supported combinations:

- Sol: high/xhigh/max
- Terra: xhigh/max
- Luna: high/xhigh/max

### Budget

All fields are optional non-negative numbers:

```json
{
  "tokens": 10000,
  "costUsd": 20,
  "wallClockSeconds": 3600,
  "toolCalls": 200,
  "maxChildren": 4
}
```

### Usage

```json
{
  "tokens": 100,
  "costUsd": 0.1,
  "wallClockSeconds": 5,
  "toolCalls": 2
}
```

Usage values are deltas, not cumulative host readings.

## Mission tools

### `mission_create`

Creates an active mission.

Required:

- `objective`
- `successCriteria[]`
- `risk`
- `actorId`
- `idempotencyKey`

Optional: `constraints[]`, `budget`.

### `mission_get`

Input: `missionId`, optional `includeDetails` (default true).

Detailed output includes tasks, artifacts, claims, and reviews.

### `mission_close`

Required:

- `missionId`
- `actorId`
- `expectedVersion`
- `idempotencyKey`

Optional `acceptFailedTasks` defaults false. All tasks must be terminal.

## Task tools

### `task_allocate`

Creates a policy-checked task and reserves direct-owner budget.

Required:

- `missionId`
- `objective`
- `role`
- `model`
- `reasoningEffort`
- `capabilityPack`
- `doneCriteria[]`
- `risk`
- `actorId`
- `idempotencyKey`

Optional:

- `parentTaskId`
- `expectedParentVersion`
- `parentLeaseToken`
- `maxEffort`
- `dependencies[]`
- `inputArtifactRefs[]`
- `allowedTools[]`
- `outputSchema`
- `budget`

Root tasks must be coordinators or advisors. Terra coordinator children must be
Luna operators or verifiers. When `parentTaskId` is set, the parent must be
running and `expectedParentVersion` plus `parentLeaseToken` are required; the
allocating actor must own that lease.

### `task_get`

Input: `taskId`.

Read this immediately before versioned mutations.

### `task_claim`

Required:

- `taskId`
- `workerId`
- `expectedVersion`
- `idempotencyKey`

Optional `leaseSeconds`. Returns an opaque lease token.

### `task_start`

Required:

- `taskId`
- `workerId`
- `leaseToken`
- `expectedVersion`
- `idempotencyKey`

Transitions leased → running.

### `task_heartbeat`

Uses the same lease fields as `task_start`, with optional `leaseSeconds`.
Extends the lease from current server time and increments the task version.

### `task_release`

Uses lease fields plus `reason`. Clears the lease and returns the task to ready.

### `task_block`

Uses lease fields plus `reason`. Records blocked state while retaining the lease.

### `task_fail`

Uses lease fields plus `reason` and optional final usage delta. Clears the lease
and transitions the attempt to failed. Future sibling allocations count its
actual usage instead of its full reservation.

### `task_cancel`

Requires task ID, actor ID, expected version, reason, and idempotency key. A child
task additionally requires the running direct parent's current version and lease
token. Direct children must already be terminal.

### `task_supersede`

Requires a failed task and a viable sibling `replacementTaskId`. Child
supersession additionally requires direct-parent version and lease authority.
The failed task becomes superseded and records replacement linkage in audit.

### `task_set_effort`

Changes a ready, unleased task's `reasoningEffort` without changing its model or
recorded maximum. Requires task version, actor, reason, and idempotency key.
Child changes additionally require the running direct parent's version and lease
token.

### `task_commit`

Required:

- `taskId`
- `actorId`
- `expectedVersion`
- `idempotencyKey`

Requires verified status and no non-terminal direct child.

## Artifact tools

### `artifact_put`

Required:

- `taskId`
- `actorId`
- `kind`
- `mimeType`
- `content`
- `encoding`: `utf8 | base64`
- `idempotencyKey`

Optional `metadata` is a JSON object.

The current production lease owner is the only actor allowed to write production
artifacts while a lease exists. Candidate tasks without a lease may receive
review evidence.

### `artifact_get`

Required `artifactId`.

Optional:

- `encoding`: default UTF-8
- `maxBytes`: default 65,536; MCP maximum 1,000,000

Output includes metadata, content, and `truncated`.

## Result tools

### `result_submit_candidate`

Uses lease fields plus:

- `summary`
- `artifactRefs[]`
- `claims[]`
- optional `unresolved[]`
- optional usage delta

Claim fields:

- `statement`
- optional confidence in `[0, 1]`
- optional `evidenceRefs[]`
- optional primary `artifactId`

The producer lease is cleared after success.

### `result_check`

Required:

- `taskId`
- `reviewerId`
- `expectedVersion`
- `approved`
- `notes`
- `idempotencyKey`

Optional `evidenceRefs[]`.

The reviewer must differ from the producer.

### `result_verify`

Same shape as `result_check`, applied to a checked task. Approval transitions to
verified.

## Accounting and recovery

### `budget_report`

Required:

- `missionId`
- `actorId`
- `expectedMissionVersion`
- usage delta
- `idempotencyKey`

Optional task accounting requires `taskId` and `expectedTaskVersion`.

### `recovery_snapshot`

Required `missionId`.

Optional:

- `afterSequence`: default zero
- `eventLimit`: bounded by server configuration

Returns mission, tasks, artifacts, claims, reviews, and ordered event page.

## Error codes

- `not_found`: referenced entity does not exist.
- `conflict`: stale version or idempotency-key conflict.
- `invalid_state`: transition prerequisites are not met.
- `policy_violation`: hierarchy/model/effort assignment is forbidden.
- `budget_exceeded`: reservation or usage exceeds a hard limit.
- `lease_conflict`: lease owner, token, or expiry is invalid.
- `forbidden`: actor is not allowed to perform the action, or control-plane SQLite is not writable (for example a Codex sandbox mounted `~/.codex` read-only).
- `validation_error`: malformed or inconsistent input.
- `internal_error`: unexpected server failure; details are logged to stderr.
