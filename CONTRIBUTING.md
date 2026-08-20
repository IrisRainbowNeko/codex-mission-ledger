# Contributing

## Before changing code

Read:

- `docs/ARCHITECTURE.md`
- `docs/PROTOCOL.md`
- relevant ADRs

Preserve the core route: native model-driven spawning with coded constraints.
Changes that move thread creation outside native Codex require a new ADR.

## Development workflow

```bash
npm install
npm run check
npm run doctor
```

For every behavior change:

1. add or update tests;
2. update API/protocol documentation;
3. add a changelog entry;
4. add an ADR if the architecture boundary changes;
5. record compatibility implications for Codex hooks or profiles.

## Pull request expectations

- Explain the user-visible outcome and reason.
- Identify state/schema/protocol changes.
- Include test evidence.
- Note migration and rollback behavior.
- Avoid unrelated formatting or cleanup.
- Do not commit secrets, generated runtime state, or private artifacts.

## Compatibility

When changing Codex integration, test App, CLI, and VS Code separately. Record:

- client version;
- bundled Codex core when known;
- model/effort availability;
- hook payload changes;
- native tree behavior.

## Commit policy

Use concise imperative messages focused on intent. Do not bypass repository
checks. Generated `dist/` is currently build output and should be reviewed
according to the eventual release policy.
