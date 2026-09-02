# Agent Trio V3

Agent Trio V3 is a cost-aware multi-agent runtime built on Codex App Server. It uses Sol for
semantic planning, Luna for most parallel execution, Terra for genuinely coupled work, and a
deterministic TypeScript scheduler for concurrency, dependencies, budgets, recovery, and patch
integration.

The runtime is designed around three targets relative to direct `gpt-5.6-sol/ultra`:

- cost at or below 40%;
- elapsed time at or below 70%;
- quality at or above 95%, or within 3 points.

The normal path contains no mission ledger, heartbeat loop, mandatory reviewer, audit chain, or
user continuation gate.

## Results

Percentages below are Agent Trio divided by direct Sol, so lower is better. Cost is calculated from
real token usage and the configured model price table.

| Task type              | Execution path                       | Time vs Sol | Cost vs Sol | Quality V3/Sol |
| ---------------------- | ------------------------------------ | ----------: | ----------: | -------------: |
| Small direct coding    | One Luna-low turn                    |       49.4% |        3.5% |        100/100 |
| Cross-module coding    | Sol-low plan + 3 Luna-medium leaves  |       63.5% |       13.7% |        100/100 |
| Exact algorithms       | Sol plan + Luna-medium leaves        |       46.5% |       24.6% |        100/100 |
| Frozen-source research | Sol plan + parallel Luna research    |       34.5% |        6.1% |         100/67 |
| Paper revision         | Sol plan + parallel Luna editing     |       36.3% |       20.9% |         97/100 |
| Spreadsheet work       | Sol-low plan + 3 Luna-low leaves     |       60.7% |       25.9% |        100/100 |
| Auto research          | Sol plan + multi-wave Luna execution |       34.9% |        6.2% |        100/100 |
| Six-domain macro       | Automatic direct/fanout routing      |       46.1% |       16.2% |         97-100 |

The three-sample direct fast path used zero planner turns and zero leaves. The three current coding
fanout instances each used one compact Sol plan and three Luna workers, with no Terra promotion,
replan, reviewer, protocol error, or user intervention.

See [Benchmarking](docs/BENCHMARKING.md) for the corpus, paired runner, evidence format, and scoring
rules.

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

`install:user` performs two user-level changes:

- registers one `[mcp_servers.agent_trio]` entry in `~/.codex/config.toml`;
- installs the explicit-only skill at `~/.agents/skills/agent-trio`.

It does not install hooks, native agent profiles, a global `AGENTS.md`, or change the selected root
model. The skill contains no scheduler or planning logic; it delegates once to the MCP runtime and
is not loaded for ordinary prompts.

Restart the ChatGPT desktop app, reload the VS Code Codex extension, and start a new Codex CLI
session after installation. The MCP registration is shared by all three local Codex clients.

Verify `agent_trio` with `/mcp` in the ChatGPT desktop app or Codex CLI, or with **MCP servers** in
the VS Code Codex extension. Then invoke it explicitly:

```text
# ChatGPT desktop app in Codex, VS Code Codex, or interactive Codex CLI
$agent-trio implement this feature and run the relevant tests
```

For a non-interactive CLI run, keep the `$` inside single quotes:

```bash
codex exec '$agent-trio research these alternatives and produce a comparison'
```

ChatGPT Chat and Work use `@agent-trio` instead of the Codex `$agent-trio` mention. A prompt without
the mention uses the normal Codex path, so the user decides when to pay the orchestration overhead.

For explicit foreground invocations, the installed skill starts a foreground-equivalent run,
immediately shows its local `monitorUrl`, and waits once for the persisted result. Open the link
while the task runs to inspect the live DAG and select any planner, leaf, direct agent, integrator,
or final-review thread. The view includes public agent messages, reasoning summaries emitted by
Codex, tool and command activity, file changes, token usage, cost, and validation state. It does not
expose private hidden model reasoning. The wait is driven by filesystem events, not model calls or
polling. Completed MCP results also prefix `finalResponse` with the Monitor link.

The skill also passes the current Codex task permission and approval modes to Agent Trio. A Full
access task gives direct agents and execution leaves Full access, including network access;
Workspace access and Read-only tasks remain correspondingly restricted. Approve for me is inherited
through App Server automatic review. The skill must never request stronger access or approval than
the calling task. Calls made without the skill can set the same context explicitly through MCP
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
zero-model cost/latency router
  |-- small, coupled, or uneconomic --> direct Luna/Terra result
  |
  `-- decomposable and profitable
          |
          v
      Sol ExecutionPlan
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
          `-- optional risk-triggered Sol review
```

Sol decides semantic boundaries, dependencies, model floors, and integration requirements. Code
handles launches, joins, concurrency, budgets, cancellation, recovery, and message delivery without
rewriting Sol's task boundaries.

Automatic fanout requires at least two independent work packages, enough expected work to repay the
planning turn, estimated cost no greater than 40% of direct Sol, and estimated latency no greater
than 70%. The router selects a 2-5 leaf ceiling before planning so Sol cannot over-decompose a small
task.

## Model Routing

| Tier  | Primary responsibility                                                               |
| ----- | ------------------------------------------------------------------------------------ |
| Luna  | Search, extraction, data processing, focused implementation, tests, mechanical edits |
| Terra | Coupled multi-file work, difficult debugging, semantic integration                   |
| Sol   | Planning, difficult algorithms, architecture, security, hidden correctness risks     |

Bounded work defaults to Luna. A leaf is promoted only when its own evidence shows that stronger
reasoning is needed; successful sibling work is retained. Sol planning, optional replanning, and
optional final review reuse the same planner identity.

## Scheduler

Foreground defaults:

| Limit                 | Value |
| --------------------- | ----: |
| Concurrent leaves     |     5 |
| Total leaves          |     8 |
| Dependency waves      |     3 |
| Sol specialist leaves |     1 |
| Sol replans           |     1 |

Durable auto-research jobs can raise the total-leaf limit to 20 while retaining the same five-way
concurrency and three-wave ceiling.

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
agent-trio run "update the report" -C /workspace --skill documents
agent-trio run "inspect the signed-in page" -C /workspace --plugin browser@openai-bundled

agent-trio submit "build a research dossier" -C /workspace --run-id dossier-01
agent-trio status dossier-01
agent-trio resume dossier-01 --input "repository permission granted"
agent-trio cancel dossier-01

agent-trio benchmark observations.json
```

Use `--strategy auto|direct|fanout` to select routing behavior. `auto` is the default and applies
the cost and latency gates before starting Sol Planner.

The CLI prints the Monitor URL before a foreground model run starts and includes it in submitted
and status results. MCP clients that support progress notifications receive the same URL as soon as
the run ID is assigned; every final structured result also contains `monitorUrl`.

## MCP Tool

The local Codex clients expose one MCP tool named `agent_trio` with five actions:

| Action   | Purpose                                                          |
| -------- | ---------------------------------------------------------------- |
| `run`    | Execute a foreground request                                     |
| `submit` | Start a durable background request                               |
| `status` | Read the latest persisted state                                  |
| `resume` | Continue the original App Server thread with supplied input      |
| `cancel` | Interrupt an active run without replaying completed side effects |

The explicit skill implements its visible foreground flow with two calls to this same tool:

```text
submit(monitorFirst=true) -> show monitorUrl -> status(runId, wait=true)
```

`monitorFirst` changes only how the caller receives the Monitor URL. The supervisor executes the
normal foreground `run` contract, and `wait=true` blocks on snapshot file events until the run
completes, fails, is cancelled, needs input, or becomes indeterminate. It adds no planner turn,
leaf, reviewer, model polling, or change to routing and execution limits. Ordinary durable
background submissions omit `monitorFirst` and return after acceptance.

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

The Monitor is a local read-only web UI. It does not start agents, poll models, review results, or
participate in scheduling. App Server `turn/*` and `item/*` notifications are written to a separate
bounded `monitor.jsonl` stream, while `job.json` remains the authoritative run snapshot.

The monitor process listens only on `127.0.0.1`. Each job root has a private token stored with the
same user-only permissions as Agent Trio job state. Consecutive text deltas for the same App Server
item are coalesced in a bounded 250 ms write batch instead of storing one JSON record per token
fragment. The browser then renders one conversation entry per logical message, reasoning item, tool
call, command, or file change. Existing logs receive the same coalescing when read, so no migration
is required. The runtime never retains an unbounded conversation in memory. Browser updates use
filesystem notifications and SSE rather than model-driven status loops, and the entire Monitor path
adds no model calls or tokens.

## Development

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
