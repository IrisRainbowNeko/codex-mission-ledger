# Mission Ledger for Codex user-global install (VS Code Codex + CLI)

Use this when you want `$agent-trio` in **any** folder opened by the Codex
VS Code extension or Codex CLI. The control plane stays one Node process; Codex
still creates native Terra/Luna threads in whatever workspace you opened.

Do **not** copy the repository `.codex/config.toml` or `.codex/hooks.json` into
`~/.codex`. Those files pin `gpt-5.6-sol` and reject every non-hierarchy spawn.

`$skill-installer` is not enough. It only copies a skill folder. Full function
also needs custom agent profiles, user hooks, and a stdio MCP server with an
absolute `dist/cli.js` path. Codex plugins can bundle some of that for the
ChatGPT desktop app and CLI, but **plugins are not available in the VS Code IDE
extension**, so this repo ships `npm run install:user` as the VS Code path.

## Install

From this repository:

```bash
cd "/mnt/tools/others/codes/web project/hierarchical-codex"
npm install
npm run build
npm run install:user
npm run doctor:user
```

Windows (PowerShell), after cloning the repo:

```powershell
cd "C:\path\to\hierarchical-codex"
npm install
npm run build
npm run install:user
npm run doctor:user
```

Python 3.10+ must be on PATH as `python3`, `py -3`, or `python`. The Windows
installer from python.org (enable the `py` launcher) or `winget install Python.Python.3.12`
is enough. Node 22.5+ is required. Hooks are launched with the same `node.exe`
that ran the installer, so a missing `python3` name is not a blocker.

If a same-named skill or agent profile already exists and was not installed by
this tool, the installer **aborts**. Re-run with `--force` to back those files
up under `~/.codex/codex-mission-ledger/backups/` (never as a sibling under
`skills/`, which Codex would load) and take ownership:

```bash
npm run install:user -- --force
```

The installer:

1. copies the skill to `~/.agents/skills/agent-trio` and `~/.codex/skills/agent-trio`;
2. copies agent profiles to `~/.codex/agents/` only when unmanaged files are absent (or `--force`);
3. copies hooks to `~/.codex/hooks/codex-mission-ledger/` and uses **absolute** paths;
4. merges MCP settings into `~/.codex/config.toml` without changing your default model, and sets `default_tools_approval_mode = "approve"` so Codex Guardian does not treat this local ledger as untrusted egress;
5. is safe to re-run: it rewrites one managed block and will not duplicate TOML keys;
6. merges hook entries into `~/.codex/hooks.json` with `--opt-in` so ordinary `spawn_agent` still works;
7. appends a short section to `~/.codex/AGENTS.md`;
8. records owned paths in `~/.codex/codex-mission-ledger/install-manifest.json`;
9. stores mission state in `~/.local/share/codex-mission-ledger/` on POSIX and
   `%LOCALAPPDATA%\codex-mission-ledger\` on Windows (not under `~/.codex`, which
   Codex sandboxes as read-only for MCP);
10. backs up `config.toml` and unmanaged conflicts to `~/.codex/codex-mission-ledger/backups/` (first managed install for config; `--force` for conflicts). Codex loads every folder under `skills/`, so `.bak-codex-mission-ledger-*` skill copies must not stay there. `doctor:user` warns if leftover backup folders remain in `~/.codex/skills` or `~/.agents/skills`.

Existing `hierarchical-codex` manifests, hook paths, backups, state, and managed
markers remain recognized for upgrade and uninstall. The MCP server key
`hierarchical_codex` and `$agent-trio` trigger remain compatibility-sensitive
protocol identifiers.

Then:

1. Restart VS Code (the Codex extension enumerates skills, MCP, and hooks at startup).
2. Open **any** project folder and trust the workspace if prompted.
3. Start a **new** Codex chat (old threads do not reload user config).
4. Run `/hooks`. Review and **trust** the Mission Ledger for Codex command hooks.
   User-level command hooks are skipped until trusted; MCP can still work while
   spawn policy, start injection, and stop checks are inactive.
5. Run `/mcp` and confirm `hierarchical_codex` is connected. After a new
   chat, this server is pre-approved (`approve`); Guardian should not review
   `artifact_put` or other tools on it.
6. Select `gpt-5.6-sol`.
7. Invoke `$agent-trio <mission>`.

`doctor:user` can PASS files/TOML while printing a WARN about untrusted hooks.
That warning is expected until step 4.

CLI is the same: `codex` started in another repo loads `~/.codex` plus that repo's
project files. Trust hooks with `/hooks` there as well.

## What must stay global vs local

| Piece          | Location                                                                                         | Why                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Skill          | `~/.agents/skills` and `~/.codex/skills`                                                         | VS Code/CLI discover user skills without the original repo as cwd     |
| Agent profiles | `~/.codex/agents`                                                                                | native `agent_type=terra-coordinator` must resolve in every workspace |
| Hooks          | `~/.codex/hooks/codex-mission-ledger` + `~/.codex/hooks.json`                                    | spawn policy and start/stop text                                      |
| MCP server     | `node <absolute>/dist/cli.js`                                                                    | tools available even when cwd is another project                      |
| Task ledger    | `~/.local/share/codex-mission-ledger` (POSIX) or `%LOCALAPPDATA%\codex-mission-ledger` (Windows) | durable state; `~/.codex` is read-only inside Codex MCP sandboxes     |
| Default model  | **not** installed                                                                                | pinning Sol globally would hijack every Codex session                 |

The MCP `cwd` is this package root so `dist/cli.js` resolves. Codex sandbox cwd
remains the folder you opened; the control plane does not have to live there.

`required = false` so a broken Node path does not block ordinary Codex chats.
If `/mcp` hides the server, run `npm run build` in this repo and `npm run install:user` again.

Keep this repository at the same path after install. Moving it without
reinstalling leaves MCP pointing at a missing `dist/cli.js`.

## Reinstall after a control-plane change

Old threads keep the previous MCP process and env. After rebuilding this
package, reinstall and start a **new** Codex chat:

```bash
cd "/mnt/tools/others/codes/web project/hierarchical-codex"
npm run build
npm run install:user
npm run doctor:user
```

Confirm `CODEX_MISSION_LEDGER_HOME` in `~/.codex/config.toml` points at
`~/.local/share/codex-mission-ledger` or `%LOCALAPPDATA%\codex-mission-ledger`,
not a path under `~/.codex`. Then
restart VS Code, open a new chat, run `/mcp`, and retry `$agent-trio`.

`npm run install:user -- --force` is only needed if unmanaged skill/agent files
block the installer. Do not copy this repo's `.codex/config.toml` over
`~/.codex`.

## Hook policy in user mode

User hooks call `pre_spawn_policy.py --opt-in`:

- spawning `terra-coordinator` / `luna-*` / `sol-advisor` is still strictly checked;
- any other `agent_type` is allowed, so other projects keep normal subagents.

`pre_coordinator_tools.py` is also installed. It denies Terra babysitting tools
only when the current model is Terra; Sol `list_agents` / `wait` stay allowed.

Project-local `.codex/hooks.json` stays **strict** (unknown profiles denied) so
this repository itself does not silently fall back to generic agents.

Trust is stored against the hook definition hash. Editing the hook command or
matcher requires a new `/hooks` review. After this change, start a **new** Codex
chat and trust the new PreToolUse command.

## Uninstall

```bash
npm run uninstall:user
```

This removes the managed config block, our hook entries, and files listed in
`install-manifest.json`. It does not delete unrelated files in `~/.codex/agents`.
It keeps `multi_agent` / `hooks` feature flags and the ledger under
`~/.local/share/codex-mission-ledger` or `%LOCALAPPDATA%\codex-mission-ledger`
SQLite state so you can reinstall without wiping missions.

## VS Code notes

- The IDE extension uses its bundled Codex core, not necessarily the system
  `codex` binary. User files under `~/.codex` and `~/.agents` (`%USERPROFILE%`
  on Windows) are still shared.
- Codex plugins are not a VS Code distribution path.
- If `$agent-trio` is missing, type `$` in a **new** chat after restart. The
  user `AGENTS.md` section still applies if the picker is empty.
- Trust the opened workspace. Untrusted workspaces can hide project overlays;
  user-level MCP/skills should still load.
- Full function is confirmed only after a nested Sol → Terra → Luna task in VS
  Code, not by `doctor:user` alone.
