---
name: agent-trio-session
description: Apply Agent Trio balanced routing when explicitly invoked and on related follow-ups. Root Sol keeps uncertain work; delegation requires proven benefit.
---

# Agent Trio Balanced Session

Apply now and on related follow-ups only when this conversation previously invoked $agent-trio-session.
Do not activate from a prior $agent-trio single-turn call. Stop after opt-out or when the user
switches to a clearly unrelated task. Invocation enables routing; it does not require an MCP call.
Use the `agent_trio` MCP runtime only when delegation qualifies.

Root Sol completes a single deliverable, repository review, algorithm, office artifact, quick
search, recovery task, indivisible Sol problem, or economically uncertain work. Inspect at most one
shallow file list or build manifest. Delegate one long tool-led unit only when at least three
matching historical runs predict <=40% of direct Sol cost and <=100% latency; otherwise stay in
root. Use `profile=balanced`, `strategy=direct`, and `directTier` set to exactly `luna` or `terra`.

Fanout needs two independently deliverable units over 30 seconds each and 90 seconds total. Default
to two Luna leaves and group similar inputs. Three leaves need three units, 120 seconds total, and at
least 20% critical-path gain over the best two-leaf grouping. Output facets are not units; use
disjoint paths or `[unit:id]` tags as evidence. Read-only evidence stays Luna. A Terra merge consumes
the only Terra slot. Office plans use Luna preparation followed by one Terra writer and deterministic
merge. Use `strategy=auto` only when root is not Sol. Root completion has no MCP call or Monitor.

Make each follow-up objective self-contained. Pass `agent_trio` arguments as flat top-level fields:
absolute `cwd`, domain, current permissions, constraints, and selected capabilities. Never wrap the
whole argument object in `request`, `input`, or `arguments`. Map read-only/workspace-write to
`readOnly`/`workspaceWrite`; map danger-full-access, unrestricted, or disabled sandboxing to
`fullAccess`. Map Never to `never` and Approve for me/on-request to `approveForMe`; never strengthen
either. Do not send `mode` or `selectedCapabilities`.

`risk` and `merge` are valid only inside `semanticPlan`; never send either as a top-level tool argument.
Use `access=readOnly` for analysis and `access=workspaceWrite` for edits. Writer paths are exclusive;
`after` uses indexes. With `strategy=direct`, omit `semanticPlan` and use `directTier`. Put limits
inside `limits`. Keep `semanticPlan` tool arguments under 350 tokens and emit no plan narration.

For a new foreground run create a UUID-style `runId`, submit with `monitorFirst=true`, then call
status. Only if submit succeeds with that ID, make exactly one `action=status` call containing only that action,
`runId`, and `wait=true`. If submit returns an MCP/tool error, stop and do not call status. The MCP
Apps monitor mounts from submit; never poll. Resume a matching `waiting_input` run instead of
duplicating it. Return successful `finalResponse` unchanged. Durable work omits `monitorFirst` and
shows its Monitor link. Report failure exactly; never silently fall back.
