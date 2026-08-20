import { spawnSync } from "node:child_process";
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
import {
  countTomlKey,
  installUserScope,
  mergeUserConfig,
  parseTomlFile,
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
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const installed = installUserScope(paths);
    expect(verifyUserInstall(paths).problems).toEqual([]);
    expect(installed.backedUpConfig).toContain(".bak-hierarchical-codex-");
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
    expect(toml).toContain(join(home, ".local", "share", "hierarchical-codex"));
    expect(toml).not.toMatch(/HIERARCHICAL_CODEX_HOME\s*=\s*"[^"]*\.codex\/hierarchical-codex"/);
    expect(existsSync(join(paths.codexHome, "hierarchical-codex", "install-manifest.json"))).toBe(
      true,
    );

    const second = installUserScope(paths);
    expect(second.backedUpConfig).toBeNull();
    assertParses(second.layout.configToml);
    const again = readFileSync(second.layout.configToml, "utf8");
    expect(countTomlKey(again, "features", "multi_agent")).toBe(1);
    expect(countTomlKey(again, "features", "hooks")).toBe(1);
    expect(countTomlKey(again, "agents", "enabled")).toBe(1);

    const hooks = JSON.parse(readFileSync(installed.layout.hooksJson, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.PreToolUse.some((entry) => entry.matcher === "^Shell$")).toBe(true);
    expect(
      hooks.hooks.PreToolUse.some((entry) =>
        entry.hooks.some((hook) => hook.command.includes("--opt-in")),
      ),
    ).toBe(true);

    uninstallUserScope(paths);
    const afterToml = readFileSync(join(paths.codexHome, "config.toml"), "utf8");
    expect(afterToml).toContain("[mcp_servers.other]");
    expect(afterToml).not.toContain("[mcp_servers.hierarchical_codex]");
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
      skillAgents: join(home, ".agents", "skills", "prism"),
      skillCodex: join(paths.codexHome, "skills", "prism"),
      agentDirectory: join(paths.codexHome, "agents"),
      hookDirectory: join(paths.codexHome, "hooks", "hierarchical-codex"),
      hooksJson: join(paths.codexHome, "hooks.json"),
      configToml: join(paths.codexHome, "config.toml"),
      userAgentsMd: join(paths.codexHome, "AGENTS.md"),
      stateDirectory: join(home, ".local", "share", "hierarchical-codex"),
      manifestDirectory: join(paths.codexHome, "hierarchical-codex"),
      manifestPath: join(paths.codexHome, "hierarchical-codex", "install-manifest.json"),
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
          path.includes(join("hierarchical-codex", "backups")) &&
          path.includes("terra-coordinator.toml.bak-hierarchical-codex-"),
      ),
    ).toBe(true);
    expect(
      readdirSync(join(paths.codexHome, "agents")).filter((name) =>
        name.includes(".bak-hierarchical-codex-"),
      ),
    ).toEqual([]);
    expect(readFileSync(custom, "utf8")).toContain("terra-coordinator");
    writeFileSync(join(paths.codexHome, "agents", "keep-me.toml"), 'name = "keep"\n');

    uninstallUserScope(paths);
    expect(existsSync(custom)).toBe(false);
    expect(readFileSync(join(paths.codexHome, "agents", "keep-me.toml"), "utf8")).toContain("keep");
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
    pythonExecutable: "python3",
  };
}

function assertParses(path: string): void {
  parseTomlFile(path);
  const result = spawnSync(
    "python3",
    ["-c", "import tomllib, sys; tomllib.load(open(sys.argv[1], 'rb'))", path],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
}
