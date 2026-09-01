import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCrossDomainDiagnosticCorpus,
  generateCrossDomainDiagnosticCorpus,
} from "../scripts/generate-cross-domain-diagnostic-benchmark.js";
import { createFileBenchmarkArtifactReader, verifyBenchmarkCorpus } from "../src/benchmark.js";
import {
  parseSealedBenchmarkValidatorV1,
  runSealedBenchmarkValidator,
} from "../src/benchmark-validator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("cross-domain diagnostic benchmark corpus", () => {
  it("defines ten deterministic sealed pairs across five families", () => {
    const first = createCrossDomainDiagnosticCorpus();
    const second = createCrossDomainDiagnosticCorpus();
    expect(first.manifest.manifestSha256).toBe(second.manifest.manifestSha256);
    expect(first.manifest.instances).toHaveLength(10);
    expect(first.artifacts).toHaveLength(40);
    expect(
      Object.fromEntries(
        ["algorithm-exact", "research-frozen", "paper-edit", "office-document", "auto-dossier"].map(
          (familyId) => [
            familyId,
            first.manifest.instances.filter((instance) => instance.familyId === familyId).length,
          ],
        ),
      ),
    ).toEqual({
      "algorithm-exact": 2,
      "research-frozen": 2,
      "paper-edit": 2,
      "office-document": 2,
      "auto-dossier": 2,
    });
    expect(
      first.manifest.instances.every(
        (instance) => instance.sourceRevision === "generated diagnostic",
      ),
    ).toBe(true);
  });

  it("uses explicit workspaces and no-shell sealed-v1 validators with at least five checks", () => {
    const corpus = createCrossDomainDiagnosticCorpus();
    const artifacts = new Map(
      corpus.artifacts.map((artifact) => [artifact.path, new TextDecoder().decode(artifact.bytes)]),
    );
    for (const instance of corpus.manifest.instances) {
      const workspacePath = instance.artifacts.find(
        (artifact) => artifact.role === "workspace_snapshot",
      )?.path;
      const validatorPath = instance.artifacts.find(
        (artifact) => artifact.role === "validator",
      )?.path;
      const rubricPath = instance.artifacts.find(
        (artifact) => artifact.role === "quality_rubric",
      )?.path;
      expect(workspacePath).toBeDefined();
      expect(validatorPath).toBeDefined();
      expect(rubricPath).toBeDefined();

      const workspace = JSON.parse(artifacts.get(workspacePath!)!) as {
        access?: unknown;
        citationPolicy?: unknown;
        decomposition?: unknown;
        files?: Array<Record<string, unknown>>;
      };
      expect(["readOnly", "workspaceWrite"]).toContain(workspace.access);
      expect(["none", "frozen-required"]).toContain(workspace.citationPolicy);
      expect(workspace.decomposition).toBe(
        instance.familyId === "algorithm-exact" ? "independent" : "coupled",
      );
      expect(workspace.files?.length).toBeGreaterThanOrEqual(
        instance.familyId === "paper-edit" ? 1 : 3,
      );
      expect(workspace.files?.every((file) => typeof file["contentUtf8"] === "string")).toBe(true);
      expect(
        workspace.files?.every(
          (file) => file["content"] === undefined && file["contentBase64"] === undefined,
        ),
      ).toBe(true);

      const validator = parseSealedBenchmarkValidatorV1(JSON.parse(artifacts.get(validatorPath!)!));
      expect(validator.commandChecks.length).toBeGreaterThanOrEqual(5);
      expect(validator.requiredDeliverables).toEqual([]);
      for (const check of validator.commandChecks) {
        expect(check.argv.slice(0, 2)).toEqual(["node", "-e"]);
        expect(check.argv[2]).toContain(".agent-trio-benchmark/model-output.txt");
        expect(check.argv).not.toContain("sh");
        expect(check.argv).not.toContain("bash");
      }

      const rubric = JSON.parse(artifacts.get(rubricPath!)!) as {
        mode?: unknown;
        criteria?: unknown[];
      };
      expect(rubric.mode).toBe("sealed-v1");
      expect(rubric.criteria).toHaveLength(validator.commandChecks.length);
    }
  });

  it("materializes a corpus that passes the manifest verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-trio-cross-domain-corpus-"));
    temporaryDirectories.push(root);
    const generated = await generateCrossDomainDiagnosticCorpus(root);
    await expect(
      verifyBenchmarkCorpus(generated.manifest, createFileBenchmarkArtifactReader(root)),
    ).resolves.toBeUndefined();
    const stored = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
      manifestSha256?: unknown;
    };
    expect(stored.manifestSha256).toBe(generated.manifest.manifestSha256);
  });

  it("executes the hidden-output Node validator without a shell", async () => {
    const corpus = createCrossDomainDiagnosticCorpus();
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "algorithm-exact-routes-01",
    );
    const validatorPath = instance?.artifacts.find(
      (artifact) => artifact.role === "validator",
    )?.path;
    expect(validatorPath).toBeDefined();
    const validatorArtifact = corpus.artifacts.find((artifact) => artifact.path === validatorPath);
    expect(validatorArtifact).toBeDefined();

    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-cross-domain-validator-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".agent-trio-benchmark"));
    await writeFile(
      join(workspace, ".agent-trio-benchmark", "model-output.txt"),
      [
        "Case A: A → C → B → D; total cost: 1 + 2 + 1 = 4.",
        "Case B: S -> A -> T; total cost: 2 + 3 = 5.",
        "Case C: P → R → Q → Z; total cost: 2 + 1 + 2 = 5.",
        "Case D: H → I → L; total cost: 5 + 1 = 6.",
        "Case E: U → V → W → X; total cost: 1 + 1 + 2 = 4.",
      ].join("\n"),
      "utf8",
    );
    const validator = JSON.parse(new TextDecoder().decode(validatorArtifact!.bytes)) as unknown;
    await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
      score: 100,
      passedChecks: 5,
      totalChecks: 5,
    });
  });

  it("accepts reconciliation labels written as file names or workspace paths", async () => {
    const corpus = createCrossDomainDiagnosticCorpus();
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "algorithm-exact-reconciliation-02",
    );
    const validatorPath = instance?.artifacts.find(
      (artifact) => artifact.role === "validator",
    )?.path;
    const validatorArtifact = corpus.artifacts.find((artifact) => artifact.path === validatorPath);
    expect(validatorArtifact).toBeDefined();

    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-reconciliation-validator-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".agent-trio-benchmark"));
    await writeFile(
      join(workspace, ".agent-trio-benchmark", "model-output.txt"),
      [
        "| file | IDs | arithmetic |",
        "| `a` | A, B | 8 + 11 = 19 |",
        "| `b.txt` | B, C | 9 + 14 = 23 |",
        "| `accounts/c.txt` | A, B, C | 12 + 7 + 11 = 30 |",
        "| `d` | A, B, E | 3 + 5 + 9 = 17 |",
        "| `accounts/e.txt` | B, E | 13 + 28 = 41 |",
      ].join("\n"),
      "utf8",
    );
    const validator = JSON.parse(new TextDecoder().decode(validatorArtifact!.bytes)) as unknown;

    await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
      score: 100,
      passedChecks: 5,
      totalChecks: 5,
    });
  });

  it("accepts semantically equivalent grant ranking and duration wording", async () => {
    const corpus = createCrossDomainDiagnosticCorpus();
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "auto-dossier-grants-02",
    );
    const validatorPath = instance?.artifacts.find(
      (artifact) => artifact.role === "validator",
    )?.path;
    const validatorArtifact = corpus.artifacts.find((artifact) => artifact.path === validatorPath);
    expect(validatorArtifact).toBeDefined();

    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-auto-dossier-validator-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".agent-trio-benchmark"));
    await writeFile(
      join(workspace, ".agent-trio-benchmark", "model-output.txt"),
      [
        "Aurora is eligible: required match $80,000, supplied $90,000. [APP-AURORA]",
        "Beacon supplied $80,000 against a required $90,000; ethics approval is pending. [APP-BEACON]",
        "Cascade has a 30-month duration over the 24-month limit. [APP-CASCADE]",
        "Aurora is the only eligible proposal and ranks first.",
        "Verified reductions are 1,200, 1,500, and 900 tCO2e/year.",
      ].join("\n"),
      "utf8",
    );
    const validator = JSON.parse(new TextDecoder().decode(validatorArtifact!.bytes)) as unknown;

    await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
      score: 100,
      passedChecks: 6,
      totalChecks: 6,
    });
  });

  it("accepts evidence-calibrated paper wording without requiring one literal phrase", async () => {
    const corpus = createCrossDomainDiagnosticCorpus();
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "paper-edit-model-02",
    );
    const validatorPath = instance?.artifacts.find(
      (artifact) => artifact.role === "validator",
    )?.path;
    const validatorArtifact = corpus.artifacts.find((artifact) => artifact.path === validatorPath);
    expect(validatorArtifact).toBeDefined();

    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-paper-validator-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".agent-trio-benchmark"));
    await writeFile(
      join(workspace, ".agent-trio-benchmark", "model-output.txt"),
      [
        "Across three random seeds on a private corpus of 1,200 documents, macro-F1 was 0.781 (SD 0.012),",
        "versus 0.774 (SD 0.009), a small 0.007 difference. No significance test was conducted,",
        "and external validity to other document collections remains untested.",
      ].join(" "),
      "utf8",
    );
    const validator = JSON.parse(new TextDecoder().decode(validatorArtifact!.bytes)) as unknown;

    await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
      score: 100,
      passedChecks: 6,
      totalChecks: 6,
    });
  });

  it("allows negated significance wording but rejects a positive significance claim", async () => {
    const corpus = createCrossDomainDiagnosticCorpus();
    const instance = corpus.manifest.instances.find(
      (candidate) => candidate.instanceId === "research-frozen-trials-02",
    );
    const validatorPath = instance?.artifacts.find(
      (artifact) => artifact.role === "validator",
    )?.path;
    const validatorArtifact = corpus.artifacts.find((artifact) => artifact.path === validatorPath);
    expect(validatorArtifact).toBeDefined();
    const validator = JSON.parse(new TextDecoder().decode(validatorArtifact!.bytes)) as unknown;
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-significance-validator-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".agent-trio-benchmark"));
    const outputPath = join(workspace, ".agent-trio-benchmark", "model-output.txt");
    const facts = [
      "Beta is the only eligible trial. [TRIAL-BETA]",
      "Alpha has 8% events against 7%. [TRIAL-ALPHA]",
      "Gamma is single-arm with 12% events and 6 months follow-up. [TRIAL-GAMMA]",
      "Responses were 62%, 58%, and 68%.",
    ].join(" ");

    await writeFile(
      outputPath,
      `${facts} The differences should not be presented as statistically significant.`,
    );
    await expect(runSealedBenchmarkValidator(validator, { workspace })).resolves.toMatchObject({
      score: 100,
    });

    await writeFile(outputPath, `${facts} The response difference is statistically significant.`);
    const positive = await runSealedBenchmarkValidator(validator, { workspace });
    expect(positive.score).toBeLessThan(100);
    expect(positive.evidence).toContainEqual(
      expect.objectContaining({ id: "no-significance", passed: false }),
    );
  });
});
