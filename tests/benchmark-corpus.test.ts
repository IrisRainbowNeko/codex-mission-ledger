import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileBenchmarkArtifactReader, verifyBenchmarkCorpus } from "../src/benchmark.js";
import {
  createDevelopmentCorpusManifest,
  generateDevelopmentBenchmarkCorpus,
} from "../src/benchmark-corpus.js";

describe("development benchmark corpus", () => {
  it("creates the complete 18-by-3 deterministic manifest in memory", () => {
    const first = createDevelopmentCorpusManifest();
    const second = createDevelopmentCorpusManifest();
    expect(first.manifest.instances).toHaveLength(54);
    expect(first.artifacts).toHaveLength(216);
    expect(first.manifest.manifestSha256).toBe(second.manifest.manifestSha256);
    expect(first.artifacts.map((item) => item.path)).toEqual(
      second.artifacts.map((item) => item.path),
    );
  });

  it("materializes bytes that pass the sealed corpus verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-trio-development-corpus-"));
    try {
      const generated = await generateDevelopmentBenchmarkCorpus({ rootDirectory: root });
      const reader = createFileBenchmarkArtifactReader(root);
      await expect(verifyBenchmarkCorpus(generated.manifest, reader)).resolves.toBeUndefined();
      const source = await readFile(join(root, "manifest.json"), "utf8");
      expect(JSON.parse(source).manifestSha256).toBe(generated.manifest.manifestSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
