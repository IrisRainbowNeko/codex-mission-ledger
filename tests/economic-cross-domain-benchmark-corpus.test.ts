import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEconomicCrossDomainCorpus } from "../scripts/generate-economic-cross-domain-benchmark.js";
import {
  parseSealedBenchmarkValidatorV1,
  runSealedBenchmarkValidator,
} from "../src/benchmark-validator.js";
import { verifyBenchmarkCorpus } from "../src/benchmark.js";
import { calibrationFixture } from "./benchmark-calibration-fixture.js";

const FAMILIES = [
  "algorithm-exact",
  "research-frozen",
  "paper-revision",
  "office-document",
  "auto-dossier",
] as const;

const FILES_PER_ROOT: Record<(typeof FAMILIES)[number], number> = {
  "algorithm-exact": 10,
  "research-frozen": 12,
  "paper-revision": 12,
  "office-document": 12,
  "auto-dossier": 12,
};

const CHECKS_PER_INSTANCE: Record<(typeof FAMILIES)[number], number> = {
  "algorithm-exact": 30,
  "research-frozen": 27,
  "paper-revision": 36,
  "office-document": 27,
  "auto-dossier": 27,
};

describe("economic cross-domain benchmark corpus", () => {
  it("seals three independent economic instances in each non-coding domain", async () => {
    const calibration = calibrationFixture(FAMILIES);
    const corpus = createEconomicCrossDomainCorpus(calibration);
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));

    expect(corpus.manifest.instances).toHaveLength(15);
    expect(
      new Set(corpus.manifest.instances.map((instance) => instance.initialStateSha256)).size,
    ).toBe(15);
    for (const familyId of FAMILIES) {
      expect(
        corpus.manifest.instances.filter((instance) => instance.familyId === familyId),
      ).toHaveLength(3);
    }
    for (const instance of corpus.manifest.instances) {
      const familyId = instance.familyId as (typeof FAMILIES)[number];
      expect(instance).toMatchObject({
        evaluationClass: "economic-decomposable",
        eligibility: {
          independentUnits: 3,
          estimatedMinLeafSeconds: 35,
          directSolP50Seconds: 120,
          calibrationEvidenceSha256: calibration.evidenceSha256,
        },
      });
      const workspaceSeal = instance.artifacts.find(
        (artifact) => artifact.role === "workspace_snapshot",
      )!;
      const workspace = JSON.parse(new TextDecoder().decode(byPath.get(workspaceSeal.path)!)) as {
        access: string;
        decomposition: string;
        ownedPaths: string[];
        files: Array<{ path: string; contentUtf8: string }>;
      };
      expect(workspace).toMatchObject({ access: "readOnly", decomposition: "independent" });
      expect(workspace.ownedPaths).toHaveLength(3);
      expect(new Set(workspace.ownedPaths).size).toBe(3);
      expect(
        new Set(workspace.files.map((item) => item.path.split("/").slice(0, 2).join("/"))).size,
      ).toBe(3);
      for (const root of workspace.ownedPaths) {
        const rootFiles = workspace.files.filter((item) => item.path.startsWith(root));
        expect(rootFiles).toHaveLength(FILES_PER_ROOT[familyId]);
        expect(
          rootFiles.reduce((total, item) => total + Buffer.byteLength(item.contentUtf8), 0),
        ).toBeGreaterThan(1_200);
      }

      const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
      const validator = parseSealedBenchmarkValidatorV1(
        JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
      );
      expect(validator.commandChecks).toHaveLength(CHECKS_PER_INSTANCE[familyId]);
      expect(
        validator.commandChecks.every((check) => check.argv.slice(0, 2).join(" ") === "node -e"),
      ).toBe(true);
      for (const check of validator.commandChecks) {
        expect(check.argv[2]).toContain("raw.indexOf('[item:'");
        const rule = JSON.parse(check.argv[3]!) as {
          anchor?: unknown;
          all?: unknown[];
          allAny?: unknown[][];
          none?: unknown[];
          noneUnlessNegated?: unknown[];
          regex?: unknown[];
          noneRegex?: unknown[];
          minWords?: unknown;
          maxWords?: unknown;
        };
        expect(rule.anchor).toMatch(/^\[item:[a-z0-9-]+\]$/u);
        const exactLiteral = (rule.all ?? []).some(
          (value) => typeof value === "string" && /[0-9$%[\]]/u.test(value),
        );
        expect(
          exactLiteral ||
            (rule.regex?.length ?? 0) > 0 ||
            (rule.noneRegex?.length ?? 0) > 0 ||
            (rule.allAny?.length ?? 0) > 0 ||
            (rule.none?.length ?? 0) > 0 ||
            (rule.noneUnlessNegated?.length ?? 0) > 0 ||
            rule.minWords !== undefined ||
            rule.maxWords !== undefined,
        ).toBe(true);
      }
      if (familyId === "auto-dossier") {
        const promptSeal = instance.artifacts.find((artifact) => artifact.role === "prompt")!;
        const prompt = new TextDecoder().decode(byPath.get(promptSeal.path)!);
        expect(prompt).toContain("exact observed value, governing threshold, and derived margin");
      }
    }

    await expect(
      verifyBenchmarkCorpus(corpus.manifest, async (artifact) => byPath.get(artifact.path)!),
    ).resolves.toBeUndefined();
  });

  it("does not claim measured economic eligibility without calibration input", () => {
    const corpus = createEconomicCrossDomainCorpus();
    expect(corpus.manifest.instances.every((instance) => instance.eligibility === undefined)).toBe(
      true,
    );
  });

  it("is deterministic and gives every prompt three explicit path partitions", () => {
    const first = createEconomicCrossDomainCorpus();
    const second = createEconomicCrossDomainCorpus();
    expect(first.manifest.manifestSha256).toBe(second.manifest.manifestSha256);
    const byPath = new Map(first.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    for (const instance of first.manifest.instances) {
      const prompt = instance.artifacts.find((artifact) => artifact.role === "prompt")!;
      const text = new TextDecoder().decode(byPath.get(prompt.path)!);
      expect(new Set(text.match(/data\/[a-z0-9-]+\//gu) ?? []).size).toBe(3);
      expect(text).toContain("independent work roots");
      expect(text).toContain("summary");
    }
  });

  it("executes an item-scoped exact check against the hidden model output", async () => {
    const corpus = createEconomicCrossDomainCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "algorithm-economic-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const validator = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const check = validator.commandChecks.find(
      (candidate) => candidate.id === "alg-1a-route-01-exact",
    )!;
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-economic-validator-"));
    try {
      await mkdir(join(workspace, ".agent-trio-benchmark"));
      await writeFile(
        join(workspace, ".agent-trio-benchmark", "model-output.txt"),
        "[item:alg-1a-route-01] Path A -> B -> C -> F; minimum cost 10; edge sum check: 3 + 4 + 3 = 10.\n",
        "utf8",
      );
      await expect(
        runSealedBenchmarkValidator(
          {
            schemaVersion: 1,
            runnerSandboxBoundary: { networkIsolation: "runner-controlled" },
            commandChecks: [check],
            requiredDeliverables: [],
          },
          { workspace },
        ),
      ).resolves.toMatchObject({ score: 100, passedChecks: 1, totalChecks: 1 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts equivalent factual wording while rejecting changed facts and positive overclaims", async () => {
    const corpus = createEconomicCrossDomainCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const selected = [
      ["research-economic-01", "research-1b-screen-01-eligible"],
      ["research-economic-01", "research-1b-screen-01-gamma"],
      ["research-economic-01", "research-1b-screen-01-alpha"],
      ["paper-economic-01", "paper-1a-paragraph-03-calibration"],
      ["office-economic-01", "office-1a-memo-01-decision"],
      ["office-economic-01", "office-1a-memo-01-rejection"],
      ["auto-economic-01", "dossier-1a-case-01-aurora"],
      ["auto-economic-01", "dossier-1a-case-01-beacon"],
      ["auto-economic-01", "dossier-1a-case-01-cascade"],
    ] as const;
    const checks = selected.map(([instanceId, checkId]) => {
      const instance = corpus.manifest.instances.find(
        (candidate) => candidate.instanceId === instanceId,
      )!;
      const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
      const validator = parseSealedBenchmarkValidatorV1(
        JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
      );
      return validator.commandChecks.find((candidate) => candidate.id === checkId)!;
    });
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-economic-equivalence-"));
    const validOutput = [
      "[item:research-1b-screen-01] Beta is the sole eligible candidate: score 83, critical defects 4%, deployment 9 vs 10 weeks. [SRC-RESEARCH-1B-SCREEN-01-BETA] Alpha has critical defects 7% and fails the 5% threshold with a +2 percentage-point margin. [SRC-RESEARCH-1B-SCREEN-01-ALPHA] Gamma has score 78 versus 80; margin -2 points. It deploys in 12 weeks versus the 10 weeks maximum; margin +2 weeks. [SRC-RESEARCH-1B-SCREEN-01-GAMMA]",
      "[item:paper-1a-paragraph-03] In this private-corpus benchmark, the observed estimate is limited by a self-reported outcome. The evidence does not establish that the method guarantees improvement.",
      "[item:office-1a-memo-01] Select Option B: $140,000, which is $9,000 under the mandatory $149,000 budget cap, completing in 9 weeks. Option A costs $163,000, exceeding the budget cap by $14,000.",
      "[item:dossier-1a-case-01] Aurora has impact 1,075, match $87,000, and duration 27 months. Result: eligible. Rank: #1, the only eligible applicant. [APP-DOSSIER-1A-CASE-01-AURORA] Beacon is ineligible: match $65,000 versus threshold $75,000, margin -$10,000; ethics pending. [APP-DOSSIER-1A-CASE-01-BEACON] Cascade is ineligible: impact 865 versus threshold 905, shortfall 40; duration 36 months versus the 30 months maximum, excess 6 months. [APP-DOSSIER-1A-CASE-01-CASCADE]",
    ].join("\n");
    try {
      await mkdir(join(workspace, ".agent-trio-benchmark"));
      const validator = {
        schemaVersion: 1 as const,
        runnerSandboxBoundary: { networkIsolation: "runner-controlled" as const },
        commandChecks: checks,
        requiredDeliverables: [],
      };
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await writeFile(outputPath, validOutput, "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput
          .replace("deployment 9 vs 10 weeks", "deployment 9 <= 10 weeks")
          .replace(
            "fails the 5% threshold with a +2 percentage-point margin",
            "exceeds the 5% threshold by 2 percentage points",
          )
          .replace(
            "margin -2 points. It deploys in 12 weeks versus the 10 weeks maximum; margin +2 weeks.",
            "failure margin 2 points under. It deploys in 12 weeks versus the 10 weeks maximum; failure margin 2 weeks over.",
          ),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace(
          "margin -2 points. It deploys in 12 weeks versus the 10 weeks maximum; margin +2 weeks.",
          "a 2-point shortfall. It deploys in 12 weeks versus the 10 weeks maximum; a 2-week excess.",
        ),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace(
          "Ranking: 1. Aurora. No other applicant is eligible.",
          "Rank: 1 of 1 eligible applicants.",
        ),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace("duration 27 months", "duration 27 vs 30-month maximum"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace(
          "duration 36 months versus the 30 months maximum, excess 6 months",
          "duration is 36 months versus the 30-month maximum (fail; exceeds maximum by 6 months)",
        ),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace(
          "impact 865 versus threshold 905, shortfall 40; duration 36 months versus the 30 months maximum, excess 6 months",
          "impact 865 vs threshold 905, margin -40 units/year; duration 36 vs the 30-month maximum, margin -6 months",
        ),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 9,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace(
          "The evidence does not establish that the method guarantees improvement.",
          "The evidence guarantees improvement.",
        ),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 89,
        passedChecks: 8,
        totalChecks: 9,
      });

      await writeFile(outputPath, validOutput.replace("impact 1,075", "impact 1,076"), "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 89,
        passedChecks: 8,
        totalChecks: 9,
      });

      await writeFile(
        outputPath,
        validOutput.replace("excess 6 months", "excess 7 months"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 89,
        passedChecks: 8,
        totalChecks: 9,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts exact office margins and day counts in equivalent wording", async () => {
    const corpus = createEconomicCrossDomainCorpus();
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "office-economic-01",
    )!;
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator")!;
    const sealed = parseSealedBenchmarkValidatorV1(
      JSON.parse(new TextDecoder().decode(byPath.get(validatorSeal.path)!)) as unknown,
    );
    const commandChecks = ["decision", "rejection", "actions"].map((suffix) =>
      sealed.commandChecks.find((candidate) => candidate.id === `office-1a-memo-01-${suffix}`)!,
    );
    const validator = { ...sealed, commandChecks };
    const validOutput =
      "[item:office-1a-memo-01] Select Option B at $140,000 against the $149,000 cap, " +
      "a favorable margin of $9,000, and complete in 9 weeks. Option A costs $163,000, " +
      "exceeding the cap by $14,000. Supplier-delay exposure is four days. Owen owns " +
      "mitigation due 2026-09-12; Inez owns confirmation due 2026-09-14.";
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-economic-office-wording-"));
    try {
      await mkdir(join(workspace, ".agent-trio-benchmark"));
      const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
      await writeFile(outputPath, validOutput, "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 3,
        totalChecks: 3,
      });

      await writeFile(
        outputPath,
        validOutput.replace("Select Option B", "Advance Option B"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 3,
        totalChecks: 3,
      });

      await writeFile(
        outputPath,
        validOutput
          .replace("a favorable margin of $9,000", "leaving $9,000 available")
          .replace("exceeding the cap by $14,000", "with margin -$14,000, so it fails the cap"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 3,
        totalChecks: 3,
      });

      await writeFile(
        outputPath,
        validOutput.replace("a favorable margin of $9,000", "$9,000 under"),
        "utf8",
      );
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 100,
        passedChecks: 3,
        totalChecks: 3,
      });

      await writeFile(outputPath, validOutput.replace("four days", "five days"), "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 67,
        passedChecks: 2,
        totalChecks: 3,
      });

      await writeFile(outputPath, validOutput.replace("$9,000", "$8,000"), "utf8");
      await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
        score: 67,
        passedChecks: 2,
        totalChecks: 3,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
