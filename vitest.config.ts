import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
    // The suite launches many short-lived Node/App Server fixtures. Vitest's
    // CPU-count default multiplies their resident sets and can OOM the host;
    // keep the normal check deterministic and bounded. Developers can still
    // opt into wider parallelism explicitly on a machine with spare memory.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
