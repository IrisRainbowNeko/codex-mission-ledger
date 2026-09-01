---
name: agent-trio
description: Explicitly delegate a user-selected task to the Agent Trio V3 MCP runtime for cost-aware direct or parallel multi-agent execution. Use only when the user invokes $agent-trio or explicitly asks to use Agent Trio; do not trigger it implicitly for ordinary requests.
---

# Agent Trio

Delegate the complete request to the `agent_trio` MCP tool exactly once.

## Invocation

- Use `action=run` unless the user asks for a durable background job.
- Use `strategy=auto` unless the user explicitly selects `direct` or `fanout`.
- Pass the complete user goal, excluding the `$agent-trio` invocation marker, as `objective`.
- Pass the current workspace's absolute path as `cwd`.
- Preserve user constraints. Add capabilities only when the user explicitly selected them.

For a background job, use `action=submit`. For a follow-up status, resume, or cancel request, use
the matching action and the existing `runId`.

Treat the tool's `finalResponse` as the complete delivery. Do not redo the work, invoke another
orchestrator, or add a second substantive summary after a successful call.
