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
- Terra: high/xhigh/max (default spawn `high`)
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

Optional: `constraints[]`, `budget`, `strategy` (`direct | fanout | director_plan | pipeline`, default `fanout`), `portrait` (`ambiguity`, `coupling`, `parallelism` each `low|medium|high`; `validator` `strong|weak|none`), `directorPlan` (required when `strategy` is `director_plan`: a workspace-relative `.md` path to the plan file in the project folder; must be empty otherwise). Strategy is immutable after create.

### `mission_get`

Input: `missionId`, optional `includeDetails` (default true).

Detailed output includes tasks, artifacts, claims, and reviews. The mission row
includes `strategy`, `portrait`, and `directorPlan` (relative plan file path)
even when `includeDetails` is false. Terra should use that compact read on
`director_plan` missions, then read the markdown file from the workspace.

### `mission_close`

Required:

- `missionId`
- `actorId`
- `expectedVersion`
- `idempotencyKey`

Optional `acceptFailedTasks` defaults false. All tasks must be terminal. On
`fanout`, `director_plan`, and `pipeline`, if the only non-terminal task is a
low/medium-risk root Terra coordinator in `candidate` / `checked` / `verified`,
`mission_close` records check + verify + commit (reviewer = close `actorId`)
then completes the mission. High/critical and `direct` root Lunas are not
auto-gated. A stale `expectedVersion` is retried once against the live mission
version; a second mismatch is still `conflict`.

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

Root role depends on `mission.strategy`. `fanout`, `director_plan`, and
`pipeline` require a Terra coordinator (or Sol advisor) at the root; `pipeline`
allows only one coordinator. `direct` allows one root Luna operator (or a Sol
advisor) and rejects a Terra tree. `fanout` Terra `objective` is capped at 2000
characters. Terra coordinator children must be Luna operators or verifiers.
When `parentTaskId` is set, the parent must be running and
`expectedParentVersion` plus `parentLeaseToken` are required; the allocating
actor must own that lease. A stale `expectedParentVersion` is accepted when
that lease is valid (heartbeats bump the parent without changing allocation
intent). Running siblings reserve remaining budget, not their full original
reservation, so a replacement plus synthesizer can fit after a cancelled leaf.

### `task_get`

Input: `taskId`.

Read this immediately before versioned mutations on **this** task. Coordinators
must not poll children with `task_get`; use `children_status` once after
`wait_agent`.

### `children_status`

Input: `parentTaskId`.

Returns compact direct-child rows only:

- `id`, `status`, `version`, `risk`, `summary`, `unresolved`, `artifactRefs` (ids), `producerId`, `updatedAt`, `leaseExpired`
- `allTerminal`

No artifact bodies, claim text, or event pages. Do not use `recovery_snapshot`
as a wait-loop substitute.

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

### `results_gate_and_commit`

Low/medium risk only. One call records the check review, the verify review, and
commit. Gates are not skipped: the producer still cannot approve itself, and
high/critical work must use `luna-verifier` plus `result_check` /
`result_verify` / `task_commit`.

Required:

- `reviewerId`
- `decisions[]` with `taskId`, `expectedVersion`, `approved`, `notes`, and
  optional `evidenceRefs[]`
- `idempotencyKey`

Optional `parentTaskId` asserts every decision is a direct child.

Children must already be `candidate` (or already gated). Non-terminal children
return `invalid_state`. Idempotent on the batch key.

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
