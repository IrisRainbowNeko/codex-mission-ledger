# ADR 0001: Keep subagent spawning native and model-driven

- Status: Accepted
- Date: 2026-08-20

## Context

The system must work inside existing Codex App and VS Code UI. Only native Codex
`spawn_agent` calls create first-class child threads visible in the Subagents UI.
MCP services and external orchestrators cannot register arbitrary threads as
native children.

A fully external scheduler could make thread creation deterministic, but would
lose native UI identity or require a custom Codex/App Server frontend.

## Decision

Use model-driven native spawning:

- Sol/Terra call Codex `spawn_agent`.
- A Skill describes when and how to spawn.
- Agent profiles pin role/model behavior.
- A PreToolUse hook rejects illegal spawn shape.
- The MCP control plane allocates durable tasks before spawning and validates all
  state transitions afterward.

Code enforces constraints around the spawn; it does not initiate the native
spawn.

## Consequences

Positive:

- Native thread tree and UI are preserved.
- Existing App, CLI, and IDE surfaces remain usable.
- Deterministic state does not depend on chat history.
- Invalid role/model/effort combinations can be blocked.

Negative:

- A model can fail to spawn when it should.
- Hooks cannot guarantee semantic compliance.
- The external control plane cannot recover a native thread itself.
- Fully deterministic scheduling would require a different product boundary.

## Rejected alternatives

### External tmux/process workers as primary agents

Rejected because they do not become first-class native Codex children.

### MCP tool that wraps `spawn_agent`

Rejected because public MCP servers do not have access to Codex's internal agent
registry.

### Modify Codex/App Server immediately

Rejected for the MVP because it increases maintenance and loses the goal of
reusing the stock UI.
