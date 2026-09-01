#!/usr/bin/env node

import { resolve } from "node:path";
import { generateDevelopmentBenchmarkCorpus } from "../src/benchmark-corpus.js";

const root = process.argv[2] ?? "benchmarks/development-v1";
const overwrite = process.argv.includes("--overwrite");
const result = await generateDevelopmentBenchmarkCorpus({
  rootDirectory: resolve(root),
  overwrite,
});
process.stdout.write(
  `generated ${String(result.manifest.instances.length)} instances and ${String(result.artifactCount)} artifacts at ${result.manifestPath}\n`,
);
