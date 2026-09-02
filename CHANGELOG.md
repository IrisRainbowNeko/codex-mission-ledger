# Changelog

## [3.2.0] - 2026-09-01

### Added

- A local Agent Trio Monitor that shows the live DAG, stage and leaf status, model usage, cost,
  App Server messages, reasoning summaries, tool calls, commands, file changes, and validation
  activity without adding model turns.
- Event-driven SSE updates and incremental history reads for ChatGPT desktop, Codex IDE, and CLI
  users through the `monitorUrl` returned by the existing `agent_trio` tool.
- Bounded asynchronous monitor capture with a 2 MiB pending-memory ceiling and a 24 MiB per-run
  event log. The monitor runs on loopback with a private per-job-root token.

### Changed

- MCP assigns the run ID before execution and reports the Monitor URL through progress
  notifications when the client supplies a progress token.
- Explicit foreground skill calls now use `submit(monitorFirst=true)` followed by exactly one
  `status(wait=true)` call. This exposes the Monitor before completion while preserving the normal
  foreground execution contract; settlement waiting uses filesystem events and no model turns.
- CLI results print the Monitor URL. The monitor service is shared across Agent Trio processes and
  reads durable job snapshots, so foreground and submitted runs use the same view.
- Monitor capture now coalesces consecutive deltas for the same App Server item in a bounded 250 ms
  batch, and the event API coalesces legacy logs while reading them. This prevents token-sized JSON
  records from multiplying storage and browser object counts.
- The Monitor conversation renders one entry per logical message, reasoning item, command, file
  change, or tool call. Completed messages replace partial content, command output is collapsible,
  and internal protocol noise is omitted from the conversation view.

### Fixed

- Direct/coordinator threads and execution leaves now inherit the calling Codex task's explicitly
  supplied permission mode. Full access enables App Server `danger-full-access` and network access;
  read-only forces child execution read-only; persisted retries and resumes retain the same mode.
- The explicit skill passes the active permission mode without escalation. MCP and CLI callers can
  provide the same per-run context through `hostAccess` and `--host-access`.
- Direct/coordinator threads and execution leaves now also inherit Approve for me through per-run
  `hostApproval`. The runtime maps it to App Server `on-request` plus `auto_review` on thread start,
  resume, and turn start; durable retries and resumes retain the same mode.
- The explicit skill copies the active approval mode without escalation. MCP and CLI callers can
  provide it through `hostApproval` and `--host-approval`.

## [3.1.1] - 2026-09-01

### Fixed

- MCP clients that do not implement workspace roots can run Agent Trio with an absolute,
  resolvable `cwd`; clients that advertise roots remain strictly confined to them.
- The explicit `$agent-trio` skill now stops on an MCP integration error instead of silently
  completing the task through the root model.
- Removed CLI version probing and `initialize.userAgent` version gates. Compatibility now follows
  actual App Server protocol behavior instead of unreliable version strings.

## [3.1.0] - 2026-09-01

### Changed

- Explicit low-risk independent roots now use a boundary-only Sol schema. Sol returns only the
  path partition; TypeScript supplies independent dependencies, Luna defaults, duration, risk,
  and deterministic integration. Ordinary and dependent DAGs keep the full semantic protocol.
- Mechanical MCP dispatch after deterministic fanout admission now uses Luna. Direct fast-path
  turns still choose Luna or Terra from task difficulty.
- Low-complexity office writer leaves use Luna-low; coding writers and exact algorithms retain
  Luna-medium.
- The frozen dossier validator accepts an equivalent `Rank: #1, the only eligible applicant`
  form instead of treating correct eligibility work as a quality failure.
- Added the host-Sol fast path: a compact caller-supplied semantic plan skips the second Sol
  planner, disables replanning, and uses deterministic reduction for low-risk fanout.
- Clear host-planned Luna leaves now use low effort; explicit Terra and Sol floors remain
  unchanged.
- The real paired runner now evaluates both arms on one warm root thread and uses
  `thread/revert` between arms, avoiding unreliable sibling-fork cache affinity.
- Benchmark quality now has a 60-point absolute floor, so equal low-quality outputs cannot satisfy
  the relative quality gate.
- Replaced routine Terra admission with a zero-model economic router. Automatic fanout now requires
  both the 40% cost and 70% latency estimates to pass; callers can still force direct or fanout.
- The router selects a 2-5 leaf ceiling before Sol planning, and that ceiling is applied to the
  strict output schema so oversized plans do not consume tokens before runtime compaction.
- Luna is the default effective worker for bounded, validated leaves. Terra and Sol remain semantic
  minimums for work that actually needs stronger reasoning.
- Bounded direct coding/general work now uses Luna, while difficult and capability-dependent direct
  work remains on Terra.
- Low-risk independent read-only results can use deterministic reduction instead of a Terra
  integration turn. Leaves without communication edges no longer load the message tool.
- Planner workspace context, JSON prompts, leaf contracts, dependency payloads, and non-leaf budget
  envelopes are smaller.
- The default OpenAI model map loads the bundled standard-context price table; custom model names
  still require explicit pricing.
- Validator infrastructure failures are now reported as transient runtime failures. They do not
  promote a Luna leaf, wake Sol for a semantic replan, or rerun successful sibling leaves.
- A real validation failure retries only its failed leaf once. Same-ID `PlanPatch` replacements
  retain the attempt count, and a capacity-invalid patch is consumed without discarding terminal
  leaf evidence.
- Clean-Git worktrees now live under a private temporary runtime root by default instead of inside
  the repository's `.git` directory, keeping App Server `command/exec` compatible with bubblewrap.
- Writer worktrees survive plan updates that change execution metadata without changing ownership,
  dependencies, access, or the workspace contract.
- Completed leaf status now wins over provider-filled nullable failure placeholders, while malformed
  terminal writer payloads retain already captured model usage and timing in indeterminate results.

### Added

- An explicit-only `$agent-trio` user skill that delegates exactly once to the V3 MCP tool across
  ChatGPT desktop, Codex IDE, and Codex CLI surfaces.
- Paired installer, uninstaller, manifest, and doctor coverage for the MCP registration and its
  user skill.
- Strongly typed `thread/fork`, `thread/inject_items`, and `thread/revert` App Server bindings.
- A non-empty coding diagnostic corpus covering a local direct task and a ten-module fanout task.
- `strategy=auto|direct|fanout` on the MCP and CLI run requests.
- Route decisions and skipped planner/integration stages in result metrics.

## [3.0.0] - 2026-08-29

### Added

- A TypeScript runtime over the `codex-cli 0.151.0` App Server schema.
- Terra admission with a direct fast path and ordinary result integration.
- Sol-generated, strict `ExecutionPlan` and one optional same-thread `PlanPatch`.
- A deterministic three-wave DAG scheduler with five-way concurrency, deadline and cost limits,
  bounded communication, and one-step model escalation.
- Luna, Terra, and at most one Sol specialist leaf through concurrent App Server turns.
- Clean-Git worktree isolation for disjoint parallel writers and single-writer enforcement for
  dirty or non-Git workspaces.
- Delayed application of isolated writer patches until aggregate validation and any required Sol
  final review succeed.
- Atomic job snapshots, remote thread/turn checkpoints, safe conditional reattachment,
  cancellation, and a detached per-job supervisor for CLI and MCP durable submissions.
- Same-thread `waiting_input` continuation for Terra admission/direct work, leaves, and Terra
  integration, with optional bounded resume input and writer workspace retention.
- Stable remote-turn usage attribution so continuation costs are neither omitted nor counted
  twice across repeated recovery.
- A single public `agent_trio` MCP tool with `run`, `submit`, `status`, `resume`, and `cancel`.
- Matching `agent-trio run/submit/status/resume/cancel/benchmark` CLI commands.
- App Server usage accounting with a user-configured price-table fallback.
- Exact skill/plugin capability discovery, opt-in plugin support, and isolated App Server
  processes for plugin-owned capabilities.
- An 18-family paired A/B evaluator covering coding, algorithms, research, papers, office work,
  and auto research.

### Changed

- Complex planning is owned by Sol; Terra is limited to admission, direct work, and routine
  integration.
- Scheduling code now controls launches, dependencies, joins, budgets, recovery, cancellation, and
  message routing without changing the plan's semantic boundaries.
- The normal critical path is Sol planning, parallel leaves, Terra integration, and optional
  risk-triggered review on the same Sol thread.
- User installation now registers only `[mcp_servers.agent_trio]`. It does not change the root
  model, native agents, skills, hooks, profiles, or global `AGENTS.md`.
- Legacy V1 and V2 configuration is removed surgically after backup while unrelated user settings
  are retained.

### Removed

- The V2 prompt-only skill, model profiles, and native model-driven fanout.
- The V1 mission ledger, SQLite workflow, leases, heartbeats, claims, evidence gates, mandatory
  reviewers, forced synthesizer, and user continuation protocol.
- Recursive Agent Trio access and project instruction loading from child App Server threads.

### Release Status

- The implementation and benchmark evaluator are present.
- The 70% time, 40% cost, and 95%-or-3-point quality thresholds remain release acceptance targets;
  this changelog does not claim that a complete paired benchmark has passed.

## [2.0.0] - 2026-08-28

### Changed

- Replaced the V1 durable mission ledger with a thin prompt-driven native fanout experiment.
- Routed routine packages to Luna and Terra while reserving difficult reasoning for Sol.
- Changed optimization from a fixed model token ratio to measured time, model-priced cost, and
  quality constraints.

### Added

- Host session-tree metrics and an initial controlled benchmark protocol.
- Precise legacy migration intended to preserve unrelated Codex configuration.

V2 is retired and is not compatible with the V3 App Server runtime.

## [0.x] - Retired

The 0.x series implemented the mission-ledger architecture. Its lifecycle tools, database, hooks,
and orchestration protocol are migration inputs only and are not part of V3.
