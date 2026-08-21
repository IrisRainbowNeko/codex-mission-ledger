---
name: agent-trio
description: Split decomposable work through native Codex Sol→Terra→Luna subagents with the hierarchical_codex MCP ledger. Use when the user asks for hierarchical agents, parallel research or implementation, durable multi-stage work, or types $agent-trio.
---

# Agent Trio

Run a mission through native `spawn_agent` threads. Sol aims, Terra fans out, Luna does the bounded work. MCP is the source of truth.

Token mass target (host `token_count`, cache included, worker threads only): **Luna 82 · Terra 13 · Sol 5**. Coordinators must stay cheap. Do not spawn Luna from Sol. Do not spawn without a live MCP `task_id`.

## Happy path

Code rejects skipped gates. Remember only these calls:

| Who           | Required MCP / native calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol           | `mission_create` → `task_allocate` (Terra `high`) → spawn Terra → **one** `wait_agent` (`timeout_ms=3600000`) → `task_get` summary only → `mission_close`. No `artifact_get`. `result_check` / `result_verify` / `task_commit` **only** if mission `risk` is `high` or `critical`, and then from summary/claims/hashes only.                                                                                                                                                                 |
| Terra         | `task_claim`/`task_start` with `leaseSeconds=14400` → allocate+spawn Luna producers → **one** `wait_agent` (`timeout_ms=3600000`) → `children_status` once → synthesizer allocate+spawn → one `wait_agent` → `children_status` → `results_gate_and_commit` (low/medium) or verifier+separate gates (high/critical) → `artifact_put` a short summary on Terra's task → `result_submit_candidate`                                                                                            |
| Luna producer | `task_claim` → `task_start` → do the bounded work → `artifact_put` on this task → `result_submit_candidate`                                                                                                                                                                                                                                                                                                                                                                                 |
| Luna verifier | `task_get(review_target_task_id)` → truncated `artifact_get` → one `result_check`. Never claim, verify, or commit.                                                                                                                                                                                                                                                                                                                                                                          |

Do **not** also memorize heartbeat, release, fail, or recovery unless a gate fails. Heartbeat with `leaseSeconds=14400` immediately before each `wait_agent`. If the attempt is dead, call `task_fail`. After interruption, call `recovery_snapshot` and resume from the latest version.

## Coordinator bans (token furnace)

These tools re-bill the cached prefix every time they return. Do not use them as a wait loop.

- Sol: never `list_agents`, never native `wait`, never `send_message`, never `exec` `sleep`/`setTimeout`, never `sed`/`cat` SKILL.md (it is already injected). If `wait_agent` returns without a Terra `TASK_RESULT`, call `wait_agent` again with the same 1h timeout (at most 3 times), then `task_get` summary and `mission_close`.
- Terra: never `list_agents`, `wait`, `send_message`, or `followup_task`. Never poll `task_get` on children. Recover a failed leaf by spawning a replacement Luna, then one more long `wait_agent`. `wait_agent` timeout must be ≥ 1800000 ms (hook-enforced). Do not deny `exec` — this client may wrap MCP as exec JS.

## Token placement

- Sol never reads or writes workspace files, never restates the analysis, never `artifact_get`s. User-visible reply is a few lines plus the path Luna wrote.
- Terra is read-only fan-out. It does not write the user-facing file and does not copy child bodies into its own artifacts.
- Luna does every read, write, and synthesis. Spawn a `luna-producer` synthesizer whose `dependencies` are the research tasks; its objective is to write the deliverable from `input_artifact_refs`.
- Default-off `luna-verifier` when `risk` is `low` or `medium` and evidence is deterministic. Terra then calls `results_gate_and_commit` from done criteria, claims, and hashes (still writes check + verify + commit).
- High/critical or non-deterministic evidence: spawn `luna-verifier`, then Terra `result_verify` and `task_commit`. Do not use `results_gate_and_commit`.
- Do not raise Sol or Terra to `xhigh`/`max` for ordinary coordination.

## Spawn recipe

`agent_type` selects the profile; `task_name` is only a UI label (underscores, not hyphens).

- Terra: `agent_type=terra-coordinator`, `model=gpt-5.6-terra`, effort **`high`** (raise to `xhigh`/`max` only if the cell is unusually coupled). Prompt contains the allocated coordinator `task_id`.
- Luna producer: `agent_type=luna-producer`, `model=gpt-5.6-luna`, effort `high`, `xhigh`, or `max`. Allocate an operator task first. Prompt contains that allocated `task_id` and the TaskEnvelope.
- Luna synthesizer: same `luna-producer` profile. Allocate after research children; set `dependencies` to those `task_id`s; objective is write the deliverable from their artifacts.
- Luna verifier: `agent_type=luna-verifier`, `model=gpt-5.6-luna`, effort `high`. **Do not allocate a new task.** Spawn only after the producer is `candidate`, and only when risk is high/critical or evidence is non-deterministic. Prompt must contain `review_target_task_id: tsk_...` of that producer. The verifier records `result_check` and must not claim any task.
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

`artifact_put` fields are `taskId`, `actorId`, `kind`, `mimeType`, `content`, `encoding`, `idempotencyKey`. Do not send `missionId`. `result_submit_candidate.artifactRefs` must belong to the submitting task; put the report on that task first. Include actual `usage` when submitting. `summary` is at most 500 characters.

## Fan-out

Use one agent for simple sequential work. Use this skill when there are multiple coherent streams, bounded leaves, useful parallelism, or independent verification.

## Stop block

The entire final assistant message must be this block. No report, file contents, or tool dump before or after it. Parents consume IDs, not bodies.

```text
TASK_RESULT
task_id: tsk_...
status: candidate_submitted | check_approved | check_rejected | blocked | failed
artifact_refs: ids or none
unresolved: text or none
```
