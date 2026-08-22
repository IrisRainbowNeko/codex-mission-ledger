# Development guide

## Setup

```bash
cd "/mnt/tools/others/codes/web project/hierarchical-codex"
npm install
npm run check
```

Requirements:

- Node >=22.5;
- npm matching the installed Node distribution;
- Python 3 for hook tests.

## Source layout

```text
src/control-plane.ts        application/domain orchestration
src/domain/types.ts         public records and enums
src/domain/policy.ts        state, assignment, budget invariants
src/domain/errors.ts        typed domain errors
src/infra/database.ts       SQLite lifecycle and migrations
src/infra/repository.ts     persistence mapping
src/infra/artifact-store.ts immutable content store
src/mcp/server.ts           Zod schemas and MCP adapters
src/cli.ts                  stdio entrypoint
src/doctor.ts               installation diagnostics
src/user-install.ts         user-global ~/.codex installer
src/install-user.ts         installer CLI
```

Keep transport validation, domain policy, and persistence separate. A new MCP
tool should call a domain operation rather than executing SQL directly.

## Coding standards

- Strict TypeScript with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`.
- ESM and explicit `.js` imports in TypeScript source.
- No `any`.
- Mutations are transactional and idempotent.
- Domain errors use stable codes.
- Every state-changing operation emits an audit event.
- No application logging to stdout in the MCP process.
- Artifact paths never derive from user-provided filenames.
- Parent-child and model/effort policy belongs in code, not only prompts.

Run:

```bash
npm run format
npm run lint
npm run typecheck
npm run test
npm run build
```

`npm run check` runs the complete gate.

## Adding a state transition

1. Update `TASK_TRANSITIONS` in `src/domain/policy.ts`.
2. Decide the actor/lease/version preconditions.
3. Implement one explicit service operation.
4. Make the mutation transactional.
5. Emit an event with no secrets.
6. Add success, stale-version, invalid-state, and idempotent-replay tests.
7. Update `docs/PROTOCOL.md` and `docs/API.md`.
8. Add a changelog entry.

Avoid generic unrestricted `set_status` tools.

## Adding an MCP tool

1. Define/extend a control-plane input interface.
2. Implement domain behavior in `ControlPlane`.
3. Add a strict Zod schema in `src/mcp/server.ts`.
4. Write a model-oriented description specifying when the tool is valid.
5. Add the tool to `.codex/config.toml` `enabled_tools`.
6. Update Agent/Skill instructions only if orchestration behavior changes.
7. Add tests and API documentation.

## Database migrations

Schema version is stored in `schema_metadata`.

For a new migration:

1. increment `SCHEMA_VERSION`;
2. add a forward-only migration method;
3. run migrations in a transaction;
4. add a fixture/test upgrading the previous schema;
5. document backup and rollback requirements;
6. never silently discard unknown/newer schema versions.

The current MVP has schema version 3. Version 3 adds immutable mission
`strategy`, `portrait_json`, and `director_plan`. Existing rows migrate to
`fanout`. Version 2 adds request hashes to idempotency records so
payload-changing replays fail closed.

## Time and IDs in tests

`ControlPlane` accepts a clock and ID factory. Unit tests must use deterministic
versions to test lease expiry and idempotency without sleeping.

## Hook development

Hooks:

- read one JSON object from stdin;
- write one valid JSON object to stdout;
- use stderr for fatal parse errors;
- avoid third-party Python packages;
- must not interpolate hook payload into shell commands.

Tests execute hooks as subprocesses. Add payload fixtures whenever Codex changes
the hook schema.

Manual hook example:

```bash
printf '%s' '{
  "model":"gpt-5.6-sol",
  "tool_input":{
    "agent_type":"terra-coordinator",
    "model":"gpt-5.6-terra",
    "reasoning_effort":"high",
    "fork_turns":"none",
    "prompt":"task_id: tsk_example"
  }
}' | python3 .codex/hooks/pre_spawn_policy.py
```

Expected output is `{}`.

## Skill and profile development

Keep the main Skill concise and route detailed contracts to project docs.

Agent profiles intentionally pin models but not reasoning effort. If effort is
added to a profile, it may override the parent's explicit spawn choice.

After profile changes:

1. restart Codex;
2. create a new root thread;
3. test every allowed effort;
4. confirm the PreToolUse payload still contains expected fields;
5. verify Luna has no collaboration tools.

## Release checklist

1. Update `CHANGELOG.md`.
2. Record significant decisions as ADRs.
3. Run `npm ci` from a clean checkout.
4. Run `npm run check`.
5. Run `npm run doctor`.
6. Perform an end-to-end native Sol → Terra → Luna smoke test.
7. Back up/migrate a representative database.
8. Tag only after client compatibility is recorded.

No Git commit or release is created automatically by project scripts.
