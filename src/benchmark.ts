import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type BenchmarkDomain =
  "coding" | "algorithm" | "research" | "paper" | "office" | "autoResearch";

export interface BenchmarkFamily {
  id: string;
  domain: BenchmarkDomain;
  title: string;
  decomposable: boolean;
}

export const BENCHMARK_FAMILIES: readonly BenchmarkFamily[] = Object.freeze([
  { id: "coding-local-bugfix", domain: "coding", title: "Local bug fix", decomposable: false },
  {
    id: "coding-cross-module",
    domain: "coding",
    title: "Cross-module feature",
    decomposable: true,
  },
  { id: "coding-review", domain: "coding", title: "Read-only diagnosis", decomposable: true },
  { id: "algorithm-exact", domain: "algorithm", title: "Exact algorithm", decomposable: true },
  {
    id: "algorithm-optimization",
    domain: "algorithm",
    title: "Combinatorial optimization",
    decomposable: true,
  },
  {
    id: "algorithm-numerical",
    domain: "algorithm",
    title: "Numerical computation",
    decomposable: true,
  },
  { id: "research-frozen", domain: "research", title: "Frozen-corpus review", decomposable: true },
  { id: "research-live", domain: "research", title: "Current web research", decomposable: true },
  {
    id: "research-conflict",
    domain: "research",
    title: "Conflicting-evidence memo",
    decomposable: true,
  },
  { id: "paper-edit", domain: "paper", title: "Targeted manuscript edit", decomposable: false },
  { id: "paper-review", domain: "paper", title: "Adversarial paper review", decomposable: true },
  { id: "paper-revision", domain: "paper", title: "Review-driven revision", decomposable: true },
  { id: "office-sheet", domain: "office", title: "Spreadsheet model", decomposable: true },
  { id: "office-document", domain: "office", title: "Document report", decomposable: true },
  { id: "office-slides", domain: "office", title: "Editable slide deck", decomposable: true },
  { id: "auto-dossier", domain: "autoResearch", title: "Durable dossier", decomposable: true },
  { id: "auto-recovery", domain: "autoResearch", title: "Crash recovery", decomposable: true },
  {
    id: "auto-pipeline",
    domain: "autoResearch",
    title: "Cross-artifact pipeline",
    decomposable: true,
  },
]);

export type BenchmarkArm = "direct_sol" | "v3";

export const BENCHMARK_MANIFEST_VERSION = 1 as const;
export const BENCHMARK_BASELINE_MODEL = "gpt-5.6-sol" as const;
export const BENCHMARK_BASELINE_EFFORT = "ultra" as const;

export const BENCHMARK_USAGE_STAGES = Object.freeze([
  "admission",
  "direct",
  "planning",
  "replan",
  "leaves",
  "integration",
  "finalReview",
] as const);

export type BenchmarkUsageStage = (typeof BENCHMARK_USAGE_STAGES)[number];

export type BenchmarkArtifactRole =
  "prompt" | "input" | "workspace_snapshot" | "validator" | "quality_rubric" | "external_snapshot";

export interface BenchmarkArtifactSeal {
  path: string;
  role: BenchmarkArtifactRole;
  sha256: string;
  sizeBytes: number;
}

export interface BenchmarkCorpusInstance {
  familyId: string;
  instanceId: string;
  seed: string;
  sourceRevision: string;
  /**
   * Sealed before either arm runs. Release corpora must set this explicitly;
   * legacy diagnostic corpora may omit it and use the family-level migration.
   */
  evaluationClass?: BenchmarkEvaluationClass;
  /** Optional sealed evidence supporting an economic-decomposable classification. */
  eligibility?: BenchmarkEconomicEligibility;
  /** Required by the release runner; diagnostic corpora may omit it. */
  provenance?: BenchmarkInstanceProvenance;
  /** Sealed evidence that the validator accepts gold and rejects at least two mutants. */
  validatorQualification?: BenchmarkValidatorQualification;
  initialStateSha256: string;
  artifacts: BenchmarkArtifactSeal[];
}

export interface BenchmarkInstanceProvenance {
  origin: "public-benchmark" | "authored-held-out";
  source: string;
  license: string;
  collectedAt: string;
}

export interface BenchmarkValidatorQualification {
  goldSha256: string;
  mutantSha256: string[];
}

export type BenchmarkEvaluationClass = "direct-fast-path" | "economic-decomposable";

export interface BenchmarkEconomicEligibility {
  independentUnits: number;
  estimatedMinLeafSeconds: number;
  calibrationRevision: string;
}

export interface BenchmarkManifestDraft {
  schemaVersion: typeof BENCHMARK_MANIFEST_VERSION;
  suiteId: string;
  sealedAt: string;
  baseline: {
    model: typeof BENCHMARK_BASELINE_MODEL;
    modelRevision: string;
    effort: typeof BENCHMARK_BASELINE_EFFORT;
  };
  instances: BenchmarkCorpusInstance[];
}

export interface BenchmarkCorpusManifest extends BenchmarkManifestDraft {
  manifestSha256: string;
}

export interface BenchmarkToolEvidence {
  id: string;
  version: string;
  configurationSha256: string;
}

export interface BenchmarkPermissionEvidence {
  sandboxMode: string;
  approvalPolicy: string;
  networkAccess: string;
}

export interface BenchmarkEnvironmentEvidence {
  provider: string;
  providerConfigurationSha256: string;
  serviceTier: string;
  permissions: Readonly<BenchmarkPermissionEvidence>;
  tools: readonly BenchmarkToolEvidence[];
}

export type BenchmarkUsageCostSource = "app_server" | "price_table";

export interface BenchmarkModelUsageEvidence {
  model: string;
  modelRevision: string;
  tier: "luna" | "terra" | "sol" | "other";
  effort: string | null;
  cachedInputTokens: number;
  /**
   * Tokens written to the provider prompt cache. This is optional so sealed
   * records produced before cache-write accounting was added remain readable.
   */
  cacheWriteInputTokens?: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  costSource: BenchmarkUsageCostSource;
  pricingSha256?: string;
  threadId?: string;
  turnId?: string | null;
}

export type BenchmarkUsageByStage = {
  [Stage in BenchmarkUsageStage]: readonly BenchmarkModelUsageEvidence[];
};

export interface BenchmarkRunArtifactEvidence {
  kind: "raw_output" | "validator_output" | "deliverable" | "scorecard";
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BenchmarkRunRecord {
  observation: BenchmarkObservation;
  manifestSha256: string;
  instanceSha256: string;
  startedAt: string;
  completedAt: string;
  environment: BenchmarkEnvironmentEvidence;
  usageByStage: BenchmarkUsageByStage;
  inputArtifactSha256: readonly string[];
  qualityDefinitionSha256: string;
  evidenceArtifacts: readonly BenchmarkRunArtifactEvidence[];
}

export interface VerifiedBenchmarkArtifact {
  seal: BenchmarkArtifactSeal;
  bytes: Uint8Array;
}

export interface BenchmarkExecutionRequest {
  arm: BenchmarkArm;
  pairIndex: number;
  orderInPair: 0 | 1;
  suiteId: string;
  manifestSha256: string;
  instanceSha256: string;
  baseline: Readonly<BenchmarkManifestDraft["baseline"]>;
  environment: Readonly<BenchmarkEnvironmentEvidence>;
  instance: Readonly<BenchmarkCorpusInstance>;
  artifacts: readonly Readonly<VerifiedBenchmarkArtifact>[];
}

export type BenchmarkExecutor = (
  request: Readonly<BenchmarkExecutionRequest>,
) => Promise<BenchmarkRunRecord>;

export interface BenchmarkExecutors {
  direct_sol: BenchmarkExecutor;
  v3: BenchmarkExecutor;
}

export type BenchmarkArtifactReader = (
  artifact: Readonly<BenchmarkArtifactSeal>,
  instance: Readonly<BenchmarkCorpusInstance>,
) => Promise<Uint8Array>;

export type BenchmarkRunArtifactReader = (
  artifact: Readonly<BenchmarkRunArtifactEvidence>,
  record: Readonly<BenchmarkRunRecord>,
) => Promise<Uint8Array>;

export interface PairedBenchmarkOptions {
  artifactReader: BenchmarkArtifactReader;
  runArtifactReader: BenchmarkRunArtifactReader;
  environment: BenchmarkEnvironmentEvidence;
  evaluation?: BenchmarkEvaluationOptions;
  armOrder?: "balanced" | "direct-first" | "v3-first";
  onRecord?: (record: Readonly<BenchmarkRunRecord>) => void | Promise<void>;
}

export interface PairedBenchmarkResult {
  suiteId: string;
  manifestSha256: string;
  records: BenchmarkRunRecord[];
  observations: BenchmarkObservation[];
  evaluation: BenchmarkEvaluation;
}

export interface BenchmarkObservation {
  familyId: string;
  instanceId: string;
  seed: string;
  arm: BenchmarkArm;
  qualityScore: number;
  elapsedMs: number;
  costUsd: number | null;
  route: "direct" | "delegated" | "fanout";
  /** Copied from the sealed corpus instance, never inferred from the observed route. */
  evaluationClass?: BenchmarkEvaluationClass;
  launchSkewMs?: number | null;
  plannerTurns?: number;
  /** True when the calling Sol supplied the semantic plan and no child Sol planner was started. */
  hostPlanned?: boolean;
  replanCount?: number;
  promotionCount?: number;
  finalReviewTurns?: number;
  leafCount?: number;
  protocolErrors?: number;
  userInterventions?: number;
  criticalFailures?: string[];
}

export interface BenchmarkGate {
  name: string;
  passed: boolean;
  actual: number | string | null;
  limit: number | string;
}

export interface BenchmarkEvaluation {
  passed: boolean;
  pairCount: number;
  familyCounts: Record<string, number>;
  evaluationClassCounts: Record<BenchmarkEvaluationClass, number>;
  speedRatio: number | null;
  costRatio: number | null;
  qualityRatio: number | null;
  qualityGap: number | null;
  directOverheadP95: number | null;
  launchSkewP95Ms: number | null;
  gates: BenchmarkGate[];
  errors: string[];
}

export interface BenchmarkEvaluationOptions {
  minimumInstancesPerFamily?: number;
  requireAllFamilies?: boolean;
  /** Release evaluation must reject observations without the pre-sealed class. */
  requireSealedEvaluationClass?: boolean;
}

interface Pair {
  family: BenchmarkFamily;
  evaluationClass: BenchmarkEvaluationClass;
  direct: BenchmarkObservation;
  candidate: BenchmarkObservation;
}

export function hashBenchmarkBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function benchmarkInstanceSha256(instance: Readonly<BenchmarkCorpusInstance>): string {
  validateCorpusInstance(instance, "instance");
  return hashBenchmarkBytes(canonicalJson(instance));
}

export function sealBenchmarkManifest(
  draft: Readonly<BenchmarkManifestDraft>,
): BenchmarkCorpusManifest {
  validateManifestDraft(draft);
  const snapshot = structuredClone(draft);
  return {
    ...snapshot,
    manifestSha256: hashBenchmarkBytes(canonicalJson(snapshot)),
  };
}

export function parseBenchmarkManifest(source: string): BenchmarkCorpusManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`invalid benchmark manifest JSON: ${normalizeError(error)}`, { cause: error });
  }
  assertBenchmarkManifest(parsed);
  return structuredClone(parsed);
}

export function assertBenchmarkManifest(value: unknown): asserts value is BenchmarkCorpusManifest {
  if (!isRecord(value)) {
    throw new Error("benchmark manifest must be an object");
  }
  validateManifestDraft(value);
  requireSha256(value["manifestSha256"], "manifestSha256");
  const { manifestSha256, ...draft } = value;
  const expected = hashBenchmarkBytes(canonicalJson(draft));
  if (manifestSha256 !== expected) {
    throw new Error(`benchmark manifest seal mismatch: expected ${expected}`);
  }
}

export function assertBenchmarkManifestCoverage(
  manifest: Readonly<BenchmarkCorpusManifest>,
  options: BenchmarkEvaluationOptions = {},
): void {
  assertBenchmarkManifest(manifest);
  if (options.requireSealedEvaluationClass === true) {
    assertBenchmarkManifestEvaluationClasses(manifest);
  }
  const minimum = options.minimumInstancesPerFamily ?? 3;
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error("minimumInstancesPerFamily must be a positive integer");
  }
  const counts = new Map<string, number>();
  for (const instance of manifest.instances) {
    counts.set(instance.familyId, (counts.get(instance.familyId) ?? 0) + 1);
  }
  const missing = BENCHMARK_FAMILIES.flatMap((family) => {
    const count = counts.get(family.id) ?? 0;
    const needsMinimum =
      options.requireAllFamilies !== false ||
      (options.minimumInstancesPerFamily !== undefined && count > 0);
    return !needsMinimum || count >= minimum
      ? []
      : [`${family.id} has ${String(count)} instances; requires ${String(minimum)}`];
  });
  if (missing.length > 0) {
    throw new Error(`benchmark manifest coverage is incomplete: ${missing.join("; ")}`);
  }
}

/** Rejects legacy diagnostic manifests that lack a pre-run evaluation class. */
export function assertBenchmarkManifestEvaluationClasses(
  manifest: Readonly<BenchmarkCorpusManifest>,
): void {
  assertBenchmarkManifest(manifest);
  const missing = manifest.instances
    .filter((instance) => instance.evaluationClass === undefined)
    .map((instance) => `${instance.familyId}/${instance.instanceId}`);
  if (missing.length > 0) {
    throw new Error(
      `release benchmark instances must pre-seal evaluationClass: ${missing.join(", ")}`,
    );
  }
}

export function createFileBenchmarkArtifactReader(rootDirectory: string): BenchmarkArtifactReader {
  requireNonEmpty(rootDirectory, "rootDirectory");
  const root = resolve(rootDirectory);
  return async (artifact) => {
    return readBenchmarkArtifactFile(root, artifact.path, "corpus");
  };
}

export function createFileBenchmarkRunArtifactReader(
  rootDirectory: string,
): BenchmarkRunArtifactReader {
  requireNonEmpty(rootDirectory, "rootDirectory");
  const root = resolve(rootDirectory);
  return async (artifact) => {
    return readBenchmarkArtifactFile(root, artifact.path, "run evidence");
  };
}

async function readBenchmarkArtifactFile(
  root: string,
  artifactPath: string,
  kind: string,
): Promise<Uint8Array> {
  validateRelativeArtifactPath(artifactPath, `${kind} artifact path`);
  const path = resolve(root, artifactPath);
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  const pathFromRoot = relative(realRoot, realPath);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`benchmark ${kind} artifact escapes its root: ${artifactPath}`);
  }
  return new Uint8Array(await readFile(realPath));
}

export async function verifyBenchmarkCorpus(
  manifest: Readonly<BenchmarkCorpusManifest>,
  artifactReader: BenchmarkArtifactReader,
): Promise<void> {
  assertBenchmarkManifest(manifest);
  for (const instance of manifest.instances) {
    await loadVerifiedInstanceArtifacts(instance, artifactReader);
  }
}

async function loadVerifiedInstanceArtifacts(
  instance: Readonly<BenchmarkCorpusInstance>,
  artifactReader: BenchmarkArtifactReader,
): Promise<VerifiedBenchmarkArtifact[]> {
  const verified: VerifiedBenchmarkArtifact[] = [];
  for (const artifact of instance.artifacts) {
    const bytes = await artifactReader(artifact, instance);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`artifact reader returned non-byte data for ${artifact.path}`);
    }
    if (bytes.byteLength !== artifact.sizeBytes) {
      throw new Error(
        `artifact size mismatch for ${artifact.path}: expected ${String(artifact.sizeBytes)}, got ${String(bytes.byteLength)}`,
      );
    }
    const actual = hashBenchmarkBytes(bytes);
    if (actual !== artifact.sha256) {
      throw new Error(
        `artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
      );
    }
    verified.push({ seal: structuredClone(artifact), bytes: structuredClone(bytes) });
  }
  return verified;
}

async function verifyRunArtifacts(
  record: Readonly<BenchmarkRunRecord>,
  artifactReader: BenchmarkRunArtifactReader,
): Promise<void> {
  for (const artifact of record.evidenceArtifacts) {
    const bytes = await artifactReader(artifact, record);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`run artifact reader returned non-byte data for ${artifact.path}`);
    }
    if (bytes.byteLength !== artifact.sizeBytes) {
      throw new Error(
        `run artifact size mismatch for ${artifact.path}: expected ${String(artifact.sizeBytes)}, got ${String(bytes.byteLength)}`,
      );
    }
    const actual = hashBenchmarkBytes(bytes);
    if (actual !== artifact.sha256) {
      throw new Error(
        `run artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
      );
    }
    if (artifact.kind === "scorecard") {
      validateScorecard(bytes, record);
    }
  }
}

function validateScorecard(bytes: Uint8Array, record: Readonly<BenchmarkRunRecord>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`scorecard is not valid JSON: ${normalizeError(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("scorecard must be a JSON object");
  }
  if (parsed["qualityScore"] !== record.observation.qualityScore) {
    throw new Error("scorecard qualityScore does not match the benchmark observation");
  }
  if (parsed["qualityDefinitionSha256"] !== record.qualityDefinitionSha256) {
    throw new Error("scorecard quality definition does not match the sealed benchmark definition");
  }
}

export async function runPairedBenchmark(
  manifest: Readonly<BenchmarkCorpusManifest>,
  executors: Readonly<BenchmarkExecutors>,
  options: PairedBenchmarkOptions,
): Promise<PairedBenchmarkResult> {
  assertBenchmarkManifestCoverage(manifest, options.evaluation);
  validateEnvironmentEvidence(options.environment, "declared benchmark environment");
  await verifyBenchmarkCorpus(manifest, options.artifactReader);

  const records: BenchmarkRunRecord[] = [];
  const observations: BenchmarkObservation[] = [];
  const armOrder = options.armOrder ?? "balanced";
  for (const [pairIndex, instance] of manifest.instances.entries()) {
    const instanceSha256 = benchmarkInstanceSha256(instance);
    const artifacts = await loadVerifiedInstanceArtifacts(instance, options.artifactReader);
    const order = benchmarkArmOrder(armOrder, pairIndex);
    const pairRecords = new Map<BenchmarkArm, BenchmarkRunRecord>();
    for (const [orderInPair, arm] of order.entries()) {
      const executor = executors[arm];
      if (typeof executor !== "function") {
        throw new Error(`missing benchmark executor for ${arm}`);
      }
      const record = structuredClone(
        await executor({
          arm,
          pairIndex,
          orderInPair: orderInPair as 0 | 1,
          suiteId: manifest.suiteId,
          manifestSha256: manifest.manifestSha256,
          instanceSha256,
          baseline: structuredClone(manifest.baseline),
          environment: structuredClone(options.environment),
          instance: structuredClone(instance),
          artifacts: structuredClone(artifacts),
        }),
      );
      validateRunRecord(record, manifest, instance, arm, instanceSha256, options.environment);
      applySealedEvaluationClass(record, instance);
      await verifyRunArtifacts(record, options.runArtifactReader);
      records.push(record);
      observations.push(record.observation);
      pairRecords.set(arm, record);
      await options.onRecord?.(structuredClone(record));
    }
    assertMatchingEnvironment(
      requireMapValue(pairRecords, "direct_sol"),
      requireMapValue(pairRecords, "v3"),
      instance,
    );
  }

  return {
    suiteId: manifest.suiteId,
    manifestSha256: manifest.manifestSha256,
    records,
    observations,
    evaluation: evaluateBenchmark(observations, options.evaluation),
  };
}

export function evaluateBenchmark(
  observations: readonly BenchmarkObservation[],
  options: BenchmarkEvaluationOptions = {},
): BenchmarkEvaluation {
  const minimum = options.minimumInstancesPerFamily ?? 3;
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error("minimumInstancesPerFamily must be a positive integer");
  }
  observations.forEach(validateObservation);
  const families = new Map(BENCHMARK_FAMILIES.map((family) => [family.id, family]));
  const byPair = new Map<string, Partial<Record<BenchmarkArm, BenchmarkObservation>>>();
  for (const observation of observations) {
    if (!families.has(observation.familyId)) {
      throw new Error(`unknown benchmark family: ${observation.familyId}`);
    }
    const key = `${observation.familyId}\u0000${observation.instanceId}\u0000${observation.seed}`;
    const pair = byPair.get(key) ?? {};
    if (pair[observation.arm] !== undefined) {
      throw new Error(
        `duplicate ${observation.arm} observation for ${key.replaceAll("\u0000", "/")}`,
      );
    }
    pair[observation.arm] = observation;
    byPair.set(key, pair);
  }

  const errors: string[] = [];
  const pairs: Pair[] = [];
  for (const [key, value] of byPair) {
    if (value.direct_sol === undefined || value.v3 === undefined) {
      errors.push(`unpaired observation: ${key.replaceAll("\u0000", "/")}`);
      continue;
    }
    const evaluationClass = resolvePairEvaluationClass(
      value.direct_sol,
      value.v3,
      families.get(value.v3.familyId)!,
      options,
      errors,
    );
    pairs.push({
      family: families.get(value.v3.familyId)!,
      evaluationClass,
      direct: value.direct_sol,
      candidate: value.v3,
    });
  }

  const familyCounts: Record<string, number> = {};
  const evaluationClassCounts: Record<BenchmarkEvaluationClass, number> = {
    "direct-fast-path": 0,
    "economic-decomposable": 0,
  };
  for (const pair of pairs) {
    familyCounts[pair.family.id] = (familyCounts[pair.family.id] ?? 0) + 1;
    evaluationClassCounts[pair.evaluationClass] += 1;
  }
  for (const family of BENCHMARK_FAMILIES) {
    const count = familyCounts[family.id] ?? 0;
    const needsMinimum =
      options.requireAllFamilies !== false ||
      (options.minimumInstancesPerFamily !== undefined && count > 0);
    if (needsMinimum && count < minimum) {
      errors.push(`${family.id} has ${count} paired instances; requires ${minimum}`);
    }
  }

  // Eligibility is sealed before execution. Never use the candidate's observed
  // route to select which pairs are accountable to the economic gates.
  const economicPairs = pairs.filter((pair) => pair.evaluationClass === "economic-decomposable");
  const actualFanoutPairs = pairs.filter((pair) => pair.candidate.route === "fanout");
  const directFastPathPairs = pairs.filter((pair) => pair.evaluationClass === "direct-fast-path");
  const telemetryErrors = benchmarkTelemetryErrors(pairs);
  errors.push(...telemetryErrors);
  const speedRatio = macroRatio(economicPairs, (item) => item.elapsedMs);
  const costComplete = economicPairs.every(
    (pair) =>
      pair.direct.costUsd !== null &&
      pair.direct.costUsd > 0 &&
      pair.candidate.costUsd !== null &&
      pair.candidate.costUsd > 0,
  );
  const costRatio = costComplete ? macroRatio(economicPairs, (item) => item.costUsd ?? 0) : null;
  const quality = macroQuality(pairs);
  const absoluteQualityFloor =
    pairs.length === 0 ? null : Math.min(...pairs.map((pair) => pair.candidate.qualityScore));
  const directOverheadP95 = percentile(
    directFastPathPairs.map((pair) => ratio(pair.candidate.elapsedMs, pair.direct.elapsedMs) - 1),
    0.95,
  );
  const launchSkewComplete = actualFanoutPairs.every(
    (pair) => pair.candidate.launchSkewMs !== null && pair.candidate.launchSkewMs !== undefined,
  );
  const launchSkewP95Ms =
    launchSkewComplete && actualFanoutPairs.length > 0
      ? percentile(
          actualFanoutPairs.map((pair) => pair.candidate.launchSkewMs as number),
          0.95,
        )
      : null;
  const protocolErrors = observations.reduce((sum, item) => sum + (item.protocolErrors ?? 0), 0);
  const interventions = observations.reduce((sum, item) => sum + (item.userInterventions ?? 0), 0);
  const criticalFailures = observations.flatMap((item) => item.criticalFailures ?? []);
  const directRoutingViolations = directFastPathPairs.filter(
    (pair) =>
      pair.candidate.route !== "direct" ||
      (pair.candidate.plannerTurns ?? 0) !== 0 ||
      (pair.candidate.leafCount ?? 0) !== 0,
  ).length;
  const domainQualityFailures = domainQualityGates(pairs).filter((gate) => !gate.passed);
  const scopedEvaluation = options.requireAllFamilies === false;

  const gates: BenchmarkGate[] = [
    applicableGate(
      "economic decomposable wall time",
      speedRatio,
      0.7,
      "max",
      economicPairs.length > 0,
      scopedEvaluation,
    ),
    applicableGate(
      "economic decomposable cost",
      costRatio,
      0.4,
      "max",
      economicPairs.length > 0,
      scopedEvaluation,
    ),
    {
      name: "overall quality",
      passed:
        quality.ratio !== null &&
        quality.gap !== null &&
        (quality.ratio >= 0.95 || quality.gap <= 3),
      actual:
        quality.ratio === null || quality.gap === null
          ? null
          : `ratio=${quality.ratio.toFixed(4)}, gap=${quality.gap.toFixed(2)}`,
      limit: "ratio >= 0.95 or gap <= 3",
    },
    {
      name: "per-domain quality",
      passed: domainQualityFailures.length === 0 && pairs.length > 0,
      actual:
        domainQualityFailures.length === 0
          ? "all domains pass"
          : domainQualityFailures.map((item) => item.name).join(", "),
      limit: "every domain passes",
    },
    gate("absolute quality floor", absoluteQualityFloor, 60, "min"),
    applicableGate(
      "direct overhead p95",
      directOverheadP95,
      0.15,
      "max",
      directFastPathPairs.length > 0,
      scopedEvaluation,
    ),
    applicableGate(
      "launch skew p95 ms",
      launchSkewP95Ms,
      5_000,
      "maxExclusive",
      actualFanoutPairs.length > 0,
      scopedEvaluation,
    ),
    exactGate("direct routing violations", directRoutingViolations, 0),
    exactGate("protocol errors", protocolErrors, 0),
    exactGate("user interventions", interventions, 0),
    exactGate("critical failures", criticalFailures.length, 0),
  ];
  if (!costComplete && economicPairs.length > 0) {
    errors.push(
      "one or more paired economic-decomposable runs lack authoritative or configured USD cost",
    );
  }
  return {
    passed: errors.length === 0 && gates.every((item) => item.passed),
    pairCount: pairs.length,
    familyCounts,
    evaluationClassCounts,
    speedRatio,
    costRatio,
    qualityRatio: quality.ratio,
    qualityGap: quality.gap,
    directOverheadP95,
    launchSkewP95Ms,
    gates,
    errors,
  };
}

function applySealedEvaluationClass(
  record: BenchmarkRunRecord,
  instance: Readonly<BenchmarkCorpusInstance>,
): void {
  if (instance.evaluationClass === undefined) {
    return;
  }
  if (
    record.observation.evaluationClass !== undefined &&
    record.observation.evaluationClass !== instance.evaluationClass
  ) {
    throw new Error(
      `benchmark executor changed sealed evaluationClass for ${instance.familyId}/${instance.instanceId}/${record.observation.arm}`,
    );
  }
  record.observation.evaluationClass = instance.evaluationClass;
}

function resolvePairEvaluationClass(
  direct: Readonly<BenchmarkObservation>,
  candidate: Readonly<BenchmarkObservation>,
  family: Readonly<BenchmarkFamily>,
  options: Readonly<BenchmarkEvaluationOptions>,
  errors: string[],
): BenchmarkEvaluationClass {
  const identity = `${candidate.familyId}/${candidate.instanceId}/${candidate.seed}`;
  if (
    direct.evaluationClass !== undefined &&
    candidate.evaluationClass !== undefined &&
    direct.evaluationClass !== candidate.evaluationClass
  ) {
    errors.push(`paired observations disagree on sealed evaluationClass: ${identity}`);
  }
  if (
    options.requireSealedEvaluationClass === true &&
    (direct.evaluationClass === undefined || candidate.evaluationClass === undefined)
  ) {
    errors.push(`missing sealed evaluationClass: ${identity}`);
  }
  return (
    direct.evaluationClass ??
    candidate.evaluationClass ??
    (family.decomposable ? "economic-decomposable" : "direct-fast-path")
  );
}

function benchmarkTelemetryErrors(pairs: readonly Pair[]): string[] {
  const errors: string[] = [];
  for (const pair of pairs) {
    for (const observation of [pair.direct, pair.candidate]) {
      const identity = `${observation.familyId}/${observation.instanceId}/${observation.seed}/${observation.arm}`;
      for (const field of ["protocolErrors", "userInterventions", "criticalFailures"] as const) {
        if (observation[field] === undefined) {
          errors.push(`missing ${field} telemetry: ${identity}`);
        }
      }
    }
    const candidateIdentity = `${pair.candidate.familyId}/${pair.candidate.instanceId}/${pair.candidate.seed}/v3`;
    if (pair.evaluationClass === "economic-decomposable") {
      for (const field of ["plannerTurns", "leafCount"] as const) {
        if (pair.candidate[field] === undefined) {
          errors.push(`missing ${field} telemetry: ${candidateIdentity}`);
        }
      }
      if (
        pair.candidate.route === "fanout" &&
        (pair.candidate.launchSkewMs === undefined || pair.candidate.launchSkewMs === null)
      ) {
        errors.push(`missing launchSkewMs telemetry: ${candidateIdentity}`);
      }
    }
  }
  return errors;
}

function validateObservation(value: BenchmarkObservation): void {
  if (!isRecord(value)) {
    throw new Error("benchmark observation must be an object");
  }
  requireNonEmpty(value.familyId, "familyId");
  requireNonEmpty(value.instanceId, "instanceId");
  requireNonEmpty(value.seed, "seed");
  if (value.arm !== "direct_sol" && value.arm !== "v3") {
    throw new Error("arm must be direct_sol or v3");
  }
  if (value.route !== "direct" && value.route !== "delegated" && value.route !== "fanout") {
    throw new Error("route must be direct, delegated, or fanout");
  }
  if (
    value.evaluationClass !== undefined &&
    value.evaluationClass !== "direct-fast-path" &&
    value.evaluationClass !== "economic-decomposable"
  ) {
    throw new Error(
      "evaluationClass must be direct-fast-path or economic-decomposable when provided",
    );
  }
  for (const [name, number] of [
    ["qualityScore", value.qualityScore],
    ["elapsedMs", value.elapsedMs],
  ] as const) {
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`${name} must be a finite non-negative number`);
    }
  }
  if (value.qualityScore > 100) {
    throw new Error("qualityScore cannot exceed 100");
  }
  if (value.costUsd !== null && (!Number.isFinite(value.costUsd) || value.costUsd < 0)) {
    throw new Error("costUsd must be null or a finite non-negative number");
  }
  if (value.hostPlanned !== undefined && typeof value.hostPlanned !== "boolean") {
    throw new Error("hostPlanned must be boolean when provided");
  }
  for (const [name, number] of [
    ["launchSkewMs", value.launchSkewMs],
    ["plannerTurns", value.plannerTurns],
    ["replanCount", value.replanCount],
    ["promotionCount", value.promotionCount],
    ["finalReviewTurns", value.finalReviewTurns],
    ["leafCount", value.leafCount],
    ["protocolErrors", value.protocolErrors],
    ["userInterventions", value.userInterventions],
  ] as const) {
    if (number !== undefined && number !== null && (!Number.isInteger(number) || number < 0)) {
      throw new Error(`${name} must be a non-negative integer when provided`);
    }
  }
  if (
    value.criticalFailures !== undefined &&
    (!Array.isArray(value.criticalFailures) ||
      value.criticalFailures.some((failure) => typeof failure !== "string"))
  ) {
    throw new Error("criticalFailures must be an array of strings when provided");
  }
}

function validateManifestDraft(value: unknown): asserts value is BenchmarkManifestDraft {
  if (!isRecord(value)) {
    throw new Error("benchmark manifest must be an object");
  }
  if (value["schemaVersion"] !== BENCHMARK_MANIFEST_VERSION) {
    throw new Error(
      `benchmark manifest schemaVersion must be ${String(BENCHMARK_MANIFEST_VERSION)}`,
    );
  }
  requireNonEmpty(value["suiteId"], "suiteId");
  requireTimestamp(value["sealedAt"], "sealedAt");
  const baseline = value["baseline"];
  if (!isRecord(baseline)) {
    throw new Error("baseline must be an object");
  }
  if (baseline["model"] !== BENCHMARK_BASELINE_MODEL) {
    throw new Error(`baseline.model must be ${BENCHMARK_BASELINE_MODEL}`);
  }
  requireNonEmpty(baseline["modelRevision"], "baseline.modelRevision");
  if (baseline["effort"] !== BENCHMARK_BASELINE_EFFORT) {
    throw new Error(`baseline.effort must be ${BENCHMARK_BASELINE_EFFORT}`);
  }
  const instances = value["instances"];
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new Error("instances must be a non-empty array");
  }
  const identities = new Set<string>();
  for (const [index, instance] of instances.entries()) {
    validateCorpusInstance(instance, `instances[${String(index)}]`);
    const identity = `${instance.familyId}\u0000${instance.instanceId}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate sealed instance: ${instance.familyId}/${instance.instanceId}`);
    }
    identities.add(identity);
  }
}

function validateCorpusInstance(
  value: unknown,
  label: string,
): asserts value is BenchmarkCorpusInstance {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  requireNonEmpty(value["familyId"], `${label}.familyId`);
  if (!BENCHMARK_FAMILIES.some((family) => family.id === value["familyId"])) {
    throw new Error(`${label}.familyId is unknown: ${String(value["familyId"])}`);
  }
  requireNonEmpty(value["instanceId"], `${label}.instanceId`);
  requireNonEmpty(value["seed"], `${label}.seed`);
  requireNonEmpty(value["sourceRevision"], `${label}.sourceRevision`);
  validateEvaluationClassification(value["evaluationClass"], value["eligibility"], label);
  validateOptionalProvenance(value["provenance"], `${label}.provenance`);
  validateOptionalValidatorQualification(
    value["validatorQualification"],
    `${label}.validatorQualification`,
  );
  requireSha256(value["initialStateSha256"], `${label}.initialStateSha256`);
  const artifacts = value["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`${label}.artifacts must be a non-empty array`);
  }
  const paths = new Set<string>();
  let prompts = 0;
  let workspaceSnapshots = 0;
  let qualityDefinitions = 0;
  for (const [index, artifact] of artifacts.entries()) {
    const artifactLabel = `${label}.artifacts[${String(index)}]`;
    validateArtifactSeal(artifact, artifactLabel);
    if (paths.has(artifact.path)) {
      throw new Error(`${label} contains duplicate artifact path: ${artifact.path}`);
    }
    paths.add(artifact.path);
    if (artifact.role === "prompt") {
      prompts += 1;
    }
    if (artifact.role === "workspace_snapshot") {
      workspaceSnapshots += 1;
      if (artifact.sha256 !== value["initialStateSha256"]) {
        throw new Error(`${label}.initialStateSha256 must seal its workspace_snapshot artifact`);
      }
    }
    if (artifact.role === "validator" || artifact.role === "quality_rubric") {
      qualityDefinitions += 1;
    }
  }
  if (prompts !== 1) {
    throw new Error(`${label} must contain exactly one prompt artifact`);
  }
  if (workspaceSnapshots !== 1) {
    throw new Error(`${label} must contain exactly one workspace_snapshot artifact`);
  }
  if (qualityDefinitions === 0) {
    throw new Error(`${label} must contain a validator or quality_rubric artifact`);
  }
}

function validateEvaluationClassification(
  evaluationClass: unknown,
  eligibility: unknown,
  label: string,
): void {
  if (
    evaluationClass !== undefined &&
    evaluationClass !== "direct-fast-path" &&
    evaluationClass !== "economic-decomposable"
  ) {
    throw new Error(
      `${label}.evaluationClass must be direct-fast-path or economic-decomposable when provided`,
    );
  }
  if (eligibility === undefined) {
    return;
  }
  if (evaluationClass !== "economic-decomposable") {
    throw new Error(`${label}.eligibility is only valid for an economic-decomposable instance`);
  }
  if (!isRecord(eligibility)) {
    throw new Error(`${label}.eligibility must be an object when provided`);
  }
  const independentUnits = eligibility["independentUnits"];
  if (
    typeof independentUnits !== "number" ||
    !Number.isInteger(independentUnits) ||
    independentUnits < 2
  ) {
    throw new Error(`${label}.eligibility.independentUnits must be an integer of at least 2`);
  }
  const estimatedMinLeafSeconds = eligibility["estimatedMinLeafSeconds"];
  if (
    typeof estimatedMinLeafSeconds !== "number" ||
    !Number.isFinite(estimatedMinLeafSeconds) ||
    estimatedMinLeafSeconds <= 30
  ) {
    throw new Error(`${label}.eligibility.estimatedMinLeafSeconds must be greater than 30`);
  }
  requireNonEmpty(eligibility["calibrationRevision"], `${label}.eligibility.calibrationRevision`);
}

function validateOptionalProvenance(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object when provided`);
  }
  if (value["origin"] !== "public-benchmark" && value["origin"] !== "authored-held-out") {
    throw new Error(`${label}.origin is invalid`);
  }
  requireNonEmpty(value["source"], `${label}.source`);
  requireNonEmpty(value["license"], `${label}.license`);
  requireTimestamp(value["collectedAt"], `${label}.collectedAt`);
}

function validateOptionalValidatorQualification(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object when provided`);
  }
  requireSha256(value["goldSha256"], `${label}.goldSha256`);
  const mutants = value["mutantSha256"];
  if (!Array.isArray(mutants) || mutants.length < 2) {
    throw new Error(`${label}.mutantSha256 must contain at least two digests`);
  }
  for (const [index, digest] of mutants.entries()) {
    requireSha256(digest, `${label}.mutantSha256[${String(index)}]`);
  }
  if (new Set(mutants).size !== mutants.length || mutants.includes(value["goldSha256"] as string)) {
    throw new Error(`${label} gold and mutant digests must be distinct`);
  }
}

function validateArtifactSeal(
  value: unknown,
  label: string,
): asserts value is BenchmarkArtifactSeal {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  validateRelativeArtifactPath(value["path"], `${label}.path`);
  if (
    value["role"] !== "prompt" &&
    value["role"] !== "input" &&
    value["role"] !== "workspace_snapshot" &&
    value["role"] !== "validator" &&
    value["role"] !== "quality_rubric" &&
    value["role"] !== "external_snapshot"
  ) {
    throw new Error(`${label}.role is invalid`);
  }
  requireSha256(value["sha256"], `${label}.sha256`);
  requireNonNegativeInteger(value["sizeBytes"], `${label}.sizeBytes`);
}

function validateRunRecord(
  value: unknown,
  manifest: Readonly<BenchmarkCorpusManifest>,
  instance: Readonly<BenchmarkCorpusInstance>,
  arm: BenchmarkArm,
  instanceSha256: string,
  declaredEnvironment: Readonly<BenchmarkEnvironmentEvidence>,
): asserts value is BenchmarkRunRecord {
  if (!isRecord(value)) {
    throw new Error(`benchmark executor for ${arm} returned a non-object record`);
  }
  const observation = value["observation"] as BenchmarkObservation;
  validateObservation(observation);
  const identity = `${instance.familyId}/${instance.instanceId}/${instance.seed}/${arm}`;
  if (
    observation.familyId !== instance.familyId ||
    observation.instanceId !== instance.instanceId ||
    observation.seed !== instance.seed ||
    observation.arm !== arm
  ) {
    throw new Error(`benchmark executor returned mismatched observation identity for ${identity}`);
  }
  for (const field of [
    "launchSkewMs",
    "plannerTurns",
    "replanCount",
    "promotionCount",
    "finalReviewTurns",
    "leafCount",
    "protocolErrors",
    "userInterventions",
    "criticalFailures",
  ] as const) {
    if (!Object.hasOwn(observation, field)) {
      throw new Error(`benchmark run observation is missing ${field} for ${identity}`);
    }
  }
  for (const field of [
    "plannerTurns",
    "replanCount",
    "promotionCount",
    "finalReviewTurns",
    "leafCount",
    "protocolErrors",
    "userInterventions",
  ] as const) {
    requireNonNegativeInteger(observation[field], `${identity}.${field}`);
  }
  if (observation.launchSkewMs === undefined) {
    throw new Error(`benchmark run observation is missing launch skew for ${identity}`);
  }
  if (observation.route === "fanout" && observation.launchSkewMs === null) {
    throw new Error(`fanout observation has null launch skew for ${identity}`);
  }
  if (!Array.isArray(observation.criticalFailures)) {
    throw new Error(`benchmark run observation is missing criticalFailures for ${identity}`);
  }
  if (value["manifestSha256"] !== manifest.manifestSha256) {
    throw new Error(`benchmark executor returned the wrong manifest seal for ${identity}`);
  }
  if (value["instanceSha256"] !== instanceSha256) {
    throw new Error(`benchmark executor returned the wrong instance seal for ${identity}`);
  }
  const startedAt = requireTimestamp(value["startedAt"], "startedAt");
  const completedAt = requireTimestamp(value["completedAt"], "completedAt");
  if (completedAt < startedAt) {
    throw new Error(`completedAt precedes startedAt for ${identity}`);
  }
  const timestampElapsed = completedAt - startedAt;
  const elapsedTolerance = Math.max(1_000, observation.elapsedMs * 0.01);
  if (Math.abs(timestampElapsed - observation.elapsedMs) > elapsedTolerance) {
    throw new Error(`elapsedMs does not match run timestamps for ${identity}`);
  }

  validateEnvironmentEvidence(value["environment"], identity);
  const environmentMismatches = compareEnvironments(value["environment"], declaredEnvironment);
  if (environmentMismatches.length > 0) {
    throw new Error(
      `${environmentMismatches.join(", ")} differ from the declared environment for ${identity}`,
    );
  }
  validateUsageEvidence(value["usageByStage"], observation, manifest, arm, identity);
  const inputArtifactSha256 = value["inputArtifactSha256"];
  if (
    !Array.isArray(inputArtifactSha256) ||
    inputArtifactSha256.some((digest) => typeof digest !== "string") ||
    canonicalJson(inputArtifactSha256) !==
      canonicalJson(instance.artifacts.map((artifact) => artifact.sha256))
  ) {
    throw new Error(`executor did not attest every verified input artifact for ${identity}`);
  }
  requireSha256(value["qualityDefinitionSha256"], `${identity}.qualityDefinitionSha256`);
  if (
    !instance.artifacts.some(
      (artifact) =>
        (artifact.role === "validator" || artifact.role === "quality_rubric") &&
        artifact.sha256 === value["qualityDefinitionSha256"],
    )
  ) {
    throw new Error(`qualityDefinitionSha256 is not sealed by the instance for ${identity}`);
  }
  const evidenceArtifacts = value["evidenceArtifacts"];
  if (!Array.isArray(evidenceArtifacts) || evidenceArtifacts.length === 0) {
    throw new Error(`evidenceArtifacts must be a non-empty array for ${identity}`);
  }
  const evidenceKinds = new Set<string>();
  for (const [index, evidence] of evidenceArtifacts.entries()) {
    validateRunArtifactEvidence(evidence, `${identity}.evidenceArtifacts[${String(index)}]`);
    evidenceKinds.add(evidence.kind);
  }
  if (
    (!evidenceKinds.has("deliverable") && !evidenceKinds.has("raw_output")) ||
    !evidenceKinds.has("validator_output") ||
    !evidenceKinds.has("scorecard")
  ) {
    throw new Error(
      `evidenceArtifacts must include output, validator_output, and scorecard for ${identity}`,
    );
  }
}

function validateEnvironmentEvidence(
  value: unknown,
  identity: string,
): asserts value is BenchmarkEnvironmentEvidence {
  if (!isRecord(value)) {
    throw new Error(`environment evidence must be an object for ${identity}`);
  }
  requireNonEmpty(value["provider"], `${identity}.environment.provider`);
  requireSha256(
    value["providerConfigurationSha256"],
    `${identity}.environment.providerConfigurationSha256`,
  );
  requireNonEmpty(value["serviceTier"], `${identity}.environment.serviceTier`);
  const permissions = value["permissions"];
  if (!isRecord(permissions)) {
    throw new Error(`permissions evidence must be an object for ${identity}`);
  }
  for (const field of ["sandboxMode", "approvalPolicy", "networkAccess"] as const) {
    requireNonEmpty(permissions[field], `${identity}.environment.permissions.${field}`);
  }
  const tools = value["tools"];
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`tools evidence must be a non-empty array for ${identity}`);
  }
  const toolIds = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const label = `${identity}.environment.tools[${String(index)}]`;
    if (!isRecord(tool)) {
      throw new Error(`${label} must be an object`);
    }
    requireNonEmpty(tool["id"], `${label}.id`);
    if (toolIds.has(tool["id"] as string)) {
      throw new Error(`duplicate tool evidence ${String(tool["id"])} for ${identity}`);
    }
    toolIds.add(tool["id"] as string);
    requireNonEmpty(tool["version"], `${label}.version`);
    requireSha256(tool["configurationSha256"], `${label}.configurationSha256`);
  }
}

function validateUsageEvidence(
  value: unknown,
  observation: BenchmarkObservation,
  manifest: Readonly<BenchmarkCorpusManifest>,
  arm: BenchmarkArm,
  identity: string,
): void {
  if (!isRecord(value)) {
    throw new Error(`usageByStage must be an object for ${identity}`);
  }
  const unknownStages = Object.keys(value).filter(
    (stage) => !(BENCHMARK_USAGE_STAGES as readonly string[]).includes(stage),
  );
  if (unknownStages.length > 0) {
    throw new Error(
      `usageByStage contains unknown stages for ${identity}: ${unknownStages.join(", ")}`,
    );
  }
  const allUsage: BenchmarkModelUsageEvidence[] = [];
  const usageCounts = new Map<BenchmarkUsageStage, number>();
  for (const stage of BENCHMARK_USAGE_STAGES) {
    const stageUsage = value[stage];
    if (!Array.isArray(stageUsage)) {
      throw new Error(`usageByStage.${stage} must be an array for ${identity}`);
    }
    usageCounts.set(stage, stageUsage.length);
    for (const [index, usage] of stageUsage.entries()) {
      validateModelUsageEvidence(usage, `${identity}.usageByStage.${stage}[${String(index)}]`);
      allUsage.push(usage);
    }
  }
  if (allUsage.length === 0) {
    throw new Error(`usage evidence is empty for ${identity}`);
  }
  if (
    !allUsage.some(
      (usage) =>
        usage.totalTokens > 0 || (usage.estimatedCostUsd !== null && usage.estimatedCostUsd > 0),
    )
  ) {
    throw new Error(`usage evidence contains no billed or token-bearing work for ${identity}`);
  }

  const priceTableSeals = new Set(
    allUsage.flatMap((usage) =>
      usage.costSource === "price_table" && usage.pricingSha256 !== undefined
        ? [usage.pricingSha256]
        : [],
    ),
  );
  if (priceTableSeals.size > 1) {
    throw new Error(`usage evidence mixes price tables for ${identity}`);
  }

  const reportedCosts = allUsage.map((usage) => usage.estimatedCostUsd);
  const completeCost = reportedCosts.every((cost): cost is number => cost !== null);
  if (observation.costUsd !== null) {
    if (observation.costUsd === 0) {
      throw new Error(`costUsd cannot be a zero placeholder for ${identity}`);
    }
    if (!completeCost) {
      throw new Error(
        `costUsd is reported without complete per-stage cost evidence for ${identity}`,
      );
    }
    const stageCost = reportedCosts.reduce((sum, cost) => sum + cost, 0);
    const tolerance = Math.max(1e-9, observation.costUsd * 1e-6);
    if (Math.abs(stageCost - observation.costUsd) > tolerance) {
      throw new Error(
        `costUsd does not match per-stage usage for ${identity}: expected ${String(stageCost)}`,
      );
    }
  } else if (completeCost) {
    throw new Error(`costUsd is null despite complete per-stage cost evidence for ${identity}`);
  }

  if (arm === "direct_sol") {
    if (observation.route !== "direct") {
      throw new Error(`direct_sol must use the direct route for ${identity}`);
    }
    for (const stage of BENCHMARK_USAGE_STAGES) {
      if (stage !== "direct" && (usageCounts.get(stage) ?? 0) > 0) {
        throw new Error(`direct_sol has unexpected ${stage} usage for ${identity}`);
      }
    }
    const directUsage = value["direct"] as BenchmarkModelUsageEvidence[];
    if (
      directUsage.some(
        (usage) =>
          usage.model !== manifest.baseline.model ||
          usage.modelRevision !== manifest.baseline.modelRevision ||
          usage.effort !== manifest.baseline.effort ||
          usage.tier !== "sol",
      )
    ) {
      throw new Error(
        `direct_sol usage does not match ${manifest.baseline.model}/${manifest.baseline.effort} for ${identity}`,
      );
    }
    if ((observation.plannerTurns ?? 0) !== 0 || (observation.leafCount ?? 0) !== 0) {
      throw new Error(`direct_sol observation contains planner or leaf work for ${identity}`);
    }
    return;
  }

  assertStageTiers(value, "admission", ["terra", "sol"], identity);
  assertStageTiers(value, "direct", ["luna", "terra", "sol"], identity);
  assertStageTier(value, "planning", "sol", identity);
  assertStageTier(value, "replan", "sol", identity);
  assertStageTiers(value, "integration", ["luna", "terra"], identity);
  assertStageTier(value, "finalReview", "sol", identity);
  const replanCount = observation.replanCount ?? 0;
  if (replanCount > 1) {
    throw new Error(`V3 reports more than one replan for ${identity}`);
  }
  if ((usageCounts.get("replan") ?? 0) > 0 !== replanCount > 0) {
    throw new Error(`V3 replan count does not match replan usage for ${identity}`);
  }
  if ((usageCounts.get("finalReview") ?? 0) > 0 !== (observation.finalReviewTurns ?? 0) > 0) {
    throw new Error(`V3 final review count does not match finalReview usage for ${identity}`);
  }

  if (observation.route === "direct") {
    for (const stage of ["planning", "replan", "leaves", "integration", "finalReview"] as const) {
      if ((usageCounts.get(stage) ?? 0) > 0) {
        throw new Error(`V3 direct route has unexpected ${stage} usage for ${identity}`);
      }
    }
    if ((observation.plannerTurns ?? 0) !== 0 || (observation.leafCount ?? 0) !== 0) {
      throw new Error(`V3 direct route contains planner or leaf work for ${identity}`);
    }
    const directUsage = value["direct"] as BenchmarkModelUsageEvidence[];
    if (directUsage.length === 0) {
      throw new Error(`V3 direct route must preserve direct usage for ${identity}`);
    }
    if (
      directUsage.some(
        (usage) =>
          usage.tier === "sol" &&
          (usage.model !== manifest.baseline.model ||
            usage.modelRevision !== manifest.baseline.modelRevision),
      )
    ) {
      throw new Error(`V3 root-Sol direct model does not match the baseline for ${identity}`);
    }
  } else if (observation.route === "delegated") {
    for (const stage of ["replan", "leaves", "finalReview"] as const) {
      if ((usageCounts.get(stage) ?? 0) > 0) {
        throw new Error(`V3 delegated route has unexpected ${stage} usage for ${identity}`);
      }
    }
    const hasPlanningUsage = (usageCounts.get("planning") ?? 0) > 0;
    if ((usageCounts.get("direct") ?? 0) === 0) {
      throw new Error(`V3 delegated route must preserve direct usage for ${identity}`);
    }
    if ((value["direct"] as BenchmarkModelUsageEvidence[]).some((usage) => usage.tier === "sol")) {
      throw new Error(`V3 delegated route cannot use Sol for direct execution in ${identity}`);
    }
    if (
      hasPlanningUsage !== (observation.plannerTurns ?? 0) > 0 ||
      (observation.leafCount ?? 0) !== 0
    ) {
      throw new Error(
        `V3 delegated route must report matching planner provenance and zero leaves for ${identity}`,
      );
    }
  } else {
    const failedFanout = (observation.criticalFailures?.length ?? 0) > 0;
    const hostPlanned = observation.hostPlanned === true;
    const hasPlanningUsage = (usageCounts.get("planning") ?? 0) > 0;
    if (
      (usageCounts.get("direct") ?? 0) > 0 ||
      (!failedFanout &&
        ((!hostPlanned && !hasPlanningUsage) || (usageCounts.get("leaves") ?? 0) === 0))
    ) {
      throw new Error(`V3 fanout must preserve planning and leaf usage for ${identity}`);
    }
    if (
      !failedFanout &&
      ((hostPlanned
        ? hasPlanningUsage !== (observation.plannerTurns ?? 0) > 0
        : (observation.plannerTurns ?? 0) < 1) ||
        (observation.leafCount ?? 0) < 2)
    ) {
      throw new Error(
        `V3 fanout must report matching planner provenance and at least two leaves for ${identity}`,
      );
    }
  }
}

function assertStageTier(
  usageByStage: Readonly<Record<string, unknown>>,
  stage: BenchmarkUsageStage,
  expectedTier: BenchmarkModelUsageEvidence["tier"],
  identity: string,
): void {
  const usage = usageByStage[stage] as BenchmarkModelUsageEvidence[];
  if (usage.some((item) => item.tier !== expectedTier)) {
    throw new Error(`V3 ${stage} usage must use the ${expectedTier} tier for ${identity}`);
  }
}

function assertStageTiers(
  usageByStage: Readonly<Record<string, unknown>>,
  stage: BenchmarkUsageStage,
  expectedTiers: readonly BenchmarkModelUsageEvidence["tier"][],
  identity: string,
): void {
  const usage = usageByStage[stage] as BenchmarkModelUsageEvidence[];
  if (usage.some((item) => !expectedTiers.includes(item.tier))) {
    throw new Error(
      `V3 ${stage} usage must use one of ${expectedTiers.join(", ")} for ${identity}`,
    );
  }
}

function validateModelUsageEvidence(
  value: unknown,
  label: string,
): asserts value is BenchmarkModelUsageEvidence {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  requireNonEmpty(value["model"], `${label}.model`);
  requireNonEmpty(value["modelRevision"], `${label}.modelRevision`);
  if (
    value["tier"] !== "luna" &&
    value["tier"] !== "terra" &&
    value["tier"] !== "sol" &&
    value["tier"] !== "other"
  ) {
    throw new Error(`${label}.tier is invalid`);
  }
  requireNullableNonEmpty(value["effort"], `${label}.effort`);
  for (const field of [
    "cachedInputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "totalTokens",
  ] as const) {
    requireNonNegativeInteger(value[field], `${label}.${field}`);
  }
  if (value["cacheWriteInputTokens"] !== undefined) {
    requireNonNegativeInteger(value["cacheWriteInputTokens"], `${label}.cacheWriteInputTokens`);
  }
  const cacheWriteInputTokens =
    value["cacheWriteInputTokens"] === undefined ? 0 : (value["cacheWriteInputTokens"] as number);
  const tokenTotal =
    (value["cachedInputTokens"] as number) +
    cacheWriteInputTokens +
    (value["uncachedInputTokens"] as number) +
    (value["outputTokens"] as number);
  if (value["totalTokens"] !== tokenTotal) {
    throw new Error(`${label}.totalTokens does not equal its token components`);
  }
  const cost = value["estimatedCostUsd"];
  if (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) {
    throw new Error(`${label}.estimatedCostUsd must be null or a finite non-negative number`);
  }
  if (value["costSource"] !== "app_server" && value["costSource"] !== "price_table") {
    throw new Error(`${label}.costSource is invalid`);
  }
  if (value["costSource"] === "price_table" && cost === null) {
    throw new Error(`${label}.estimatedCostUsd is required for price_table usage`);
  }
  if (value["costSource"] === "price_table") {
    requireSha256(value["pricingSha256"], `${label}.pricingSha256`);
  } else if (value["pricingSha256"] !== undefined) {
    throw new Error(`${label}.pricingSha256 is only valid for price_table usage`);
  }
  if (value["threadId"] !== undefined) {
    requireNonEmpty(value["threadId"], `${label}.threadId`);
  }
  if (value["turnId"] !== undefined) {
    requireNullableNonEmpty(value["turnId"], `${label}.turnId`);
  }
}

function validateRunArtifactEvidence(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    value["kind"] !== "raw_output" &&
    value["kind"] !== "validator_output" &&
    value["kind"] !== "deliverable" &&
    value["kind"] !== "scorecard"
  ) {
    throw new Error(`${label}.kind is invalid`);
  }
  validateRelativeArtifactPath(value["path"], `${label}.path`);
  requireSha256(value["sha256"], `${label}.sha256`);
  requireNonNegativeInteger(value["sizeBytes"], `${label}.sizeBytes`);
}

function assertMatchingEnvironment(
  direct: Readonly<BenchmarkRunRecord>,
  candidate: Readonly<BenchmarkRunRecord>,
  instance: Readonly<BenchmarkCorpusInstance>,
): void {
  const mismatches = compareEnvironments(direct.environment, candidate.environment);
  const directPricing = priceTableSeals(direct);
  const candidatePricing = priceTableSeals(candidate);
  if (
    directPricing.length > 0 &&
    candidatePricing.length > 0 &&
    canonicalJson(directPricing) !== canonicalJson(candidatePricing)
  ) {
    mismatches.push("pricing");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `benchmark arms are not comparable for ${instance.familyId}/${instance.instanceId}/${instance.seed}: ${mismatches.join(", ")} differ`,
    );
  }
}

function compareEnvironments(
  left: Readonly<BenchmarkEnvironmentEvidence>,
  right: Readonly<BenchmarkEnvironmentEvidence>,
): string[] {
  const mismatches: string[] = [];
  if (left.provider !== right.provider) {
    mismatches.push("provider");
  }
  if (left.providerConfigurationSha256 !== right.providerConfigurationSha256) {
    mismatches.push("providerConfiguration");
  }
  if (left.serviceTier !== right.serviceTier) {
    mismatches.push("serviceTier");
  }
  if (canonicalJson(left.permissions) !== canonicalJson(right.permissions)) {
    mismatches.push("permissions");
  }
  const leftTools = [...left.tools].sort(compareToolEvidence);
  const rightTools = [...right.tools].sort(compareToolEvidence);
  if (canonicalJson(leftTools) !== canonicalJson(rightTools)) {
    mismatches.push("tools");
  }
  return mismatches;
}

function priceTableSeals(record: Readonly<BenchmarkRunRecord>): string[] {
  return [
    ...new Set(
      BENCHMARK_USAGE_STAGES.flatMap((stage) =>
        record.usageByStage[stage].flatMap((usage) =>
          usage.costSource === "price_table" && usage.pricingSha256 !== undefined
            ? [usage.pricingSha256]
            : [],
        ),
      ),
    ),
  ].sort();
}

function compareToolEvidence(left: BenchmarkToolEvidence, right: BenchmarkToolEvidence): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function benchmarkArmOrder(
  order: NonNullable<PairedBenchmarkOptions["armOrder"]>,
  pairIndex: number,
): readonly BenchmarkArm[] {
  if (order === "direct-first") {
    return ["direct_sol", "v3"];
  }
  if (order === "v3-first") {
    return ["v3", "direct_sol"];
  }
  return pairIndex % 2 === 0 ? ["direct_sol", "v3"] : ["v3", "direct_sol"];
}

function requireMapValue(
  map: ReadonlyMap<BenchmarkArm, BenchmarkRunRecord>,
  arm: BenchmarkArm,
): BenchmarkRunRecord {
  const value = map.get(arm);
  if (value === undefined) {
    throw new Error(`missing ${arm} benchmark record`);
  }
  return value;
}

function validateRelativeArtifactPath(value: unknown, label: string): asserts value is string {
  requireNonEmpty(value, label);
  const path = value as string;
  if (
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.startsWith("\\\\") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.length === 0 || part === ".." || part === ".")
  ) {
    throw new Error(`${label} must be a normalized portable relative path`);
  }
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireNullableNonEmpty(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    requireNonEmpty(value, label);
  }
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function requireTimestamp(value: unknown, label: string): number {
  requireNonEmpty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`${label} must be an ISO timestamp with a timezone`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("benchmark evidence cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`benchmark evidence contains unsupported value type: ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function macroRatio(
  pairs: readonly Pair[],
  value: (observation: BenchmarkObservation) => number,
): number | null {
  const byFamily = groupPairs(pairs);
  const ratios = [...byFamily.values()].map((group) =>
    ratio(
      group.reduce((total, pair) => total + value(pair.candidate), 0),
      group.reduce((total, pair) => total + value(pair.direct), 0),
    ),
  );
  return mean(ratios);
}

function macroQuality(pairs: readonly Pair[]): { ratio: number | null; gap: number | null } {
  const byDomain = new Map<BenchmarkDomain, Pair[]>();
  for (const pair of pairs) {
    const group = byDomain.get(pair.family.domain) ?? [];
    group.push(pair);
    byDomain.set(pair.family.domain, group);
  }
  const ratios: number[] = [];
  const gaps: number[] = [];
  for (const group of byDomain.values()) {
    const direct = mean(group.map((pair) => pair.direct.qualityScore));
    const candidate = mean(group.map((pair) => pair.candidate.qualityScore));
    if (direct !== null && candidate !== null) {
      ratios.push(ratio(candidate, direct));
      gaps.push(Math.max(0, direct - candidate));
    }
  }
  return { ratio: mean(ratios), gap: mean(gaps) };
}

function domainQualityGates(pairs: readonly Pair[]): BenchmarkGate[] {
  const domains = new Set(pairs.map((pair) => pair.family.domain));
  return [...domains].map((domain) => {
    const quality = macroQuality(pairs.filter((pair) => pair.family.domain === domain));
    return {
      name: domain,
      passed:
        quality.ratio !== null &&
        quality.gap !== null &&
        (quality.ratio >= 0.95 || quality.gap <= 3),
      actual: quality.ratio,
      limit: "ratio >= 0.95 or gap <= 3",
    };
  });
}

function groupPairs(pairs: readonly Pair[]): Map<string, Pair[]> {
  const groups = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const group = groups.get(pair.family.id) ?? [];
    group.push(pair);
    groups.set(pair.family.id, group);
  }
  return groups;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return numerator === 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function gate(
  name: string,
  actual: number | null,
  limit: number,
  comparison: "min" | "max" | "maxExclusive",
): BenchmarkGate {
  return {
    name,
    passed:
      actual !== null &&
      Number.isFinite(actual) &&
      (comparison === "min"
        ? actual >= limit
        : comparison === "max"
          ? actual <= limit
          : actual < limit),
    actual,
    limit,
  };
}

function applicableGate(
  name: string,
  actual: number | null,
  limit: number,
  comparison: "min" | "max" | "maxExclusive",
  applicable: boolean,
  scopedEvaluation: boolean,
): BenchmarkGate {
  return !applicable && scopedEvaluation
    ? { name, passed: true, actual: "not applicable", limit }
    : gate(name, actual, limit, comparison);
}

function exactGate(name: string, actual: number, limit: number): BenchmarkGate {
  return { name, passed: actual === limit, actual, limit };
}
