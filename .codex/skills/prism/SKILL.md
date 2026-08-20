---
name: prism
description: Split decomposable work through native Codex Sol→Terra→Luna subagents with the hierarchical_codex MCP ledger. Use when the user asks for hierarchical agents, parallel research or implementation, durable multi-stage work, or types $prism.
---

# Prism

Split a mission through native `spawn_agent` threads. Sol aims, Terra fans out, Luna does the bounded work. MCP is the source of truth.
Do not spawn Luna from Sol. Do not spawn without a live MCP `task_id`.

## Happy path

Code rejects skipped gates. Remember only these calls:

| Who           | Required MCP / native calls                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol           | `mission_create` → `task_allocate` → spawn Terra → `wait_agent` → `result_check` → `result_verify` → `task_commit` → `mission_close`                                                                                                               |
| Terra         | `task_claim` → `task_start` → allocate+spawn Luna producers → wait until `candidate` → Terra `result_check` or spawn `luna-verifier` → Terra `result_verify` → `task_commit` children → `artifact_put` on Terra's task → `result_submit_candidate` |
| Luna producer | `task_claim` → `task_start` → do the bounded work → `artifact_put` on this task → `result_submit_candidate`                                                                                                                                        |
| Luna verifier | `task_get(review_target_task_id)` → `artifact_get` → one `result_check`. Never claim, verify, or commit.                                                                                                                                           |

Do **not** also memorize heartbeat, release, fail, or recovery unless a gate fails. If a lease may expire, call `task_heartbeat`. If the attempt is dead, call `task_fail`. After interruption, call `recovery_snapshot` and resume from the latest version.

## Spawn recipe

`agent_type` selects the profile; `task_name` is only a UI label (underscores, not hyphens).

- Terra: `agent_type=terra-coordinator`, `model=gpt-5.6-terra`, effort `xhigh` or `max`. Prompt contains the allocated coordinator `task_id`.
- Luna producer: `agent_type=luna-producer`, `model=gpt-5.6-luna`, effort `high`, `xhigh`, or `max`. Allocate an operator task first. Prompt contains that allocated `task_id` and the TaskEnvelope.
- Luna verifier: `agent_type=luna-verifier`, `model=gpt-5.6-luna`, effort `high`, `xhigh`, or `max`. **Do not allocate a new task.** Spawn only after the producer is `candidate`. Prompt must contain `review_target_task_id: tsk_...` of that producer. The verifier records `result_check` and must not claim any task.
- V2: `fork_turns="none"`. V1: `fork_context=false`. Never mix.

Producer / Terra prompt envelope:

```text
mission_id / task_id / parent_task_id / objective / done_criteria
allowed_tools / budget / model / reasoning_effort / max_effort / worker_id
```

Verifier prompt envelope:

```text
review_target_task_id / expected_version / mission_id / worker_id
```

Idempotency keys: `<operation>:<task-or-mission>:<attempt>`. Reuse a key only for the exact same request.

`artifact_put` fields are `taskId`, `actorId`, `kind`, `mimeType`, `content`, `encoding`, `idempotencyKey`. Do not send `missionId`. `result_submit_candidate.artifactRefs` must belong to the submitting task; put the report on that task first. Include actual `usage` when submitting.

## Fan-out

Use one agent for simple sequential work. Use this skill when there are multiple coherent streams, bounded leaves, useful parallelism, or independent verification.

## Stop block

```text
TASK_RESULT
task_id: tsk_...
status: candidate_submitted | check_approved | check_rejected | blocked | failed
artifact_refs: ids or none
unresolved: text or none
```
