---
name: agent-trio
description: Split decomposable work through native Codex Sol→Terra→Luna subagents with the hierarchical_codex MCP ledger. Use when the user asks for hierarchical agents, parallel research or implementation, durable multi-stage work, or types $agent-trio.
---

# Agent Trio

Run a mission through native `spawn_agent` threads. MCP is the source of truth. Strategy is locked on `mission_create`. Do not spawn without a live MCP `task_id`. Do not babysit.

Token mass target for **`fanout` only** (host `token_count`, cache included, worker threads only): **Luna 82 · Terra 13 · Sol 5**.

## Turn 1: no tools

Emit only this block, then stop that turn:

```text
MISSION_ROUTE
strategy: direct | fanout | director_plan | pipeline
ambiguity: low|medium|high
coupling: low|medium|high
parallelism: low|medium|high
validator: strong|weak|none
reason: one line
```

Pick from the portrait, not from habit:

| Portrait                                                                          | Strategy                      |
| --------------------------------------------------------------------------------- | ----------------------------- |
| Low ambiguity, low coupling, sequential, strong validator                         | `direct`                      |
| High parallelism, low coupling, decomposable                                      | `fanout` (default if omitted) |
| High coupling or strict stage order                                               | `pipeline`                    |
| High ambiguity, weak/none validator, or an architecture/tradeoff plan is required | `director_plan`               |

Then write the `director_plan` markdown file if that is the strategy. Then `mission_create` with the portrait fields and, for `director_plan`, the relative file path in `directorPlan`. Strategy is immutable. Follow **only** that strategy's call list.

## Happy paths

Code rejects skipped gates. Coordinator bans are identical on every path.

### `direct`

Skip Terra. Sol allocates **one** root Luna.

| Who           | Required calls                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol           | `mission_create` (`strategy=direct`) → `task_allocate` (Luna `operator`, `parentTaskId=null`, `high`) → spawn `luna-producer` → **one** `wait_agent` (`timeout_ms=3600000`) → `results_gate_and_commit` as Sol (low/medium) or spawn `luna-verifier` then `result_verify`/`task_commit` (high/critical) → `mission_close`. No Terra. No `artifact_get`. |
| Luna producer | `task_claim` → `task_start` → do the work → `artifact_put` → `result_submit_candidate`                                                                                                                                                                                                                                                                  |

### `fanout` (default)

Thin Sol. One Terra fans out.

| Who           | Required calls                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol           | `mission_create` → `task_allocate` (Terra `high`, objective ≤ 2000 chars) → spawn Terra → **one** `wait_agent` (`timeout_ms=3600000`) → `task_get` summary only → `mission_close`. No `artifact_get`. No `results_gate_and_commit` — close auto-finalizes a low/medium root Terra candidate.                                                                                                                        |
| Terra         | `task_claim`/`task_start` with `leaseSeconds=14400` → allocate+spawn the **research batch**, then **one** `wait_agent` (`timeout_ms=3600000`) — do not wait per spawn → `children_status` once → synthesizer allocate+spawn → **one** `wait_agent` → `children_status` → `results_gate_and_commit` (low/medium) or verifier+separate gates (high/critical) → short Terra `artifact_put` → `result_submit_candidate` |
| Luna producer | `task_claim` → `task_start` → do the bounded work → `artifact_put` on this task → `result_submit_candidate`                                                                                                                                                                                                                                                                                                         |
| Luna verifier | `task_get(review_target_task_id)` → truncated `artifact_get` → one `result_check`. Never claim, verify, or commit.                                                                                                                                                                                                                                                                                                  |

If Terra returns `blocked`, Sol stops and tells the user to **继续**. Do not `mission_close`.

### `director_plan`

Sol writes a **bounded** plan as a markdown file in the project folder (default `director-plan.md`, 750–8000 characters). Then `mission_create` with `directorPlan` set to that relative path. Do not paste the plan into MCP or into Terra `objective`. No child `artifact_get`, no babysit. Then the Terra path from `fanout`. Terra calls `mission_get` with `includeDetails=false`, reads the file at `directorPlan`, and follows it. Luna also reads that file. This is the only Sol workspace write.

### `pipeline`

Sol allocates **one** Terra, same wait/close as `fanout`. Terra allocates Luna stages with `dependencies` so work is serial, then a synthesizer. Same gate rules. Same coordinator bans. If a stage is a long job, Luna parks it (`task_block`); Terra parks too and returns `blocked` — Sol must **not** `mission_close` and must **not** wait overnight.

## Long jobs and long chats

Training, remote eval, multi-hour downloads, and overnight pipelines are **external jobs**. The ledger outlives the Codex thread. Do not keep `wait_agent` open across a GPU run.

- Luna: never hold one `exec`/SSH open for more than about 10 minutes. Start the job detached (`tmux`/`nohup`/`sbatch` on POSIX; `Start-Process`/`Start-Job`/`schtasks` on Windows, or WSL `tmux`), `artifact_put` a short run handle (host, session/pid, log path, resume command), then `task_block` and `TASK_RESULT` `status: blocked`. Heartbeat is not a substitute for a 4-hour exec.
- Terra: `wait_agent` only until Luna parks or finishes that short setup. If `children_status` shows `blocked`, `task_block` this coordinator with the child ids, `TASK_RESULT` `blocked`. Do not wait_agent for the GPU job. Do not `result_submit_candidate` while children are blocked.
- Sol: after `blocked`, stop. Last message is a few lines plus `mission_id` / `task_id` and that the user can say **继续**. Do not `mission_close`. Do not `wait_agent` again for that job.
- **继续** / after compaction: `recovery_snapshot` or `mission_get`, then spawn against the **same** parked `task_id`. Claim the blocked task, attach to the run handle, harvest or `task_block` again. Do not `mission_create` a duplicate. The chat may be long; the transcript is not the source of truth.

Do **not** also memorize heartbeat, release, fail, or recovery unless a gate fails. Heartbeat with `leaseSeconds=14400` immediately before each `wait_agent`. If the attempt is dead, call `task_fail`. After interruption, call `recovery_snapshot` and resume from the latest version.

## Coordinator bans (token furnace)

These tools re-bill the cached prefix every time they return. Do not use them as a wait loop.

- Sol: never `list_agents`, never native `wait` (including guessed `cell_id`s), never `send_message`, never `exec` `sleep`/`setTimeout`, never `sed`/`cat` SKILL.md. One `wait_agent` (`timeout_ms=3600000`). If it returns without `TASK_RESULT`, call `children_status` on the root Terra (or `task_get` on a `direct` Luna). Terminal or `candidate` → `mission_close`. Any `blocked` child → stop and tell the user to **继续** later. Still running and `leaseExpired=false` → **one** more `wait_agent` only. `leaseExpired` or a second timeout → `task_cancel` the stalled **running** tasks (never parked `blocked` jobs) and `mission_close` only if nothing is blocked. Never wait 1h three times.
- Terra: never `list_agents`, `send_message`, or `followup_task`. Never poll `task_get` on children. After `wait_agent` timeout, `children_status` once. Retry `wait_agent` only if a child is running and not `leaseExpired`. Recover a failed or expired leaf with one replacement Luna, then one more long `wait_agent`. `wait_agent` timeout must be ≥ 1800000 ms (hook-enforced). VS Code cell yield (`wait` with a real `cell_id` + `max_tokens`) is allowed; guessed cell ids and timeout-style `wait` are not. Do not deny `exec` — this client may wrap MCP as exec JS.

## Token placement

- Sol never restates the analysis and never `artifact_get`s. Sol's last user-visible message is a few lines plus IDs **and the path Luna wrote** when a file exists — not a `TASK_RESULT` block alone. The only Sol workspace write is the `director_plan` markdown file in the project folder.
- Terra is read-only coordination. It does not write the user-facing file and does not copy child bodies into its own artifacts.
- Luna does every read, write, and synthesis. On Terra paths, spawn a `luna-producer` synthesizer whose `dependencies` are the research tasks; its objective is to write the deliverable from `input_artifact_refs`.
- Default mission `risk` is `medium`. Use `high`/`critical` only when the user asks to destroy data, leak credentials, or change production they did not already authorize. Git/GitHub rename, commit, and push the user already authorized in this thread are `medium`. Do not submit a candidate that leaves those steps as "pending authorization".
- Default-off `luna-verifier` when `risk` is `low` or `medium` and evidence is deterministic. Then `results_gate_and_commit` from done criteria, claims, and hashes (still writes check + verify + commit). On `direct`, Sol is the reviewer and must not be the Luna producer.
- High/critical or non-deterministic evidence: spawn `luna-verifier` for the **last** mutating producer only, then parent `result_verify` and `task_commit`. Do not use `results_gate_and_commit`. Do not verifier-gate every pipeline stage.
- Do not raise Sol or Terra to `xhigh`/`max` for ordinary coordination.

## Spawn recipe

`agent_type` selects the profile; `task_name` is only a UI label (underscores, not hyphens).

- Terra: `agent_type=terra-coordinator`, `model=gpt-5.6-terra`, effort **`high`**. Prompt contains the allocated coordinator `task_id`.
- Luna producer: `agent_type=luna-producer`, `model=gpt-5.6-luna`, effort `high`, `xhigh`, or `max`. Allocate an operator task first. Prompt contains that allocated `task_id` and the TaskEnvelope. Sol may spawn this **only** when `mission.strategy` is `direct` and the `task_id` is that root operator.
- Luna synthesizer: same `luna-producer` profile under Terra. Allocate after research children; set `dependencies` to those `task_id`s.
- Luna verifier: `agent_type=luna-verifier`, `model=gpt-5.6-luna`, effort `high`. **Do not allocate a new task.** Spawn only after the producer is `candidate`, and only when risk is high/critical or evidence is non-deterministic. Prompt must contain `review_target_task_id: tsk_...` of that producer.
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

Use `direct` for one sequential leaf with a strong validator. Use `fanout` when there are multiple coherent streams. Use `pipeline` when stages must be ordered. Use `director_plan` when Sol must write a bounded plan file in the project before Terra/Luna execute.

## Stop block

Terra and Luna: the entire final assistant message must be this block. No report, file contents, or tool dump before or after it. Parents consume IDs, not bodies. Sol may put a few lines and the Luna file path above the same block.

```text
TASK_RESULT
task_id: tsk_...
status: candidate_submitted | check_approved | check_rejected | blocked | failed
artifact_refs: ids or none
unresolved: text or none
```
