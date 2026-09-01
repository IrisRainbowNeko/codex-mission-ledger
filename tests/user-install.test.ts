import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROFILE_FILES,
  cleanupLegacyHooksJson,
  installUserScope,
  mergeUserConfig,
  resolveUserLayout,
  uninstallUserScope,
  verifyUserInstall,
  type UserInstallPaths,
} from "../src/user-install.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let temporaryRoot: string | null = null;

describe("V3 user installation", () => {
  afterEach(() => {
    if (temporaryRoot !== null) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  });

  it("preserves user settings while installing one V3 MCP tool", () => {
    const source = `
model = "gpt-5.6-sol"
model_reasoning_effort = "ultra"

[agents]
interrupt_message = true

[mcp_servers.hierarchical_codex]
command = "old"

[mcp_servers.hierarchical_codex.env]
OLD = "1"

[mcp_servers.notion]
enabled = true
url = "https://mcp.notion.com/mcp"

[[skills.config]]
path = "/home/me/.agents/skills/agent-trio"
enabled = true
`;
    const options = {
      packageRoot: "/opt/agent-trio",
      nodePath: "/usr/bin/node",
      jobRoot: "/var/lib/agent-trio/jobs",
    };

    const merged = mergeUserConfig(source, options);

    expect(merged).toContain('model = "gpt-5.6-sol"');
    expect(merged).toContain('model_reasoning_effort = "ultra"');
    expect(merged).toContain("interrupt_message = true");
    expect(merged).toContain("[mcp_servers.notion]");
    expect(merged).not.toContain("hierarchical_codex");
    expect(merged).not.toContain("[[skills.config]]");
    expect(merged.match(/\[mcp_servers\.agent_trio\]/gu)).toHaveLength(1);
    expect(merged).toContain('command = "/usr/bin/node"');
    expect(merged).toContain('args = ["/opt/agent-trio/dist/mcp/server.js"]');
    expect(merged).toContain('default_tools_approval_mode = "approve"');
    expect(merged).toContain('AGENT_TRIO_JOB_ROOT = "/var/lib/agent-trio/jobs"');
    expect(mergeUserConfig(merged, options)).toBe(merged);
  });

  it("migrates V1/V2 to one explicit skill without profiles or AGENTS instructions", () => {
    const paths = temporaryPaths();
    const layout = resolveUserLayout(paths);
    mkdirSync(dirname(layout.configToml), { recursive: true });
    writeFileSync(
      layout.configToml,
      `[mcp_servers.hierarchical_codex]\ncommand = "old"\n\n[mcp_servers.notion]\nenabled = true\n`,
    );
    writeFileSync(
      layout.userAgentsMd,
      `Keep this user rule.\n\n<!-- agent-trio-v2 -->\nUse $agent-trio.\n<!-- /agent-trio-v2 -->\n`,
    );
    materializeLegacyInstall(paths);

    const result = installUserScope(paths, { nodePath: "/usr/bin/node" });
    const report = verifyUserInstall(paths);
    const config = readFileSync(layout.configToml, "utf8");
    const agents = readFileSync(layout.userAgentsMd, "utf8");

    expect(report.problems).toEqual([]);
    expect(result.removedLegacy.length).toBeGreaterThanOrEqual(4);
    expect(result.backups.length).toBeGreaterThanOrEqual(4);
    expect(config).toContain("[mcp_servers.agent_trio]");
    expect(config).toContain("[mcp_servers.notion]");
    expect(config).not.toContain("hierarchical_codex");
    expect(agents).toBe("Keep this user rule.\n");
    expect(readFileSync(join(layout.skillDirectory, "SKILL.md"), "utf8")).toContain(
      "`agent_trio` MCP tool exactly once",
    );
    expect(readFileSync(join(layout.skillDirectory, "agents", "openai.yaml"), "utf8")).toContain(
      "allow_implicit_invocation: false",
    );
    expect(PROFILE_FILES).toEqual([]);
    expect(existsSync(join(layout.profileDirectory, "luna-worker.toml"))).toBe(false);
  });

  it("does not touch unrelated native agent profiles", () => {
    const paths = temporaryPaths();
    const layout = resolveUserLayout(paths);
    mkdirSync(layout.profileDirectory, { recursive: true });
    const personal = join(layout.profileDirectory, "personal.toml");
    writeFileSync(personal, 'name = "personal"\n');

    installUserScope(paths);

    expect(readFileSync(personal, "utf8")).toBe('name = "personal"\n');
  });

  it("uninstalls only the V3 MCP table and managed explicit skill", () => {
    const paths = temporaryPaths();
    const layout = resolveUserLayout(paths);
    mkdirSync(dirname(layout.configToml), { recursive: true });
    writeFileSync(
      layout.configToml,
      `model = "gpt-5.6-sol"\n\n[mcp_servers.notion]\nenabled = true\n`,
    );
    installUserScope(paths);

    uninstallUserScope(paths);

    const config = readFileSync(layout.configToml, "utf8");
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain("[mcp_servers.notion]");
    expect(config).not.toContain("mcp_servers.agent_trio");
    expect(existsSync(layout.skillDirectory)).toBe(false);
    expect(existsSync(layout.manifestPath)).toBe(false);
  });

  it("replaces its managed skill idempotently without reporting it as legacy", () => {
    const paths = temporaryPaths();
    const first = installUserScope(paths);
    const second = installUserScope(paths);
    const layout = resolveUserLayout(paths);

    expect(first.written).toContain(layout.skillDirectory);
    expect(second.removedLegacy).not.toContain(layout.skillDirectory);
    expect(verifyUserInstall(paths).problems).toEqual([]);
    expect(readFileSync(join(layout.skillDirectory, "SKILL.md"), "utf8")).toContain(
      "name: agent-trio",
    );
  });

  it("detects an implicitly invokable installed skill", () => {
    const paths = temporaryPaths();
    installUserScope(paths);
    const layout = resolveUserLayout(paths);
    const metadata = join(layout.skillDirectory, "agents", "openai.yaml");
    writeFileSync(
      metadata,
      readFileSync(metadata, "utf8").replace(
        "allow_implicit_invocation: false",
        "allow_implicit_invocation: true",
      ),
    );

    expect(verifyUserInstall(paths).problems).toContain(
      "installed agent-trio skill must be explicit-only",
    );
  });

  it("removes only managed legacy hook commands", () => {
    const source = JSON.stringify({
      hooks: {
        PreToolUse: [
          { command: "/home/me/.codex/hooks/codex-mission-ledger/run_hook.mjs" },
          { command: "/home/me/bin/personal-hook" },
        ],
      },
    });
    const cleaned = cleanupLegacyHooksJson(source);
    expect(cleaned).not.toContain("codex-mission-ledger");
    expect(cleaned).toContain("personal-hook");
  });
});

function temporaryPaths(): UserInstallPaths {
  temporaryRoot = mkdtempSync(join(tmpdir(), "agent-trio-v3-"));
  return {
    packageRoot,
    homeDirectory: temporaryRoot,
    codexHome: join(temporaryRoot, ".codex"),
  };
}

function materializeLegacyInstall(paths: UserInstallPaths): void {
  const layout = resolveUserLayout(paths);
  const oldSkill = layout.skillDirectory;
  const duplicateSkill = join(paths.codexHome, "skills", "agent-trio");
  const oldHook = join(paths.codexHome, "hooks", "codex-mission-ledger");
  const oldManifest = join(paths.codexHome, "codex-mission-ledger", "install-manifest.json");
  for (const directory of [oldSkill, duplicateSkill, oldHook, dirname(oldManifest)]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(oldSkill, "SKILL.md"), "old canonical skill\n");
  writeFileSync(join(duplicateSkill, "SKILL.md"), "old duplicate skill\n");
  writeFileSync(join(oldHook, "run_hook.mjs"), "// old hook\n");
  mkdirSync(layout.profileDirectory, { recursive: true });
  const oldProfile = join(layout.profileDirectory, "luna-worker.toml");
  writeFileSync(oldProfile, 'name = "luna-worker"\n');
  writeFileSync(
    oldManifest,
    `${JSON.stringify({ version: 2, files: [oldSkill, duplicateSkill, oldHook, oldProfile] })}\n`,
  );
}
