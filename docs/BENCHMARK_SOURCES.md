# Benchmark Sources

The paired harness is designed to consume frozen artifacts, not live repository URLs. The
following sources were checked on 2026-08-29 and are candidates for a release corpus. Before
including an instance, record the source revision, artifact digest, original data license, and any
upstream terms in the manifest's evidence package.

| Domain / family              | Candidate source                                                                                                                                   | License or execution note                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding                       | [SWE-bench](https://github.com/SWE-bench/SWE-bench)                                                                                                | Repository is MIT; each target repository and issue artifact has its own terms. Verified instances and commits are reproducible in Docker.                                                                                                                    |
| Algorithm exact              | [HumanEval](https://github.com/openai/human-eval), [MBPP](https://github.com/google-research/google-research/tree/master/mbpp)                     | HumanEval code is MIT. MBPP data is CC BY 4.0; preserve attribution and run the supplied tests.                                                                                                                                                               |
| Algorithm optimization       | [CombiBench](https://github.com/MoonshotAI/CombiBench)                                                                                             | MIT repository; Lean verifier and compiler version must be pinned.                                                                                                                                                                                            |
| Algorithm numerical          | [SciCode](https://github.com/scicode-bench/SciCode)                                                                                                | Apache-2.0 code; verify the data-card and upstream problem licenses per instance.                                                                                                                                                                             |
| Research frozen              | [BRIGHT](https://github.com/xlang-ai/BRIGHT), [SciFact](https://github.com/allenai/scifact), [PubMedQA](https://github.com/pubmedqa/pubmedqa)      | Freeze documents and labels locally. BRIGHT is CC BY 4.0; SciFact mixes CC BY and ODC-By corpus terms; PubMed sources retain their own terms.                                                                                                                 |
| Research claim checking      | [FEVER](https://github.com/awslabs/fever), [SciFact](https://github.com/allenai/scifact)                                                           | FEVER code is Apache-2.0; claims/evidence include Wikipedia content and must retain the applicable Wikipedia/CC BY-SA 3.0 terms. Freeze the June 2017 snapshot and evidence sentences.                                                                        |
| Research live                | [Simple Evals BrowseComp](https://github.com/openai/simple-evals), [AssistantBench](https://huggingface.co/datasets/AssistantBench/AssistantBench) | Freeze the CSV or dataset revision, web evidence, access date, and canary handling. AssistantBench data card is Apache-2.0 (214 tasks); its GitHub implementation is OpenRAIL-S and has separate use restrictions. Charge any LLM judge equally to both arms. |
| Paper edit/revision          | [arXivEdits](https://github.com/chaojiang06/arXivEdits), [F1000RD](https://github.com/UKPLab/f1000rd)                                              | Filter arXiv items by their individual license. F1000RD data is CC BY-SA 4.0.                                                                                                                                                                                 |
| Paper review                 | [SubstanReview](https://github.com/YanzhuGuo/SubstanReview), [NLPeer](https://github.com/UKPLab/nlpeer)                                            | Check dataset access and reviewer-consent terms before redistribution.                                                                                                                                                                                        |
| Paper stress / auto research | [PaperBench](https://github.com/openai/frontier-evals/tree/main/project/paperbench)                                                                | Parent repository is MIT, but the 20-paper task package has per-paper/data terms. Docker, Git-LFS, GPU and API keys may be required; some runs take up to 24 hours. Keep it in a stress track, not the core latency gate.                                     |
| Office document              | [llm-docx-editing](https://github.com/nberk/llm-docx-editing)                                                                                      | MIT code and deterministic OOXML comparisons.                                                                                                                                                                                                                 |
| Office sheet                 | [SpreadsheetBench V1](https://github.com/RUCKBReasoning/SpreadsheetBench)                                                                          | CC BY-SA 4.0; pin the V1 release and spreadsheet recalculation engine.                                                                                                                                                                                        |
| Office slides                | [PPT-Eval](https://github.com/microsoft/ppteval)                                                                                                   | MIT code; freeze source decks and external download terms.                                                                                                                                                                                                    |
| Office multi-app / pipeline  | [OfficeBench](https://github.com/zlwang-cs/OfficeBench)                                                                                            | Apache-2.0 code; 300 tasks across one-, two-, and three-application workflows. Pin the Docker image and exact input files; preserve the dataset card terms and use execution-based scoring where possible.                                                    |
| Auto recovery/pipeline       | [tau2-bench](https://github.com/sierra-research/tau2-bench), [WebArena](https://github.com/web-arena-x/webarena)                                   | tau2-bench is MIT and should be pinned to a release tag (currently v1.0.1). Pin the simulator or self-hosted site snapshot for WebArena. Web credentials and network behavior must be part of the environment seal.                                           |

`benchmarks/development-v1` is intentionally synthetic and contains no third-party data. Generate it
with:

```bash
npm run benchmark:generate -- benchmarks/development-v1
```

It is suitable for protocol, hashing, scheduling, and evaluator tests only. Its placeholder model
revision and synthetic quality scores must never be used to claim the 40% cost, 70% latency, or 95%
quality release gates.

## Recommended release mapping

Use the following minimum mapping for the 18 evaluator families. Each row names a source family,
not a license grant: the manifest must still preserve the source URL, license URL, release/tag or
commit, access date, transformation description, and SHA-256 digest for every artifact.

| Evaluator family         | Suggested frozen instances                             | Notes                                                                                     |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `coding-local-bugfix`    | SWE-bench Verified                                     | Choose three small, single-package issues with reproducible commits.                      |
| `coding-cross-module`    | SWE-bench Verified                                     | Choose three multi-file issues; retain repository licenses independently.                 |
| `coding-review`          | SWE-bench issue text                                   | Hide the patch and score root cause and affected files only.                              |
| `algorithm-exact`        | HumanEval, MBPP, or APPS                               | Keep supplied tests and attribution; these are sanity checks and can saturate.            |
| `algorithm-optimization` | CombiBench                                             | Pin Lean and verifier versions; do not rely on an external Lean server.                   |
| `algorithm-numerical`    | SciCode                                                | Select distinct scientific subdomains and retain gold tests.                              |
| `research-frozen`        | BRIGHT, SciFact, PubMedQA                              | Freeze corpus bytes and labels locally before either arm runs.                            |
| `research-live`          | BrowseComp                                             | Keep question/answer files private, and seal retrieved evidence by access date.           |
| `research-conflict`      | FEVER                                                  | Freeze a Wikipedia snapshot and require evidence sentence identifiers.                    |
| `paper-edit`             | License-filtered arXivEdits                            | Accept only instances whose individual paper license permits the intended use.            |
| `paper-review`           | SubstanReview or authorized NLPeer                     | Do not redistribute NLPeer without access approval and consent terms.                     |
| `paper-revision`         | F1000RD                                                | Freeze the review-to-revision chain and use the same rubric for both arms.                |
| `office-sheet`           | SpreadsheetBench V1                                    | Preserve all golden workbooks and pin LibreOffice/Excel recalculation.                    |
| `office-document`        | llm-docx-editing                                       | Use OOXML and rendered comparisons; retain the original fixtures.                         |
| `office-slides`          | PPT-Eval CLI                                           | Pin downloaded decks and avoid account-dependent GUI mode in the core gate.               |
| `auto-dossier`           | PaperBench Code-Dev or a frozen BRIGHT/SciFact dossier | PaperBench is a stress track because of GPU/API and runtime requirements.                 |
| `auto-recovery`          | tau2-bench                                             | Inject a fixed crash after a recorded turn and evaluate resume without duplicate effects. |
| `auto-pipeline`          | OfficeBench two/three-app tasks                        | Prefer execution-based scoring and pin the complete container image.                      |

The three-instance minimum is only a release floor, not a statistically strong estimate. Keep every
raw paired result and report per-instance distributions; for tuning, use at least ten instances per
family where licensing and runtime permit. Subjective paper, research, and office rubrics must be
prepared before outputs are visible, and any judge-model calls must be charged to both arms or
excluded from both end-to-end cost totals.

## Provenance and heavy-track boundary

For each artifact, store `sourceUrl`, `licenseUrl`, `accessedAt`, `sourceRevision`,
`transformDescription`, and `sha256` alongside the existing relative path, role, and byte length.
Upstream repository code, target repositories, paper text, Wikipedia snapshots, OneDrive decks,
Kaggle data, and hosted environments can each have different terms. A code repository license is
not evidence that its attached data or external dependencies may be redistributed.

BrowseComp, AssistantBench, PaperBench, MLE-bench, OSWorld, WorkArena, and GUI-backed PPT/office
tasks require live web access, external accounts, GPU/VM resources, or a model/VLM judge. Run them
under a separately named `stress` profile with its own environment seal. Do not combine their setup
time, network drift, or judge cost with the core speed/cost gate unless the direct and V3 arms use
identical resources and accounting.
