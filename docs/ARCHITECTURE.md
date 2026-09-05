# Agent Trio V3.5 Architecture

## Objective

Agent Trio V3.5 exposes two policies over the same runtime: `balanced` minimizes elapsed time and
actual model cost while staying close to a direct `gpt-5.6-sol/ultra` baseline; `quality` preserves
the wider, always-delegate V3.3 policy. Both separate semantic decisions from execution mechanics:

- Sol decides how a complex task should be decomposed and which model tier each package needs.
- TypeScript handles the bounded direct fast path, validates hard execution constraints, decides
  when a ready package starts, joins dependencies, and stops at explicit limits.
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

### Semantic Routing

```text
balanced Sol host -> root completion -----------> no runtime call
                  |-> direct + tier ------------> one execution agent
                  `-> fanout + semanticPlan ----> validated 2-3 leaf DAG

quality Sol host  -> direct + tier -------------> one execution agent
                  `-> fanout + semanticPlan ----> validated 2-5 leaf DAG

CLI / uncertain caller -> deterministic direct fast path
                       `-> one adaptive Sol turn -> one agent or DAG
```

The local router returns one of:

- `direct` when host Sol selects one execution agent or the positive fast path proves a small,
  bounded single objective;
- `fanout` when host Sol supplies a semantic plan or explicit fanout is requested;
- `adaptive` when one internal Sol turn must choose between a single task and a profile-bounded DAG;
- `waiting_input` when real permission or external information is missing.

A runtime direct result does not start Sol Planner or fanout leaves. A balanced skill may instead
finish one bounded deliverable or an indivisible Sol task in the root without calling MCP; quality
always delegates. Balanced selects a single worker only with at least three matching historical
samples predicting no more than 40% of direct Sol cost and 100% of its latency. Without that
evidence the host Sol retains the task.
The zero-model runtime fast path is positive, not exhaustive: it recognizes only clearly bounded
single-objective work. Prompt length, Chinese character count, domain, and decomposition keywords
do not prove direct or fanout. All uncertain medium or larger `auto` requests go to adaptive
internal Sol planning.

Bounded coding/general direct tasks use Luna. Difficult algorithmic, research, architectural, and
security-sensitive coupled work uses Terra; bounded exact calculations remain on Luna.

Caller-selected skills are supplied as structured App Server inputs during admission, so Terra can
finish a small document or office task in that first turn. Without an explicit selection, Terra
sees a compact capability catalog: unique skill names omit paths, while duplicate names retain paths
for deterministic disambiguation. Terra may request only exact catalog entries for its one direct
continuation; the resolver remains authoritative and rejects unavailable or disabled capabilities.

### Planned Execution

```text
host semanticPlan or adaptive Sol micro-plan
      |
      v
validate hard constraints -> prepare workspaces -> run DAG
                                                  |
                                                  v
                       local reduction or Terra integration + validation
                                                  |
                                                  v
                                  anomaly-only lazy Sol PlanPatch
                                                  |
                                                  v
                                  apply isolated writer patches
```

Cost and latency projections compare the complete candidate path against direct
`gpt-5.6-sol/ultra`. Matching historical p50/p95 data supplies the direct baseline; an independent
cold projection is used when no history exists. Host-declared leaf durations affect only the DAG
critical path and cannot inflate that baseline. Three or more matching signature samples use hard
40% cost and 70% latency limits. Without history, fanout requires distinct paths, sources, or named
work units and must pass conservative 30% cost and 55% latency limits. Pricing or workload evidence
that cannot support either calculation downgrades the submitted request to one cheapest sufficient
worker. Quality bypasses these Balanced economic checks unless `maxCostUsd` is explicit.

All profiles still reject permission mismatch, cycles, unsafe concurrent write ownership, explicit
limits, fewer than two useful concurrently runnable leaves, or no structural critical-path saving.
Balanced additionally rejects more than one Terra execution node and three-leaf plans without 120
seconds of total work and at least 20% improvement over the best two-leaf grouping.

There are two Sol entry paths. In Desktop, VS Code, and interactive CLI, the current root Sol can
supply the compact `semanticPlan` directly with the `agent_trio` call. The runtime expands IDs,
effort, and scheduler fields mechanically and adopts low/medium/high-risk, dependency-bearing,
multi-wave, deterministic or Terra-integrated plans with zero additional planning usage. The host
skill limits these tool arguments to 350 tokens without plan narration. Internal Responses
execution plans use the same 350-token output cap. The host session has a logical
`external:<runId>` ID. It creates no internal Sol thread during normal execution.

If a leaf reports a blocker or contract change, results materially conflict, a non-mechanical
validator fails, or confidence becomes too low, the first PlanPatch request lazily starts one real
internal Sol thread. That continuation receives the host plan, completed results, and trigger and
may change only affected work. Its thread ID is persisted for recovery. Successful tasks are never
replayed merely because the continuation was created.

The internal planner has two transports. The default `auto` mode resolves a Responses-compatible
provider from explicit environment variables or the active local Codex configuration and auth,
then falls back to App Server. Responses sends only the compact planner prompt, reasoning effort,
and strict JSON schema, with no executable tools or Codex skill catalog. Plan and patch prompts are
self-contained, so the transport can keep local thread identity without storing provider-side
responses.

The root Sol chooses the semantic route before its tool call at the root session's current effort;
the paired harness uses medium because that same turn may directly execute a bounded task. Only
Balanced internal adaptive planning uses low effort by default. Difficult algorithm, architecture,
security, cryptography, consensus, or race-condition planning still uses high effort. Quality uses
medium effort for ordinary coupled planning. This keeps expensive reasoning on semantic decisions
that need it without charging another planner turn after a valid host plan.

When a low-risk objective explicitly names independent roots, requires no capability assignment,
and the workspace is read-only or a clean Git repository, the strict Sol schema contains only the
path groups. The runtime fixes empty dependencies, Luna defaults, a bounded duration, low risk, and
deterministic integration. Sol still chooses the semantic partition; it does not spend output
tokens repeating mechanical defaults. Dirty or non-Git writer tasks and dependency-bearing DAGs
cannot use this profile.

Balanced host tasks with no explicit tier floor are Luna work. Read-only analysis, evidence,
extraction, and preparation remain Luna even when the parent task is office, review, recovery, or
synthesis. Terra is assigned only from that leaf's own coupled reasoning or writer contract, and a
Terra merge consumes the same one-node allowance. Explicit `floor=terra` and `floor=sol` remain
authoritative, but a plan that exceeds the one-Terra-node or one-Sol-leaf limit is inadmissible. Sol
is reserved for a clearly difficult algorithm, security, or concurrency package. The protocol carries only
`goal`, `paths`, numeric dependency indexes, and `floor`; the runtime supplies repetitive fields.

The adaptive Sol turn returns a strict compact wire plan within the active profile ceiling. One
task becomes `planned_single`; multiple tasks become a DAG. Balanced defaults to two leaves, uses a
30-second leaf floor and at least 90 seconds of serial work, and permits a third leaf only with 120
seconds total plus the 20% critical-path gain. Quality
uses the V3.3 15-second floor and wider ceiling. Sol supplies domain when the caller did not, semantic
partition, tier floors, dependency indexes, capability indexes, expected durations, risk, and merge
choice; TypeScript derives repetitive execution fields. The planner receives the user objective,
constraints, a bounded relevant-file index, relevant capability keys, compact model economics, and
execution ceilings. It does not receive cwd, key-file excerpts, full domain recipes, or an
unbounded workspace dump.

When capability admission created a Terra thread, it is reused for semantic integration. Internal
plans reuse their planner identity for the single allowed `PlanPatch`; host plans lazily create and
then reuse a continuation identity only after a real anomaly. Responses restores the synthetic
identity and sends a self-contained compact prompt, so process recovery never substitutes a
different planner transport.

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

Profile limits are:

| Limit                 | Balanced foreground | Balanced durable | Quality foreground | Quality durable |
| --------------------- | ------------------: | ---------------: | -----------------: | --------------: |
| Concurrent leaves     |                   3 |                3 |                  5 |               5 |
| Total leaves          |                   3 |                5 |                  8 |              20 |
| Dependency waves      |                   3 |                3 |                  3 |               3 |
| Sol specialist leaves |                   1 |                1 |                  1 |               1 |
| Sol replans           |                   1 |                1 |                  1 |               1 |

The public schema accepts the quality durable ceiling, but the service applies the selected profile
and mode before any worker starts. A deadline or USD budget can further constrain the run. Plan
validation checks predicted bounds, and the scheduler checks observed usage before starting more
work.

### MCP Request Boundary

The single public `agent_trio` tool advertises only canonical request fields. Direct execution uses
`directTier`; capabilities use structured references; limits are nested; and fanout plan fields live
inside `semanticPlan`. Before strict parsing, the server normalizes only a bounded set of known,
semantically unambiguous legacy shapes seen in real clients. This compatibility pass is local code:
it starts no model turn and adds no token, latency, or storage overhead beyond parsing one small
request object. Duplicate representations must agree after normalization. Conflicting permissions,
tiers, limits, capabilities, envelope fields, or plan fields fail before a run is created.

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
| Recovery/stateful work, coupled debugging, semantic merge/final writer | Terra        | medium, high   |
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

Snapshots and both Monitor views expose `routeEvidence` (`history`, `structural_cold_start`, or
`unavailable`) and `routeAdjustment` (`none`, `reduced_to_two`, or `downgraded_to_single`). They also
show proposed versus selected leaf count, selected tier distribution, and the exact downgrade
reason. Legacy snapshots omit these optional fields and remain readable.

The recorder uses a bounded 250 ms asynchronous batch, a 512 KiB pending-memory ceiling, a 16 KiB
per-event ceiling, and an 8 MiB per-run log ceiling. Token delta notifications are discarded;
completed App Server items provide one durable record per message, reasoning item, command, tool
call, or file change. Job lifecycle and recovery continue independently if monitor capture or
presentation fails.

The primary presentation is an MCP Apps resource attached to `agent_trio`. It renders inside the
host conversation and calls the same tool with a byte cursor, snapshot revision, and bounded long
poll timeout. These component-originated calls do not enter model context. A detached loopback HTTP
process remains as the CLI and non-MCP-Apps fallback. It pages the same files by byte cursor and uses
filesystem-driven SSE. Both paths add no model tokens, App Server turns, reviewers, scheduler gates,
or orchestration heartbeat.

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

For an office or other staged plan with one final Terra writer that depends on every preparation
leaf, deterministic reduction returns that writer's result directly. It does not start a second
Terra integration turn.

Sol final review is optional and is not inserted into every fanout. A host plan, including a
high-risk host plan, does not receive an eager review merely because of its risk label; real anomaly
evidence first goes through the single lazy `PlanPatch`. An internal plan may explicitly request a
review through its integration contract. For clean Git writers, any requested review completes
before isolated patches are applied to the user's workspace.

## Persistence And Recovery

Each run has a small directory containing `job.json`, `events.jsonl`, and a process lock. Snapshot
writes use a private temporary file, `fsync`, and atomic rename. The request hash makes a caller's
`runId` idempotent only for the identical request.

CLI and MCP `submit` each start one detached supervisor and wait for an IPC acknowledgement after
the first snapshot exists. The supervisor then waits for that same run and exits independently of
the submitting process. There is no daemon database, lease renewer, heartbeat loop, or separate
workflow state machine.

Explicit foreground skill invocations generate a unique run ID and issue
`submit(monitorFirst=true)`. The detached foreground supervisor returns after its first durable
snapshot, allowing the attached MCP Apps resource to mount near the start of execution. The skill
then issues exactly one `status(wait=true)` call only when submit succeeds and returns the same run
ID; an MCP/tool error stops the sequence without querying a nonexistent run. That status call waits
on persisted state and starts no model work. The component's cursor-based `status` long polls are
component traffic, not model turns.

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

The public tool accepts action-scoped foreground presentation flags: `monitorFirst` only on
`submit`, and `wait` only on `status`. The embedded component uses cursor, revision, and long-poll
fields on `status`; they do not expose another tool or alter execution semantics.

Canonical tool arguments are flat top-level fields. The parser normalizes one compatibility
envelope shaped as `{ request: { ...flat fields... } }`, because some hosts may synthesize that
wrapper despite the schema. The wrapper is not advertised, cannot be combined with top-level
fields, and cannot be nested recursively. `risk` and `merge` are plan-only fields nested inside a
fanout `semanticPlan`. The boundary also normalizes valid misplaced hints: direct/auto calls discard
them, while fanout calls move them into a plan only when they do not conflict with an existing plan
value. Neither compatibility form is advertised in the public schema.

The user installer registers that MCP server and installs two user skills. `$agent-trio` delegates
one explicitly selected turn. `$agent-trio-session` permits implicit selection only for related
follow-ups after it was explicitly invoked in the same conversation; completed follow-ups start a
new run with compact prior context, while `waiting_input` continues the existing run. All four
Agent Trio skills are excluded from child capability discovery. V3 installs no model profile, hook, or global
`AGENTS.md` instructions, and it does not change the user's selected root model.

The installed MCP command enters through `dist/mcp/launcher.js`. Before constructing the runtime,
the launcher reads assignment-style `*.env` files from the installed Codex home into its process
environment. App Server workers already inherit that environment, so custom-provider credentials
cross the desktop/VS Code MCP process boundary without appearing in `config.toml`. The loader treats
files as data and never evaluates shell commands.

## Explicit Non-Goals

V3 intentionally excludes:

- a mission/task ledger or SQLite workflow;
- leases, heartbeats, claims, evidence gates, and mandatory reviewers;
- model-driven status polling or launch loops;
- recursive use of Agent Trio by child threads;
- automatic user-scope installation;
- performance claims before the frozen three-arm suite passes.
