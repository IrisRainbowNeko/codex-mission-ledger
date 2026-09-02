---
name: agent-trio-session
description: Use only when the user explicitly invokes $agent-trio-session, or when this same conversation previously invoked $agent-trio-session and the current prompt is a related follow-up, correction, extension, continuation, or question about that delegated Agent Trio V3 work. Do not activate from a prior $agent-trio single-turn call, for an unrelated new task, or after the user opts out. Provides cost-aware direct or parallel multi-agent execution.
---

# Agent Trio Session

Delegate the complete request to the `agent_trio` MCP runtime and keep related follow-ups on Agent
Trio for this conversation.

## Session Boundary

- An explicit `$agent-trio-session` invocation activates session routing for the current
  conversation.
- On later turns, invoke this skill implicitly only when the current request directly follows up on
  work delegated after that activation. Related follow-ups include corrections, refinements,
  extensions, continuation requests, and questions about the result.
- Do not activate session routing merely because this conversation used the single-turn
  `$agent-trio` skill or called the `agent_trio` tool for another reason.
- End session routing when the user explicitly says to stop using Agent Trio, asks to use normal
  Codex, or switches to a clearly unrelated task. A new conversation starts inactive.

## Invocation

- For a foreground request, first call `action=submit` with `monitorFirst=true`. As soon as it
  returns, show the returned `monitorUrl` as a Markdown link in a commentary update. Then call
  `action=status` with the same `runId` and `wait=true` exactly once. This second call waits for the
  original foreground-equivalent run; it is not polling and must not be repeated.
- Use `strategy=auto` unless the user explicitly selects `direct` or `fanout`.
- On the activating turn, pass the complete user goal without the `$agent-trio-session` marker as
  `objective`.
- For a related follow-up after a completed run, start a new foreground run. Make `objective`
  self-contained with the new request plus only the prior goal, result facts, decisions, and
  artifact paths needed to understand it. Do not paste Monitor events, full transcripts, or
  irrelevant prior output.
- If the prior run is still `waiting_input` and the new message supplies the requested information,
  use `action=resume` with that run ID instead of starting a new run. Use `status` or `cancel` only
  when the user asks for those operations.
- Pass the current workspace's absolute path as `cwd`.
- Pass the current Codex task's permission mode as `hostAccess` on `run` or `submit`: use
  `readOnly` for read-only, `workspaceWrite` for workspace access, and `fullAccess` for Full access.
  Copy the active mode exactly. Never request a stronger mode than the current task has.
- Pass the current Codex task's approval mode as `hostApproval`: use `approveForMe` only when the
  task uses Approve for me, and `never` when approvals are disabled. Copy the active mode exactly;
  never enable automatic approval for a caller that does not already have it.
- Preserve user constraints. Add capabilities only when the user explicitly selected them.

When the user explicitly asks for a durable background job, use ordinary `action=submit` without
`monitorFirst`, show the Monitor link after acceptance, and stop without waiting.

Treat the blocking status call's `finalResponse` as the complete foreground delivery. Do not redo
the work, invoke another orchestrator, or add a second substantive summary after a successful call.

When `monitorUrl` is present, keep the Monitor link that already prefixes `finalResponse`. Do not
remove, rewrite, or hide it.

If the MCP call itself fails, report the exact integration error and stop. Do not complete the
objective directly or silently switch to another execution path unless the user explicitly asks.
