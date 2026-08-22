# Operations runbook

## Preflight

From the repository root:

```bash
npm ci
npm run check
npm run doctor
```

`doctor` validates Node, Python, project integration files, built MCP entrypoint,
SQLite availability, and storage writability.

## Starting the server

Codex normally starts the server from `.codex/config.toml`.

Manual stdio start:

```bash
node dist/cli.js
```

Do not type arbitrary text into this process. stdin/stdout carry MCP JSON-RPC.
Diagnostics go to stderr. `serveStdio()` returns a connection handle; the
entrypoint must keep SQLite open until that handle closes.

## State locations

Project-local default (when `HIERARCHICAL_CODEX_HOME` is unset):

```text
.hierarchical-codex/control-plane.sqlite
.hierarchical-codex/control-plane.sqlite-wal
.hierarchical-codex/control-plane.sqlite-shm
.hierarchical-codex/artifacts/
```

User-global install (`npm run install:user`) stores the ledger at
`~/.local/share/hierarchical-codex/`. That path is outside `~/.codex` because
Codex MCP sandboxes treat `~/.codex` as read-only; `mission_create` cannot
INSERT into a read-only SQLite file. If the configured home is not writable,
the server falls back to `$TMPDIR/hierarchical-codex/<uid>` and logs the
chosen path on stderr.

Use environment variables to move state to a persistent encrypted volume.

## Backup

Stop active Codex sessions or use a SQLite-aware online backup mechanism. For a
quiet local system:

1. stop the MCP process;
2. copy `control-plane.sqlite`;
3. copy the complete artifact directory;
4. record the application and schema version;
5. verify backup hashes.

The database and artifact directory form one logical backup set. Restoring only
one may leave dangling references or missing content.

## Restore

1. stop the MCP process;
2. move the current state aside;
3. restore the database and artifact directory together;
4. ensure ownership and restrictive permissions;
5. run `npm run doctor`;
6. start Codex and call `recovery_snapshot`;
7. reconcile unexpired leases with real native agents.

Do not assume native threads survived a host restore.

## Interrupted task recovery

For each active mission:

1. call `recovery_snapshot`;
2. list native agents from the direct parent;
3. wait for an existing live owner with an unexpired lease;
4. reclaim an expired lease using the latest task version;
5. replay exact uncertain writes with their original idempotency key;
6. create a new attempt and key when the strategy changes.

Never copy a previous lease token into a new worker.

## Lease tuning

Defaults:

- lease: 15 minutes;
- maximum lease: 4 hours.

Terra coordinators should request `leaseSeconds=14400` on claim/start and
immediately before a blocking `wait_agent`. Luna keeps the 15-minute default
unless it asks for more.

Set a lease longer than expected heartbeat jitter but shorter than acceptable
failure detection. Workers should heartbeat before long, non-streaming tools.

Very long batch jobs should:

- submit through a durable external scheduler;
- store the external job ID as an artifact/claim;
- heartbeat while polling;
- avoid holding untracked local processes.

## Artifact limits

Default maximum write size is 5 MiB. MCP reads default to 64 KiB and are capped
at 1 MiB per call.

For large datasets:

- store them in an approved external object store;
- put a manifest, checksum, schema, and URI in the local artifact store;
- never raise the inline MCP limit to accommodate unbounded data.

## Database maintenance

SQLite configuration:

- foreign keys enabled;
- busy timeout 5 seconds;
- synchronous normal;
- WAL requested when supported.

The current schema version is stored in `schema_metadata` (version 3: mission
strategy, portrait, and director plan).

Before application upgrades:

1. back up state;
2. read `CHANGELOG.md`;
3. run tests against a copy;
4. run the new binary once to migrate;
5. verify a recovery snapshot;
6. keep the old binary and backup for rollback.

## Observability

Current observability sources:

- Codex native Subagents UI for live thread activity;
- `recovery_snapshot` for durable workflow state;
- ordered `events` for mutations;
- stderr for unexpected MCP failures;
- task/mission usage records for reported resource consumption.

Recommended future production additions:

- OpenTelemetry spans keyed by mission/task ID;
- metrics for active leases, stale leases, conflicts, rejections, and budget use;
- structured stderr logging;
- host-side authoritative token accounting.

## Common failures

### MCP server fails to start

Run:

```bash
npm run build
npm run doctor
```

Check that Codex starts from the repository root and that `dist/cli.js` exists.

### Project configuration ignored

The project may be untrusted, or the Codex client may not support the expected
project config layer. Trust the project, restart the client, and create a new
root thread.

### `$agent-trio` missing from the App picker

`npm install` / `npm run doctor` do not register the skill with ChatGPT. Codex
enumerates skills at session start from the **workspace root**.

1. Open this repository root, not a parent folder and not ChatGPT without a
   Codex workspace.
2. Trust the project. Some Codex builds hide `.codex/skills` until trusted.
3. Restart the App and start a new conversation.
4. Confirm both `.codex/skills/agent-trio/SKILL.md` and
   `.agents/skills/agent-trio/SKILL.md` exist.
5. If the `$` list is still empty, continue with `AGENTS.md`; it is injected
   for trusted workspaces even when the picker is empty.

### Spawn rejected by hook

Inspect the hook reason. Common causes:

- omitted `reasoning_effort`;
- invalid model/effort pair;
- missing task ID;
- missing/invalid V2 `fork_turns` or V1 `fork_context`;
- illegal parent/profile edge.

Do not bypass the hook to make the workflow proceed. Correct allocation or
spawn input.

### Task version conflict

Call `task_get`, reconcile the latest state, and retry with a new idempotency key
unless replaying the exact uncertain request.

### Lease conflict

Check owner and expiry. Wait for an unexpired owner. Reclaim only after expiry
and with the latest version.

### Artifact metadata exists but content is missing

Treat this as storage corruption. Restore the matching database/artifact backup
set. Do not mark dependent claims verified.

### Budget unexpectedly exceeded

Reservations are hierarchical:

- active root tasks reserve their remaining budget against the mission;
- active children reserve configured budget against the parent task;
- terminal children consume actual usage rather than their former reservation;
- actual usage counts against task and mission.

Inspect sibling budgets and reported usage before raising limits.

### Measuring host token share

Ledger `usage_json` is agent-reported and can be near zero. Measure Codex host
`token_count` instead (cached input included):

```bash
npx tsx scripts/measure-host-tokens.ts <parent-session-id>
```

Worker-thread target is Luna 82 · Terra 13 · Sol 5. Guardian share is printed
separately and must not be folded into Luna 82. First rerun pass: Luna ≥75,
Terra ≤18, Sol ≤12.

## Shutdown

Codex closes the stdio process when the host disconnects. The CLI closes SQLite
in its `finally` block.

For forced shutdown, prefer SIGTERM and allow the process to exit. SQLite
transactions are atomic, but a killed worker's logical task lease remains until
expiry.
