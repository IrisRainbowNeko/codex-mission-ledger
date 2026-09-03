import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseSealedBenchmarkValidatorV1 } from "../src/benchmark-validator.js";
import { verifyBenchmarkCorpus } from "../src/benchmark.js";
import { createEconomicCodingCorpus } from "../scripts/generate-economic-coding-benchmark.js";
import { calibrationFixture } from "./benchmark-calibration-fixture.js";

const execFileAsync = promisify(execFile);

describe("economic coding diagnostic corpus", () => {
  it("seals three distinct three-way workspace-write instances with executable validators", async () => {
    const calibration = calibrationFixture(["coding-cross-module"]);
    const corpus = createEconomicCodingCorpus(calibration);
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));

    expect(corpus.manifest.instances).toHaveLength(3);
    expect(
      new Set(corpus.manifest.instances.map((instance) => instance.initialStateSha256)).size,
    ).toBe(3);
    for (const instance of corpus.manifest.instances) {
      expect(instance).toMatchObject({
        familyId: "coding-cross-module",
        evaluationClass: "economic-decomposable",
        eligibility: {
          independentUnits: 3,
          estimatedMinLeafSeconds: 35,
          directSolP50Seconds: 120,
          calibrationRevision: "independent-development-fixture-v1",
          calibrationEvidenceSha256: calibration.evidenceSha256,
        },
      });
      const validator = instance.artifacts.find((artifact) => artifact.role === "validator")!;
      const parsed = parseSealedBenchmarkValidatorV1(
        JSON.parse(new TextDecoder().decode(byPath.get(validator.path)!)) as unknown,
      );
      expect(parsed.commandChecks).toHaveLength(3);
    }

    await expect(
      verifyBenchmarkCorpus(corpus.manifest, async (artifact) => byPath.get(artifact.path)!),
    ).resolves.toBeUndefined();
  });

  it("does not claim measured economic eligibility without calibration input", () => {
    const corpus = createEconomicCodingCorpus();
    expect(corpus.manifest.instances.every((instance) => instance.eligibility === undefined)).toBe(
      true,
    );
  });

  it("emits syntactically valid JavaScript validation files", async () => {
    const corpus = createEconomicCodingCorpus();
    const root = await mkdtemp(join(tmpdir(), "agent-trio-economic-corpus-"));
    try {
      for (const artifact of corpus.artifacts.filter((item) =>
        item.path.endsWith("workspace.json"),
      )) {
        const snapshot = JSON.parse(new TextDecoder().decode(artifact.bytes)) as {
          files: Array<{ path: string; contentUtf8: string }>;
        };
        for (const file of snapshot.files.filter(
          (candidate) =>
            candidate.path.startsWith("validation/") && candidate.path.endsWith(".test.mjs"),
        )) {
          const target = join(root, artifact.path.replaceAll("/", "-"), file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.contentUtf8, "utf8");
          await expect(execFileAsync(process.execPath, ["--check", target])).resolves.toBeDefined();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
