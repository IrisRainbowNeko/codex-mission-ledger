# Agent Trio V3 Architecture

## Objective

Agent Trio V3 minimizes elapsed time and actual model cost subject to quality staying close to a
direct `gpt-5.6-sol/ultra` baseline. It separates semantic decisions from execution mechanics:

- Sol decides how a complex task should be decomposed and which model tier each package needs.
- TypeScript performs zero-model economic admission, decides when a ready package starts, joins
  dependencies, and stops at hard limits.
- Terra performs capability-dependent admission, difficult direct work, and semantic integration
  only when local reduction is insufficient.
- Luna is the default leaf for bounded work; Terra handles genuine cross-file reasoning;
  at most one Sol leaf handles a genuinely difficult specialist package.

This is an App Server runtime, not a prompt-only routing convention and not a durable workflow
ledger.

## Components

| Component                     | Responsibility                                                  |
| ----------------------------- | --------------------------------------------------------------- |
| `src/core/service.ts`         | Run lifecycle and direct/fanout critical path                   |
| `src/core/planner.ts`         | Sol planner session, structured plan, one optional patch        |
| `src/core/plan-validation.ts` | Strict plan and patch parsing, DAG and contract checks          |
| `src/core/scheduler.ts`       | Deterministic waves, concurrency, escalation, messages, limits  |
| `src/core/policy.ts`          | Admission, model/effort policy, conflicts, replan triggers      |
| `src/core/recipes.ts`         | Lightweight coding, research, writing, and office guidance      |
| `src/core/workspace.ts`       | Writer ownership, isolated Git worktrees, patch integration     |
| `src/core/job-store.ts`       | Atomic snapshots, compact events, process locks, request hashes |
| `src/app-server/*`            | App Server transport, protocol validation, and role adapters    |
| `src/responses-planner.ts`    | Optional tool-free Sol planner transport                        |
| `src/runtime.ts`              | Shared production wiring for CLI and MCP                        |
| `src/supervisor.ts`           | One detached process per submitted durable run                  |
| `src/mcp/protocol.ts`         | Single public `agent_trio` MCP tool                             |
| `src/cli.ts`                  | Matching CLI plus offline benchmark evaluation                  |
| `src/monitor/*`               | Bounded App Server event capture and local read-only dashboard  |

The runtime talks to Codex App Server over multiplexed JSONL. Requests are correlated by ID, and
turn completion is driven by server events, so independent `thread/start` and `turn/start`
sequences can overlap without model-driven launch loops.

The runtime launches the configured Codex App Server directly. Compatibility is determined by
actual JSON-RPC methods and response schemas; startup and `doctor` do not infer it from a CLI
version or `userAgent` string.

## Request Flow

### Direct Path

```text
RunRequest -> local economic router -> direct execution -> BatchResult
```

The local router returns one of:

- `direct` for short, sequential, highly coupled, or otherwise unsuitable work;
- `fanout` when parallel work is likely to repay planning and integration;
- `waiting_input` when real permission or external information is missing.

A direct result does not start Sol Planner or any leaf. Automatic fanout is admitted only with a
complete price table and estimates at or below 40% of direct-Sol cost and 70% of direct-Sol
latency. Small decomposable tasks therefore remain direct when Sol planning cannot repay itself.
Bounded coding/general direct tasks use Luna to avoid paying Terra for a cold child context.
Only difficult algorithmic, research, architectural, and security-sensitive direct work uses Terra;
bounded exact calculations remain on Luna. Capability-dependent tasks retain Terra admission and can
continue in that thread.

Caller-selected skills are supplied as structured App Server inputs during admission, so Terra can
finish a small document or office task in that first turn. Without an explicit selection, Terra
sees a compact capability catalog: unique skill names omit paths, while duplicate names retain paths
for deterministic disambiguation. Terra may request only exact catalog entries for its one direct
continuation; the resolver remains authoritative and rejects unavailable or disabled capabilities.

### Fanout Path

```text
local economic admission
      |
      v
Sol micro-plan -> validate -> prepare workspaces -> run DAG
                                                  |
                                                  v
                       local reduction or Terra integration + validation
                                                  |
                                                  v
                                  optional same-thread Sol review
                                                  |
                                                  v
                                  apply isolated writer patches
```

Automatic admission compares the full candidate path against the product baseline,
`gpt-5.6-sol/ultra`, rather than against the cheaper Luna/Terra direct fallback. The estimate uses
the configured internal planner transport: App Server carries its measured cold Codex context,
while Responses uses the compact tool-free envelope. This prevents both false rejection of useful
fanout and false admission caused by pretending the heavy planner input is cached.

There are two Sol entry paths. In Desktop, the current root Sol can supply the compact
`semanticPlan` directly with the `agent_trio` call. The runtime expands IDs, low-risk defaults,
effort, and scheduler fields mechanically, adopts the plan with zero additional planner usage, and
sets `maxReplans=0`. This path is limited to low-risk deterministic fanout; semantic integration,
high-risk work, or contract changes use the full internal Sol planner session instead. The internal
path remains available to CLI callers that do not already have a Sol plan.

The internal planner has two transports. The default `auto` mode resolves a Responses-compatible
provider from explicit environment variables or the active local Codex configuration and auth,
then falls back to App Server. Responses sends only the compact planner prompt, reasoning effort,
and strict JSON schema, with no executable tools or Codex skill catalog. Plan and patch prompts are
self-contained, so the transport can keep local thread identity without storing provider-side
responses.

The root Sol uses low effort for a bounded admission or single-worker delegation and medium effort
when it constructs a fanout plan. Internal Sol planning uses low for an explicit independent path
partition, high for difficult algorithm, architecture, security, cryptography, consensus, or race
condition planning, and medium otherwise. This keeps expensive reasoning on semantic decisions
that need it without charging high effort for obvious partitions.

When a low-risk objective explicitly names independent roots, requires no capability assignment,
and the workspace is read-only or a clean Git repository, the strict Sol schema contains only the
path groups. The runtime fixes empty dependencies, Luna defaults, a bounded duration, low risk, and
deterministic integration. Sol still chooses the semantic partition; it does not spend output
tokens repeating mechanical defaults. Dirty or non-Git writer tasks and dependency-bearing DAGs
cannot use this profile.

Host tasks with no explicit tier floor are bounded Luna work and default to low effort. A
`floor=terra` or `floor=sol` remains authoritative. The host protocol carries only `goal`, `paths`,
numeric dependency indexes, and `floor`; the runtime, not Sol, supplies repetitive transport and
policy fields.

The initial Sol turn returns a strict compact wire plan. The router selects a useful 2-5 leaf
ceiling before this turn and binds that ceiling into Sol's output schema. Sol supplies only the
semantic partition, tier floors, dependency indexes, capability indexes, expected durations, risk,
and merge choice; TypeScript derives repetitive execution fields. The planner receives the user
objective, domain, constraints, a bounded relevant-file index, relevant capability keys, compact
model economics, route, and leaf ceiling. It does not receive cwd, key-file excerpts, full domain
recipes, or the complete execution-limit object.

After deterministic admission has already selected fanout, the outer MCP host performs only an
exact tool call and fixed acknowledgement, so the benchmark and cost model use Luna for that
dispatch. A direct decision still routes the real task to Luna or Terra by difficulty. This keeps
the outer envelope from costing more than the work it dispatches.

When capability admission created a Terra thread, it is reused for semantic integration. The
original Sol planner identity is reused for the single allowed `PlanPatch` and for a risk-triggered
final review. App Server resumes the provider thread. Responses restores the synthetic identity and
sends a self-contained compact prompt, so process recovery never falls back to an App Server Sol
thread.

## ExecutionPlan Contract

An `ExecutionPlan` contains:

- a protocol version, plan ID, objective, domain, assumptions, and risk;
- leaf objective, domain, tier, effort, access, and owned paths;
- explicit dependencies and allowed communication peers;
- requested skills or plugins;
- focused validators;
- expected duration and optional expected cost;
- difficulty, ambiguity, confidence, and criticality;
- required final outputs, aggregate validation, and final-review policy.

The plan is parsed against a strict JSON schema and then checked as a graph. Validation rejects
unknown fields, duplicate IDs, missing dependencies, cycles, unsupported tier/effort pairs,
ownership conflicts, unjustified fanout, excessive waves, missing cost estimates under a cost
ceiling, and other violations before workers start.

Terra and the scheduler cannot silently reinterpret the semantic contract. Changing an objective,
dependency, ownership boundary, or integration contract requires a Sol `PlanPatch`.

## Deterministic Scheduling

The scheduler repeatedly computes ready DAG nodes and starts up to `maxConcurrent` leaves with
`Promise.all`. It joins each concurrently launched batch, retains successful sibling results, and
schedules only dependencies that completed successfully.

Default foreground limits are:

| Limit                 | Default | Foreground max | Durable max |
| --------------------- | ------: | -------------: | ----------: |
| Concurrent leaves     |       5 |              5 |           5 |
| Total leaves          |       8 |              8 |          20 |
| Dependency waves      |       3 |              3 |           3 |
| Sol specialist leaves |       1 |              1 |           1 |
| Sol replans           |       1 |              1 |           1 |

The public schema accepts the durable ceiling, while the service rejects foreground requests above
eight leaves. Durable auto-research runs are the intended users of the larger ceiling. A deadline
or USD budget can further constrain the run. Plan validation checks predicted bounds, and the
scheduler checks observed usage before starting more work.

A leaf that fails specifically because its reasoning was insufficient can be promoted once:
`Luna -> Terra -> Sol`. A mechanical validator repair promotes Luna only to Terra-medium. In both
cases only the failed leaf reruns; completed siblings and their evidence remain available. The
Sol-leaf ceiling still applies.

A validator that cannot execute because `command/exec`, bubblewrap, or another runtime dependency
failed is classified as `transient`, not as evidence that the leaf reasoned incorrectly. It causes
neither model promotion nor Sol replanning. Permission, contract, and indeterminate failures are
also not treated as reasons to rerun everything on a stronger model.

## Model Routing

The planner selects semantic minimum tiers from task difficulty, ambiguity, coupling, validator
strength, configured economics, optional latency history, and the cost ceiling. Runtime policy then
chooses the cheapest sufficient effective tier. A conservative Terra hint can become Luna when the
leaf is bounded and strongly validated; explicit `minTier` prevents an unsafe downgrade.

| Work shape                                                             | Default tier | Allowed effort |
| ---------------------------------------------------------------------- | ------------ | -------------- |
| Search, extraction, data processing, mechanical edits, focused tests   | Luna         | low, medium    |
| Cross-file semantic reasoning, difficult debugging, synthesis          | Terra        | medium, high   |
| Difficult algorithms, architecture, security, hidden correctness risks | Sol          | high, xhigh    |

The default model map is `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`. Providers, service
tier, model names, and prices are configurable, but the planner role itself remains Sol.

## Replanning

Routine status checks, waits, timeout observation, and ordinary retry bookkeeping never wake Sol.
The scheduler may request one `PlanPatch` only when deterministic evidence identifies a semantic
problem:

- an incomplete contract or missing required output;
- a blocker on a critical task;
- a material result conflict;
- a non-mechanical validator failure;
- confidence below 0.7 on a critical leaf;
- elapsed time or cost more than 30% above its estimate;
- an integration scope change;
- a high-risk output without reliable validation.

A patch can add, replace, or cancel affected tasks and can update the integration contract. The
result is revalidated against total leaves, waves, concurrency, Sol-leaf count, deadline, cost, and
already completed work. The patch prompt reports remaining capacity and directs Sol to replace a
failed task under the same ID instead of adding a parallel replacement. Same-ID replacements keep
their prior attempt count, preventing a second promotion cycle. A patch that exceeds leaf capacity
consumes the one replan slot but does not erase terminal evidence; other invalid semantic patches
still fail closed. Completed unaffected leaves are not rerun.

## Communication

Leaves do not have free point-to-point chat. Codex App Server 0.151.0 does not honor
`thread/start.dynamicTools`, so V3 does not advertise a model-side `agent_message` function that
would work only in fake tests. Sol expresses required information flow as DAG dependencies. The
scheduler injects each completed predecessor's compact summary, findings, changed files, artifact
references, citation evidence, confidence, and aggregate validator status into the dependent leaf.

Independent same-wave leaves remain isolated. A contract change or critical blocker is reported in
the leaf result and can trigger the one allowed `PlanPatch` on the same Sol planner thread. This
keeps communication executable on the pinned protocol and avoids extra chat turns.

There is no polling conversation, broadcast discussion, coordinator babysitting, or user
continuation gate.

## Observability

Every App Server created by the production runtime is subscribed once for `turn/*`, `item/*`, and
thread usage notifications. Remote-turn checkpoints provide the `runId`, role, task, thread, and
turn mapping; the monitor recorder then appends only matching events to that run's
`monitor.jsonl`. This path is observational and never feeds content back into a model.

The recorder uses a bounded 250 ms asynchronous batch, a 2 MiB pending-memory ceiling, a 128 KiB
per-event ceiling, and a 24 MiB per-run log ceiling. Consecutive delta notifications with the same
method, thread, turn, and item ID are merged before serialization. Delta events are the first events
dropped when the pending buffer is full. Job lifecycle and recovery continue independently if
monitor capture or presentation fails.

A detached loopback HTTP process reads `job.json` and monitor events on demand. Its SSE endpoint is
woken by filesystem notifications, and event history is paged by byte cursor. The read path also
coalesces adjacent legacy delta records, while the browser joins pages by logical App Server item ID
and renders conversation entries rather than token fragments. The process is shared by foreground,
submitted, MCP, and CLI runs under one job root. It adds no model tokens, App Server turns,
reviewers, scheduler gates, or orchestration heartbeat.

## Workspaces

Read-only leaves share the request workspace. Writer behavior depends on repository state:

- dirty or non-Git workspace: at most one writer, operating directly in the original workspace;
- clean Git repository: every writer uses a detached temporary worktree, including a single writer.

By default, worktree state is placed under
`/tmp/agent-trio-v3-<uid>/workspaces/<workspace>/<run>/worktrees`, outside both the delivered tree and
the repository's `.git` directory. This matters because App Server validators run through
bubblewrap: a worktree nested under `.git` can be visible through a read-only mount and make every
`command/exec` validator fail before the command starts. A configured state root must likewise stay
outside the delivered working tree.

Concurrent writers must declare non-overlapping owned paths. After successful leaves finish, V3
creates binary patches, verifies that changed paths stay within ownership, and validates their
combined state in an isolated snapshot. When a final Sol review is required, the main workspace is
left untouched until that review succeeds. V3 then preflights all patches and applies them
transactionally. A rejected review discards the temporary worktrees. Overlapping patches are
allowed only when the plan explicitly orders their writers by dependency; unordered overlap is
rejected instead of being merged by guesswork.

A dirty or non-Git writer cannot provide this delayed-apply guarantee because it runs in the
original workspace. V3 limits that case to one writer and never blindly replays it during recovery.
The durable snapshot sets `workspaceCommitState=pending` before any writer plan can run and changes
it to `applied` only after workspace integration returns successfully. Recovery treats a completed
writer outcome with missing or pending commit evidence as `indeterminate`.

## Domain Recipes

The planner receives a small recipe selected from the request domain; it does not load one large
workflow for every task:

- coding groups tightly coupled edits and splits independent modules by file ownership;
- algorithms can separate specification/proof, implementation, and property testing;
- research splits non-overlapping source queries and returns compact claims with citations;
- papers keep one manuscript owner while parallelizing evidence or section analysis;
- office work keeps one artifact owner and loads only the needed document, sheet, or slide
  capability;
- auto research permits query, gather, follow-up, and synthesis stages within three waves.

These recipes guide Sol's plan but do not bypass schema, budget, workspace, or capability checks.

## Capabilities And Recursion Isolation

The planner sees a capability catalog from App Server `skills/list` and, only when explicitly
enabled, `plugin/installed`. Terra admission receives the compact form described in the direct
path. A leaf receives only capabilities named in its plan. Both Agent Trio user skills are always
forbidden.

Plugin support is opt-in through `AGENT_TRIO_ALLOW_PLUGINS=1`. An explicitly requested plugin, or
a skill owned by a plugin, selects a separate App Server process. The resolver rejects disabled,
missing, ambiguous, or unplanned capabilities instead of falling back silently.

Isolation is turn-scoped. An explicit plugin can be consumed in the admission turn; a plugin chosen
by Terra is resolved during admission but its process is created only when direct execution starts.
Owned processes close after the turn, so the coordinator never parks an unused plugin process
between admission and execution.

Every child thread:

- disables native multi-agent functionality;
- disables project instruction loading;
- disables `agent_trio`, `hierarchical_codex`, and the legacy mission-ledger MCP server;
- rejects instruction sources that still contain recursive orchestration directives;
- uses `approvalPolicy=never` by default, or `on-request` with `auto_review` for execution work when
  the caller uses Approve for me;
- lets direct/coordinator and leaf execution inherit the per-run `hostAccess`, with Full access
  mapped to `danger-full-access` and read-only callers forced to `read-only`;
- lets those execution threads inherit per-run `hostApproval`, without changing the separately
  restricted planner, integration, review, and deterministic validator scopes;
- cannot ask the user to send `ok`, `continue`, or an internal readiness signal.

The MCP protocol carries `hostAccess=readOnly|workspaceWrite|fullAccess` and
`hostApproval=never|approveForMe` because MCP does not expose the calling Codex sandbox or approval
mode as standard tool metadata. Both user skills copy the active host modes and must not raise
either. Omitted values preserve the original role-specific workspace and non-approving behavior.
Both fields are stored in the durable run request and reused for leaf retries and resume turns.
`approveForMe` maps exactly to App Server `approvalPolicy=on-request` and
`approvalsReviewer=auto_review`. Semantic planner, integration, review, and deterministic validator
sandboxes remain independently restricted.

The process boundary is isolated as well. `createDefaultRuntime()` starts internally-created App
Server processes with a lazily-created projected `CODEX_HOME`: when the caller's home has
`auth.json`/`config.toml`, only those explicitly selected files are symlinked; otherwise a minimal
temporary config is used. The directory is reused across reconnects and removed by
`runtime.close()`. This prevents a global `~/.codex/AGENTS.md` or MCP registration from entering a
child process. The low-level `createCodexAppServerConnectionFactory()` keeps `inherit` as its
backwards-compatible default; callers can select `codexHomeIsolation: { mode: "explicit", path }`
for an owned home, or the explicit `projected` mode with a chosen `sourceHome`/`files` list.
Projection never reads or copies credential bytes, and it never removes the source files. Set the
runtime's `AGENT_TRIO_CODEX_HOME_MODE=temporary` when a deliberately credential-free process is
required; authentication then must come from an environment-provided API key.

## Integration And Review

Leaves self-test against their local validation contract. Low-risk, independent, read-only results
with no review requirement are reduced locally from structured results; this uses no model turn.
Other plans use one Terra semantic integration turn and aggregate validation. There is no default
reviewer or producer/verifier ceremony.

Sol final review is optional. It runs on the existing planner thread when the integration contract
requests it, or when risk evidence requires it: high plan risk, a Sol `PlanPatch`, non-passing
aggregate validation, failed leaf validation, or low confidence on a critical leaf. It is not
inserted into every fanout. For clean Git writers, it completes before isolated patches are applied
to the user's workspace.

## Persistence And Recovery

Each run has a small directory containing `job.json`, `events.jsonl`, and a process lock. Snapshot
writes use a private temporary file, `fsync`, and atomic rename. The request hash makes a caller's
`runId` idempotent only for the identical request.

CLI and MCP `submit` each start one detached supervisor and wait for an IPC acknowledgement after
the first snapshot exists. The supervisor then waits for that same run and exits independently of
the submitting process. There is no daemon database, lease renewer, heartbeat loop, or separate
workflow state machine.

Explicit foreground skill invocations use a Monitor-first variant of that handshake. MCP
`submit(monitorFirst=true)` asks the supervisor to execute the ordinary foreground `run` contract,
returns the first persisted snapshot and Monitor URL, and leaves execution running in that same
operation. One subsequent `status(wait=true)` call watches `job.json` and returns when the run is
completed, failed, cancelled, waiting for input, or indeterminate. The watcher closes the
read-before-watch race with an immediate second snapshot read. This changes presentation timing,
not admission, planning, scheduling, budgets, leaf limits, integration, or review policy, and it
does not poll a model or filesystem.

Snapshots record App Server thread and turn IDs at `thread_started`, `running`, and confirmed
`terminal` states. Recovery attempts to resolve those IDs through App Server. Read-only turns can
be observed to completion only while the underlying Codex state remains available. A writer with
uncertain remote state is never blindly replayed, because duplicate side effects are less
acceptable than an `indeterminate` result.

When a terminal admission, direct, leaf, or integration turn returns `waiting_input`, its bounded
continuation checkpoint records the original thread, prior turn, workspace, capabilities, and
blocked condition. `resume --input` reattaches that thread and starts exactly one new continuation
turn. Completed siblings are retained, dependents remain blocked until the continued leaf
completes, and writer workspaces are committed only after aggregate validation and any required
final review succeed.

Non-leaf usage is associated with stable thread/turn keys. Recovery marks usage already present in
each stage and appends only newly checkpointed continuation usage. A terminal remote turn whose
usage cannot be attributed remains a hard-budget failure instead of being hidden by older usage in
the same stage.

## Cost Accounting

The default OpenAI model map loads the bundled standard-context price table. Custom providers or
model names require an override price table, and hard `maxCostUsd` requests fail closed if any
routed model is unpriced. App Server usage is
authoritative when it supplies USD totals after a turn. Otherwise the user price table maps
actual model names to uncached input, cached input, cache-write input, and output rates:

```text
estimated cost =
    uncached input tokens * input rate
  + cached input tokens   * cached rate
  + cache-write input tokens * cache-write rate
  + output tokens         * output rate
```

Planning, patching, leaf work, integration, and optional final review are all included. Release
benchmark evidence must report Sol planning separately so an optimization cannot hide expensive
coordination inside the aggregate.

## Public Boundary

Local Codex clients expose exactly one MCP tool, `agent_trio`, with `run`, `submit`, `status`,
`resume`, and `cancel` actions. The CLI provides the same five operations plus `benchmark`. Both
call the same `AgentTrioService`; neither reimplements scheduling policy.

The public tool also accepts two action-scoped presentation flags: `monitorFirst` only on `submit`,
and `wait` only on `status`. Together they let a client render the Monitor before waiting for a
foreground-equivalent result without exposing another tool or scheduling path.

The user installer registers that MCP server and installs two user skills. `$agent-trio` delegates
one explicitly selected turn. `$agent-trio-session` permits implicit selection only for related
follow-ups after it was explicitly invoked in the same conversation; completed follow-ups start a
new run with compact prior context, while `waiting_input` continues the existing run. Both skills
are excluded from child capability discovery. V3 installs no model profile, hook, or global
`AGENTS.md` instructions, and it does not change the user's selected root model.

## Explicit Non-Goals

V3 intentionally excludes:

- a mission/task ledger or SQLite workflow;
- leases, heartbeats, claims, evidence gates, and mandatory reviewers;
- model-driven status polling or launch loops;
- recursive use of Agent Trio by child threads;
- automatic user-scope installation;
- performance claims before the frozen paired A/B suite passes.
