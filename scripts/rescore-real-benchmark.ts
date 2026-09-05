#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBenchmarkManifest,
  evaluateBenchmark,
  type BenchmarkCandidateArm,
  type BenchmarkObservation,
  type BenchmarkRunRecord,
} from "../src/benchmark.js";
import {
  parseSealedBenchmarkValidatorV1,
  runSealedBenchmarkValidator,
} from "../src/benchmark-validator.js";

interface RescoreOptions {
  corpus: string;
  source: string;
  evidence: string;
  output: string;
}

interface SourceReport {
  suiteId: string;
  manifestSha256: string;
  records: BenchmarkRunRecord[];
}

interface ScoreChange {
  familyId: string;
  instanceId: string;
  arm: BenchmarkObservation["arm"];
  previousScore: number;
  rescoredScore: number;
}

export async function rescoreRealBenchmark(options: Readonly<RescoreOptions>): Promise<void> {
  const corpusRoot = resolve(options.corpus);
  const evidenceRoot = resolve(options.evidence);
  const sourcePath = resolve(options.source);
  const outputPath = resolve(options.output);
  const manifestValue = JSON.parse(
    await readFile(resolve(corpusRoot, "manifest.json"), "utf8"),
  ) as unknown;
  assertBenchmarkManifest(manifestValue);
  const report = parseSourceReport(
    JSON.parse(await readFile(sourcePath, "utf8")) as unknown,
    sourcePath,
  );
  const instances = new Map(
    manifestValue.instances.map((instance) => [
      `${instance.familyId}\0${instance.instanceId}\0${instance.seed}`,
      instance,
    ]),
  );
  const observations: BenchmarkObservation[] = [];
  const scoreChanges: ScoreChange[] = [];
  let rescoredOutputs = 0;
  let preservedArtifactScores = 0;

  for (const record of report.records) {
    const observation = structuredClone(record.observation);
    const key = `${observation.familyId}\0${observation.instanceId}\0${observation.seed}`;
    const instance = instances.get(key);
    if (instance === undefined) {
      throw new Error(`rescoring corpus does not contain ${key.replaceAll("\0", "/")}`);
    }
    const validatorSeal = instance.artifacts.find((artifact) => artifact.role === "validator");
    if (validatorSeal === undefined) {
      throw new Error(`${observation.familyId}/${observation.instanceId} has no validator`);
    }
    const validatorPath = containedPath(corpusRoot, validatorSeal.path, "validator artifact");
    const validator = parseSealedBenchmarkValidatorV1(
      JSON.parse(await readFile(validatorPath, "utf8")) as unknown,
    );
    if (!isOutputOnlyValidator(validator.commandChecks.map((check) => check.argv))) {
      preservedArtifactScores += 1;
      observations.push(observation);
      continue;
    }
    const rawOutputArtifact = record.evidenceArtifacts.find(
      (artifact) => artifact.kind === "raw_output",
    );
    if (rawOutputArtifact === undefined) {
      throw new Error(
        `${observation.familyId}/${observation.instanceId}/${observation.arm} has no raw output`,
      );
    }
    const rawOutputPath = containedPath(evidenceRoot, rawOutputArtifact.path, "raw output");
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-trio-rescore-"));
    try {
      const hiddenOutput = resolve(workspace, ".agent-trio-benchmark", "model-output.txt");
      await mkdir(dirname(hiddenOutput), { recursive: true });
      await writeFile(hiddenOutput, await readFile(rawOutputPath));
      const validation = await runSealedBenchmarkValidator(validator, { workspace });
      const previousScore = observation.qualityScore;
      observation.qualityScore = validation.score;
      rescoredOutputs += 1;
      if (previousScore !== validation.score) {
        scoreChanges.push({
          familyId: observation.familyId,
          instanceId: observation.instanceId,
          arm: observation.arm,
          previousScore,
          rescoredScore: validation.score,
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    observations.push(observation);
  }

  const evaluations = Object.fromEntries(
    (["balanced", "quality"] as const).map((candidateArm) => [
      candidateArm,
      evaluateProfile(observations, candidateArm),
    ]),
  );
  const result = {
    suiteId: report.suiteId,
    sourceReport: sourcePath,
    sourceManifestSha256: report.manifestSha256,
    rescoringManifestSha256: manifestValue.manifestSha256,
    rescoredAt: new Date().toISOString(),
    modelCalls: 0,
    preservedCostAndTiming: true,
    rescoredOutputs,
    preservedArtifactScores,
    scoreChanges,
    observations,
    evaluation: evaluations.balanced,
    evaluations,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ output: outputPath, rescoredOutputs, preservedArtifactScores, scoreChanges: scoreChanges.length, evaluations })}\n`,
  );
}

function evaluateProfile(
  observations: readonly BenchmarkObservation[],
  candidateArm: BenchmarkCandidateArm,
) {
  const paired = observations.filter(
    (observation) => observation.arm === "direct_sol" || observation.arm === candidateArm,
  );
  return evaluateBenchmark(paired, {
    candidateArm,
    minimumInstancesPerFamily: 3,
    requireAllFamilies: true,
    requireSealedEvaluationClass: true,
  });
}

function isOutputOnlyValidator(commandVectors: readonly (readonly string[])[]): boolean {
  return (
    commandVectors.length > 0 &&
    commandVectors.every((argv) =>
      argv.some((argument) => argument.includes(".agent-trio-benchmark/model-output.txt")),
    )
  );
}

function containedPath(root: string, path: string, label: string): string {
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (
    isAbsolute(relation) ||
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`${label} escapes its declared root: ${path}`);
  }
  return target;
}

function parseSourceReport(value: unknown, path: string): SourceReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`benchmark report is not an object: ${path}`);
  }
  const source = value as Partial<SourceReport>;
  if (
    typeof source.suiteId !== "string" ||
    typeof source.manifestSha256 !== "string" ||
    !Array.isArray(source.records)
  ) {
    throw new Error(`benchmark report is missing suiteId, manifestSha256, or records: ${path}`);
  }
  return source as SourceReport;
}

function parseOptions(args: readonly string[]): RescoreOptions {
  const value = (flag: string): string => {
    const index = args.indexOf(flag);
    const result = index < 0 ? undefined : args[index + 1];
    if (result === undefined || result.startsWith("--")) {
      throw new Error(`${flag} requires a path`);
    }
    return result;
  };
  const known = new Set(["--corpus", "--source", "--evidence", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index]!)) {
      throw new Error(`unknown rescore argument: ${args[index]}`);
    }
  }
  return {
    corpus: value("--corpus"),
    source: value("--source"),
    evidence: value("--evidence"),
    output: value("--output"),
  };
}

const entryPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  await rescoreRealBenchmark(parseOptions(process.argv.slice(2)));
}
