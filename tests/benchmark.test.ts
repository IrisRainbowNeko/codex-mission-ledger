import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertReleaseBenchmarkCorpus,
  allocatePairStorage,
  assertNoSubAgentActivity,
  benchmarkCheapRootTier,
  benchmarkDirectRootThreadConfig,
  benchmarkRootThreadConfig,
  diagnosticHostPlan,
  disposePairStorage,
  isBenchmarkTurnTimeout,
  loadPartialBenchmarkRecords,
  localRouteRequiresTool,
  mergeCriticalFailures,
  parseWorkspaceSnapshot,
  parseOptions,
  parseRootSolDirectOutput,
  parseRootSolPlanOutput,
  parseRootSolRouteDecision,
  resetMaterializedWorkspace,
  writeWorkspaceSnapshot,
} from "../scripts/run-real-benchmark.js";
import { AppServerAdapterError } from "../src/app-server/adapters/runtime.js";
import {
  BENCHMARK_FAMILIES,
  BENCHMARK_MANIFEST_VERSION,
  BENCHMARK_USAGE_STAGES,
  assertBenchmarkManifest,
  assertBenchmarkManifestCoverage,
  benchmarkInstanceSha256,
  createFileBenchmarkArtifactReader,
  economicEligibilityFromCalibration,
  evaluateBenchmark,
  hashBenchmarkBytes,
  parseBenchmarkManifest,
  parseBenchmarkCalibrationTable,
  runPairedBenchmark,
  sealBenchmarkManifest,
  type BenchmarkArtifactReader,
  type BenchmarkArtifactRole,
  type BenchmarkCorpusManifest,
  type BenchmarkEnvironmentEvidence,
  type BenchmarkExecutionRequest,
  type BenchmarkExecutor,
  type BenchmarkManifestDraft,
  type BenchmarkModelUsageEvidence,
  type BenchmarkObservation,
  type BenchmarkRunRecord,
  type BenchmarkRunArtifactReader,
  type BenchmarkUsageByStage,
} from "../src/benchmark.js";

function passingObservations(): BenchmarkObservation[] {
  return BENCHMARK_FAMILIES.flatMap((family) => {
    const direct: BenchmarkObservation = {
      familyId: family.id,
      instanceId: "fixture",
      seed: "1",
      arm: "direct_sol",
      qualityScore: 100,
      elapsedMs: 1_000,
      costUsd: 1,
      route: "direct",
      evaluationClass: family.decomposable ? "economic-decomposable" : "direct-fast-path",
      launchSkewMs: null,
      plannerTurns: 0,
      leafCount: 0,
      protocolErrors: 0,
      userInterventions: 0,
      criticalFailures: [],
    };
    const candidate: BenchmarkObservation = {
      ...direct,
      arm: "v3",
      qualityScore: 97,
      elapsedMs: family.decomposable ? 650 : 1_100,
      costUsd: family.decomposable ? 0.35 : 0.5,
      route: family.decomposable ? "fanout" : "direct",
      launchSkewMs: family.decomposable ? 1_000 : null,
      plannerTurns: family.decomposable ? 1 : 0,
      leafCount: family.decomposable ? 2 : 0,
    };
    return [direct, candidate];
  });
}

describe("real benchmark runner", () => {
  it("treats an admitted fanout as a binding root-tool contract", () => {
    expect(localRouteRequiresTool({ route: "fanout" })).toBe(true);
    expect(localRouteRequiresTool({ route: "direct" })).toBe(false);
    expect(localRouteRequiresTool(null)).toBe(false);
  });

  it("uses Luna for mechanical tool dispatch and preserves direct tier routing", () => {
    const officeRequest = {
      objective:
        "Create three editable spreadsheet workbooks with complete analysis and summaries.",
      cwd: "/workspace",
      domain: "office" as const,
    };

    expect(benchmarkCheapRootTier(officeRequest, { dispatchOnly: true })).toBe("luna");
    expect(benchmarkCheapRootTier(officeRequest, { dispatchOnly: false })).toBe("terra");
  });

  it("disables native collaboration in every benchmark root config", () => {
    expect(benchmarkRootThreadConfig("/tmp/bridge.sock", "/tmp/workspace")).toMatchObject({
      agents: { enabled: false },
      features: { multi_agent: false },
    });
    expect(benchmarkDirectRootThreadConfig()).toMatchObject({
      agents: { enabled: false },
      features: { multi_agent: false },
    });
  });

  it("rejects native subagent activity instead of recording a zero-leaf direct arm", () => {
    expect(() =>
      assertNoSubAgentActivity(
        [
          { type: "reasoning" },
          { type: "subAgentActivity", kind: "started", agentPath: "/root/worker" },
        ],
        "V3 root",
      ),
    ).toThrow("V3 root started native subagents");
    expect(() => assertNoSubAgentActivity([{ type: "agentMessage" }], "direct Sol")).not.toThrow();
  });

  it("uses the existing root Sol by default and keeps diagnostic planner modes explicit", () => {
    expect(parseOptions([]).planningMode).toBe("host-sol");
    expect(parseOptions([]).release).toBe(false);
    expect(parseOptions(["--release", "--full"])).toMatchObject({ release: true, full: true });
    expect(parseOptions(["--dynamic-tool", "--force-delegated"])).toMatchObject({
      dynamicTool: true,
      forceDelegated: true,
    });
    expect(() => parseOptions(["--force-delegated"])).toThrow("requires --dynamic-tool");
    expect(() => parseOptions(["--dynamic-tool", "--force-delegated", "--force-fanout"])).toThrow(
      "mutually exclusive",
    );
    expect(parseOptions(["--host-sol-plan"]).planningMode).toBe("host-sol");
    expect(parseOptions(["--internal-sol-plan"]).planningMode).toBe("internal-sol");
    expect(parseOptions(["--host-plan"]).planningMode).toBe("diagnostic-host");
    expect(parseOptions(["--instance", "coding-02"]).instance).toBe("coding-02");
    expect(parseOptions(["--balanced-only"]).balancedOnly).toBe(true);
    expect(parseOptions(["--resume"]).resume).toBe(true);
    expect(() => parseOptions(["--resume", "--v3-only"])).toThrow(
      "only supported for paired benchmark runs",
    );
    expect(() => parseOptions(["--internal-sol-plan", "--host-sol-plan"])).toThrow(
      "planning mode flags are mutually exclusive",
    );
    expect(() => parseOptions(["--balanced-only", "--v3-only"])).toThrow("mutually exclusive");
    expect(() => parseOptions(["--release", "--balanced-only"])).toThrow(
      "release evidence requires all arms",
    );
  });

  it("evaluates balanced and quality observations against the same direct baseline", () => {
    const legacy = passingObservations();
    const direct = legacy.filter((item) => item.arm === "direct_sol");
    const balanced = legacy
      .filter((item) => item.arm === "v3")
      .map((item) => ({ ...item, arm: "balanced" as const, planningCostUsd: 0.2 }));
    const quality = legacy
      .filter((item) => item.arm === "v3")
      .map((item) => ({ ...item, arm: "quality" as const, qualityScore: 100 }));

    expect(
      evaluateBenchmark([...direct, ...balanced, ...quality], {
        minimumInstancesPerFamily: 1,
        candidateArm: "balanced",
      }).passed,
    ).toBe(true);
    expect(
      evaluateBenchmark([...direct, ...balanced, ...quality], {
        minimumInstancesPerFamily: 1,
        candidateArm: "quality",
      }).qualityRatio,
    ).toBe(1);
  });

  it("reports quality economics without blocking and enforces balanced planning cost", () => {
    const legacy = passingObservations();
    const direct = legacy.filter((item) => item.arm === "direct_sol");
    const quality = legacy
      .filter((item) => item.arm === "v3")
      .map((item) => ({
        ...item,
        arm: "quality" as const,
        route: item.evaluationClass === "direct-fast-path" ? ("delegated" as const) : item.route,
        elapsedMs: item.evaluationClass === "economic-decomposable" ? 950 : item.elapsedMs,
        costUsd: item.evaluationClass === "economic-decomposable" ? 0.9 : item.costUsd,
        planningCostUsd: 0.8,
        qualityScore: 100,
      }));
    const qualityReport = evaluateBenchmark([...direct, ...quality], {
      minimumInstancesPerFamily: 1,
      candidateArm: "quality",
    });
    expect(qualityReport.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "economic decomposable wall time", passed: true }),
        expect.objectContaining({ name: "economic decomposable cost", passed: true }),
        expect.objectContaining({ name: "Sol planning cost by family", passed: true }),
        expect.objectContaining({ name: "direct routing violations", passed: true }),
      ]),
    );

    const balanced = legacy
      .filter((item) => item.arm === "v3")
      .map((item) => ({ ...item, arm: "balanced" as const, planningCostUsd: 0.26 }));
    const balancedReport = evaluateBenchmark([...direct, ...balanced], {
      minimumInstancesPerFamily: 1,
      candidateArm: "balanced",
    });
    expect(balancedReport.gates).toContainEqual(
      expect.objectContaining({ name: "Sol planning cost by family", passed: false }),
    );
    expect(balancedReport.passed).toBe(false);
  });

  it("resumes completed arms and discards only an unterminated JSONL tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-trio-benchmark-resume-"));
    const path = join(root, "release.records.jsonl");
    const record = {
      observation: {
        familyId: "coding-cross-module",
        instanceId: "coding-economic-01",
        seed: "seed-01",
        arm: "direct_sol",
      },
    };
    try {
      await writeFile(path, `${JSON.stringify(record)}\n{"observation":`, "utf8");
      const records = await loadPartialBenchmarkRecords(path);
      expect(records.size).toBe(1);
      expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(record)}\n`);

      await writeFile(path, `${JSON.stringify(record)}\nnot-json\n`, "utf8");
      await expect(loadPartialBenchmarkRecords(path)).rejects.toThrow(
        "invalid benchmark resume record at line 2",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes a turn timeout from unrelated App Server failures", () => {
    expect(isBenchmarkTurnTimeout(new AppServerAdapterError("turn_timeout", "late"))).toBe(true);
    expect(isBenchmarkTurnTimeout(new AppServerAdapterError("turn_failed", "failed"))).toBe(false);
    expect(isBenchmarkTurnTimeout(new Error("turn_timeout"))).toBe(false);
  });

  it("deduplicates validator-declared critical failures during observation propagation", () => {
    expect(
      mergeCriticalFailures(
        ["data-destruction: modified sealed source"],
        ["data-destruction: modified sealed source", "citation-integrity: unsupported citation"],
      ),
    ).toEqual([
      "data-destruction: modified sealed source",
      "citation-integrity: unsupported citation",
    ]);
  });

  it("rejects diagnostic corpora before a paid release run", async () => {
    const fixture = benchmarkFixture();
    const draft = structuredClone(fixture.manifest) as BenchmarkManifestDraft & {
      manifestSha256?: string;
    };
    delete draft.manifestSha256;
    delete draft.instances[0]!.eligibility;
    const uncalibrated = sealBenchmarkManifest(draft);
    await expect(
      assertReleaseBenchmarkCorpus(
        uncalibrated,
        fixture.reader,
        parseOptions(["--release", "--full", "--corpus", "/tmp/release-corpus"]),
      ),
    ).rejects.toThrow("missing independent development calibration");
  });

  it("requires the root Sol to declare the read-only deterministic host-plan boundary", () => {
    const plan = diagnosticHostPlan("readOnly");
    expect(plan).toMatchObject({ access: "readOnly", merge: "deterministic", risk: "low" });
    expect(parseRootSolPlanOutput(JSON.stringify({ mode: "plan", answer: null, ...plan }))).toEqual(
      plan,
    );
    expect(() =>
      parseRootSolPlanOutput(JSON.stringify({ mode: "plan", answer: null, tasks: plan.tasks })),
    ).toThrow("access must be readOnly, workspaceWrite, or null");
    expect(diagnosticHostPlan("workspaceWrite")).toMatchObject({
      access: "workspaceWrite",
      merge: "deterministic",
      risk: "low",
    });
    expect(
      parseRootSolDirectOutput(
        JSON.stringify({
          mode: "direct",
          answer: "done",
          access: null,
          merge: null,
          risk: null,
          tasks: [],
        }),
      ),
    ).toBe("done");
    expect(
      parseRootSolRouteDecision(
        JSON.stringify({
          mode: "direct",
          answer: "delegate:luna",
          access: null,
          merge: null,
          risk: null,
          tasks: [],
        }),
      ),
    ).toEqual({ mode: "delegate", tier: "luna" });
    expect(
      parseRootSolRouteDecision(
        JSON.stringify({
          mode: "direct",
          answer: "delegate:terra",
          access: "workspaceWrite",
          merge: "terra",
          risk: "medium",
          tasks: [],
        }),
      ),
    ).toEqual({ mode: "delegate", tier: "terra" });
    expect(
      parseRootSolRouteDecision(
        JSON.stringify({
          mode: "direct",
          answer: "complete final answer",
          access: null,
          merge: null,
          risk: null,
          tasks: [],
        }),
      ),
    ).toEqual({ mode: "self", answer: "complete final answer" });
    expect(
      parseRootSolRouteDecision(JSON.stringify({ mode: "plan", answer: null, ...plan })),
    ).toEqual({ mode: "plan", plan });
    expect(
      parseRootSolRouteDecision(
        JSON.stringify({
          mode: "plan",
          answer: null,
          ...plan,
          merge: "terra",
          risk: "high",
        }),
      ),
    ).toMatchObject({ mode: "plan", plan: { merge: "terra", risk: "high" } });
    expect(() =>
      parseRootSolRouteDecision(
        JSON.stringify({
          mode: "direct",
          answer: null,
          access: null,
          merge: null,
          risk: null,
          tasks: [],
        }),
      ),
    ).toThrow("direct answer or delegation");
  });

  it("keeps the JobStore outside the paired workspace and removes both roots", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agent-trio-storage-test-"));
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    let storage: Awaited<ReturnType<typeof allocatePairStorage>> | undefined;
    try {
      storage = await allocatePairStorage(workspace);
      expect(relative(workspace, storage.jobRoot).startsWith("..")).toBe(true);
      expect(relative(storage.runtimeRoot, storage.jobRoot)).toBe("jobs");
      await mkdir(storage.jobRoot, { recursive: true });
      await writeFile(join(storage.jobRoot, "job.json"), "{}", "utf8");

      await disposePairStorage(storage);

      await expect(access(workspace)).rejects.toThrow();
      await expect(access(storage.runtimeRoot)).rejects.toThrow();
      storage = undefined;
    } finally {
      if (storage !== undefined) {
        await disposePairStorage(storage);
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("materializes UTF-8 and binary files and restores the sealed snapshot", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agent-trio-workspace-test-"));
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    const config = parseWorkspaceSnapshot(
      new TextEncoder().encode(
        JSON.stringify({
          access: "workspaceWrite",
          citationPolicy: "frozen-required",
          decomposition: "independent",
          files: [
            { path: "notes/report.txt", contentUtf8: "sealed text\n" },
            { path: "assets/input.bin", contentBase64: "AAEC/w==" },
          ],
        }),
      ),
    );
    try {
      await writeWorkspaceSnapshot(workspace, config);
      expect(await readFile(join(workspace, "notes/report.txt"), "utf8")).toBe("sealed text\n");
      expect([...(await readFile(join(workspace, "assets/input.bin")))]).toEqual([0, 1, 2, 255]);
      await writeFile(join(workspace, "unsealed.txt"), "first arm", "utf8");
      const beforeReset = await stat(workspace);

      await resetMaterializedWorkspace(workspace, config);

      expect((await stat(workspace)).ino).toBe(beforeReset.ino);
      await expect(access(join(workspace, "unsealed.txt"))).rejects.toThrow();
      expect(await readFile(join(workspace, "notes/report.txt"), "utf8")).toBe("sealed text\n");
      expect([...(await readFile(join(workspace, "assets/input.bin")))]).toEqual([0, 1, 2, 255]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects dot-segment workspace paths before materialization", () => {
    for (const path of ["../outside.txt", "nested/../outside.txt", "./inside.txt", ".."] as const) {
      expect(() =>
        parseWorkspaceSnapshot(
          new TextEncoder().encode(JSON.stringify({ files: [{ path, contentUtf8: "unsafe" }] })),
        ),
      ).toThrow("unsafe path");
    }
  });
});

describe("evaluateBenchmark", () => {
  it("passes a complete paired suite that meets every release gate", () => {
    const report = evaluateBenchmark(passingObservations(), {
      minimumInstancesPerFamily: 1,
    });
    expect(report.passed).toBe(true);
    expect(report.pairCount).toBe(18);
    expect(report.speedRatio).toBeCloseTo(0.65);
    expect(report.costRatio).toBeCloseTo(0.35);
    expect(report.directOverheadP95).toBeCloseTo(0.1);
    expect(report.evaluationClassCounts).toEqual({
      "direct-fast-path": 2,
      "economic-decomposable": 16,
    });
  });

  it("includes every instance in each family cost and time ratio", () => {
    const first = passingObservations()
      .filter((item) => item.familyId === "algorithm-exact")
      .map((item) => ({ ...item, instanceId: "first" }));
    first.find((item) => item.arm === "direct_sol")!.costUsd = 1;
    first.find((item) => item.arm === "direct_sol")!.elapsedMs = 1_000;
    first.find((item) => item.arm === "v3")!.costUsd = 0.2;
    first.find((item) => item.arm === "v3")!.elapsedMs = 200;
    const second = structuredClone(first).map((item) => ({ ...item, instanceId: "second" }));
    second.find((item) => item.arm === "v3")!.costUsd = 0.8;
    second.find((item) => item.arm === "v3")!.elapsedMs = 800;

    const report = evaluateBenchmark([...first, ...second], {
      minimumInstancesPerFamily: 1,
      requireAllFamilies: false,
    });

    expect(report.costRatio).toBeCloseTo(0.5);
    expect(report.speedRatio).toBeCloseTo(0.5);
  });

  it("treats class-specific gates without scoped samples as not applicable", () => {
    const economicOnly = evaluateBenchmark(
      passingObservations().filter((item) => item.familyId === "algorithm-exact"),
      { minimumInstancesPerFamily: 1, requireAllFamilies: false },
    );
    expect(economicOnly.passed).toBe(true);
    expect(economicOnly.gates).toContainEqual({
      name: "direct overhead p95",
      passed: true,
      actual: "not applicable",
      limit: 0.15,
    });

    const directOnly = evaluateBenchmark(
      passingObservations().filter((item) => item.familyId === "coding-local-bugfix"),
      { minimumInstancesPerFamily: 1, requireAllFamilies: false },
    );
    expect(directOnly.passed).toBe(true);
    expect(directOnly.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "economic decomposable wall time",
          passed: true,
          actual: "not applicable",
        }),
        expect.objectContaining({
          name: "launch skew p95 ms",
          passed: true,
          actual: "not applicable",
        }),
      ]),
    );
  });

  it("fails closed on missing price, direct fanout, intervention, or critical regression", () => {
    const observations = passingObservations();
    const candidate = observations.find(
      (item) => item.arm === "v3" && item.familyId === "coding-cross-module",
    )!;
    candidate.costUsd = null;
    candidate.userInterventions = 1;
    candidate.criticalFailures = ["data loss"];
    const directCandidate = observations.find(
      (item) => item.arm === "v3" && item.familyId === "coding-local-bugfix",
    )!;
    directCandidate.route = "fanout";
    directCandidate.plannerTurns = 1;
    directCandidate.leafCount = 2;

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
    });
    expect(report.passed).toBe(false);
    expect(report.costRatio).toBeNull();
    expect(report.errors).toContain(
      "one or more paired economic-decomposable runs lack authoritative or configured USD cost",
    );
    expect(report.gates.filter((gate) => !gate.passed).map((gate) => gate.name)).toEqual(
      expect.arrayContaining([
        "economic decomposable cost",
        "direct routing violations",
        "user interventions",
        "critical failures",
      ]),
    );
  });

  it("rejects equal but unusably low quality", () => {
    const observations = passingObservations();
    for (const observation of observations) {
      observation.qualityScore = 0;
    }

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
    });

    expect(report.passed).toBe(false);
    expect(report.qualityRatio).toBe(1);
    expect(report.qualityGap).toBe(0);
    expect(report.gates).toContainEqual(
      expect.objectContaining({ name: "absolute quality floor", passed: false, actual: 0 }),
    );
  });

  it("applies the absolute quality floor to V3 rather than a failed baseline", () => {
    const observations = passingObservations();
    for (const observation of observations) {
      if (observation.arm === "direct_sol") observation.qualityScore = 0;
    }

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
    });

    expect(report.passed).toBe(true);
    expect(report.gates).toContainEqual(
      expect.objectContaining({ name: "absolute quality floor", passed: true, actual: 97 }),
    );
  });

  it("enforces an explicit minimum for represented families in a partial suite", () => {
    const report = evaluateBenchmark(passingObservations(), {
      minimumInstancesPerFamily: 2,
      requireAllFamilies: false,
    });

    expect(report.passed).toBe(false);
    expect(report.errors).toContain("coding-cross-module has 1 paired instances; requires 2");
  });

  it("does not treat a zero-dollar placeholder as authoritative cost", () => {
    const observations = passingObservations();
    observations.find(
      (item) => item.arm === "v3" && item.familyId === "coding-cross-module",
    )!.costUsd = 0;

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
    });

    expect(report.passed).toBe(false);
    expect(report.costRatio).toBeNull();
    expect(report.errors).toContain(
      "one or more paired economic-decomposable runs lack authoritative or configured USD cost",
    );
  });

  it("fails when any fanout observation omits launch-skew telemetry", () => {
    const observations = passingObservations();
    delete observations.find(
      (item) => item.arm === "v3" && item.familyId === "coding-cross-module",
    )!.launchSkewMs;

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
    });

    expect(report.passed).toBe(false);
    expect(report.errors).toContain(
      "missing launchSkewMs telemetry: coding-cross-module/fixture/1/v3",
    );
  });

  it("keeps every preclassified economic pair in cost and time gates after a direct route", () => {
    const observations = passingObservations().filter(
      (item) => item.familyId === "algorithm-exact",
    );
    const candidate = observations.find((item) => item.arm === "v3")!;
    candidate.route = "direct";
    candidate.elapsedMs = 900;
    candidate.costUsd = 0.9;
    candidate.launchSkewMs = null;
    candidate.plannerTurns = 0;
    candidate.leafCount = 0;

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
      requireAllFamilies: false,
      requireSealedEvaluationClass: true,
    });

    expect(report.speedRatio).toBeCloseTo(0.9);
    expect(report.costRatio).toBeCloseTo(0.9);
    expect(report.evaluationClassCounts).toEqual({
      "direct-fast-path": 0,
      "economic-decomposable": 1,
    });
    expect(report.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "economic decomposable wall time", passed: false }),
        expect.objectContaining({ name: "economic decomposable cost", passed: false }),
      ]),
    );
  });

  it("uses only direct-fast-path pairs for direct overhead regardless of family or route", () => {
    const observations = passingObservations().filter(
      (item) => item.familyId === "algorithm-exact" || item.familyId === "coding-local-bugfix",
    );
    for (const observation of observations.filter((item) => item.familyId === "algorithm-exact")) {
      observation.evaluationClass = "direct-fast-path";
    }
    const algorithmCandidate = observations.find(
      (item) => item.familyId === "algorithm-exact" && item.arm === "v3",
    )!;
    algorithmCandidate.route = "direct";
    algorithmCandidate.elapsedMs = 1_400;
    algorithmCandidate.launchSkewMs = null;
    algorithmCandidate.plannerTurns = 0;
    algorithmCandidate.leafCount = 0;

    const report = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
      requireAllFamilies: false,
      requireSealedEvaluationClass: true,
    });

    expect(report.directOverheadP95).toBeCloseTo(0.4);
    expect(report.evaluationClassCounts["direct-fast-path"]).toBe(2);
  });

  it("supports legacy diagnostic migration but rejects it for sealed release evaluation", () => {
    const observations = passingObservations();
    for (const observation of observations) {
      delete observation.evaluationClass;
    }

    expect(evaluateBenchmark(observations, { minimumInstancesPerFamily: 1 }).passed).toBe(true);
    const release = evaluateBenchmark(observations, {
      minimumInstancesPerFamily: 1,
      requireSealedEvaluationClass: true,
    });
    expect(release.passed).toBe(false);
    expect(release.errors).toContain("missing sealed evaluationClass: algorithm-exact/fixture/1");
  });
});

describe("paired benchmark harness", () => {
  it("runs balanced and quality against one cached direct record per instance", async () => {
    const fixture = benchmarkFixture();
    const directCalls: string[] = [];
    const rawDirect = executorFor("direct_sol", fixture.manifest, directCalls);
    const directRecords = new Map<string, BenchmarkRunRecord>();
    const direct: BenchmarkExecutor = async (request) => {
      const key = `${request.instance.familyId}\u0000${request.instance.instanceId}`;
      const cached = directRecords.get(key);
      if (cached !== undefined) return structuredClone(cached);
      const record = await rawDirect(request);
      directRecords.set(key, structuredClone(record));
      return record;
    };
    const common = {
      artifactReader: fixture.reader,
      runArtifactReader: fixture.runArtifactReader,
      environment: fixture.environment,
      evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
    };
    const balanced = await runPairedBenchmark(
      fixture.manifest,
      { direct_sol: direct, balanced: executorFor("balanced", fixture.manifest, []) },
      { ...common, candidateArm: "balanced" },
    );
    const quality = await runPairedBenchmark(
      fixture.manifest,
      { direct_sol: direct, quality: executorFor("quality", fixture.manifest, []) },
      { ...common, candidateArm: "quality" },
    );
    const records = new Map(
      [...balanced.records, ...quality.records].map((record) => [
        `${record.observation.familyId}\u0000${record.observation.instanceId}\u0000${record.observation.arm}`,
        record,
      ]),
    );

    expect(directCalls).toHaveLength(fixture.manifest.instances.length);
    expect(records.size).toBe(fixture.manifest.instances.length * 3);
    for (const arm of ["direct_sol", "balanced", "quality"] as const) {
      expect([...records.values()].filter((record) => record.observation.arm === arm)).toHaveLength(
        fixture.manifest.instances.length,
      );
    }
  });

  it("rejects corpus artifacts that escape through a symbolic link", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agent-trio-benchmark-"));
    const corpus = join(temporary, "corpus");
    const outside = join(temporary, "outside.txt");
    try {
      await mkdir(corpus);
      await writeFile(outside, "outside");
      await symlink(outside, join(corpus, "escape.txt"), "file");
      const reader = createFileBenchmarkArtifactReader(corpus);

      await expect(
        reader(
          {
            path: "escape.txt",
            role: "input",
            sha256: hashBenchmarkBytes("outside"),
            sizeBytes: 7,
          },
          benchmarkFixture().manifest.instances[0]!,
        ),
      ).rejects.toThrow("escapes its root");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("verifies a sealed corpus, balances arm order, and preserves stage evidence", async () => {
    const fixture = benchmarkFixture();
    const calls: string[] = [];
    const persisted: BenchmarkRunRecord[] = [];
    const direct = executorFor("direct_sol", fixture.manifest, calls);
    const candidate = executorFor("v3", fixture.manifest, calls);

    const result = await runPairedBenchmark(
      fixture.manifest,
      { direct_sol: direct, v3: candidate },
      {
        artifactReader: fixture.reader,
        runArtifactReader: fixture.runArtifactReader,
        environment: fixture.environment,
        evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        onRecord: (record) => {
          persisted.push(structuredClone(record));
        },
      },
    );

    expect(result.evaluation.passed).toBe(true);
    expect(result.observations).toHaveLength(4);
    expect(result.records).toHaveLength(4);
    expect(persisted).toEqual(result.records);
    expect(calls).toEqual([
      "coding-cross-module/direct_sol/0",
      "coding-cross-module/v3/1",
      "coding-local-bugfix/v3/0",
      "coding-local-bugfix/direct_sol/1",
    ]);
    const fanout = result.records.find(
      (record) =>
        record.observation.familyId === "coding-cross-module" && record.observation.arm === "v3",
    );
    expect(fanout?.usageByStage.planning).toHaveLength(1);
    expect(fanout?.usageByStage.leaves).toHaveLength(1);
    expect(fanout?.usageByStage.integration).toHaveLength(1);
    expect(fanout?.observation.evaluationClass).toBe("economic-decomposable");
    expect(result.manifestSha256).toBe(fixture.manifest.manifestSha256);
  });

  it("accepts Luna direct execution and deterministic fanout reduction", async () => {
    const fixture = benchmarkFixture();
    const calls: string[] = [];
    const direct = executorFor("direct_sol", fixture.manifest, calls);
    const candidate = executorFor("v3", fixture.manifest, calls, (record) => {
      if (record.observation.route === "direct") {
        const usage = record.usageByStage.direct[0]!;
        usage.model = "gpt-5.6-luna";
        usage.tier = "luna";
      } else {
        const removed = record.usageByStage.integration;
        record.usageByStage.integration = [];
        record.observation.costUsd! -= removed.reduce(
          (sum, usage) => sum + (usage.estimatedCostUsd ?? 0),
          0,
        );
      }
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: direct, v3: candidate },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).resolves.toMatchObject({ evaluation: { passed: true } });
  });

  it("allows V3 to use lower Sol effort while preserving the baseline model revision", async () => {
    const fixture = benchmarkFixture();
    const candidate = executorFor("v3", fixture.manifest, [], (record) => {
      if (record.observation.route !== "direct") {
        return;
      }
      record.usageByStage.admission = [];
      record.usageByStage.direct = [
        usage(
          fixture.manifest.baseline.model,
          "sol",
          "medium",
          0.5,
          fixture.manifest.baseline.modelRevision,
        ),
      ];
      record.observation.costUsd = 0.5;
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: candidate },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).resolves.toMatchObject({ evaluation: { passed: true } });
  });

  it("accounts for a host-Sol decision followed by delegated direct execution", async () => {
    const fixture = benchmarkFixture();
    const candidate = executorFor("v3", fixture.manifest, [], (record) => {
      if (record.observation.route !== "fanout") {
        return;
      }
      record.observation.route = "delegated";
      record.observation.launchSkewMs = null;
      record.observation.plannerTurns = 0;
      record.observation.leafCount = 0;
      record.usageByStage.admission = record.usageByStage.planning;
      record.usageByStage.planning = [];
      record.usageByStage.leaves = [];
      record.usageByStage.integration = [];
      record.usageByStage.direct = [usage("gpt-5.6-luna", "luna", "medium", 0.15)];
      record.observation.costUsd = 0.25;
    });

    const result = await runPairedBenchmark(
      fixture.manifest,
      { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: candidate },
      {
        artifactReader: fixture.reader,
        runArtifactReader: fixture.runArtifactReader,
        environment: fixture.environment,
        evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
      },
    );

    const delegated = result.records.find((record) => record.observation.route === "delegated");
    expect(delegated).toMatchObject({
      observation: { plannerTurns: 0, leafCount: 0 },
      usageByStage: { admission: [{ tier: "sol" }], planning: [], direct: [{ tier: "luna" }] },
    });
  });

  it("accounts for zero-token local routing followed by delegated direct execution", async () => {
    const fixture = benchmarkFixture();
    const candidate = executorFor("v3", fixture.manifest, [], (record) => {
      if (record.observation.route !== "fanout") {
        return;
      }
      record.observation.route = "delegated";
      record.observation.launchSkewMs = null;
      record.observation.plannerTurns = 0;
      record.observation.leafCount = 0;
      record.usageByStage.planning = [];
      record.usageByStage.leaves = [];
      record.usageByStage.integration = [];
      record.usageByStage.direct = [usage("gpt-5.6-luna", "luna", "low", 0.15)];
      record.observation.costUsd = 0.15;
    });

    const result = await runPairedBenchmark(
      fixture.manifest,
      { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: candidate },
      {
        artifactReader: fixture.reader,
        runArtifactReader: fixture.runArtifactReader,
        environment: fixture.environment,
        evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
      },
    );

    expect(result.records.find((record) => record.observation.route === "delegated")).toMatchObject(
      {
        observation: { plannerTurns: 0, leafCount: 0 },
        usageByStage: { planning: [], direct: [{ tier: "luna", effort: "low" }] },
      },
    );
  });

  it("rejects delegated records that omit worker usage", async () => {
    const fixture = benchmarkFixture();
    const candidate = executorFor("v3", fixture.manifest, [], (record) => {
      if (record.observation.route !== "fanout") {
        return;
      }
      record.observation.route = "delegated";
      record.observation.launchSkewMs = null;
      record.observation.leafCount = 0;
      record.usageByStage.leaves = [];
      record.usageByStage.integration = [];
      record.usageByStage.direct = [];
      record.observation.costUsd = 0.1;
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: candidate },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow("must preserve direct usage");
  });

  it("detects manifest tampering and malformed JSON seals", () => {
    const fixture = benchmarkFixture();
    const tampered = structuredClone(fixture.manifest);
    tampered.suiteId = "changed-after-sealing";

    expect(() => assertBenchmarkManifest(tampered)).toThrow("manifest seal mismatch");
    expect(() => parseBenchmarkManifest(JSON.stringify(tampered))).toThrow(
      "manifest seal mismatch",
    );
    expect(parseBenchmarkManifest(JSON.stringify(fixture.manifest))).toEqual(fixture.manifest);
  });

  it("does not allow the release baseline to be downgraded in the manifest", () => {
    const fixture = benchmarkFixture();
    const draft = {
      schemaVersion: fixture.manifest.schemaVersion,
      suiteId: fixture.manifest.suiteId,
      sealedAt: fixture.manifest.sealedAt,
      baseline: { ...fixture.manifest.baseline, model: "gpt-5.6-luna" },
      instances: fixture.manifest.instances,
    };

    expect(() => sealBenchmarkManifest(draft as unknown as BenchmarkManifestDraft)).toThrow(
      "baseline.model must be gpt-5.6-sol",
    );
  });

  it("seals economic eligibility and rejects invalid or unclassified release instances", () => {
    const fixture = benchmarkFixture();
    expect(() =>
      assertBenchmarkManifestCoverage(fixture.manifest, {
        minimumInstancesPerFamily: 1,
        requireAllFamilies: false,
        requireSealedEvaluationClass: true,
      }),
    ).not.toThrow();

    const legacyDraft = structuredClone(fixture.manifest) as BenchmarkManifestDraft & {
      manifestSha256?: string;
    };
    delete legacyDraft.manifestSha256;
    delete legacyDraft.instances[0]!.evaluationClass;
    delete legacyDraft.instances[0]!.eligibility;
    const legacy = sealBenchmarkManifest(legacyDraft);
    expect(() =>
      assertBenchmarkManifestCoverage(legacy, {
        minimumInstancesPerFamily: 1,
        requireAllFamilies: false,
        requireSealedEvaluationClass: true,
      }),
    ).toThrow("must pre-seal evaluationClass");

    const invalidDraft = structuredClone(fixture.manifest) as BenchmarkManifestDraft & {
      manifestSha256?: string;
    };
    delete invalidDraft.manifestSha256;
    invalidDraft.instances[0]!.eligibility!.estimatedMinLeafSeconds = 30;
    expect(() => sealBenchmarkManifest(invalidDraft)).toThrow(
      "estimatedMinLeafSeconds must be greater than 30",
    );

    const directWithEligibility = structuredClone(fixture.manifest) as BenchmarkManifestDraft & {
      manifestSha256?: string;
    };
    delete directWithEligibility.manifestSha256;
    directWithEligibility.instances[1]!.eligibility = {
      independentUnits: 2,
      estimatedMinLeafSeconds: 31,
      directSolP50Seconds: 90,
      calibrationRevision: "fixture-calibration-v1",
    };
    expect(() => sealBenchmarkManifest(directWithEligibility)).toThrow(
      "eligibility is only valid for an economic-decomposable instance",
    );
  });

  it("derives economic eligibility only from an independent calibration table", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      revision: "development-calibration-v7",
      entries: [
        {
          familyId: "coding-cross-module",
          developmentInstanceIds: ["dev-a", "dev-b", "dev-c"],
          directSolSeconds: [95, 125, 110],
          independentLeafP50Seconds: [31, 48, 52],
        },
      ],
    });
    const calibration = parseBenchmarkCalibrationTable(source);

    expect(economicEligibilityFromCalibration(calibration, "coding-cross-module", 3)).toEqual({
      independentUnits: 3,
      estimatedMinLeafSeconds: 31,
      directSolP50Seconds: 110,
      calibrationRevision: "development-calibration-v7",
      calibrationEvidenceSha256: hashBenchmarkBytes(source),
    });
    expect(economicEligibilityFromCalibration(undefined, "coding-cross-module", 3)).toBeUndefined();
    expect(() => economicEligibilityFromCalibration(calibration, "coding-cross-module", 2)).toThrow(
      "corpus requires 2",
    );
  });

  it("rejects calibration tables with too few development samples", () => {
    expect(() =>
      parseBenchmarkCalibrationTable(
        JSON.stringify({
          schemaVersion: 1,
          revision: "invalid",
          entries: [
            {
              familyId: "coding-cross-module",
              developmentInstanceIds: ["dev-a", "dev-b"],
              directSolSeconds: [100, 110],
              independentLeafP50Seconds: [40, 45],
            },
          ],
        }),
      ),
    ).toThrow("at least three samples");
  });

  it("verifies every artifact before either executor can run", async () => {
    const fixture = benchmarkFixture();
    const executor = vi.fn<BenchmarkExecutor>();
    const corruptReader: BenchmarkArtifactReader = async (artifact) =>
      artifact.role === "prompt"
        ? new TextEncoder().encode("corrupt prompt")
        : fixture.reader(artifact, fixture.manifest.instances[0]!);

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executor, v3: executor },
        {
          artifactReader: corruptReader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow(/artifact (size|hash) mismatch/u);
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["provider", "providerConfiguration", "serviceTier", "permissions", "tools"] as const)(
    "rejects a pair whose %s evidence differs between arms",
    async (field) => {
      const fixture = benchmarkFixture();
      const calls: string[] = [];
      const direct = executorFor("direct_sol", fixture.manifest, calls);
      const candidate = executorFor("v3", fixture.manifest, calls, (record) => {
        if (field === "provider") {
          record.environment.provider = "different-provider";
        } else if (field === "providerConfiguration") {
          record.environment.providerConfigurationSha256 = hashBenchmarkBytes("other provider");
        } else if (field === "serviceTier") {
          record.environment.serviceTier = "different-tier";
        } else if (field === "permissions") {
          record.environment.permissions = {
            ...record.environment.permissions,
            networkAccess: "full",
          };
        } else {
          record.environment.tools = record.environment.tools.slice(1);
        }
      });

      await expect(
        runPairedBenchmark(
          fixture.manifest,
          { direct_sol: direct, v3: candidate },
          {
            artifactReader: fixture.reader,
            runArtifactReader: fixture.runArtifactReader,
            environment: fixture.environment,
            evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
          },
        ),
      ).rejects.toThrow(new RegExp(`${field} differ`, "u"));
    },
  );

  it("rejects observations that are not reconciled to per-stage cost", async () => {
    const fixture = benchmarkFixture();
    const calls: string[] = [];
    const direct = executorFor("direct_sol", fixture.manifest, calls);
    const candidate = executorFor("v3", fixture.manifest, calls, (record) => {
      if (record.observation.route === "fanout") {
        record.usageByStage.planning[0]!.estimatedCostUsd = 0.2;
      }
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: direct, v3: candidate },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow("costUsd does not match per-stage usage");
  });

  it("includes cache-write tokens in stage token reconciliation", async () => {
    const fixture = benchmarkFixture();
    const candidate = executorFor("v3", fixture.manifest, [], (record) => {
      if (record.observation.route === "fanout") {
        const stage = record.usageByStage.planning[0]!;
        stage.cacheWriteInputTokens = 2;
        stage.totalTokens += 2;
      }
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: candidate },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).resolves.toMatchObject({ evaluation: { passed: true } });

    const malformed = executorFor("v3", fixture.manifest, [], (record) => {
      if (record.observation.route === "fanout") {
        record.usageByStage.planning[0]!.cacheWriteInputTokens = 2;
      }
    });
    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: malformed },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow("totalTokens does not equal its token components");
  });

  it("rejects missing telemetry or unverified quality evidence", async () => {
    const fixture = benchmarkFixture();
    const calls: string[] = [];
    const direct = executorFor("direct_sol", fixture.manifest, calls);
    const missingTelemetry = executorFor("v3", fixture.manifest, calls, (record) => {
      delete record.observation.protocolErrors;
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: direct, v3: missingTelemetry },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow("missing protocolErrors");

    const missingEvidence = executorFor("v3", fixture.manifest, [], (record) => {
      record.evidenceArtifacts = record.evidenceArtifacts.filter(
        (artifact) => artifact.kind !== "scorecard",
      );
    });
    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: missingEvidence },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow("must include output, validator_output, and scorecard");
  });

  it("hashes returned quality artifacts instead of trusting executor claims", async () => {
    const fixture = benchmarkFixture();
    const candidate = executorFor("v3", fixture.manifest, [], (record) => {
      record.evidenceArtifacts[0]!.sha256 = hashBenchmarkBytes("fabricated output");
    });

    await expect(
      runPairedBenchmark(
        fixture.manifest,
        { direct_sol: executorFor("direct_sol", fixture.manifest, []), v3: candidate },
        {
          artifactReader: fixture.reader,
          runArtifactReader: fixture.runArtifactReader,
          environment: fixture.environment,
          evaluation: { minimumInstancesPerFamily: 1, requireAllFamilies: false },
        },
      ),
    ).rejects.toThrow("run artifact hash mismatch");
  });
});

interface BenchmarkFixture {
  manifest: BenchmarkCorpusManifest;
  reader: BenchmarkArtifactReader;
  runArtifactReader: BenchmarkRunArtifactReader;
  environment: BenchmarkEnvironmentEvidence;
}

function benchmarkFixture(): BenchmarkFixture {
  const files = new Map<string, Uint8Array>();
  const instances = ["coding-cross-module", "coding-local-bugfix"].map((familyId, index) => {
    const prefix = `corpus/${familyId}`;
    const prompt = addFixtureArtifact(files, `${prefix}/prompt.txt`, "prompt", `prompt ${index}`);
    const validator = addFixtureArtifact(
      files,
      `${prefix}/validator.txt`,
      "validator",
      `validator ${index}`,
    );
    const workspace = addFixtureArtifact(
      files,
      `${prefix}/workspace.snapshot`,
      "workspace_snapshot",
      `state ${index}`,
    );
    return {
      familyId,
      instanceId: `sealed-${String(index + 1)}`,
      seed: `seed-${String(index + 1)}`,
      sourceRevision: `revision-${String(index + 1)}`,
      evaluationClass:
        familyId === "coding-cross-module"
          ? ("economic-decomposable" as const)
          : ("direct-fast-path" as const),
      ...(familyId === "coding-cross-module"
        ? {
            eligibility: {
              independentUnits: 2,
              estimatedMinLeafSeconds: 45,
              directSolP50Seconds: 120,
              calibrationRevision: "fixture-calibration-v1",
              calibrationEvidenceSha256: hashBenchmarkBytes("fixture-calibration-v1"),
            },
          }
        : {}),
      initialStateSha256: workspace.sha256,
      artifacts: [prompt, workspace, validator],
    };
  });
  const draft: BenchmarkManifestDraft = {
    schemaVersion: BENCHMARK_MANIFEST_VERSION,
    suiteId: "fixture-suite",
    sealedAt: "2026-08-29T00:00:00.000Z",
    baseline: {
      model: "gpt-5.6-sol",
      modelRevision: "gpt-5.6-sol-2026-08-01",
      effort: "ultra",
    },
    instances,
  };
  const manifest = sealBenchmarkManifest(draft);
  const environment: BenchmarkEnvironmentEvidence = {
    provider: "fixture-provider",
    providerConfigurationSha256: hashBenchmarkBytes("fixture-provider-config"),
    serviceTier: "priority",
    permissions: {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: "restricted",
    },
    tools: [tool("shell"), tool("browser")],
  };
  return {
    manifest,
    reader: async (artifact) => structuredClone(files.get(artifact.path)!),
    runArtifactReader: async (artifact, record) =>
      new TextEncoder().encode(runArtifactSource(artifact.kind, artifact.path, record)),
    environment,
  };
}

function addFixtureArtifact(
  files: Map<string, Uint8Array>,
  path: string,
  role: BenchmarkArtifactRole,
  source: string,
) {
  const bytes = new TextEncoder().encode(source);
  files.set(path, bytes);
  return { path, role, sha256: hashBenchmarkBytes(bytes), sizeBytes: bytes.byteLength };
}

function executorFor(
  arm: BenchmarkExecutionRequest["arm"],
  manifest: BenchmarkCorpusManifest,
  calls: string[],
  mutate?: (record: BenchmarkRunRecord) => void,
): BenchmarkExecutor {
  return async (request) => {
    expect(request.arm).toBe(arm);
    expect(request.artifacts).toHaveLength(request.instance.artifacts.length);
    for (const artifact of request.artifacts) {
      expect(hashBenchmarkBytes(artifact.bytes)).toBe(artifact.seal.sha256);
    }
    calls.push(`${request.instance.familyId}/${request.arm}/${String(request.orderInPair)}`);
    const record = benchmarkRecord(request, manifest);
    mutate?.(record);
    return record;
  };
}

function benchmarkRecord(
  request: Readonly<BenchmarkExecutionRequest>,
  manifest: BenchmarkCorpusManifest,
): BenchmarkRunRecord {
  const decomposable = request.instance.familyId === "coding-cross-module";
  const candidate = request.arm !== "direct_sol";
  const route = candidate && decomposable ? "fanout" : "direct";
  const elapsedMs = candidate ? (decomposable ? 650 : 1_100) : 1_000;
  const costUsd = candidate ? (decomposable ? 0.35 : 0.5) : 1;
  const qualityScore = candidate ? 97 : 100;
  const qualityDefinitionSha256 = request.instance.artifacts.find(
    (artifact) => artifact.role === "validator",
  )!.sha256;
  const usageByStage = emptyStageUsage();
  if (request.arm === "direct_sol") {
    usageByStage.direct.push(
      usage(
        manifest.baseline.model,
        "sol",
        manifest.baseline.effort,
        1,
        manifest.baseline.modelRevision,
      ),
    );
  } else if (route === "direct") {
    usageByStage.admission.push(usage("gpt-5.6-terra", "terra", "low", 0.05));
    usageByStage.direct.push(usage("gpt-5.6-terra", "terra", "medium", 0.45));
  } else {
    usageByStage.planning.push(
      usage(manifest.baseline.model, "sol", "high", 0.1, manifest.baseline.modelRevision),
    );
    usageByStage.leaves.push(usage("gpt-5.6-luna", "luna", "medium", 0.2));
    usageByStage.integration.push(usage("gpt-5.6-terra", "terra", "medium", 0.05));
  }
  const startedAt = Date.parse("2026-08-29T01:00:00.000Z");
  return {
    observation: {
      familyId: request.instance.familyId,
      instanceId: request.instance.instanceId,
      seed: request.instance.seed,
      arm: request.arm,
      qualityScore,
      elapsedMs,
      costUsd,
      route,
      launchSkewMs: route === "fanout" ? 1_000 : null,
      plannerTurns: route === "fanout" ? 1 : 0,
      replanCount: 0,
      promotionCount: 0,
      finalReviewTurns: 0,
      leafCount: route === "fanout" ? 2 : 0,
      protocolErrors: 0,
      userInterventions: 0,
      criticalFailures: [],
    },
    manifestSha256: request.manifestSha256,
    instanceSha256: benchmarkInstanceSha256(request.instance),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + elapsedMs).toISOString(),
    environment: {
      ...structuredClone(request.environment),
      tools:
        request.arm === "direct_sol"
          ? [tool("shell"), tool("browser")]
          : [tool("browser"), tool("shell")],
    },
    usageByStage,
    inputArtifactSha256: request.artifacts.map((artifact) => artifact.seal.sha256),
    qualityDefinitionSha256,
    evidenceArtifacts: [
      runEvidence("deliverable", `${request.instance.instanceId}/${request.arm}/deliverable.txt`),
      runEvidence(
        "validator_output",
        `${request.instance.instanceId}/${request.arm}/validator.txt`,
      ),
      runEvidence(
        "scorecard",
        `${request.instance.instanceId}/${request.arm}/scorecard.json`,
        JSON.stringify({ qualityScore, qualityDefinitionSha256 }),
      ),
    ],
  };
}

function emptyStageUsage(): {
  [Stage in keyof BenchmarkUsageByStage]: BenchmarkModelUsageEvidence[];
} {
  return Object.fromEntries(BENCHMARK_USAGE_STAGES.map((stage) => [stage, []])) as unknown as {
    [Stage in keyof BenchmarkUsageByStage]: BenchmarkModelUsageEvidence[];
  };
}

function usage(
  model: string,
  tier: BenchmarkModelUsageEvidence["tier"],
  effort: string,
  estimatedCostUsd: number,
  modelRevision = `${model}-fixture-revision`,
): BenchmarkModelUsageEvidence {
  return {
    model,
    modelRevision,
    tier,
    effort,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    uncachedInputTokens: 20,
    outputTokens: 5,
    totalTokens: 35,
    estimatedCostUsd,
    costSource: "app_server",
  };
}

function runEvidence(
  kind: BenchmarkRunRecord["evidenceArtifacts"][number]["kind"],
  path: string,
  source = path,
) {
  const bytes = new TextEncoder().encode(source);
  return { kind, path, sha256: hashBenchmarkBytes(bytes), sizeBytes: bytes.byteLength };
}

function runArtifactSource(
  kind: BenchmarkRunRecord["evidenceArtifacts"][number]["kind"],
  path: string,
  record: Readonly<BenchmarkRunRecord>,
): string {
  return kind === "scorecard"
    ? JSON.stringify({
        qualityScore: record.observation.qualityScore,
        qualityDefinitionSha256: record.qualityDefinitionSha256,
      })
    : path;
}

function tool(id: string) {
  return { id, version: "1", configurationSha256: hashBenchmarkBytes(`${id}-config`) };
}
