# Repository Instructions

This repository implements the Agent Trio V3 TypeScript runtime over Codex App Server.

- Do not install or modify user-scope Codex configuration without explicit authorization.
- Keep the public surface to one MCP tool and the matching CLI commands.
- Preserve the direct-task fast path and never add a ledger, heartbeat, mandatory reviewer, or user continuation gate.
- Child App Server threads must disable recursive orchestration and project instruction loading.
- Run formatting, lint, type checking, tests, and build before release.
