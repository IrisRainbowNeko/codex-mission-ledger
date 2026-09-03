# Agent Trio V3.4

Agent Trio V3.4 is a cost-aware multi-agent runtime built on Codex App Server. Its default
`balanced` profile lets the current Sol choose among root completion, one Luna/Terra execution
agent, and a compact parallel DAG. The `quality` profile preserves V3.3's always-delegate,
quality-first behavior. TypeScript handles concurrency, dependencies, budgets, recovery, and patch
integration after Sol makes the semantic decision.

The runtime is designed around three targets relative to direct `gpt-5.6-sol/ultra`:

- cost at or below 40%;
- elapsed time at or below 70%;
- quality at or above 95%, or within 3 points.

The normal path contains no mission ledger, heartbeat loop, mandatory reviewer, audit chain, or
user continuation gate.

## Results

The existing quality-reference measurements are below. Percentages are Agent Trio divided by direct
Sol, so lower is better. Cost is calculated from real token usage and the configured model price
table. V3.4 release benchmarking uses direct Sol, balanced, and quality as three arms.

| Task type              | Quality-reference path               | Time vs Sol | Cost vs Sol | Quality/Sol |
| ---------------------- | ------------------------------------ | ----------: | ----------: | ----------: |
| Small direct coding    | One Luna-low turn                    |       49.4% |        3.5% |     100/100 |
| Cross-module coding    | Sol-low plan + 3 Luna-medium leaves  |       63.5% |       13.7% |     100/100 |
| Exact algorithms       | Sol plan + Luna-medium leaves        |       46.5% |       24.6% |     100/100 |
| Frozen-source research | Sol plan + parallel Luna research    |       34.5% |        6.1% |      100/67 |
| Paper revision         | Sol plan + parallel Luna editing     |       36.3% |       20.9% |      97/100 |
| Spreadsheet work       | Sol-low plan + 3 Luna-low leaves     |       60.7% |       25.9% |     100/100 |
| Auto research          | Sol plan + multi-wave Luna execution |       34.9% |        6.2% |     100/100 |
| Six-domain macro       | Automatic direct/fanout routing      |       46.1% |       16.2% |      97-100 |

The three-sample direct fast path used zero planner turns and zero leaves. The three current coding
fanout instances each used one compact Sol plan and three Luna workers, with no Terra promotion,
replan, reviewer, protocol error, or user intervention.

See [Benchmarking](docs/BENCHMARKING.md) for calibration, the three-arm runner, evidence format, and
scoring rules.

## Install

Requirements:

- Node.js 20 or newer.
- A working Codex CLI with App Server support.
- Access to the configured Luna, Terra, and Sol models.
- Git for isolated parallel writers.

Install from the repository:

```bash
npm install
npm run check
npm run install:user
npm run doctor:user
```

`install:user` performs two kinds of user-level change:

- registers one `[mcp_servers.agent_trio]` entry in `~/.codex/config.toml`;
- installs `$agent-trio`, `$agent-trio-session`, `$agent-trio-quality`, and
  `$agent-trio-quality-session` under `~/.agents/skills`.

The MCP launcher reads assignment-style `*.env` files directly under the active Codex home before
starting Agent Trio. This makes provider variables such as `PRO_API_KEY` available to Agent Trio and
its child App Server processes in the desktop app, VS Code, and CLI without storing credentials in
`config.toml`. Files are loaded in filename order; later assignments override earlier ones. The
loader accepts `KEY=value`, `export KEY=value`, quoted values, and comments, but does not execute
shell commands.

It does not install hooks, native agent profiles, a global `AGENTS.md`, or change the selected root
model. All four skills contain routing instructions only and reuse the same MCP runtime.

Restart the ChatGPT desktop app, reload the VS Code Codex extension, and start a new Codex CLI
session after installation. The MCP registration is shared by all three local Codex clients.

Verify `agent_trio` with `/mcp` in the ChatGPT desktop app or Codex CLI, or with **MCP servers** in
the VS Code Codex extension. Then choose one mode:

```text
# ChatGPT desktop app in Codex, VS Code Codex, or interactive Codex CLI
# One turn only; later turns must mention it again.
$agent-trio implement this feature and run the relevant tests

# Related follow-ups in this conversation continue through Agent Trio automatically.
$agent-trio-session implement this feature and run the relevant tests

# Quality-first variants always delegate and retain the wider V3.3 DAG policy.
$agent-trio-quality analyze this repository and report correctness risks
$agent-trio-quality-session build this feature and handle my related follow-ups
```

For a non-interactive CLI run, keep the `$` inside single quotes:

```bash
codex exec '$agent-trio research these alternatives and produce a comparison'
```

ChatGPT Chat and Work use `@` instead of Codex `$` mentions. The non-session skills apply to one
turn. After either session skill is explicitly selected once, related corrections, refinements,
continuations, and questions retain that profile. Say to stop using Agent Trio, ask for normal
Codex, switch to an unrelated task, or start a new conversation to leave session mode.

For foreground invocations, the selected skill passes flat top-level MCP arguments, supplies a
unique run ID, submits the run for immediate durable acceptance, and then waits once for its final
result only after submit succeeds with that same ID. ChatGPT and Codex clients
with MCP Apps support therefore mount the live Monitor near the start of execution instead of after
the run finishes; no separate browser tab is required. Select any planner, leaf, direct agent,
integrator, or final-review thread to inspect its messages, reasoning summaries, commands, file
changes, token usage, cost, and validation state. The component reads cursor-based updates by
calling `status` through the MCP Apps bridge. Those calls stay inside the component and never invoke
a model. Clients without MCP Apps support keep the local `monitorUrl` text fallback.

All four skills also pass the current Codex task permission and approval modes to Agent Trio. A Full
access task gives direct agents and execution leaves Full access, including network access;
Workspace access and Read-only tasks remain correspondingly restricted. Approve for me is inherited
through App Server automatic review. Neither skill may request stronger access or approval than
the calling task. Calls made without a skill can set the same context explicitly through MCP
`hostAccess`/`hostApproval` or CLI `--host-access`/`--host-approval`.

Useful installation commands:

```bash
npm run install:user -- --job-root /absolute/job/path
npm run install:user -- --price-table /absolute/prices.json
npm run uninstall:user
```

## Execution Model

```text
request
  |
  v
host Sol balanced semantic route
  |-- tiny/indivisible ----------> root completion (no MCP)
  |-- one bounded work unit -----> one Luna/Terra execution agent
  |
  `-- 2-3 useful work units -----> host semanticPlan
          |
          v
  deterministic DAG scheduler
    |-- Luna leaves
    |-- Terra leaves
    `-- at most one Sol specialist
          |
          v
  local reduction or Terra integration
          |
          `-- anomaly-only lazy Sol PlanPatch

quality skill
  `-- always delegate: one agent or a 2-5-leaf DAG

CLI / insufficient host context
  |
  `-- deterministic bounded direct, otherwise one adaptive Sol plan
        |-- 1 leaf --> planned single agent
        `-- 2-5 leaves --> DAG scheduler
```

The current root Sol decides root completion versus delegation, direct versus fanout, domain,
semantic boundaries, dependencies, model floors, and integration requirements. Balanced fanout
requires two independent leaves over 30 seconds and at least 90 seconds of serial work; it defaults
to two leaves and uses three only for three substantial streams when that lowers the predicted
critical path by at least 20% versus the best two-leaf grouping. Quality retains the 15-second and
two-to-five-leaf V3.3 policy. Code handles permissions, launches, joins, concurrency, budgets,
cancellation, recovery, and message delivery without rewriting those semantic choices.

The 40% cost and 70% latency targets remain planning guidance, metrics, and balanced release gates.
Missing a predicted ratio does not override a valid host Sol plan. A CLI or non-Sol caller uses
`auto`: the runtime takes a zero-model direct route only for a provably bounded single objective;
otherwise one internal Sol turn chooses a single execution agent or a bounded DAG.

## Model Routing

| Tier  | Primary responsibility                                                               |
| ----- | ------------------------------------------------------------------------------------ |
| Luna  | Search, extraction, data processing, focused implementation, tests, mechanical edits |
| Terra | Recovery/stateful work, coupled debugging, review/synthesis, office artifacts        |
| Sol   | Planning, difficult algorithms, architecture, security, hidden correctness risks     |

Bounded work defaults to Luna. A leaf is promoted only when its own evidence shows that stronger
reasoning is needed; successful sibling work is retained. A normal host plan starts no internal Sol
thread. A blocker, material conflict, contract change, non-mechanical validation failure, or low
confidence can lazily start one internal Sol continuation for a minimal `PlanPatch`.

## Scheduler

Profile defaults:

| Limit                 | Balanced foreground | Balanced durable | Quality foreground | Quality durable |
| --------------------- | ------------------: | ---------------: | -----------------: | --------------: |
| Concurrent leaves     |                   3 |                3 |                  5 |               5 |
| Total leaves          |                   3 |                5 |                  8 |              20 |
| Dependency waves      |                   3 |                3 |                  3 |               3 |
| Sol specialist leaves |                   1 |                1 |                  1 |               1 |
| Sol replans           |                   1 |                1 |                  1 |               1 |

Balanced is intentionally capped at three foreground leaves. Quality durable auto-research may use
up to 20 total leaves while retaining the five-way concurrency and three-wave ceiling.

Independent writers in a clean Git repository receive isolated temporary worktrees. Their patches
are ownership-checked, combined, validated, and then applied to the original workspace. Read-only
leaves share the request workspace. Dirty and non-Git workspaces use a single writer.

The default model map is:

```text
luna  -> gpt-5.6-luna
terra -> gpt-5.6-terra
sol   -> gpt-5.6-sol
```

## CLI

The CLI and Desktop MCP tool use the same runtime core.

For direct CLI use, declare the permission and approval modes of the environment launching the task:

```bash
agent-trio run --host-access full-access --host-approval never 'inspect the configured package sources'
agent-trio run --host-access workspace-write --host-approval approve-for-me 'implement the requested repository change'
agent-trio run --host-access read-only --host-approval never 'analyze this project without changing it'
```

Omitting these flags retains the original workspace-scoped, non-approving behavior for compatibility.

```bash
agent-trio run "implement the requested feature" -C /workspace
agent-trio run --profile quality "perform a deep repository analysis" -C /workspace
agent-trio run "update the report" -C /workspace --skill documents
agent-trio run "inspect the signed-in page" -C /workspace --plugin browser@openai-bundled

agent-trio submit "build a research dossier" -C /workspace --run-id dossier-01
agent-trio status dossier-01
agent-trio resume dossier-01 --input "repository permission granted"
agent-trio cancel dossier-01

agent-trio benchmark observations.json
```

Use `--profile balanced|quality` to select the default policy; balanced is the default. An explicit
`--strategy auto|direct|fanout` takes precedence over profile routing. In `auto`, clearly bounded
single-agent work stays on the deterministic direct path, while other work receives one adaptive
internal Sol plan.

The CLI prints the local Monitor URL before a foreground model run starts and includes it in
submitted and status results. MCP Apps clients use the embedded view; clients that only support
progress notifications receive the local URL as a fallback. Final structured results retain
`monitorUrl` for compatibility.

## MCP Tool

The local Codex clients expose one MCP tool named `agent_trio` with five actions:

| Action   | Purpose                                                          |
| -------- | ---------------------------------------------------------------- |
| `run`    | Execute a foreground request                                     |
| `submit` | Start a durable background request                               |
| `status` | Read the latest persisted state                                  |
| `resume` | Continue the original App Server thread with supplied input      |
| `cancel` | Interrupt an active run without replaying completed side effects |

All installed skills implement this foreground flow when they call the runtime:

```text
generate unique runId -> submit(runId, monitorFirst=true)
  -> on successful response with the same runId: status(runId, wait=true) once
  -> on MCP/tool error: stop without status
```

Tool arguments are flat fields such as `action`, `runId`, `objective`, and `cwd`; callers must not
nest the whole argument object beneath `request`, `input`, or `arguments`. The runtime accepts one
legacy `request` wrapper for compatibility, but the public schema and documented format remain
flat.

The first call returns as soon as the foreground run has a durable snapshot, which gives the host a
completed tool result to attach the component to. The second call waits on that same run locally;
it does not start another planner, leaf, reviewer, or model turn. The component performs its own
cursor-based `status` long polling over the MCP Apps bridge, and those component calls never enter
the model context. Ordinary durable background submissions omit `monitorFirst` and return after
acceptance without the one-time foreground wait.

Child App Server threads have project instruction loading, native multi-agent orchestration, and
recursive Agent Trio access disabled.

## Configuration

| Variable                          | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `AGENT_TRIO_JOB_ROOT`             | Durable snapshot and event directory               |
| `AGENT_TRIO_PRICE_TABLE`          | Override model price table                         |
| `AGENT_TRIO_MODEL_PROVIDER`       | App Server provider override                       |
| `AGENT_TRIO_SERVICE_TIER`         | Shared service tier                                |
| `AGENT_TRIO_CODEX_PATH`           | Path to the pinned Codex executable                |
| `AGENT_TRIO_CODEX_HOME_MODE`      | Child home: `projected`, `temporary`, or `inherit` |
| `AGENT_TRIO_LUNA_MODEL`           | Luna model override                                |
| `AGENT_TRIO_TERRA_MODEL`          | Terra model override                               |
| `AGENT_TRIO_SOL_MODEL`            | Sol model override                                 |
| `AGENT_TRIO_ALLOW_PLUGINS=1`      | Enable explicitly selected plugin capabilities     |
| `AGENT_TRIO_PLANNER_TRANSPORT`    | Planner: `auto`, `responses`, or `app-server`      |
| `AGENT_TRIO_PLANNER_BASE_URL`     | Responses-compatible planner endpoint              |
| `AGENT_TRIO_PLANNER_API_KEY`      | Planner bearer credential                          |
| `AGENT_TRIO_PLANNER_MODEL`        | Planner model override                             |
| `AGENT_TRIO_PLANNER_SERVICE_TIER` | Planner-only service tier                          |
| `AGENT_TRIO_MONITOR=0`            | Disable local Monitor capture and URLs             |
| `AGENT_TRIO_MONITOR_PORT`         | Fixed loopback Monitor port override               |

The bundled standard-context price table is
[`config/openai-prices.standard.json`](config/openai-prices.standard.json). Custom model names or
providers require an explicit price table so admission and hard cost limits can be calculated before
execution.

The planner transport defaults to `auto`: it uses a Responses-compatible provider when configured
and falls back to Codex App Server. Responses planning is tool-free and uses strict structured
output.

## Monitor

The primary Monitor is a self-contained MCP Apps resource attached to the existing `agent_trio`
tool. It renders inside compatible ChatGPT and Codex clients and calls the same tool with private
cursor and revision fields for bounded long polling. The local loopback web UI remains available to
the CLI and clients without MCP Apps support. Neither presentation starts agents, reviews results,
or participates in scheduling.

App Server completed items and lifecycle notifications are written to a separate bounded
`monitor.jsonl` stream, while `job.json` remains authoritative. Token delta notifications are not
stored. The recorder uses a 512 KiB pending-memory ceiling, a 16 KiB per-event ceiling, and an 8 MiB
per-run log ceiling. Both views render one conversation entry per completed message, reasoning item,
tool call, command, or file change, retain bounded UI state, and add no model calls or tokens. The
loopback fallback still listens only on `127.0.0.1` and uses a private per-job-root token.

## Development

`npm run check` keeps the authored Office corpus disabled because generating and qualifying that
release benchmark is intentionally resource intensive. Run it explicitly on a machine with
LibreOffice using:

```bash
AGENT_TRIO_RUN_AUTHORED_CORE_TESTS=1 npm test -- tests/authored-core-benchmark-corpus.test.ts
```

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run doctor -- --project-only
```

The normal test configuration uses one Vitest worker to keep App Server fixture memory bounded.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Benchmarking](docs/BENCHMARKING.md)
- [Benchmark sources](docs/BENCHMARK_SOURCES.md)
- [Pricing](docs/PRICING.md)
- [Changelog](CHANGELOG.md)
