---
name: agent-trio-quality-session
description: Use Agent Trio quality-first V3.3 behavior when explicitly invoked and for related follow-ups. Always delegate; do not activate from another skill or unrelated work.
---

# Agent Trio Quality Session

Always delegate through the `agent_trio` MCP runtime with `profile=quality`. Preserve V3.3 routing:
one Luna/Terra worker for tightly coupled work or 2-5 useful leaves over 15 seconds, normally two
Luna leaves, with at most one Sol specialist. Root Sol does not complete the task itself.

An explicit `$agent-trio-quality-session` activates this policy for related follow-ups in the same
conversation. It does not activate from any other Agent Trio skill. Stop after opt-out or a clearly
unrelated task.

Pass the `agent_trio` tool arguments as flat top-level fields. Never wrap the whole argument object
in `request`, `input`, or `arguments`.

For each new foreground run, generate a UUID-style `runId` and call `action=submit` with
`monitorFirst=true`. Only if submit succeeds and returns that same `runId`, make exactly one `action=status`
call with that ID and `wait=true`. If submit returns an MCP/tool error, stop
immediately and do not call status. The MCP Apps monitor mounts while work runs; do not poll. Resume
an existing `waiting_input` run when the user supplies its requested input.

Make follow-up objectives self-contained with only relevant prior facts and artifact paths. Pass
absolute `cwd`, exact current permissions and approval mode, inferred domain, constraints, and only
selected capabilities. Durable runs submit without `monitorFirst`. Treat successful
`finalResponse` as complete; report MCP failure without silent fallback.
