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
  "idempotencyKey": "mission_create:user-request-42:1"
}
```

The returned mission version is required for budget updates and closure.

## Allocate before spawn

For a Terra producer:

1. Sol calls `task_allocate` with no parent task.
2. The control plane validates role/model/effort and reserves budget.
3. Sol places the returned `task_id` in a complete TaskEnvelope.
4. Sol calls native `spawn_agent`.

For a Luna producer:

1. Terra claims and starts its coordinator task.
2. Terra calls `task_allocate` with its coordinator task as parent, current
   parent version, and parent lease token.
3. Terra uses `role=operator`, `model=luna`, and an explicit effort.
4. Terra calls native `spawn_agent` with `luna-producer`.

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

## Lease lifecycle

Before execution:

1. `task_get`
2. `task_claim(expectedVersion)`
3. `task_start(expectedVersion, leaseToken)`

All lease-bound mutations use the current worker ID, token, and task version.

Use `task_heartbeat` during long operations. A heartbeat is a mutation and
increments the task version.

If blocked:

- `task_block` records the reason while retaining the lease;
- continue heartbeats if the same worker should resume;
- otherwise call `task_release`, which clears the lease and returns the task to
  `ready`.

If the attempt definitively fails, the lease owner calls `task_fail` with the
final usage and reason. The direct parent may allocate a viable sibling
replacement and then call `task_supersede` on the failed task. Abandoned
non-terminal work must be closed with `task_cancel`; child cancellation and
supersession require direct-parent lease authority.

After expiry, another worker may reclaim the task. The old token is fenced out.

## Artifact protocol

Call `artifact_put` with UTF-8 or canonical base64 content. The server:

1. enforces the configured size limit;
2. hashes the bytes with SHA-256;
3. writes an immutable content object atomically;
4. records task-scoped metadata;
5. returns an artifact ID.

Messages should contain artifact IDs and concise summaries. `artifact_get`
returns a bounded prefix and a `truncated` flag.

The MVP does not register arbitrary filesystem paths, preventing path traversal
and host-file exfiltration through this API.

## Candidate submission

The active producer calls `result_submit_candidate` with:

- summary;
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

No single operation skips candidate/check/verify gates.

## Verifier native threads

A `luna-verifier` receives `review_target_task_id` and its expected version. Do
not allocate a separate verifier task. Spawn the verifier only after the
producer is `candidate`. The verifier does not claim any task; it records a
review through `result_check`. Terra then calls `result_verify` and
`task_commit`.

## Direct-parent lifecycle

- Sol waits for and accepts Terra.
- Terra waits for and accepts its own Luna children.
- Sol may observe or send a hint to Luna, but does not perform Luna follow-up or
  wait lifecycle.
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
