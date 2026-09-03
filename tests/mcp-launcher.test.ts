import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDotEnv,
  envDirectoryFromArguments,
  loadCodexEnvDirectory,
} from "../src/mcp/launcher.js";

let temporaryRoot: string | null = null;

afterEach(() => {
  if (temporaryRoot !== null) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe("MCP launcher environment", () => {
  it("loads sorted Codex env files without executing shell syntax", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "agent-trio-env-"));
    const codexHome = join(temporaryRoot, ".codex");
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, "10-provider.env"),
      [
        "export PRO_API_KEY='first-key'",
        'PRO_BASE_URL="https://provider.example/v1"',
        "LITERAL=$(printf must-not-execute)",
      ].join("\n"),
    );
    writeFileSync(
      join(codexHome, "20-override.env"),
      ["PRO_API_KEY=second-key # selected provider", 'QUOTED="line\\nvalue"'].join("\n"),
    );
    writeFileSync(join(codexHome, "notes.txt"), "PRO_API_KEY=wrong-file\n");
    const environment: NodeJS.ProcessEnv = {};

    expect(loadCodexEnvDirectory(codexHome, environment)).toEqual([
      "10-provider.env",
      "20-override.env",
    ]);
    expect(environment).toMatchObject({
      PRO_API_KEY: "second-key",
      PRO_BASE_URL: "https://provider.example/v1",
      QUOTED: "line\nvalue",
      LITERAL: "$(printf must-not-execute)",
    });
  });

  it("accepts dotenv comments, quotes, and empty assignments", () => {
    const environment: NodeJS.ProcessEnv = {};
    applyDotEnv(
      [
        "# provider settings",
        "EMPTY=",
        "HASH=value#part",
        "COMMENTED=value # comment",
        "SINGLE=' spaced value '",
        "not shell syntax",
      ].join("\n"),
      environment,
    );
    expect(environment).toEqual({
      EMPTY: "",
      HASH: "value#part",
      COMMENTED: "value",
      SINGLE: " spaced value ",
    });
  });

  it("uses the installed Codex home argument ahead of inherited environment", () => {
    expect(
      envDirectoryFromArguments(["--env-dir", "/configured/codex"], {
        CODEX_HOME: "/inherited/codex",
      }),
    ).toBe("/configured/codex");
  });
});
