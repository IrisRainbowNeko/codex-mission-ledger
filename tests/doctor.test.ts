import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";

describe("runDoctor", () => {
  it("checks the same Codex executable configured for the runtime", async () => {
    const verifyVersion = vi.fn(async () => "0.151.0");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const report = await runDoctor([], {
        env: { AGENT_TRIO_CODEX_PATH: "/opt/codex-0.151.0" },
        verifyVersion,
      });

      expect(verifyVersion).toHaveBeenCalledWith({
        codexPath: "/opt/codex-0.151.0",
        env: { AGENT_TRIO_CODEX_PATH: "/opt/codex-0.151.0" },
      });
      expect(report.checks).toContainEqual({
        name: "Codex App Server schema version",
        ok: true,
        detail: "codex-cli 0.151.0",
      });
    } finally {
      write.mockRestore();
    }
  });

  it("does not probe Codex for project-only checks", async () => {
    const verifyVersion = vi.fn(async () => "0.151.0");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const codexHome = mkdtempSync(join(tmpdir(), "agent-trio-doctor-empty-home-"));
    try {
      const report = await runDoctor(["--project-only"], {
        env: { CODEX_HOME: codexHome },
        verifyVersion,
      });
      expect(verifyVersion).not.toHaveBeenCalled();
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
