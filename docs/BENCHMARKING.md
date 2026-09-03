# Agent Trio V3.4 Benchmarking

The V3.4 balanced performance requirements are acceptance targets. They have not been demonstrated merely
because the runtime and evaluator exist. Do not claim that Agent Trio is faster, cheaper, or within
the quality target until the frozen three-arm suite passes on the release candidate.

The 2026-09-01 tuning checkpoint covers one current instance in every target domain. Coding,
research, paper, and office are fresh paired runs. Algorithm is a paired run immediately before the
boundary-only schema; auto research uses a paired run whose raw output was rescored after an
equivalent-wording validator correction. All are diagnostic rather than release evidence, but every
corrected row meets the requested gate:

| Domain        | Quality ref/direct time | Quality ref/direct cost | Quality ref | Direct quality |
| ------------- | ----------------------: | ----------------------: | ----------: | -------------: |
| Coding        |                   63.5% |                   13.7% |         100 |            100 |
| Algorithm     |                   46.5% |                   24.6% |         100 |            100 |
| Research      |                   34.5% |                    6.1% |         100 |             67 |
| Paper         |                   36.3% |                   20.9% |          97 |            100 |
| Office        |                   60.7% |                   25.9% |         100 |            100 |
| Auto research |                   34.9% |                    6.2% |         100 |            100 |

The current coding pair charged 425 uncached input plus 87 output tokens ($0.00344) to Sol planning,
then used three Luna-medium leaves. The current office pair charged 597 input plus 134 output tokens
($0.00507) to Sol planning, then used three Luna-low leaves. Neither used Terra, a reviewer, replan,
promotion, user continuation, or recursive native agent.

The pre-optimization `coding-cross-module` smoke pair was a clear failure: direct Sol took 42.0s
and $0.0150, while the old fanout path took 131.9s and $0.1213 at equal quality. The fanout spend was
$0.0107 Terra admission, $0.0639 Sol planning, $0.0289 across four incorrectly routed Terra leaves,
and $0.0178 Terra integration. No retry, review, replan, or protocol failure occurred. This evidence
is why the current runtime skips ordinary admission, caps Sol output before generation, defaults
leaves to Luna, locally reduces low-risk results, and refuses automatic fanout when the 40%/70%
estimate does not pass. It is diagnostic evidence, not a claim that the revised runtime passes.

A fresh natural-route coding pair on `coding-cross-module-economic-01` measured direct Sol at
387.57s and $0.05310 and V3 at 246.04s and $0.00730, with both outputs scoring 100. V3 therefore used
63.5% of the time and 13.7% of the cost. It launched three Luna-medium leaves with 0ms skew and used
no Terra leaf, replan, promotion, review, protocol recovery, or user intervention.

Two additional current-revision V3-only stability runs covered the other coding instances. They
finished in 131.88s for $0.00826 and 116.19s for $0.00669, both at quality 100. Together with the
paired instance, all three used exactly one Sol-low micro-plan and three Luna-medium leaves, with no
Terra leaf, replan, promotion, review, protocol error, or intervention. The unpaired rows establish
candidate stability, not direct-Sol time or cost ratios.

A fresh natural-route office pair on `office-sheet-authored-01` measured direct Sol at 128.45s and
$0.03393 and V3 at 78.03s and $0.00877, again with both outputs scoring 100. V3 used 60.7% of the
time and 25.9% of the cost. Its three Luna-low leaves launched with 0ms skew and completed without
promotion or replan.

The available development evidence now spans one economic family in each of the six target
domains. It is not one release-frozen candidate suite: some rows were run on earlier revisions and
one row was replayed after a validator correction. The results are useful for tuning, but they do
not replace the required 18-family release run.

| Family                | Pairs | V3/direct time | V3/direct cost | Quality evidence                          |
| --------------------- | ----: | -------------: | -------------: | ----------------------------------------- |
| `coding-cross-module` |     3 |         45.05% |         20.90% | 100% of direct; all three V3 scores 100   |
| `algorithm-exact`     |     3 |         37.07% |         16.17% | 96.67%; focused medium-Luna probe 100     |
| `research-frozen`     |     3 |         32.18% |         18.25% | corrected replay about 98.7%; probe 100   |
| `paper-revision`      |     3 |         23.92% |         18.70% | 100% of direct; all three V3 scores 100   |
| `office-document`     |     3 |         57.70% |         18.56% | corrected replay: all three V3 scores 100 |
| `auto-dossier`        |     3 |         32.88% |         12.20% | 108.97% of direct; minimum V3 score 67    |

The algorithm pair used low-effort Luna leaves and scored 90/100 on one instance because one leaf
ignored a lexicographic tie rule. Keeping the same Luna tier but using medium effort produced
100/100 on that exact instance in 33.82s and $0.01445, versus the paired direct baseline's 93.09s
and $0.08476. The current policy therefore reserves medium Luna effort for exact algorithm leaves;
it does not promote them to Terra or Sol.

A later natural-route `algorithm-optimization` smoke measured direct Sol at 123.41s and $0.05313
and V3 at 57.37s and $0.00253, or 46.49% time and 4.76% cost. The complete public-path estimate
rejected fanout at 85% predicted latency and delegated the bounded task to one low-effort Luna,
which produced the same twelve correct optima. Replaying both raw outputs after fixing an
overly literal selected-ID validator scored both at 100/100. Because the validator correction
changes the manifest digest, this pair remains diagnostic rather than release evidence.

The office pair used the current three-Luna partition and measured 57.70% time and 18.56% cost.
The initially recorded quality failure came from narrow wording checks and a valid direct decision
verb. Replaying the raw outputs with exact numeric boundaries and controlled equivalent wording
scored V3 at 100/100/100 and direct at 67/100/100. The direct 67 is a real omission: it reported
the $14,000 overage but omitted every original Option A cost. Because this validator correction
changes the manifest digest, the replay is diagnostic rather than release evidence.

No successful economic run above used a mandatory reviewer, audit pass, user continuation, or
protocol recovery. A fresh three-sample `coding-local-bugfix` direct-fast-path set measured -26.0%
p95 overhead: every V3 arm was faster than its direct-Sol baseline, both arms scored 100 on every
instance, and V3 used one Luna-low direct turn with zero planner turns and zero leaves. The remaining
twelve release families and a larger cross-domain direct sample still need qualified frozen
instances before the project can claim the complete target.

The original cost failure was not caused primarily by validators. Its fixed model turns were Terra
admission, a cold second Sol planner, four incorrectly routed Terra leaves, and Terra integration.
The revised runtime removes those turns. Deterministic schema/DAG checks remain because they cost no
model tokens; default reviewer, audit, gate, and synthesizer turns remain absent.

A later failed coding diagnostic did show how validation infrastructure can amplify cost. Its Git
worktrees were nested below `.git`, so App Server bubblewrap mounted the validator cwd read-only and
all three `command/exec` calls failed before running. The old failure path then spent 384.0s and
$0.10973 on three Luna leaves, three Terra retries, one Sol replan, and another Luna/Terra cycle,
while producing quality 0. This was wasted recovery spend, not useful deterministic validation.

Worktrees now default to a private runtime directory under `/tmp`, and a real zero-model
`command/exec` probe passed there. Validator infrastructure failures are marked transient and do not
promote workers or wake Sol. Actual validator failures retry only the failed leaf once; successful
siblings are retained. The post-fix coding pair above is the corresponding end-to-end confirmation.

The first current-revision run of coding instance 02 exposed a separate result-boundary bug. One
leaf returned `status=completed` but filled the schema's nullable `error` and `failureKind`
placeholders; the strict parser marked that writer indeterminate, discarded all three isolated
patches, omitted the leaf's captured usage, and produced quality 0. Completed status now clears those
provider-filled placeholders before authoritative validation, while genuinely malformed terminal
writer payloads retain captured usage and timing. The immediate rerun completed in 131.88s for
$0.00826 at quality 100.

## Baseline

Every candidate run is paired with direct `gpt-5.6-sol/ultra`. Keep these conditions identical
between the two arms:

- provider and exact model revision;
- service tier;
- task prompt and frozen input artifacts;
- repository revision and initial worktree state;
- sandbox, approvals, permissions, and available tools;
- network and external-data snapshot where reproducibility requires it;
- validator and quality rubric.

Do not use V1, V2, direct Terra, or a different task as the release baseline. Those variants may
help diagnose behavior, but they do not establish the requested V3 performance.

Run each sealed instance with both arms under the same seed label. Use at least three paired
instances per family. Randomize arm order where provider load could bias elapsed time, and retain
the raw outputs so quality can be scored blind.

### Existing-root pairing

The real runner measures the decision made by an already-running root Sol, not two unrelated cold
threads. For each pair it creates one temporary root thread, completes one tiny setup turn before
the sealed task exists, and then injects the task into model-visible history without a model call.
The setup turn represents prior conversation and is excluded from both arms. The measured arm
starts immediately before the root task turn, so all direct output or Sol planning time and usage is
charged normally.

The first arm runs on that root thread. After its evidence is sealed, `thread/revert` removes that
turn while preserving the injected task; the second arm then runs on the same thread ID. Arm order
is balanced across instances. This keeps root context and provider cache affinity identical while
leaving both arms with the same model-visible task state. Sibling `thread/fork` is not used for cost
acceptance because the pinned provider did not reliably preserve cache affinity across sibling
thread IDs. Candidate accounting includes the host Sol plan and every worker turn; it excludes only
the common pre-task setup turn.

The direct baseline runs at the sealed `gpt-5.6-sol/ultra` setting. A balanced candidate host Sol
uses `low` effort for routing and compact fanout plans; quality retains `medium` for ordinary
coupled DAG planning. The internal planner follows the same profile rule and may use `high` for
difficult algorithms, architecture, security, or hidden correctness work. Spending planner-level
reasoning on a short machine-readable dispatch decision would defeat the tiered-cost design. The
model, provider, service tier, task state, and permissions remain paired.

The Agent Trio JobStore is allocated under a separate temporary runtime root, never under the
materialized fixture workspace. Both the workspace and runtime root are removed when the pair
finishes, including failure cleanup. Consequently a V3-first pair cannot expose plan, job, or leaf
result files to the later direct arm through its workspace file view.

## Frozen Suite

The evaluator defines 18 families across six domains:

| Domain        | Family ID                | Task shape                         |
| ------------- | ------------------------ | ---------------------------------- |
| Coding        | `coding-local-bugfix`    | Local bug fix; direct              |
| Coding        | `coding-cross-module`    | Cross-module feature; decomposable |
| Coding        | `coding-review`          | Read-only diagnosis; decomposable  |
| Algorithm     | `algorithm-exact`        | Exact algorithm                    |
| Algorithm     | `algorithm-optimization` | Combinatorial optimization         |
| Algorithm     | `algorithm-numerical`    | Numerical computation              |
| Research      | `research-frozen`        | Frozen-corpus review               |
| Research      | `research-live`          | Current web research               |
| Research      | `research-conflict`      | Conflicting-evidence memo          |
| Paper         | `paper-edit`             | Targeted manuscript edit; direct   |
| Paper         | `paper-review`           | Adversarial paper review           |
| Paper         | `paper-revision`         | Review-driven revision             |
| Office        | `office-sheet`           | Spreadsheet model                  |
| Office        | `office-document`        | Document report                    |
| Office        | `office-slides`          | Editable slide deck                |
| Auto research | `auto-dossier`           | Durable dossier                    |
| Auto research | `auto-recovery`          | Crash recovery                     |
| Auto research | `auto-pipeline`          | Cross-artifact pipeline            |

Each family needs at least three independently sealed instances. The 54 instances each run once on
direct Sol, balanced, and quality, for at least 162 arms. A release may add harder instances, but it
must not quietly drop or rewrite a failed instance after seeing results.

Family shape is not sufficient to decide which performance gate applies to a particular instance.
Every release instance must pre-seal one of these `evaluationClass` values before either arm runs:

- `direct-fast-path`: the instance is expected to stay in the zero-planner, zero-leaf fast path and
  is included in direct overhead p95;
- `economic-decomposable`: the instance is economically large enough to amortize planning and is
  included in the 40% cost and 70% wall-time aggregates.

Every release `economic-decomposable` instance must seal `eligibility` derived from an independent
development calibration table. The table records at least three development instance IDs and their
direct Sol durations plus the p50 duration of each coarse independent leaf. The generator computes
`directSolP50Seconds`, `independentUnits`, and `estimatedMinLeafSeconds`, and seals both
`calibrationRevision` and `calibrationEvidenceSha256`. Release preflight rejects missing or
generator-authored placeholder calibration. Development generators may omit eligibility entirely.

Classification is an evaluation contract, not a forced route: an economic instance remains in both
balanced economic aggregates even when balanced ultimately chooses `direct` or `delegated`.
Conversely, observing a successful fanout does not move a preclassified fast-path instance into the
economic set. This prevents post-run route selection from hiding an economic failure.

The calibration must show direct Sol p50 of at least 90 seconds and at least two independent leaf
p50 values strictly above 30 seconds. Balanced uses the same 30-second floor and requires at least
90 seconds of candidate serial work; quality retains the V3.3 15-second startup-amortization floor.
The 40% and 70% ratios are planning guidance and release gates, not runtime vetoes for an otherwise
legal Sol plan.

Supply calibration explicitly when sealing a candidate corpus:

```bash
npm run benchmark:generate-authored-core -- /tmp/agent-trio-held-out \
  --calibration /absolute/path/development-calibration.json
```

The calibration file has this shape; durations are real seconds from development tasks, not the
held-out instances:

```json
{
  "schemaVersion": 1,
  "revision": "development-2026-09-03",
  "entries": [
    {
      "familyId": "coding-cross-module",
      "developmentInstanceIds": ["dev-01", "dev-02", "dev-03"],
      "directSolSeconds": [101.2, 118.4, 132.7],
      "independentLeafP50Seconds": [38.1, 42.6, 47.3]
    }
  ]
}
```

The generator does not bundle or fabricate measured values. New held-out seeds are sealed only after
routing and parameters are frozen, and must not reuse the development calibration instances.

Legacy development/diagnostic manifests and observation files may omit `evaluationClass`; the
library migrates them using the static family `decomposable` flag, never the observed candidate
route. This compatibility behavior is not valid for a release. Release preflight and evaluation
must set `requireSealedEvaluationClass: true`, which rejects missing classifications before model
execution in the paired harness. The generated synthetic corpus remains diagnostic and non-release.

The library-level harness uses a `BenchmarkCorpusManifest`. The manifest fixes the suite ID, direct
`gpt-5.6-sol/ultra` baseline and exact revision, source revision, initial-state hash, seed, and every
prompt, input, workspace snapshot, validator, rubric, or external-data artifact. Each artifact
records its portable relative path, byte length, role, and SHA-256 digest. Every instance must have
exactly one `workspace_snapshot`, and its digest is the instance's `initialStateSha256`.
`sealBenchmarkManifest()` adds a canonical manifest digest; `runPairedBenchmark()` verifies that
digest and reads and hashes every artifact before invoking an arm. A changed or missing corpus file
therefore stops the run before model work begins.

Use `createFileBenchmarkArtifactReader(corpusRoot)` and
`createFileBenchmarkRunArtifactReader(evidenceRoot)` for filesystem artifacts, or inject equivalent
readers for an artifact store. Partial development manifests are allowed only when the matching
evaluation options set `requireAllFamilies: false`; the default harness requires all 18 families
and three instances per family.

## What To Capture

For every arm, record:

- family, instance, seed, exact prompt, and artifact hashes;
- start/end timestamps and end-to-end elapsed milliseconds;
- route, planner-turn count, leaf count, launch timestamps, and launch skew;
- App Server cached input, cache-write input, uncached input, output tokens, and USD usage by
  actual model;
- Sol planning, patch, specialist, and final-review usage separately;
- Terra admission/direct/integration usage and all Luna leaf usage;
- retry, escalation, protocol-error, and user-intervention counts;
- deterministic validator output and the final deliverable;
- quality score from the frozen rubric;
- any critical failure.

Wall-clock starts when the user-facing request is issued and ends when the final result is
available. Setup, planning, integration, final review, retries, and recovery all belong to the
candidate time and cost.

App Server USD usage is authoritative. If a custom provider does not return it, configure a real
price table and calculate:

```text
cost =
    uncached_input * uncached_input_rate
  + cached_input   * cached_input_rate
  + cache_write    * cache_write_rate
  + output         * output_rate
```

All rates must correspond to the actual provider, service tier, and model. An
`economic-decomposable` pair with `costUsd: null`, an unpriced model, or a zero placeholder is
incomplete and cannot pass the cost gate. Legacy price tables without a cache-write rate fall back
to the uncached-input rate rather than silently treating cache population as free.

## Quality Scoring

Prefer deterministic validators: tests, builds, linters, exact answers, numerical tolerances,
schema checks, citation resolvers, and render comparisons. Freeze them before running either arm.

Relative quality alone is insufficient: equal zero scores must never pass. Every V3 observation
must also score at least 60/100 on its frozen validator or rubric. This candidate floor is a release
gate in addition to the 95% ratio-or-3-point-gap requirement. A failed direct baseline remains in
the paired time, cost, and relative-quality aggregates, but it does not invalidate a correct V3
result merely because the baseline itself stopped early or answered incorrectly.

For research, paper, and office outputs that need judgment, use a domain-specific rubric prepared
before results are visible. Score blinded outputs on factual correctness, required coverage,
reasoning quality, citation support, and usefulness. Any LLM judge cost must be charged equally to
both arms or reported outside both arms.

Quality must pass both globally and within every domain. Macro averaging by domain prevents cheap
success in one domain from hiding a material regression in another.

These are immediate release blockers regardless of aggregate score:

- destructive data loss;
- an unsupported or wrong citation;
- omission of a required task or deliverable;
- an unrecoverable duplicate side effect;
- any other predeclared critical failure.

## Three-Arm Harness

`runPairedBenchmark(manifest, executors, options)` evaluates one candidate profile against direct
Sol. The real runner invokes it sequentially for balanced and quality while caching one verified
direct record per instance. This keeps provider authentication and App Server process ownership
outside the generic harness and produces exactly one `direct_sol`, one `balanced`, and one `quality`
record per instance. Compare profiles only from one complete three-arm run over the same frozen
corpus and implementation revision; a separate `--balanced-only` diagnostic is not comparable to
an earlier quality run. Pair order is balanced by default to reduce load-order bias; `direct-first`
and the legacy `v3-first` order remain available for controlled diagnostics.

Each executor returns a `BenchmarkRunRecord` containing:

- the ordinary `BenchmarkObservation`;
- the manifest and instance digests it actually received;
- provider identity and non-secret configuration hash, service tier, permission-profile evidence,
  and the versioned/config-hashed tool set;
- model/token/USD usage split into `admission`, `direct`, `planning`, `replan`, `leaves`,
  `integration`, and `finalReview`;
- verified input attestations plus output, validator-output, deliverable, and scorecard references.

The harness rejects a pair when provider identity/configuration, service tier, permissions, or
tools differ. Tool ordering does not matter, but identity, version, and configuration digest do. It
also reconciles the observation's USD cost against the sum of its per-stage records, requires a
price-table digest for locally calculated costs, proves that the baseline arm used only the sealed
Sol model/effort, and checks that candidate direct and fanout stage evidence agrees with the
reported route.
The output reader hashes each referenced artifact. Scorecards are parsed and must reproduce both the
reported quality score and the sealed validator/rubric digest. `onRecord` can persist each completed
arm immediately so evidence survives a later arm failure. No model is built into the harness; tests
and offline experiments use injected executors.

For a real local App Server run, use the experiment runner added to this repository. It verifies and
materializes each sealed instance into disposable workspaces, runs direct Sol, balanced, and quality
with the same prompt and snapshot, and writes raw output, validator output, scorecards, usage, and
observations. The default command runs one three-arm smoke instance; select a family and three
instances for a development family check, or pass `--full` for the complete 54-instance suite:

```bash
npm run benchmark:real -- --family coding-cross-module --limit 3 \
  --output /tmp/agent-trio-coding.json \
  --evidence /tmp/agent-trio-coding-evidence

agent-trio benchmark /tmp/agent-trio-coding.observations.json \
  --allow-partial --minimum-instances 1 --json
```

Every completed arm is appended to the output-adjacent `.records.jsonl`. After an OOM, process
termination, or host restart, repeat the same command with `--resume`; the runner revalidates
the cached records and their evidence hashes, skips their model calls, and executes only missing
arms. Resume is valid only when code, corpus, provider configuration, output path, and evidence path
are unchanged. A single unterminated final JSONL fragment is repaired as an interrupted append;
invalid or duplicate complete lines stop the run.

The release runner uses host Sol semantic routing. Balanced may complete a strict fast-path task in
the root, delegate one worker, or supply a two-to-three-leaf foreground DAG. Quality always delegates
and retains the wider V3.3 topology. `--internal-sol-plan` and `--host-plan` remain diagnostic modes;
forced routes are never release evidence. The bundled price table is used by default;
`AGENT_TRIO_PRICE_TABLE` is an explicit runtime override.

This runner issues real model calls and therefore consumes provider quota. Synthetic development
fixtures validate the execution and evidence protocol; they are intentionally too small to support
release claims about cost or speed. Use a frozen, domain-specific corpus before publishing the
acceptance result.

## Observation File

`agent-trio benchmark` remains the backwards-compatible offline evaluator. It does not execute
tasks; use the three-arm harness above to authenticate and preserve run evidence. A harness result has
an `observations` array and can therefore be passed directly to the CLI. Existing inputs may still
be either an observation array or an object with an `observations` array. Pair rows by `familyId`,
`instanceId`, and `seed`:

```json
{
  "observations": [
    {
      "familyId": "coding-cross-module",
      "instanceId": "repo-a-feature-01",
      "seed": "run-1",
      "arm": "direct_sol",
      "qualityScore": 96,
      "elapsedMs": 600000,
      "costUsd": 2.5,
      "route": "direct",
      "plannerTurns": 0,
      "leafCount": 0,
      "protocolErrors": 0,
      "userInterventions": 0,
      "criticalFailures": []
    },
    {
      "familyId": "coding-cross-module",
      "instanceId": "repo-a-feature-01",
      "seed": "run-1",
      "arm": "balanced",
      "qualityScore": 94,
      "elapsedMs": 390000,
      "costUsd": 0.9,
      "route": "fanout",
      "launchSkewMs": 1800,
      "plannerTurns": 1,
      "leafCount": 3,
      "protocolErrors": 0,
      "userInterventions": 0,
      "criticalFailures": []
    },
    {
      "familyId": "coding-cross-module",
      "instanceId": "repo-a-feature-01",
      "seed": "run-1",
      "arm": "quality",
      "qualityScore": 96,
      "elapsedMs": 420000,
      "costUsd": 1.1,
      "route": "fanout",
      "launchSkewMs": 1500,
      "plannerTurns": 0,
      "leafCount": 3,
      "protocolErrors": 0,
      "userInterventions": 0,
      "criticalFailures": []
    }
  ]
}
```

Evaluate the complete suite:

```bash
agent-trio benchmark observations.json
agent-trio benchmark observations.json --json
```

During development, `--allow-partial` permits a diagnostic subset and `--minimum-instances N`
changes the per-family minimum. A partial result is not release evidence.

## Acceptance Gates

Balanced passes only when all gates pass:

| Dimension            | Gate                                                       |
| -------------------- | ---------------------------------------------------------- |
| Economic speed       | Preclassified economic macro time ratio is at most 0.70    |
| Economic cost        | Preclassified economic macro USD ratio is at most 0.40     |
| Sol planning cost    | Maximum economic family ratio is at most 0.25              |
| Overall quality      | Ratio is at least 0.95 or absolute gap is at most 3 points |
| Per-domain quality   | Every domain meets the same 0.95-or-3-point rule           |
| Direct overhead      | p95 extra elapsed ratio is at most 0.15                    |
| Direct routing       | Zero direct cases start Sol Planner or leaves              |
| Launch skew          | Same-wave p95 is strictly below 5,000 ms                   |
| Protocol reliability | Zero protocol errors                                       |
| Human continuation   | Zero user interventions for internal readiness             |
| Critical safety      | Zero critical failures                                     |

The cost and elapsed gates apply to every balanced pair pre-sealed as `economic-decomposable`,
regardless of its actual route. Direct overhead and the zero-MCP-planner/zero-leaf check apply only
to balanced pairs pre-sealed as `direct-fast-path`. Candidate quality must also be at least 60.
Missing USD data makes the economic cost gate fail; it is never treated as zero.

Quality must preserve V3.3 behavior and meet the quality and reliability gates. Its cost, elapsed
time, planning ratio, direct overhead, and direct-delegation count are reported without blocking the
quality profile. Protocol errors, user intervention, critical failures, and quality remain blocking.

Report per-family and per-domain results, not only aggregate averages. Include confidence intervals
or raw distributions where sample size permits, plus the number of replans, promotions, planner
turns, and final reviews. The release report must show that expensive Sol usage is confined to
high-value planning and exceptional reasoning rather than hidden in repeated coordination.

## Interpreting Failure

- If direct overhead fails, shorten Terra admission or bypass more requests before touching fanout.
- If launch skew fails, inspect App Server request dispatch and provider queueing.
- If cost fails but quality passes, reduce duplicated context and promote fewer packages.
- If quality fails in one domain, fix that domain recipe or route only the failing package upward.
- If recovery fails, do not add blind retries for writers; preserve side-effect safety.

Do not respond to a failed gate by adding a mandatory reviewer, a heartbeat loop, or broad Sol
execution. Re-run the same frozen pairs after a focused change and report both improvements and
regressions.
