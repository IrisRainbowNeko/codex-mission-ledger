import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe as vitestDescribe, expect, it } from "vitest";
import {
  createAuthoredCoreCorpus,
  createAuthoredCoreRoutingCorpus,
} from "../scripts/generate-authored-core-benchmark.js";
import { BENCHMARK_FAMILIES, verifyBenchmarkCorpus } from "../src/benchmark.js";
import {
  parseSealedBenchmarkValidatorV1,
  runSealedBenchmarkValidator,
} from "../src/benchmark-validator.js";
import { assertReleaseBenchmarkCorpus, parseOptions } from "../scripts/run-real-benchmark.js";
import { calibrationFixture, ECONOMIC_FAMILY_IDS } from "./benchmark-calibration-fixture.js";

const describe =
  process.env["AGENT_TRIO_RUN_AUTHORED_CORE_TESTS"] === "1" && commandAvailable("soffice")
    ? vitestDescribe
    : vitestDescribe.skip;

describe("authored core benchmark corpus", () => {
  it("covers all eighteen families with three distinct sealed instances", async () => {
    const corpus = await createAuthoredCoreCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));

    expect(corpus.manifest.instances).toHaveLength(54);
    expect(
      new Set(corpus.manifest.instances.map((instance) => instance.initialStateSha256)).size,
    ).toBe(54);
    const directFastPathFamilies = new Set([
      "coding-local-bugfix",
      "coding-review",
      "algorithm-optimization",
      "algorithm-numerical",
      "research-live",
      "paper-edit",
      "paper-review",
      "auto-recovery",
      "auto-pipeline",
    ]);
    for (const family of BENCHMARK_FAMILIES) {
      const instances = corpus.manifest.instances.filter(
        (instance) => instance.familyId === family.id,
      );
      expect(instances).toHaveLength(3);
      expect(
        instances.every(
          (instance) =>
            instance.evaluationClass ===
            (directFastPathFamilies.has(family.id) ? "direct-fast-path" : "economic-decomposable"),
        ),
      ).toBe(true);
    }
    expect(
      corpus.manifest.instances.filter(
        (instance) => instance.evaluationClass === "direct-fast-path",
      ),
    ).toHaveLength(27);
    expect(
      corpus.manifest.instances.filter(
        (instance) => instance.evaluationClass === "economic-decomposable",
      ),
    ).toHaveLength(27);

    await expect(
      verifyBenchmarkCorpus(corpus.manifest, async (artifact) => byPath.get(artifact.path)!),
    ).resolves.toBeUndefined();
  }, 300_000);

  it("contains real office and pipeline deliverable contracts plus frozen live snapshots", async () => {
    const corpus = await createAuthoredCoreCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    for (const instance of corpus.manifest.instances) {
      const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
      const validator = parseSealedBenchmarkValidatorV1(
        JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
      );
      const paths = validator.requiredDeliverables.map((deliverable) => deliverable.path);
      if (instance.familyId === "office-sheet")
        expect(paths.some((path) => path.endsWith(".xlsx"))).toBe(true);
      if (instance.familyId === "office-document")
        expect(paths.some((path) => path.endsWith(".docx"))).toBe(true);
      if (instance.familyId === "office-slides")
        expect(paths.some((path) => path.endsWith(".pptx"))).toBe(true);
      if (instance.familyId === "auto-pipeline") {
        expect(
          new Set(paths.map((path) => path.slice(path.lastIndexOf(".")))).size,
        ).toBeGreaterThanOrEqual(2);
      }
      if (instance.familyId === "research-live") {
        expect(instance.artifacts.some((artifact) => artifact.role === "external_snapshot")).toBe(
          true,
        );
      }
    }
  }, 300_000);

  it("passes the release corpus structural preflight", async () => {
    const corpus = await createAuthoredCoreCorpus(calibrationFixture(ECONOMIC_FAMILY_IDS));
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const options = parseOptions(["--release", "--dynamic-tool", "--full"]);
    await expect(
      assertReleaseBenchmarkCorpus(
        corpus.manifest,
        async (artifact) => byPath.get(artifact.path)!,
        options,
      ),
    ).resolves.toBeUndefined();
  }, 300_000);

  it("materializes and converts each office artifact type with the bundled offline helper", async () => {
    const corpus = await createAuthoredCoreCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-office-helper-"));
    try {
      for (const familyId of ["office-sheet", "office-document", "office-slides"] as const) {
        const instance = corpus.manifest.instances.find(
          (candidate) => candidate.familyId === familyId,
        )!;
        const workspaceSeal = instance.artifacts.find(
          (artifact) => artifact.role === "workspace_snapshot",
        )!;
        const snapshot = JSON.parse(new TextDecoder().decode(byPath.get(workspaceSeal.path)!)) as {
          files: Array<{ path: string; contentUtf8: string; mode?: number }>;
        };
        const root = snapshot.files
          .find((candidate) => candidate.path.endsWith("/build_office.py"))!
          .path.split("/")
          .slice(0, 2)
          .join("/");
        for (const fixture of snapshot.files.filter((candidate) =>
          candidate.path.startsWith(`${root}/`),
        )) {
          const target = join(workspace, fixture.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, fixture.contentUtf8, "utf8");
        }
        const spec =
          familyId === "office-sheet"
            ? {
                rows: [
                  ["Metric", "Value"],
                  ["Total Revenue", 123],
                ],
              }
            : familyId === "office-document"
              ? { paragraphs: ["Decision: Select Option B", "Budget margin $11,000"] }
              : {
                  slides: [
                    { title: "Executive Status", bullets: ["Completion 70%"] },
                    { title: "Budget and Delivery", bullets: ["Budget $420,000"] },
                    { title: "Risks and Actions", bullets: ["Risk supplier delay"] },
                  ],
                };
        const extension =
          familyId === "office-sheet" ? "xlsx" : familyId === "office-document" ? "docx" : "pptx";
        await writeFile(join(workspace, root, "test.json"), JSON.stringify(spec), "utf8");
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            "python3",
            ["build_office.py", extension, "test.json", `test.${extension}`],
            { cwd: join(workspace, root) },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error(stderr || `exit ${String(code)}`)),
          );
        });
        const bytes = await readFile(join(workspace, root, `test.${extension}`));
        expect(bytes.subarray(0, 2).toString()).toBe("PK");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts equivalent table and labeled exact-optimization result formats", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "algorithm-optimization-authored-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const fullValidator = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const firstCheck = fullValidator.commandChecks[0]!;
    const validator = { ...fullValidator, commandChecks: [firstCheck] };
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-optimization-format-"));
    try {
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await mkdir(dirname(outputPath), { recursive: true });
      for (const output of [
        "[item:opt-1a-case-01] | [B, C] | 7 | 18 | f=15; unique maximum",
        "[item:opt-1a-case-01] IDs [B,C]; weight 3+4=7; value 8+10=18; exhaustive check",
        "[item:opt-1a-case-01] IDs=[B,C], total weight=7, total value=18. Exhaustive check: all 32 subsets evaluated.",
        "[item:opt-1a-case-01] Selected IDs B, C; total weight 7; total value 18; feasible subsets checked.",
        "[item:opt-1a-case-01] Selected IDs: B, C. Total weight: 7. Total value: 18. Exhaustive check: all 32 subsets evaluated.",
        "[item:opt-1a-case-01] selected [B,C], weight 3+4=7, value 8+10=18; feasible subsets checked",
        '[item:opt-1a-case-01] selected IDs ["B","C"]; total weight 7; total value 18; DP 0..7 = [0,0,5,8,10,13,15,18]',
      ]) {
        await writeFile(outputPath, output, "utf8");
        await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
          score: 100,
          passedChecks: 1,
          totalChecks: 1,
        });
      }
      await writeFile(
        outputPath,
        '[item:opt-1a-case-01] selected IDs ["A","C"]; total weight 7; total value 18; DP 0..7 = [0,0,5,8,10,13,15,18]',
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 0,
        passedChecks: 0,
        totalChecks: 1,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts labeled prices in frozen research output without weakening source checks", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "research-live-authored-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const validator = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-research-price-format-"));
    try {
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await mkdir(dirname(outputPath), { recursive: true });
      const validOutput = [
        "[item:live-1a] Beacon, price 90, 92 ms, available, 2026-08-20T12:00:00Z [WEB-LIVE-1A-B]",
        "[item:live-1b] Beacon, price 95, 90 ms, available, 2026-08-20T12:00:00Z [WEB-LIVE-1B-B]",
        "[item:live-1c] Beacon, price 100, 88 ms, available, 2026-08-20T12:00:00Z [WEB-LIVE-1C-B]",
      ].join("\n");
      await writeFile(outputPath, validOutput, "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 3,
        totalChecks: 3,
      });

      await writeFile(
        outputPath,
        validOutput.replace("[WEB-LIVE-1B-B]", "[WEB-LIVE-1B-A]"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        passedChecks: 2,
        totalChecks: 3,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts an explicit committed-ID skip list in recovery output", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "auto-recovery-authored-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const fullValidator = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const validator = { ...fullValidator, commandChecks: [fullValidator.commandChecks[0]!] };
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-recovery-format-"));
    try {
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await mkdir(dirname(outputPath), { recursive: true });
      const validOutput = [
        "[item:recovery-1a]",
        "Committed IDs to skip: recovery-1a-job-1, recovery-1a-job-2.",
        "Remaining execution order: recovery-1a-job-3, recovery-1a-job-4, recovery-1a-job-5.",
        "Idempotency keys: idem:recovery-1a-job-3, idem:recovery-1a-job-4, idem:recovery-1a-job-5.",
        "Remaining amount 147.",
      ].join("\n");
      await writeFile(outputPath, validOutput, "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 1,
        totalChecks: 1,
      });

      await writeFile(
        outputPath,
        validOutput.replace("Remaining amount 147", "Remaining amount 148"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 0,
        passedChecks: 0,
        totalChecks: 1,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts colon-delimited pipeline Markdown labels while retaining exact values", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "auto-pipeline-authored-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const fullValidator = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const markdownCheck = fullValidator.commandChecks.find(
      (check) => check.id === "pipeline-1a-markdown",
    )!;
    const validator = {
      ...fullValidator,
      commandChecks: [markdownCheck],
      requiredDeliverables: [],
    };
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-pipeline-format-"));
    try {
      const outputPath = join(workspace, "data", "pipeline-1a", "summary.md");
      await mkdir(dirname(outputPath), { recursive: true });
      const validOutput = [
        "Total: 100",
        "Average: 25.00",
        "Maximum: 31",
        "Citation: [SRC-PIPELINE-1A]",
        "The maximum of 31 is greater than the average of 25.00.",
      ].join("\n");
      await writeFile(outputPath, validOutput, "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 1,
        totalChecks: 1,
      });

      await writeFile(outputPath, validOutput.replaceAll("25.00", "25.01"), "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 0,
        passedChecks: 0,
        totalChecks: 1,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts full and hierarchical paper-review section labels with semantic equivalents", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "paper-review-authored-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const fullValidator = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const validator = { ...fullValidator, commandChecks: [fullValidator.commandChecks[0]!] };
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-paper-review-format-"));
    try {
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await mkdir(dirname(outputPath), { recursive: true });
      for (const output of [
        "review-paper-1a-section-01: Issue: Test-set leakage. Severity: Critical. The score is optimistically biased. Required correction: use training/validation data and an untouched test set.",
        "review-paper-1a:\n- section-01: Hyperparameters used the final test set. Severity: major. This creates bias. Tune on training/development data, then use an untouched test set.",
      ]) {
        await writeFile(outputPath, output, "utf8");
        await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
          score: 100,
          passedChecks: 1,
          totalChecks: 1,
        });
      }
      await writeFile(
        outputPath,
        "review-paper-1a:\n- section-01: Repeated observations were treated as independent. Severity: major. Use participant-level analysis and report uncertainty.",
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 0,
        passedChecks: 0,
        totalChecks: 1,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("binds every validator qualification digest to executed gold and mutant evidence", async () => {
    const corpus = await createAuthoredCoreCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    for (const instance of corpus.manifest.instances) {
      const qualification = instance.validatorQualification!;
      const seals = instance.artifacts.filter((artifact) =>
        artifact.path.includes("/qualification/"),
      );
      expect(seals).toHaveLength(3);
      const byDigest = new Map(seals.map((seal) => [seal.sha256, seal]));
      const goldSeal = byDigest.get(qualification.goldSha256)!;
      const mutantSeals = qualification.mutantSha256.map((digest) => byDigest.get(digest)!);
      expect(goldSeal).toBeDefined();
      expect(mutantSeals.every((seal) => seal !== undefined)).toBe(true);

      const validatorSha256 = instance.artifacts.find(
        (artifact) => artifact.role === "validator",
      )!.sha256;
      const readEvidence = (path: string) =>
        JSON.parse(new TextDecoder().decode(byPath.get(path)!)) as {
          identity: string;
          validatorSha256: string;
          fixture: {
            id: string;
            output: string;
            writes: unknown[];
            commands: unknown[];
            deletes: unknown[];
          };
          result: {
            score: number;
            passedChecks: number;
            totalChecks: number;
            checks: Array<{ passed: boolean }>;
          };
        };
      const gold = readEvidence(goldSeal.path);
      const mutants = mutantSeals.map((seal) => readEvidence(seal.path));
      expect(gold.identity).toBe(`${instance.familyId}/${instance.instanceId}`);
      expect(gold.validatorSha256).toBe(validatorSha256);
      expect(gold.fixture.id).toBe("gold");
      expect(gold.result.score).toBe(100);
      expect(gold.result.passedChecks).toBe(gold.result.totalChecks);
      expect(gold.result.checks.every((check) => check.passed)).toBe(true);
      expect(
        gold.fixture.output.length > 0 ||
          gold.fixture.writes.length > 0 ||
          gold.fixture.commands.length > 0,
      ).toBe(true);
      expect(mutants.map((mutant) => mutant.fixture.id)).toEqual([
        "mutant-wrong",
        "mutant-missing",
      ]);
      expect(mutants.every((mutant) => mutant.validatorSha256 === validatorSha256)).toBe(true);
      expect(mutants.every((mutant) => mutant.result.score < 100)).toBe(true);
      expect(mutants.every((mutant) => mutant.result.checks.some((check) => !check.passed))).toBe(
        true,
      );
    }
  }, 120_000);
});

vitestDescribe("authored core lightweight output contracts", () => {
  it("accepts equivalent numerical notation and natural paper-edit wording", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-light-contracts-"));
    try {
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await mkdir(dirname(outputPath), { recursive: true });
      for (const [instanceId, output] of [
        [
          "algorithm-numerical-authored-01",
          "[item:num-1a-case-01] mean 6.000; variance 8.500; trapezoid 18.000; S=2+5+7+10=24",
        ],
        [
          "paper-edit-authored-01",
          "[item:paper-edit-1] In this observational study of 184 participants, the exposed group reported an outcome that was 3.2 points higher on average, with a 95% CI from 0.8 to 5.6. Assignment was observational rather than randomized, and the outcome was self-reported. The estimate therefore describes an association and does not establish causality. The interval summarizes uncertainty around the estimated difference, while possible confounding, selection effects, and reporting error remain important limitations. These design constraints should guide interpretation of the result and prevent stronger causal conclusions from being drawn from the available evidence alone.",
        ],
      ] as const) {
        const instance = corpus.manifest.instances.find(
          (candidate) => candidate.instanceId === instanceId,
        )!;
        const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
        const full = parseSealedBenchmarkValidatorV1(
          JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
        );
        await writeFile(outputPath, output, "utf8");
        await expect(
          runSealedBenchmarkValidator(
            { ...full, commandChecks: [full.commandChecks[0]!], requiredDeliverables: [] },
            { workspace },
          ),
        ).resolves.toMatchObject({ score: 100, passedChecks: 1, totalChecks: 1 });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts natural labels while retaining every office decision value", async () => {
    const corpus = await createAuthoredCoreRoutingCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-office-contracts-"));
    try {
      const cases = [
        {
          instanceId: "office-document-authored-01",
          checkId: "document-1a-json",
          path: "data/document-1a/result.json",
          content: JSON.stringify({
            paragraphs: [
              "Decision: Select Option B.",
              "Option A costs $196,000 and exceeds the $180,000 cap by $16,000.",
              "Option B costs $169,000 and is $11,000 below the cap.",
              "Deadline 8 weeks. Mina owns confirmation due 2026-10-12.",
            ],
          }),
        },
        {
          instanceId: "office-slides-authored-01",
          checkId: "slides-1a-json",
          path: "data/slides-1a/result.json",
          content: JSON.stringify({
            slides: [
              { title: "Executive Status", bullets: ["Program slides-1a", "Completion: 62%"] },
              {
                title: "Budget and Delivery",
                bullets: ["Approved budget: $420,000", "Spent: $365,000"],
              },
              {
                title: "Risks and Actions",
                bullets: ["Risk: supplier delay", "Owner: Mina", "Next gate: 2026-11-15"],
              },
            ],
          }),
        },
      ] as const;
      for (const testCase of cases) {
        const instance = corpus.manifest.instances.find(
          (candidate) => candidate.instanceId === testCase.instanceId,
        )!;
        const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
        const full = parseSealedBenchmarkValidatorV1(
          JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
        );
        const check = full.commandChecks.find((candidate) => candidate.id === testCase.checkId)!;
        const target = join(workspace, testCase.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, testCase.content, "utf8");
        await expect(
          runSealedBenchmarkValidator(
            { ...full, commandChecks: [check], requiredDeliverables: [] },
            { workspace },
          ),
        ).resolves.toMatchObject({ score: 100, passedChecks: 1, totalChecks: 1 });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 });
  return result.status === 0;
}
