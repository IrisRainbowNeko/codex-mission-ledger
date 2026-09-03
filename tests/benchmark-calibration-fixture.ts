import {
  parseBenchmarkCalibrationTable,
  type LoadedBenchmarkCalibration,
} from "../src/benchmark.js";

export const ECONOMIC_FAMILY_IDS = [
  "coding-cross-module",
  "algorithm-exact",
  "research-frozen",
  "research-conflict",
  "paper-revision",
  "office-sheet",
  "office-document",
  "office-slides",
  "auto-dossier",
] as const;

export function calibrationFixture(
  familyIds: readonly string[],
  independentUnits = 3,
): LoadedBenchmarkCalibration {
  return parseBenchmarkCalibrationTable(
    JSON.stringify({
      schemaVersion: 1,
      revision: "independent-development-fixture-v1",
      entries: familyIds.map((familyId) => ({
        familyId,
        developmentInstanceIds: ["development-01", "development-02", "development-03"],
        directSolSeconds: [100, 120, 140],
        independentLeafP50Seconds: Array.from(
          { length: independentUnits },
          (_, index) => 35 + index * 10,
        ),
      })),
    }),
  );
}
