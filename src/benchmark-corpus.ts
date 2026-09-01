import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BENCHMARK_FAMILIES,
  BENCHMARK_MANIFEST_VERSION,
  hashBenchmarkBytes,
  sealBenchmarkManifest,
  type BenchmarkArtifactRole,
  type BenchmarkCorpusManifest,
  type BenchmarkManifestDraft,
} from "./benchmark.js";
import { CODEX_APP_SERVER_VERSION } from "./core/contracts.js";

/**
 * A small, deterministic corpus used to exercise the paired harness without network access or
 * model calls. It is development evidence only; release claims must use sealed third-party data.
 */
export interface DevelopmentCorpusOptions {
  rootDirectory: string;
  suiteId?: string;
  sealedAt?: string;
  sourceRevision?: string;
  instancesPerFamily?: number;
  overwrite?: boolean;
}

export interface DevelopmentCorpusResult {
  rootDirectory: string;
  manifestPath: string;
  manifest: BenchmarkCorpusManifest;
  artifactCount: number;
}

interface CorpusArtifact {
  path: string;
  role: BenchmarkArtifactRole;
  bytes: Uint8Array;
}

const DEFAULT_SUITE_ID = "agent-trio-development-v1";
const DEFAULT_SEALED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_SOURCE_REVISION = "synthetic-development-v1";

/** Build deterministic artifact bytes and a sealed manifest in memory. */
export function createDevelopmentCorpusManifest(
  options: Pick<
    DevelopmentCorpusOptions,
    "suiteId" | "sealedAt" | "sourceRevision" | "instancesPerFamily"
  > = {},
): { manifest: BenchmarkCorpusManifest; artifacts: readonly CorpusArtifact[] } {
  const suiteId = options.suiteId ?? DEFAULT_SUITE_ID;
  const sealedAt = options.sealedAt ?? DEFAULT_SEALED_AT;
  const sourceRevision = options.sourceRevision ?? DEFAULT_SOURCE_REVISION;
  const instancesPerFamily = options.instancesPerFamily ?? 3;
  if (suiteId.trim().length === 0) {
    throw new Error("suiteId must be non-empty");
  }
  if (!Number.isInteger(instancesPerFamily) || instancesPerFamily < 1) {
    throw new Error("instancesPerFamily must be a positive integer");
  }
  if (Number.isNaN(Date.parse(sealedAt))) {
    throw new Error("sealedAt must be an ISO timestamp");
  }

  const artifacts: CorpusArtifact[] = [];
  const instances: BenchmarkManifestDraft["instances"] = [];
  for (const family of BENCHMARK_FAMILIES) {
    for (let index = 1; index <= instancesPerFamily; index += 1) {
      const instanceId = `${family.id}-${String(index).padStart(2, "0")}`;
      const seed = `development-${String(index)}`;
      const base = `instances/${family.id}/${instanceId}`;
      const prompt = [
        `Synthetic benchmark instance: ${instanceId}`,
        `Family: ${family.id}`,
        `Domain: ${family.domain}`,
        `Task shape: ${family.title}`,
        `Route expectation: ${family.decomposable ? "fanout" : "direct"}`,
        "Return a concise result and identify any uncertainty.",
        "This fixture intentionally has no external data and no user secrets.",
        "",
      ].join("\n");
      const workspace = JSON.stringify(
        {
          fixture: "agent-trio-development-v1",
          familyId: family.id,
          instanceId,
          seed,
          files: [{ path: "README.fixture", content: `fixture for ${instanceId}\n` }],
        },
        null,
        2,
      );
      const validator = [
        "name: fixture-validator",
        "kind: deterministic",
        'command: node -e "process.exit(0)"',
        `expected_route: ${family.decomposable ? "fanout" : "direct"}`,
        "",
      ].join("\n");
      const rubric = JSON.stringify(
        {
          version: 1,
          dimensions: ["correctness", "coverage", "contract adherence"],
          maximum: 100,
          deterministic: true,
        },
        null,
        2,
      );
      const definitions: Array<[string, BenchmarkArtifactRole, string]> = [
        ["prompt.txt", "prompt", prompt],
        ["workspace.json", "workspace_snapshot", workspace],
        ["validator.txt", "validator", validator],
        ["rubric.json", "quality_rubric", rubric],
      ];
      const seals = definitions.map(([name, role, content]) => {
        const bytes = new TextEncoder().encode(content);
        const path = `${base}/${name}`;
        artifacts.push({ path, role, bytes });
        return {
          path,
          role,
          sha256: hashBenchmarkBytes(bytes),
          sizeBytes: bytes.byteLength,
        };
      });
      const workspaceSeal = seals.find((seal) => seal.role === "workspace_snapshot");
      if (workspaceSeal === undefined) {
        throw new Error(`internal error: missing workspace seal for ${instanceId}`);
      }
      instances.push({
        familyId: family.id,
        instanceId,
        seed,
        sourceRevision,
        evaluationClass: "direct-fast-path",
        initialStateSha256: workspaceSeal.sha256,
        artifacts: seals,
      });
    }
  }

  const draft: BenchmarkManifestDraft = {
    schemaVersion: BENCHMARK_MANIFEST_VERSION,
    suiteId,
    sealedAt,
    baseline: {
      model: "gpt-5.6-sol",
      modelRevision: `codex-cli-${CODEX_APP_SERVER_VERSION}`,
      effort: "ultra",
    },
    instances,
  };
  return { manifest: sealBenchmarkManifest(draft), artifacts };
}

/** Materialize the deterministic development corpus and its sealed manifest. */
export async function generateDevelopmentBenchmarkCorpus(
  options: DevelopmentCorpusOptions,
): Promise<DevelopmentCorpusResult> {
  const rootDirectory = resolve(options.rootDirectory);
  const manifestPath = `${rootDirectory}/manifest.json`;
  const overwrite = options.overwrite ?? false;
  const generated = createDevelopmentCorpusManifest(options);
  if (!overwrite) {
    try {
      await readFile(manifestPath);
      throw new Error(`development corpus already exists at ${rootDirectory}; pass overwrite`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("development corpus already exists")) {
        throw error;
      }
    }
  }

  await mkdir(rootDirectory, { recursive: true });
  for (const artifact of generated.artifacts) {
    const path = resolve(rootDirectory, artifact.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifact.bytes);
  }
  await writeFile(manifestPath, `${JSON.stringify(generated.manifest, null, 2)}\n`);
  return {
    rootDirectory,
    manifestPath,
    manifest: generated.manifest,
    artifactCount: generated.artifacts.length,
  };
}
