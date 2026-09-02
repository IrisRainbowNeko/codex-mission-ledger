---
name: agent-trio
description: Explicitly delegate a user-selected task to the Agent Trio V3 MCP runtime for cost-aware direct or parallel multi-agent execution. Use only when the user invokes $agent-trio or explicitly asks to use Agent Trio; do not trigger it implicitly for ordinary requests.
---

# Agent Trio

Delegate the complete request to the `agent_trio` MCP runtime.

## Invocation

- For a foreground request, first call `action=submit` with `monitorFirst=true`. As soon as it
  returns, show the returned `monitorUrl` as a Markdown link in a commentary update. Then call
  `action=status` with the same `runId` and `wait=true` exactly once. This second call waits for the
  original foreground-equivalent run; it is not polling and must not be repeated.
- Use `strategy=auto` unless the user explicitly selects `direct` or `fanout`.
- Pass the complete user goal, excluding the `$agent-trio` invocation marker, as `objective`.
- Pass the current workspace's absolute path as `cwd`.
- Pass the current Codex task's permission mode as `hostAccess` on `run` or `submit`: use
  `readOnly` for read-only, `workspaceWrite` for workspace access, and `fullAccess` for Full access.
  Copy the active mode exactly. Never request a stronger mode than the current task has.
- Pass the current Codex task's approval mode as `hostApproval`: use `approveForMe` only when the
  task uses Approve for me, and `never` when approvals are disabled. Copy the active mode exactly;
  never enable automatic approval for a caller that does not already have it.
- Preserve user constraints. Add capabilities only when the user explicitly selected them.

When the user explicitly asks for a durable background job, use ordinary `action=submit` without
`monitorFirst`, show the Monitor link after acceptance, and stop without waiting. For a later
status, resume, or cancel request, use the matching action and the existing `runId`.

Treat the blocking status call's `finalResponse` as the complete foreground delivery. Do not redo
the work, invoke another orchestrator, or add a second substantive summary after a successful call.

When `monitorUrl` is present, keep the Monitor link that already prefixes `finalResponse`. Do not
remove, rewrite, or hide it.

If the MCP call itself fails, report the exact integration error and stop. Do not complete the
objective directly or silently switch to another execution path unless the user explicitly asks.
