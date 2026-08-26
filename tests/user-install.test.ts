import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { textContainsPath } from "../src/platform.js";
import { resolvePythonInvocation, spawnPython } from "../src/python.js";
import {
  countTomlKey,
  installUserScope,
  mergeUserConfig,
  parseTomlFile,
  resolveUserLayout,
  uninstallUserScope,
  verifyUserInstall,
  type UserInstallPaths,
} from "../src/user-install.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("user-global install", () => {
  let home: string | undefined;

  afterEach(() => {
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("merges Codex user config without pinning Sol or replacing other hooks", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    mkdirSync(paths.codexHome, { recursive: true });
    writeFileSync(
      join(paths.codexHome, "config.toml"),
      `
model = "gpt-5.6-codex"
[features]
shell = true
[agents]
enabled = true
max_concurrent_threads_per_session = 4
[mcp_servers.other]
command = "echo"
`.trimStart(),
    );
    writeFileSync(
      join(paths.codexHome, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "^Shell$",
                hooks: [{ type: "command", command: "true" }],
              },
              {
                matcher: "^(spawn_agent|Agent)$",
                hooks: [
                  {
                    type: "command",
                    command:
                      "python3 '/tmp/hooks/codex-mission-ledger/pre_spawn_policy.py' --opt-in",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const installed = installUserScope(paths);
    expect(verifyUserInstall(paths).problems).toEqual([]);
    expect(installed.backedUpConfig).toContain(".bak-codex-mission-ledger-");
    assertParses(installed.layout.configToml);

    const toml = readFileSync(installed.layout.configToml, "utf8");
    expect(toml).toContain('model = "gpt-5.6-codex"');
    expect(toml).not.toMatch(/^\s*model\s*=\s*"gpt-5\.6-sol"/m);
    expect(countTomlKey(toml, "features", "multi_agent")).toBe(1);
    expect(countTomlKey(toml, "features", "hooks")).toBe(1);
    expect(countTomlKey(toml, "agents", "max_concurrent_threads_per_session")).toBe(1);
    expect(toml).toContain("max_concurrent_threads_per_session = 4");
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain("[mcp_servers.hierarchical_codex]");
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(textContainsPath(toml, installed.layout.stateDirectory)).toBe(true);
    expect(toml).not.toMatch(/HIERARCHICAL_CODEX_HOME\s*=\s*"[^"]*\.codex[/\\]hierarchical-codex"/);
    expect(existsSync(join(paths.codexHome, "codex-mission-ledger", "install-manifest.json"))).toBe(
      true,
    );

    const second = installUserScope(paths);
    expect(second.backedUpConfig).toBeNull();
    assertParses(second.layout.configToml);
    const again = readFileSync(second.layout.configToml, "utf8");
    expect(countTomlKey(again, "features", "multi_agent")).toBe(1);
    expect(countTomlKey(again, "features", "hooks")).toBe(1);
    expect(countTomlKey(again, "agents", "enabled")).toBe(1);

    expect(toml).toContain("[[hooks.PreToolUse]]");
    expect(toml).toContain("[[hooks.SubagentStart]]");
    expect(toml).toContain("[[hooks.SubagentStop]]");
    expect(toml).toContain("^(spawn_agent|Agent)$");
    expect(toml).toContain("^(wait|Wait|list_agents|send_message|followup_task)$");
    expect(toml).toContain("^wait_agent$");
    expect(toml).toContain("--opt-in");
    expect(toml).toContain("run_hook.mjs");
    expect(toml).not.toContain("commandWindows");

    const hooks = JSON.parse(readFileSync(installed.layout.hooksJson, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.PreToolUse).toHaveLength(1);
    expect(hooks.hooks.PreToolUse.some((entry) => entry.matcher === "^Shell$")).toBe(true);
    expect(
      hooks.hooks.PreToolUse.some(
        (entry) => entry.matcher === "^(wait|Wait|list_agents|send_message|followup_task)$",
      ),
    ).toBe(false);

    uninstallUserScope(paths);
    const afterToml = readFileSync(join(paths.codexHome, "config.toml"), "utf8");
    expect(afterToml).toContain("[mcp_servers.other]");
    expect(afterToml).not.toContain("[mcp_servers.hierarchical_codex]");
    expect(afterToml).not.toContain("[[hooks.PreToolUse]]");
    assertParses(join(paths.codexHome, "config.toml"));
    const afterHooks = JSON.parse(readFileSync(join(paths.codexHome, "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(afterHooks.hooks.PreToolUse).toHaveLength(1);
  });

  it("repairs duplicate feature keys and refuses invalid writes", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    const broken = `
[features]
hooks = true
multi_agent = true
hooks = true
multi_agent = true
[agents]
enabled = true
`.trimStart();
    const merged = mergeUserConfig(broken, paths, {
      ...paths,
      agentsHome: join(home, ".agents"),
      skillAgents: join(home, ".agents", "skills", "agent-trio"),
      skillCodex: join(paths.codexHome, "skills", "agent-trio"),
      agentDirectory: join(paths.codexHome, "agents"),
      hookDirectory: join(paths.codexHome, "hooks", "hierarchical-codex"),
      hooksJson: join(paths.codexHome, "hooks.json"),
      configToml: join(paths.codexHome, "config.toml"),
      userAgentsMd: join(paths.codexHome, "AGENTS.md"),
      stateDirectory: join(home, ".local", "share", "hierarchical-codex"),
      manifestDirectory: join(paths.codexHome, "hierarchical-codex"),
      manifestPath: join(paths.codexHome, "hierarchical-codex", "install-manifest.json"),
      legacyHookDirectory: join(paths.codexHome, "hooks", "hierarchical-codex"),
      legacyManifestDirectory: join(paths.codexHome, "hierarchical-codex"),
      legacyManifestPath: join(paths.codexHome, "hierarchical-codex", "install-manifest.json"),
      legacyStateDirectory: join(home, ".local", "share", "hierarchical-codex"),
      mcpEntrypoint: join(paths.packageRoot, "dist", "cli.js"),
    });
    expect(countTomlKey(merged, "features", "hooks")).toBe(1);
    expect(countTomlKey(merged, "features", "multi_agent")).toBe(1);
    const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-parse-"));
    const path = join(directory, "config.toml");
    writeFileSync(path, merged);
    assertParses(path);
    rmSync(directory, { recursive: true, force: true });
  });

  it("replaces legacy managed markers with the canonical block", () => {
    home = mkdtempSync(join(tmpdir(), "codex-mission-ledger-user-"));
    const paths = materialize(home);
    const merged = mergeUserConfig(
      `# >>> hierarchical-codex\n[mcp_servers.hierarchical_codex]\n# <<< hierarchical-codex\n`,
      paths,
      {
        ...paths,
        agentsHome: join(home, ".agents"),
        skillAgents: join(home, ".agents", "skills", "agent-trio"),
        skillCodex: join(paths.codexHome, "skills", "agent-trio"),
        agentDirectory: join(paths.codexHome, "agents"),
        hookDirectory: join(paths.codexHome, "hooks", "codex-mission-ledger"),
        hooksJson: join(paths.codexHome, "hooks.json"),
        configToml: join(paths.codexHome, "config.toml"),
        userAgentsMd: join(paths.codexHome, "AGENTS.md"),
        stateDirectory: join(home, ".local", "share", "codex-mission-ledger"),
        manifestDirectory: join(paths.codexHome, "codex-mission-ledger"),
        manifestPath: join(paths.codexHome, "codex-mission-ledger", "install-manifest.json"),
        legacyHookDirectory: join(paths.codexHome, "hooks", "hierarchical-codex"),
        legacyManifestDirectory: join(paths.codexHome, "hierarchical-codex"),
        legacyManifestPath: join(paths.codexHome, "hierarchical-codex", "install-manifest.json"),
        legacyStateDirectory: join(home, ".local", "share", "hierarchical-codex"),
        mcpEntrypoint: join(paths.packageRoot, "dist", "cli.js"),
      },
    );
    expect(merged).toContain("# >>> codex-mission-ledger");
    expect(merged).not.toContain("# >>> hierarchical-codex");
    expect(merged).toContain("CODEX_MISSION_LEDGER_HOME");
  });

  it("aborts on unmanaged conflicts and only deletes manifest files on uninstall", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    mkdirSync(join(paths.codexHome, "agents"), { recursive: true });
    const custom = join(paths.codexHome, "agents", "terra-coordinator.toml");
    writeFileSync(custom, 'name = "custom"\n');

    expect(() => installUserScope(paths)).toThrowError(/unmanaged files/);
    expect(readFileSync(custom, "utf8")).toContain('name = "custom"');

    const forced = installUserScope(paths, { force: true });
    expect(
      forced.backedUpConflicts.some(
        (path) =>
          path.includes(join("codex-mission-ledger", "backups")) &&
          path.includes("terra-coordinator.toml.bak-codex-mission-ledger-"),
      ),
    ).toBe(true);
    expect(
      readdirSync(join(paths.codexHome, "agents")).filter((name) =>
        name.includes(".bak-codex-mission-ledger-"),
      ),
    ).toEqual([]);
    expect(readFileSync(custom, "utf8")).toContain("terra-coordinator");
    writeFileSync(join(paths.codexHome, "agents", "keep-me.toml"), 'name = "keep"\n');

    uninstallUserScope(paths);
    expect(existsSync(custom)).toBe(false);
    expect(readFileSync(join(paths.codexHome, "agents", "keep-me.toml"), "utf8")).toContain("keep");
  });

  it("uninstalls canonical and legacy manifests and hook directories together", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    const installed = installUserScope(paths);
    const legacyHookDirectory = join(paths.codexHome, "hooks", "hierarchical-codex");
    const legacyManifestDirectory = join(paths.codexHome, "hierarchical-codex");
    const legacyHook = join(legacyHookDirectory, "pre_spawn_policy.py");
    mkdirSync(legacyHookDirectory, { recursive: true });
    writeFileSync(legacyHook, "# legacy hook\n");
    mkdirSync(legacyManifestDirectory, { recursive: true });
    writeFileSync(
      join(legacyManifestDirectory, "install-manifest.json"),
      `${JSON.stringify({ version: 1, packageRoot: paths.packageRoot, files: [legacyHook] })}\n`,
    );

    uninstallUserScope(paths);

    expect(existsSync(installed.layout.manifestPath)).toBe(false);
    expect(existsSync(join(legacyManifestDirectory, "install-manifest.json"))).toBe(false);
    expect(existsSync(installed.layout.hookDirectory)).toBe(false);
    expect(existsSync(legacyHookDirectory)).toBe(false);
  });

  it("reports missing MCP approve mode as a verification problem", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    installUserScope(paths);
    const config = join(paths.codexHome, "config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        'default_tools_approval_mode = "approve"',
        'default_tools_approval_mode = "auto"',
      ),
    );
    const report = verifyUserInstall(paths);
    expect(report.problems.some((problem) => problem.includes("approve"))).toBe(true);
  });

  it("reports invalid user TOML as a verification problem", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    installUserScope(paths);
    writeFileSync(
      join(paths.codexHome, "config.toml"),
      `
[features]
hooks = true
hooks = true
`.trimStart(),
    );
    const report = verifyUserInstall(paths);
    expect(report.problems.some((problem) => /TOML|overwrite|hooks/i.test(problem))).toBe(true);
  });

  it("warns when leftover skill backups remain under skills/", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    installUserScope(paths);
    const leftover = join(paths.codexHome, "skills", "sol-terra-luna.bak-hierarchical-codex-old");
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, "notes.md"), "stale backup\n");
    const report = verifyUserInstall(paths);
    expect(report.problems).toEqual([]);
    expect(report.warnings.some((warning) => warning.includes(leftover))).toBe(true);
  });

  it("removes previously owned skill folders after a rename", () => {
    home = mkdtempSync(join(tmpdir(), "hierarchical-codex-user-"));
    const paths = materialize(home);
    const first = installUserScope(paths);
    const stale = join(paths.codexHome, "skills", "sol-terra-luna");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), "---\nname: sol-terra-luna\n---\n");
    const manifest = JSON.parse(readFileSync(first.layout.manifestPath, "utf8")) as {
      files: string[];
    };
    manifest.files.push(stale);
    writeFileSync(first.layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    installUserScope(paths);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(first.layout.skillCodex, "SKILL.md"))).toBe(true);
  });

  it("stores the ledger under LocalAppData for a Windows layout", () => {
    home = mkdtempSync(join(tmpdir(), "codex-mission-ledger-win-"));
    const paths: UserInstallPaths = { ...materialize(home), platform: "win32" };
    const layout = resolveUserLayout(paths);
    expect(layout.stateDirectory).toBe(join(home, "AppData", "Local", "codex-mission-ledger"));
    const installed = installUserScope(paths);
    const toml = readFileSync(installed.layout.configToml, "utf8");
    expect(textContainsPath(toml, layout.stateDirectory)).toBe(true);
    expect(toml).toContain("[[hooks.PreToolUse]]");
    expect(toml).toContain("run_hook.mjs");
    expect(toml).toContain("--opt-in");
    expect(toml).toContain("commandWindows");
    expect(toml).toContain('"');
    expect(existsSync(installed.layout.hooksJson)).toBe(false);
    expect(verifyUserInstall(paths).problems).toEqual([]);
  });
});

function materialize(home: string): UserInstallPaths {
  const packageDir = join(home, "pkg");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  cpSync(join(packageRoot, ".codex", "agents"), join(packageDir, ".codex", "agents"), {
    recursive: true,
  });
  cpSync(join(packageRoot, ".codex", "hooks"), join(packageDir, ".codex", "hooks"), {
    recursive: true,
  });
  cpSync(join(packageRoot, ".codex", "skills"), join(packageDir, ".codex", "skills"), {
    recursive: true,
  });
  writeFileSync(join(packageDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  return {
    packageRoot: packageDir,
    homeDirectory: home,
    codexHome: join(home, ".codex"),
    nodeExecutable: process.execPath,
    python: resolvePythonInvocation(),
  };
}

function assertParses(path: string): void {
  parseTomlFile(path);
  const result = spawnPython(
    ["-c", "import tomllib, sys; tomllib.load(open(sys.argv[1], 'rb'))", path],
    { encoding: "utf8" },
  );
  expect(result.status, String(result.stderr)).toBe(0);
}
