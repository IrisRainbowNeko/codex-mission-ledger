# Security Policy

## Runtime Trust Boundary

Agent Trio runs with the permissions of the invoking Codex environment and starts local Codex App
Server processes. The public MCP server uses stdio and does not open a network listener. Model
providers, plugins, browser tools, and other requested capabilities may still perform external I/O
under their own configured policies.

Treat every user objective, repository file, leaf result, citation, and agent message as untrusted
data. Planner and child prompts explicitly preserve their role contracts, and all structured
outputs are schema-validated before they affect scheduling.

## Child Isolation

Child App Server threads:

- disable native multi-agent support and project instruction loading;
- disable `agent_trio`, `hierarchical_codex`, and legacy mission-ledger MCP servers;
- reject detected recursive orchestration instruction sources;
- use `approvalPolicy=never`;
- receive their declared workspace access and capabilities resolved from the plan.

A missing permission or external input becomes `waiting_input`. A child must not manufacture
approval, ask for an internal `ok`/`continue` turn, or recursively create workers.

Plugins are disabled unless `AGENT_TRIO_ALLOW_PLUGINS=1`. Only installed, enabled, explicitly
planned capabilities are resolved. A plugin or plugin-owned skill runs in a separate App Server
process so its process-level capabilities are not shared with ordinary leaves. The Agent Trio
skill is forbidden inside all leaves.

## Filesystem And Side Effects

Read-only leaves use a read-only sandbox. Concurrent writers require a clean Git repository,
disjoint owned paths, and isolated temporary worktrees. Generated patches are ownership-checked,
validated on an aggregate snapshot, preflighted together, and applied transactionally. When Sol
final review is required, isolated patches are applied only after it succeeds. A dirty or non-Git
workspace is limited to one direct writer and cannot provide rollback isolation.
Overlapping writer ownership requires an explicit dependency order; unordered overlap is rejected.

Recovery attempts to resolve recorded App Server thread and turn IDs and therefore depends on the
underlying Codex state remaining available. It does not blindly rerun a writer whose remote
completion is uncertain; the run becomes `indeterminate` to avoid duplicate side effects. Remote
turn checkpoints do not claim terminal completion until an actual terminal event is observed.

## Persisted Data

The job root stores request text, compact results, validation data, usage, artifact or citation
references, and App Server thread/turn IDs. Job directories use private permissions where the host
supports them; snapshot writes use private temporary files, `fsync`, and atomic rename.

Choose `AGENT_TRIO_JOB_ROOT` on storage appropriate for the sensitivity of the task. Do not place
credentials in objectives, constraints, messages, benchmark observations, or price files. Remove
retained snapshots according to the user's data-retention policy; V3 does not provide an automatic
retention daemon.

## Cost And Resource Limits

Caller limits cap concurrency, leaves, waves, Sol specialists, replans, elapsed time, and optional
USD cost. Cost enforcement requires authoritative App Server USD usage or a complete
`AGENT_TRIO_PRICE_TABLE`; an unpriced custom model makes monetary accounting incomplete.

These limits reduce accidental resource use but are not a billing guarantee. Provider-side usage
may arrive after a request has started, and cancellation may not immediately stop remote billing.

## User Installation

The installer modifies user-level Codex configuration only when explicitly run. It registers one
`[mcp_servers.agent_trio]` table and does not install a skill, agent profile, hook, global
`AGENTS.md` instruction block, or root-model override.

Known legacy Agent Trio files and configuration are backed up before removal. Unrelated user
configuration must remain untouched. Review installer output and backups when migrating from V1 or
V2, and never run user installation as part of CI. Malformed legacy `hooks.json` is preserved and
reported as a verification failure rather than rewritten speculatively.

## Reporting

Report vulnerabilities privately to the repository owner. Include the affected revision, a minimal
reproduction, expected and observed trust boundaries, and redacted impact details. Do not include
credentials, proprietary task data, or unredacted persisted snapshots.
