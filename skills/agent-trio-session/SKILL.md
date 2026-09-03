---
name: agent-trio-session
description: Use Agent Trio balanced routing when explicitly invoked and for related follow-ups in this conversation. Do not activate from a one-shot call, an unrelated task, or after opt-out.
---

# Agent Trio Balanced Session

Apply the same balanced route policy as `$agent-trio` with the `agent_trio` MCP runtime: root
self-completion for one bounded deliverable without independent workstreams; otherwise
`profile=balanced` with one Luna/Terra worker or a useful DAG. A direct worker must set
`strategy=direct` and `directTier` to exactly `luna` or `terra`. Use Terra for state recovery, resume/idempotency
logic, coupled debugging, review/synthesis, or one office artifact. Fanout requires independent
leaves over 30 seconds and at least 90 seconds serial work, defaults to two Luna leaves, and uses
three only for three substantial streams.

An explicit `$agent-trio-session` activates this behavior for related corrections, refinements,
extensions, continuations, and questions. Do not activate from a prior $agent-trio single-turn
call. Stop when the user opts out or switches to a clearly unrelated task.
Invoke implicitly only when this conversation previously invoked $agent-trio-session.

Pass the `agent_trio` tool arguments as flat top-level fields. Never wrap the whole argument object
in `request`, `input`, or `arguments`.

For `run` or `submit`, use only schema fields. `domain` is exactly `coding`, `algorithm`, `research`,
`paper`, `office`, `autoResearch`, or `general`; omit it when uncertain. Map current Codex labels:
read-only to `readOnly`, workspace-write to `workspaceWrite`, and danger-full-access,
unrestricted, or disabled sandboxing to `fullAccess`; map Never to `never` and Approve for me or
on-request to `approveForMe`. Never strengthen access or approval. Use `directTier`, never a
top-level `floor`. Do not send `mode` or `selectedCapabilities`. `capabilities` contains
`{kind,name,path?}` objects, and execution limit fields belong inside `limits`.

For each new foreground MCP run, generate a unique UUID-style `runId` and call `action=submit` with
`monitorFirst=true`. Only if submit succeeds and returns that same `runId`, make exactly one `action=status`
call containing only that action, the same ID, and `wait=true`. If submit returns an MCP/tool error, stop
immediately and do not call status. The MCP Apps monitor mounts while work runs; never poll. If a
prior run is `waiting_input` and the user supplies the requested input, resume that run instead.

Make each follow-up objective self-contained using only needed prior goals, facts, decisions, and
artifact paths. Pass absolute `cwd`, inferred `domain`, exact current `hostAccess` and
`hostApproval`, preserved constraints, and only explicitly selected capabilities. `risk` and
`merge` are valid only inside `semanticPlan` for `strategy=fanout`; never send either as a top-level
tool argument. Inside that plan, writer paths must be disjoint and dependency, merge, and risk
values must use the exact schema. With `strategy=direct`, omit `semanticPlan` and all plan-only
fields.

Treat successful `finalResponse` as the complete delivery. Durable jobs submit without
`monitorFirst`. On MCP failure, report the exact error and stop unless the user asks for fallback.
