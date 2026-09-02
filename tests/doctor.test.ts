import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";

describe("runDoctor", () => {
  it("does not probe or reject the configured Codex executable by version", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const report = await runDoctor([], {
        env: { AGENT_TRIO_CODEX_PATH: "/definitely/not/a/codex/executable" },
      });

      expect(report.checks.some((check) => check.name.includes("version"))).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it("does not probe Codex for project-only checks", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const codexHome = mkdtempSync(join(tmpdir(), "agent-trio-doctor-empty-home-"));
    try {
      const report = await runDoctor(["--project-only"], {
        env: { CODEX_HOME: codexHome },
      });
      expect(report.checks).toContainEqual({
        name: "Planner transport",
        ok: true,
        detail: "Codex App Server (fallback)",
      });
      expect(report.checks).toContainEqual({
        name: "Model prices",
        ok: true,
        detail: "3 priced models (bundled default)",
      });
      expect(report.warnings).toEqual([]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      write.mockRestore();
    }
  });

  it("fails closed when the Responses planner has no independent credential", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const codexHome = mkdtempSync(join(tmpdir(), "agent-trio-doctor-empty-home-"));
    try {
      const report = await runDoctor(["--project-only"], {
        env: { AGENT_TRIO_PLANNER_TRANSPORT: "responses", CODEX_HOME: codexHome },
      });
      expect(report.checks).toContainEqual({
        name: "Planner transport",
        ok: false,
        detail:
          "Responses planner requires explicit credentials or a Responses-compatible local Codex provider",
      });
      expect(report.ok).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      write.mockRestore();
    }
  });
});
