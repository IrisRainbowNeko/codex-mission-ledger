# Codex integration

## Integration strategy

Codex native multi-agent tools create every UI-visible child. The external
control plane never attempts to mount or impersonate a native thread.

```text
Model decision
  ├── MCP task_allocate
  ├── native spawn_agent
  ├── child MCP task_claim/start
  └── direct-parent wait/check/verify/commit
```

This preserves the existing Codex App and IDE thread experience while putting
stateful constraints in code.

## Project-scoped files

```text
AGENTS.md
.agents/skills/agent-trio/SKILL.md
.codex/skills/agent-trio/SKILL.md
.codex/config.toml
.codex/agents/terra-coordinator.toml
.codex/agents/luna-producer.toml
.codex/agents/luna-verifier.toml
.codex/agents/sol-advisor.toml
.codex/hooks.json
.codex/hooks/*.py
```

Codex loads project `.codex` configuration and hooks only when the project is
trusted.

## MCP startup

`.codex/config.toml` configures:

```toml
[mcp_servers.hierarchical_codex]
command = "node"
args = ["dist/cli.js"]
cwd = "."
required = true
```

The repository must be opened at its root and built before a session starts:

```bash
npm install
npm run build
npm run doctor
```

If Codex starts in a nested working directory, set `cwd` to the repository root
for that installation.

The App, CLI, and IDE extension attached to the same Codex host share MCP
configuration. Plugin packaging is deliberately not required because Codex
plugins are not currently a universal IDE-extension distribution mechanism.

## Agent profiles

Profiles pin role and model but intentionally omit `model_reasoning_effort`.
This allows the direct parent to choose effort per spawn.

### `terra-coordinator`

- Model: `gpt-5.6-terra`
- Effort: explicit `high` default; `xhigh` or `max` only when the cell is unusually coupled
- Sandbox: read-only
- May spawn only Luna profiles
- Must not write the user-facing deliverable; spawn a Luna synthesizer instead

### `luna-producer`

- Model: `gpt-5.6-luna`
- Effort: explicit `high`, `xhigh`, or `max`
- Sandbox: workspace write
- Strict leaf

### `luna-verifier`

- Model: `gpt-5.6-luna`
- Effort: explicit `high` preferred; `xhigh` or `max` when the evidence is heavy
- Sandbox: read-only for workspace files
- Strict leaf; records `result_check` on `review_target_task_id`; never claims a task
- Spawn only for high/critical or non-deterministic evidence

### `sol-advisor`

- Model: `gpt-5.6-sol`
- Effort: explicit `high`, `xhigh`, or `max`
- Sandbox: read-only
- No lifecycle takeover

Custom agent files take precedence for fields they set. Since effort is omitted,
an explicit native spawn effort can be selected independently.

## Skill invocation

Codex discovers project skills from more than one layout:

- Codex App and older cores scan `.codex/skills/**/SKILL.md`
- current CLI/IDE builds also scan `.agents/skills/**/SKILL.md` from the
  session working directory up to the git root
- `AGENTS.md` is always injected when this folder is the workspace, even if
  the `$` picker is empty

`npm run doctor` only proves local files exist. The App shows `$agent-trio`
only after it has **this repository as the workspace**, the project is
**trusted**, and a **new** conversation is started.

If `$agent-trio` is missing:

1. In Codex App / VS Code, Open Folder on
   `/mnt/tools/others/codes/web project/hierarchical-codex` (the repo root, not a
   parent or nested directory).
2. Trust the project when prompted, or add this exact path to
   `~/.codex/config.toml`:

   ```toml
   [projects."/mnt/tools/others/codes/web project/hierarchical-codex"]
   trust_level = "trusted"
   ```

3. Confirm `dist/cli.js` exists (`npm run build`) so the required MCP server
   can start.
4. Fully quit and reopen the App, then start a **new** chat. Skills are
   enumerated at session start.
5. Type `$` in the composer. The skill will not appear in the plain ChatGPT
   app; it is a Codex workspace skill, not a ChatGPT GPT.

Start a new Sol root conversation and invoke:

```text
$agent-trio <mission>
```

If the picker is still empty, paste the mission and rely on `AGENTS.md`; the
root Sol instructions are loaded from that file.

The Skill may also be selected automatically for complex hierarchical requests.
Explicit invocation is preferred while validating the MVP.

The Skill instructs Sol/Terra to:

1. allocate control-plane tasks;
2. call native spawn with a complete TaskEnvelope;
3. disable context inheritance using the fields exposed by that runtime:
   `fork_turns: "none"` for V2 or `fork_context: false` for V1;
4. route completion to the direct parent;
5. store large outputs as artifacts;
6. enforce evidence gates.

## Hook behavior

### PreToolUse

`pre_spawn_policy.py` matches `spawn_agent`/`Agent` and denies:

- unregistered agent profiles;
- Luna parent spawning;
- Sol directly spawning Luna;
- Terra spawning Sol/Terra;
- invalid model/profile combinations;
- unsupported reasoning effort;
- missing explicit effort;
- a fork mode other than V2 `fork_turns=none` or V1 `fork_context=false`;
- mixed V1/V2 fork fields;
- spawn input without a `tsk_...` identifier.

`pre_coordinator_tools.py` matches Terra `wait` / `list_agents` / `send_message`
/ `followup_task` and Terra `wait_agent` with `timeout_ms` below 1800000. It
denies only when `payload.model` classifies as Terra. Sol root chats keep those
tools. Missing `model` fails open so user-global install cannot wedge ordinary
sessions. Do not deny `exec`; this VS Code client wraps MCP as exec JS.

The hooks rely on current hook payload fields and handle common argument-name
aliases. Re-run hook tests after Codex upgrades.

### SubagentStart

`subagent_start.py` adds concise protocol context. Codex currently does not allow
this event to prevent an already-starting subagent; enforcement belongs in
PreToolUse.

### SubagentStop

`subagent_stop.py` asks a child to continue once if its final response is not a
compact `TASK_RESULT` block (header plus `task_id`, `status`, `artifact_refs`,
`unresolved`, no preamble, under 800 characters). It honors `stop_hook_active`
to prevent infinite continuation.

The hook validates message shape, not control-plane truth. The parent must query
the task.

## Native lifecycle ownership

- Sol: create/wait/close the direct Terra only. One long `wait_agent`. No
  `list_agents` / `wait` / `send_message` poll loop. No `artifact_get`, no
  workspace writes.
- Terra: create/wait/gate its direct Luna only. One long `wait_agent` then
  `children_status`. `send_message` and `followup_task` are denied. Read-only;
  Luna synthesizer writes files.
- Luna: no collaboration tools.

Terra must not `send_message` children. Recover by spawning a replacement Luna.
Sol skill forbids the same poll tools; it cannot be hooked safely because Sol is
the root chat.

## Model and effort compatibility

Model catalog support is client-version dependent. App and VS Code may use a
bundled Codex core different from the system CLI.

Sol and Terra currently use the V2 collaboration runtime while Luna may expose
V1 leaf metadata. The hook accepts the no-context fork form from either schema.
All required model/effort pairs have been accepted in a 0.146.1 compatibility
check, but this project keeps 0.148.0 as the recommended production floor because
later Luna leaf fixes are relevant to nested operation.

Before deployment:

1. run `npm run doctor`;
2. start a new root session after upgrading Codex;
3. spawn one profile at each allowed effort;
4. confirm effective model/effort in logs or activity where available;
5. verify Luna receives no collaboration tools;
6. run a nested Terra → Luna workflow;
7. test hooks with the actual spawn payload.

Do not edit the Codex model catalog to make Luna appear coordinator-capable.

## User-scoped installation

To use the complete stack from any folder in Codex CLI or the VS Code
extension, run the installer from this repository after a production build:

```bash
npm run build
npm run install:user
npm run doctor:user
```

Details, hook `--opt-in` behavior, and uninstall are in
[USER_INSTALL.md](USER_INSTALL.md).

The installer merges `~/.codex/config.toml` and `~/.codex/hooks.json`. It does
not copy this project's default `model = "gpt-5.6-sol"` into the user config.
Re-running install is idempotent. Unmanaged same-named files abort unless
`--force` is passed. After install, trust the new command hooks with `/hooks`.

## Unsupported expectations

- MCP cannot invoke Codex's internal native spawn registry.
- An external thread cannot become a first-class native child.
- Hooks cannot reconstruct a fully authoritative native tree.
- Native UI does not provide the durable task ledger.
- The control plane cannot force a model to spawn; it can reject invalid spawns
  and make compliant behavior discoverable.

If deterministic code must create every native thread, a custom App Server
client or Codex modification is required, which is outside this project's chosen
route.
