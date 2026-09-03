---
name: agent-trio-quality
description: Explicitly delegate one turn with Agent Trio quality-first V3.3 behavior. Always delegate, using one worker or a 2-5 leaf DAG; never continue implicitly.
---

# Agent Trio Quality

Always delegate the complete request to the `agent_trio` MCP runtime with `profile=quality`.

When root Sol knows the topology, infer `domain` and choose `strategy=direct` with `directTier` set
to exactly `luna` or `terra` for one tightly coupled worker, or `strategy=fanout` with a compact semantic
plan. Default to two Luna leaves, use three for three real streams, and reserve four or five for
large independent corpora. Each leaf must exceed 15 seconds and shorten the critical path. Use at
most one Sol leaf. Use `strategy=auto` only when reliable semantic boundaries are unavailable. An
explicit quality call never completes the objective in root Sol.

Pass the `agent_trio` tool arguments as flat top-level fields. Never wrap the whole argument object
in `request`, `input`, or `arguments`.

For `run` or `submit`, use only schema fields. `domain` is exactly `coding`, `algorithm`, `research`,
`paper`, `office`, `autoResearch`, or `general`; omit it when uncertain. Map current Codex labels:
read-only to `readOnly`, workspace-write to `workspaceWrite`, and danger-full-access,
unrestricted, or disabled sandboxing to `fullAccess`; map Never to `never` and Approve for me or
on-request to `approveForMe`. Never strengthen access or approval. Use `directTier`, never a
top-level `floor`. Do not send `mode` or `selectedCapabilities`. `capabilities` contains
`{kind,name,path?}` objects, and execution limit fields belong inside `limits`.

For foreground work, generate a UUID-style `runId` and call `action=submit` with
`monitorFirst=true`. Only if submit succeeds and returns that same `runId`, make exactly one `action=status`
call containing only that action, the same ID, and `wait=true`. If submit returns an MCP/tool error, stop
immediately and do not call status. The MCP Apps monitor mounts while work runs; do not poll.

Pass the complete objective, absolute `cwd`, exact current `hostAccess` and `hostApproval`, inferred
domain, constraints, and only explicitly selected capabilities. `risk` and `merge` are valid only
inside `semanticPlan` for `strategy=fanout`; never send either as a top-level tool argument. Inside
that plan, writer paths are pairwise disjoint and dependencies, merge, and risk use exact schema
values. With `strategy=direct`, omit `semanticPlan` and all plan-only fields.

For durable work, submit without `monitorFirst` and stop after showing the Monitor link. Treat a
successful `finalResponse` as the complete delivery. Report MCP failures exactly without silently
falling back.
