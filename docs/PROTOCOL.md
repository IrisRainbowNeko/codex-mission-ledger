# Orchestration protocol

## Scope

This protocol connects native Codex threads to the deterministic MCP control
plane. The native thread tree remains owned by Codex; the logical mission/task
state remains owned by the control plane.

## Identifiers

- Mission: `mis_<opaque>`
- Task: `tsk_<opaque>`
- Lease: `lease_<opaque>`
- Artifact: `art_<opaque>`
- Claim: `clm_<opaque>`
- Review: `rev_<opaque>`

Never infer hierarchy from an ID. Use `parentTaskId` and the native Codex tree.

## Actor IDs

Use a stable ID for one logical attempt:

- `sol-root`
- `terra:<task_id>:<attempt>`
- `luna:<task_id>:<attempt>`
- `verifier:<target_task_id>:<attempt>`

If Codex exposes a stable native agent path, it may be recorded in the actor ID
or audit payload. It is observational metadata, not the task primary key.

## Idempotency keys

Every mutation requires a key of 8–200 characters.

Recommended format:

```text
<operation>:<mission-or-task-id>:<attempt-or-purpose>
```

Examples:

```text
mission_create:user-request-42:1
task_allocate:mis_abcd:research-cell
task_claim:tsk_abcd:luna-attempt-1
artifact_put:tsk_abcd:primary-report
result_check:tsk_abcd:independent-check-1
```

Reuse a key only to replay the exact same logical mutation after uncertain
delivery. A key used for another operation or a different canonical request
payload is rejected.

## Mission creation

Sol creates the mission before native child spawning:

```json
{
  "objective": "Deliver the requested system",
  "constraints": ["Preserve native Codex UI"],
  "successCriteria": ["Tests pass", "Artifacts are documented"],
  "risk": "high",
  "budget": {
    "tokens": 100000,
    "costUsd": 100,
    "wallClockSeconds": 14400,
    "toolCalls": 2000,
    "maxChildren": 4
  },
  "actorId": "sol-root",
  "idempotencyKey": "mission_create:user-request-42:1",
  "strategy": "fanout",
  "portrait": {
    "ambiguity": "low",
    "coupling": "low",
    "parallelism": "high",
    "validator": "strong"
  }
}
```

The returned mission version is required for budget updates. `mission_close`
retries a stale `expectedVersion` once. On Terra-path strategies it also
auto-finalizes one low/medium root coordinator that is already a candidate
with all descendants terminal, so Sol does not call `results_gate_and_commit`.
`strategy` is immutable. Omit it to default `fanout`. `director_plan` requires
`directorPlan` to be a workspace-relative markdown path (for example
`director-plan.md`). Sol writes the 750–8000 character plan body into that
project file before `mission_create`. Other strategies must leave `directorPlan`
empty.

Sol's first action is a no-tool `MISSION_ROUTE` (strategy + portrait + one-line
reason), then `mission_create` with those fields, then only that strategy's
call list.

## Allocate before spawn

For a Terra producer (`fanout`, `director_plan`, `pipeline`):

1. Sol calls `task_allocate` with no parent task (`role=coordinator`).
2. The control plane validates role/model/effort, strategy root policy, and budget.
3. Sol places the returned `task_id` in a complete TaskEnvelope.
4. Sol calls native `spawn_agent`.

For a Luna producer under Terra:

1. Terra claims and starts its coordinator task.
2. Terra calls `task_allocate` with its coordinator task as parent, current
   parent version, and parent lease token.
3. Terra uses `role=operator`, `model=luna`, and an explicit effort.
4. Terra calls native `spawn_agent` with `luna-producer`.

For `direct`, Sol allocates one root Luna (`parentTaskId=null`) instead of Terra.
The spawn hook allows Sol→`luna-producer` only when the ledger row is that
root operator on a `direct` mission.

Never spawn first and invent a task ID afterward. The allocation is the durable
intent and the native spawn is its execution attempt.

## TaskEnvelope

```text
mission_id: mis_...
task_id: tsk_...
parent_task_id: tsk_... | null
objective: ...
input_artifact_refs: [...]
dependencies: [...]
constraints: [...]
allowed_tools: [...]
done_criteria: [...]
output_schema: ...
risk: low | medium | high | critical
budget: ...
model: sol | terra | luna
reasoning_effort: high | xhigh | max
max_effort: high | xhigh | max
worker_id: ...
```

Do not include the full parent transcript. Include only the inputs necessary to
complete and verify the task.

## Native spawn requirements

- Use the configured custom profile.
- Pass the profile's model explicitly.
- Pass a supported reasoning effort explicitly.
- Disable context inheritance with `fork_turns: "none"` in the V2 schema or
  `fork_context: false` in the V1 schema. Never send both.
- Include a `tsk_...` ID in the child prompt.

The PreToolUse hook rejects spawns that violate these conditions.

A second PreToolUse hook (`pre_coordinator_tools.py`) denies Terra
`wait` / `list_agents` / `send_message` / `followup_task` and Terra
`wait_agent` with `timeout_ms` below 1800000. Sol is not denied (it is the root
chat). Missing `model` fails open.

## Lease lifecycle

Before execution:

1. `task_get`
2. `task_claim(expectedVersion)`
3. `task_start(expectedVersion, leaseToken)`

All lease-bound mutations use the current worker ID, token, and task version.

Terra claim/start/pre-wait heartbeat must pass `leaseSeconds=14400` (the default
maximum). A blocking `wait_agent` cannot heartbeat; a 15-minute default lease
will expire mid-wait.

Use `task_heartbeat` immediately before `wait_agent`. A heartbeat is a mutation
and increments the task version.

If blocked:

- `task_block` parks the task on an external job or a true blocker, records the
  reason, and **clears the lease** so the Codex thread can exit;
- put the run handle (host, session/pid, log, resume command) in an artifact
  first;
- do not hold an SSH/train `exec` open for hours hoping to heartbeat;
- another worker resumes with `task_claim` on the parked `blocked` row.

`wait_agent` is only for a native child thread to park or finish. It is not a
handle on a GPU job. Overnight work stays `blocked` on the ledger; the user
says 继续, Sol/Terra claim the same `task_id`, and a Luna attaches to the run.

If the attempt definitively fails, the lease owner calls `task_fail` with the
final usage and reason. The direct parent may allocate a viable sibling
replacement and then call `task_supersede` on the failed task. Abandoned
**running** work must be closed with `task_cancel`; parked `blocked` jobs must
not be cancelled just because the Codex thread ended. Child cancellation and
supersession require direct-parent lease authority.

After expiry, another worker may reclaim the task. The old token is fenced out.

## Artifact protocol

Call `artifact_put` with UTF-8 or canonical base64 content. The server:

1. enforces the configured size limit;
2. hashes the bytes with SHA-256;
3. writes an immutable content object atomically;
4. records task-scoped metadata;
5. returns an artifact ID.

Messages must be a compact `TASK_RESULT` block: artifact IDs and a summary of
at most 500 characters. Do not paste reports into `wait_agent`; parents re-bill
that prefix on every later turn. `artifact_get` returns a bounded prefix and a
`truncated` flag. Sol and Terra must not fetch full artifacts; a Luna
synthesizer reads child refs and writes the user-facing file.

The MVP does not register arbitrary filesystem paths, preventing path traversal
and host-file exfiltration through this API.

## Candidate submission

The active producer calls `result_submit_candidate` with:

- summary (max 500 characters);
- artifact references owned by the task;
- claims and evidence references;
- unresolved items;
- actual usage.

The mutation:

- enforces lease ownership;
- atomically charges task and mission budgets;
- creates candidate claims;
- clears the producer lease;
- transitions the task to `candidate`.

## Check, verify, commit

### Check

An actor different from the producer calls `result_check`.

- Approval: `candidate → checked`
- Rejection: `candidate → ready`

The checker should use deterministic validators or primary evidence.

### Verify

The direct parent calls `result_verify`.

- Approval: `checked → verified`
- Rejection: `checked → ready`

### Commit

The direct parent calls `task_commit`.

- The task must be `verified`.
- Every direct child must be terminal.
- The task becomes `committed`.
- Proposed dependent tasks whose dependencies are now satisfied become `ready`.

No single MCP round-trip is required for high/critical work. For `low` or
`medium` risk, Terra (or Sol on a `direct` mission) may call
`results_gate_and_commit` after the candidate is in. That tool still writes
check and verify reviews and then commits; it does not skip the
producer≠reviewer rule.

## Verifier native threads

A `luna-verifier` receives `review_target_task_id` and its expected version. Do
not allocate a separate verifier task. Spawn the verifier only after the
producer is `candidate`. The verifier does not claim any task; it records a
review through `result_check`. Terra then calls `result_verify` and
`task_commit`.

## Direct-parent lifecycle

- Sol waits for and accepts its child (Terra, or the root Luna on `direct`)
  with one long `wait_agent`. It must not poll with `list_agents`, `wait`, or
  `send_message`. After a timeout it calls `children_status` once. It may
  retry `wait_agent` once if a child is still live; expired-lease **running**
  tasks are cancelled instead of waited on again. Parked `blocked` jobs are
  left on the ledger. On Terra paths Sol then `task_get`s the summary and
  `mission_close`s only when nothing is blocked. `mission_close` cancels
  stalled leased/running tasks whose lease has expired; it does not cancel
  `blocked` tasks.
- Terra waits for the research batch with one long `wait_agent`, then the
  synthesizer with one more. It must not `wait_agent` per spawn, `send_message`,
  or `followup_task`. VS Code cell yield (`wait` with `cell_id` + `max_tokens`)
  is not a poll.
- On Terra paths, Sol may observe Luna in the UI, but does not perform Luna
  follow-up or wait lifecycle except `direct`.
- Cross-cell data moves through committed artifacts and dependencies.

This avoids completion routing ambiguity in deep native trees.

## Effort escalation

The assigned effort and maximum effort are recorded in the task.

Escalation requires:

1. concrete new evidence that current effort is insufficient;
2. direct-parent approval;
3. `task_set_effort` while the task is ready and unleased;
4. a new native attempt with the recorded effort;
5. budget availability;
6. an audit event through the corresponding mutation.

Do not use `max` as a generic retry. Change scope or tools when those caused the
failure.

## Terminal child message

The SubagentStop hook requires:

```text
TASK_RESULT
task_id: tsk_...
status: candidate_submitted | check_approved | check_rejected | blocked | failed
artifact_refs: art_... | none
unresolved: ... | none
```

This block is a native-message handoff. The parent must still inspect MCP state.

## Recovery protocol

1. Call `recovery_snapshot`.
2. Use event sequence pagination when necessary.
3. Compare task leases with native live agents.
4. Wait for active unexpired owners.
5. Reclaim expired leases using the latest version.
6. Replay exact uncertain operations with the original idempotency key.
7. Use a new key for a changed strategy.

Chat transcript recovery is advisory. Do not parse transcripts as a stable
control-plane interface.
