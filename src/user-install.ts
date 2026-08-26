import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_PLANE_DB_NAME } from "./config.js";
import {
  defaultUserStateDirectory,
  isManagedHookCommand,
  mkdirPrivate,
  normalizePathSeparators,
  textContainsPath,
  userHome,
} from "./platform.js";
import {
  formatNodeHookCommand,
  formatPythonInvocation,
  resolvePythonInvocation,
  spawnPython,
  type PythonInvocation,
} from "./python.js";

export const MANAGED_BEGIN = "# >>> codex-mission-ledger";
export const MANAGED_END = "# <<< codex-mission-ledger";
export const AGENTS_BEGIN = "<!-- codex-mission-ledger -->";
export const AGENTS_END = "<!-- /codex-mission-ledger -->";
export const HOOK_MARKER = "codex-mission-ledger/pre_spawn_policy.py";
export const COORDINATOR_HOOK_MARKER = "codex-mission-ledger/pre_coordinator_tools.py";
export const LEGACY_MANAGED_BEGIN = "# >>> hierarchical-codex";
export const LEGACY_MANAGED_END = "# <<< hierarchical-codex";
export const LEGACY_AGENTS_BEGIN = "<!-- hierarchical-codex -->";
export const LEGACY_AGENTS_END = "<!-- /hierarchical-codex -->";
export const LEGACY_HOOK_MARKER = "hierarchical-codex/pre_spawn_policy.py";
export const LEGACY_COORDINATOR_HOOK_MARKER = "hierarchical-codex/pre_coordinator_tools.py";
export const MANIFEST_NAME = "install-manifest.json";
export const SKILL_NAME = "agent-trio";

const AGENT_FILES = [
  "terra-coordinator.toml",
  "luna-producer.toml",
  "luna-verifier.toml",
  "sol-advisor.toml",
] as const;

const HOOK_FILES = [
  "hook_utils.py",
  "pre_spawn_policy.py",
  "pre_coordinator_tools.py",
  "subagent_start.py",
  "subagent_stop.py",
  "run_hook.mjs",
] as const;

const FEATURE_KEYS = ["multi_agent", "hooks"] as const;
const AGENT_TABLE_KEYS = [
  "enabled",
  "max_concurrent_threads_per_session",
  "interrupt_message",
] as const;

const MCP_TOOLS = [
  "mission_create",
  "mission_get",
  "mission_close",
  "task_allocate",
  "task_get",
  "task_claim",
  "task_start",
  "task_heartbeat",
  "task_release",
  "task_block",
  "task_fail",
  "task_cancel",
  "task_supersede",
  "task_set_effort",
  "artifact_put",
  "artifact_get",
  "result_submit_candidate",
  "result_check",
  "result_verify",
  "task_commit",
  "budget_report",
  "recovery_snapshot",
  "children_status",
  "results_gate_and_commit",
] as const;

export interface UserInstallPaths {
  packageRoot: string;
  homeDirectory: string;
  codexHome: string;
  nodeExecutable: string;
  python: PythonInvocation;
  platform?: NodeJS.Platform;
}

export interface UserInstallLayout {
  codexHome: string;
  agentsHome: string;
  skillAgents: string;
  skillCodex: string;
  agentDirectory: string;
  hookDirectory: string;
  hooksJson: string;
  configToml: string;
  userAgentsMd: string;
  stateDirectory: string;
  manifestDirectory: string;
  manifestPath: string;
  legacyHookDirectory: string;
  legacyManifestDirectory: string;
  legacyManifestPath: string;
  legacyStateDirectory: string;
  mcpEntrypoint: string;
}

export interface UserInstallOptions {
  force?: boolean;
}

export interface UserInstallResult {
  layout: UserInstallLayout;
  backedUpConfig: string | null;
  backedUpConflicts: string[];
  written: string[];
}

export interface UserVerifyReport {
  problems: string[];
  warnings: string[];
}

interface InstallManifest {
  version: 1;
  packageRoot: string;
  files: string[];
}

export function packageRootFromModule(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export function defaultUserInstallPaths(
  packageRoot: string,
  homeDirectory = userHome(),
): UserInstallPaths {
  return {
    packageRoot,
    homeDirectory,
    codexHome: process.env["CODEX_HOME"] ?? join(homeDirectory, ".codex"),
    nodeExecutable: process.execPath,
    python: resolvePythonInvocation(),
    platform: process.platform,
  };
}

export function resolveUserLayout(paths: UserInstallPaths): UserInstallLayout {
  const hookDirectory = join(paths.codexHome, "hooks", "codex-mission-ledger");
  const manifestDirectory = join(paths.codexHome, "codex-mission-ledger");
  // Codex sandboxes ~/.codex as read-only for MCP processes, so the live ledger
  // must live outside that tree. The install manifest stays under ~/.codex.
  const platform = paths.platform ?? process.platform;
  const stateEnv: NodeJS.ProcessEnv = {
    HOME: paths.homeDirectory,
    USERPROFILE: paths.homeDirectory,
  };
  if (platform === "win32") {
    const redirected = process.env["LOCALAPPDATA"];
    stateEnv["LOCALAPPDATA"] =
      resolve(paths.homeDirectory) === userHome() &&
      redirected !== undefined &&
      redirected.trim().length > 0
        ? redirected.trim()
        : join(paths.homeDirectory, "AppData", "Local");
  }
  const canonicalStateDirectory = defaultUserStateDirectory(
    "codex-mission-ledger",
    stateEnv,
    platform,
  );
  const legacyHookDirectory = join(paths.codexHome, "hooks", "hierarchical-codex");
  const legacyManifestDirectory = join(paths.codexHome, "hierarchical-codex");
  const legacyStateDirectory = defaultUserStateDirectory("hierarchical-codex", stateEnv, platform);
  const stateDirectory =
    existsSync(join(canonicalStateDirectory, CONTROL_PLANE_DB_NAME)) ||
    !existsSync(join(legacyStateDirectory, CONTROL_PLANE_DB_NAME))
      ? canonicalStateDirectory
      : legacyStateDirectory;
  return {
    codexHome: paths.codexHome,
    agentsHome: join(paths.homeDirectory, ".agents"),
    skillAgents: join(paths.homeDirectory, ".agents", "skills", SKILL_NAME),
    skillCodex: join(paths.codexHome, "skills", SKILL_NAME),
    agentDirectory: join(paths.codexHome, "agents"),
    hookDirectory,
    hooksJson: join(paths.codexHome, "hooks.json"),
    configToml: join(paths.codexHome, "config.toml"),
    userAgentsMd: join(paths.codexHome, "AGENTS.md"),
    stateDirectory,
    manifestDirectory,
    manifestPath: join(manifestDirectory, MANIFEST_NAME),
    legacyHookDirectory,
    legacyManifestDirectory,
    legacyManifestPath: join(legacyManifestDirectory, MANIFEST_NAME),
    legacyStateDirectory,
    mcpEntrypoint: join(paths.packageRoot, "dist", "cli.js"),
  };
}

export function assertInstallable(paths: UserInstallPaths, layout: UserInstallLayout): void {
  const required = [
    join(paths.packageRoot, ".codex", "skills", SKILL_NAME, "SKILL.md"),
    join(paths.packageRoot, ".codex", "hooks", "pre_spawn_policy.py"),
    layout.mcpEntrypoint,
    ...AGENT_FILES.map((name) => join(paths.packageRoot, ".codex", "agents", name)),
    ...HOOK_FILES.map((name) => join(paths.packageRoot, ".codex", "hooks", name)),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Build/install sources missing: ${missing.join(", ")}. Run npm run build.`);
  }
}

export function installUserScope(
  paths: UserInstallPaths,
  options: UserInstallOptions = {},
): UserInstallResult {
  const layout = resolveUserLayout(paths);
  assertInstallable(paths, layout);
  const force = options.force === true;
  const written: string[] = [];
  const backedUpConflicts: string[] = [];
  const previousManifest =
    readManifest(layout.manifestPath) ?? readManifest(layout.legacyManifestPath);
  const owned = new Set(previousManifest?.files ?? []);
  const planned = plannedManagedFiles(paths, layout);

  const conflicts = planned.filter((target) => existsSync(target) && !owned.has(target));
  if (conflicts.length > 0 && !force) {
    throw new Error(
      "Refusing to overwrite unmanaged files. Re-run with --force to back them up, or remove:\n" +
        conflicts.join("\n"),
    );
  }
  for (const conflict of conflicts) {
    const backup = backupIfExists(conflict, layout);
    if (backup !== null) {
      backedUpConflicts.push(backup);
    }
  }

  mkdirPrivate(join(paths.homeDirectory, ".agents", "skills"));
  mkdirPrivate(join(layout.codexHome, "skills"));
  mkdirPrivate(layout.agentDirectory);
  mkdirPrivate(layout.hookDirectory);
  mkdirPrivate(layout.manifestDirectory);
  mkdirPrivate(layout.stateDirectory);

  copySkill(paths.packageRoot, layout.skillAgents);
  copySkill(paths.packageRoot, layout.skillCodex);
  written.push(layout.skillAgents, layout.skillCodex);

  const plannedSet = new Set(planned);
  for (const previous of owned) {
    if (!plannedSet.has(previous) && existsSync(previous)) {
      rmSync(previous, { recursive: true, force: true });
    }
  }

  for (const name of AGENT_FILES) {
    const target = join(layout.agentDirectory, name);
    copyFileSync(join(paths.packageRoot, ".codex", "agents", name), target);
    written.push(target);
  }
  for (const name of HOOK_FILES) {
    const target = join(layout.hookDirectory, name);
    copyFileSync(join(paths.packageRoot, ".codex", "hooks", name), target);
    written.push(target);
  }

  const existingConfig = existsSync(layout.configToml)
    ? readFileSync(layout.configToml, "utf8")
    : "";
  const firstManagedInstall = !hasManagedBlock(existingConfig);
  const backedUpConfig = firstManagedInstall ? backupIfExists(layout.configToml, layout) : null;
  const nextConfig = mergeUserConfig(existingConfig, paths, layout);
  assertTomlText(nextConfig, layout.configToml);
  atomicWrite(layout.configToml, nextConfig);
  written.push(layout.configToml);

  const nextHooks = mergeUserHooks(
    existsSync(layout.hooksJson) ? readFileSync(layout.hooksJson, "utf8") : "",
    paths,
    layout,
  );
  atomicWrite(layout.hooksJson, `${JSON.stringify(nextHooks, null, 2)}\n`);
  written.push(layout.hooksJson);

  const nextAgents = mergeUserAgentsMd(
    existsSync(layout.userAgentsMd) ? readFileSync(layout.userAgentsMd, "utf8") : "",
  );
  atomicWrite(layout.userAgentsMd, nextAgents);
  written.push(layout.userAgentsMd);

  const manifest: InstallManifest = {
    version: 1,
    packageRoot: paths.packageRoot,
    files: planned,
  };
  atomicWrite(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(layout.manifestPath);

  return { layout, backedUpConfig, backedUpConflicts, written };
}

export function uninstallUserScope(paths: UserInstallPaths): UserInstallLayout {
  const layout = resolveUserLayout(paths);
  const manifestPaths = [layout.manifestPath, layout.legacyManifestPath];
  const manifests = manifestPaths
    .map((path) => readManifest(path))
    .filter((manifest): manifest is InstallManifest => manifest !== null);
  const files = new Set(manifests.flatMap((manifest) => manifest.files));
  for (const file of files) {
    rmSync(file, { recursive: true, force: true });
  }
  // Both directories are dedicated to this integration, including installs
  // from before the manifest was introduced.
  rmSync(layout.hookDirectory, { recursive: true, force: true });
  rmSync(layout.legacyHookDirectory, { recursive: true, force: true });

  if (existsSync(layout.configToml)) {
    const stripped = stripManagedBlocks(readFileSync(layout.configToml, "utf8"));
    atomicWrite(layout.configToml, stripped.length === 0 ? "" : `${stripped}\n`);
  }
  if (existsSync(layout.hooksJson)) {
    const current = JSON.parse(readFileSync(layout.hooksJson, "utf8")) as HooksFile;
    atomicWrite(layout.hooksJson, `${JSON.stringify(removeOurHooks(current), null, 2)}\n`);
  }
  if (existsSync(layout.userAgentsMd)) {
    atomicWrite(
      layout.userAgentsMd,
      stripManagedAgentBlocks(readFileSync(layout.userAgentsMd, "utf8")),
    );
  }
  for (const manifestPath of manifestPaths) {
    rmSync(manifestPath, { force: true });
  }
  return layout;
}

export function mergeUserConfig(
  source: string,
  paths: UserInstallPaths,
  layout: UserInstallLayout,
): string {
  let next = stripManagedBlocks(source);
  for (const key of FEATURE_KEYS) {
    next = dedupeTomlKey(next, "features", key);
  }
  for (const key of AGENT_TABLE_KEYS) {
    next = dedupeTomlKey(next, "agents", key);
  }
  next = upsertTomlKey(next, "features", "multi_agent", "true");
  next = upsertTomlKey(next, "features", "hooks", "true");
  next = upsertTomlKey(next, "agents", "enabled", "true");
  if (!tomlTableHasKey(next, "agents", "max_concurrent_threads_per_session")) {
    next = upsertTomlKey(next, "agents", "max_concurrent_threads_per_session", "8");
  }
  if (!tomlTableHasKey(next, "agents", "interrupt_message")) {
    next = upsertTomlKey(next, "agents", "interrupt_message", "true");
  }
  return `${next.trimEnd()}\n\n${renderManagedConfig(paths, layout)}\n`;
}

export function mergeUserHooks(
  source: string,
  paths: UserInstallPaths,
  layout: UserInstallLayout,
): HooksFile {
  const parsed = source.trim().length === 0 ? emptyHooksFile() : (JSON.parse(source) as HooksFile);
  const current = hooksFile(parsed.description, parsed.hooks ?? {});
  const withoutOurs = removeOurHooks(current);
  const ours = userHookDefinitions(paths, layout);
  return hooksFile(withoutOurs.description ?? "User Codex hooks", {
    ...withoutOurs.hooks,
    PreToolUse: [...(withoutOurs.hooks.PreToolUse ?? []), ...ours.PreToolUse],
    SubagentStart: [...(withoutOurs.hooks.SubagentStart ?? []), ...ours.SubagentStart],
    SubagentStop: [...(withoutOurs.hooks.SubagentStop ?? []), ...ours.SubagentStop],
  });
}

export function mergeUserAgentsMd(source: string): string {
  const stripped = stripManagedAgentBlocks(source).trimEnd();
  const section = `${AGENTS_BEGIN}
When the user invokes \`$agent-trio\` or asks for hierarchical Sol/Terra/Luna
agents, follow the agent-trio skill. Use native spawn_agent and the
\`hierarchical_codex\` MCP tools. Do not spawn Luna from Sol. Allocate a control-plane
task before spawning Terra or Luna. Coordinators must not poll with list_agents,
wait, send_message, or followup_task; use one long wait_agent. After a timeout,
children_status once — do not wait 1h three times. Parked blocked training jobs
stay on the ledger; the user says 继续 to resume.
${AGENTS_END}
`;
  return stripped.length === 0 ? `${section}\n` : `${stripped}\n\n${section}\n`;
}

export function verifyUserLayout(paths: UserInstallPaths): string[] {
  return verifyUserInstall(paths).problems;
}

export function verifyUserInstall(paths: UserInstallPaths): UserVerifyReport {
  const layout = resolveUserLayout(paths);
  const problems: string[] = [];
  const warnings: string[] = [];
  const required = [
    join(layout.skillAgents, "SKILL.md"),
    join(layout.skillCodex, "SKILL.md"),
    ...AGENT_FILES.map((name) => join(layout.agentDirectory, name)),
    ...HOOK_FILES.map((name) => join(layout.hookDirectory, name)),
    layout.configToml,
    layout.hooksJson,
    layout.mcpEntrypoint,
    layout.manifestPath,
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      problems.push(`missing ${path}`);
    }
  }

  const pythonCheck = spawnPython(["--version"], { encoding: "utf8" }, paths.python);
  if (pythonCheck.status !== 0) {
    problems.push(
      `Python 3 is required for Codex hooks (${formatPythonInvocation(paths.python)} failed). On Windows install python.org Python or the py launcher.`,
    );
  }

  if (existsSync(layout.configToml)) {
    try {
      parseTomlFile(layout.configToml);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    const toml = readFileSync(layout.configToml, "utf8");
    if (!toml.includes("[mcp_servers.hierarchical_codex]")) {
      problems.push("config.toml is missing [mcp_servers.hierarchical_codex]");
    }
    if (!textContainsPath(toml, layout.mcpEntrypoint)) {
      problems.push("config.toml MCP args do not point at dist/cli.js");
    }
    if (!/default_tools_approval_mode\s*=\s*"approve"/.test(toml)) {
      problems.push(
        'config.toml must set mcp_servers.hierarchical_codex.default_tools_approval_mode = "approve" so Codex Guardian skips this local ledger. Re-run npm run install:user.',
      );
    }
    if (
      /HIERARCHICAL_CODEX_HOME\s*=\s*"[^"]*\.codex[/\\](?:hierarchical-codex|codex-mission-ledger)"/.test(
        toml,
      ) ||
      /CODEX_MISSION_LEDGER_HOME\s*=\s*"[^"]*\.codex[/\\](?:hierarchical-codex|codex-mission-ledger)"/.test(
        toml,
      )
    ) {
      warnings.push(
        "MCP state is under ~/.codex, which Codex sandboxes as read-only. Re-run npm run install:user so the ledger moves outside that tree (%LOCALAPPDATA%\\codex-mission-ledger on Windows, ~/.local/share/codex-mission-ledger elsewhere).",
      );
    }
    if (/^\s*model\s*=\s*"gpt-5\.6-sol"/m.test(managedSection(toml))) {
      problems.push("managed config must not pin the global default model to Sol");
    }
    for (const key of FEATURE_KEYS) {
      if (countTomlKey(toml, "features", key) > 1) {
        problems.push(`config.toml has duplicate features.${key} assignments`);
      }
    }
    for (const key of AGENT_TABLE_KEYS) {
      if (countTomlKey(toml, "agents", key) > 1) {
        problems.push(`config.toml has duplicate agents.${key} assignments`);
      }
    }
    if (!/trusted_hash\s*=/.test(toml)) {
      warnings.push(
        "User-level command hooks are not trusted yet. In a new Codex chat run /hooks and trust the Mission Ledger for Codex commands; until then spawn policy is skipped.",
      );
    }
  }

  for (const name of AGENT_FILES) {
    const path = join(layout.agentDirectory, name);
    if (!existsSync(path)) {
      continue;
    }
    try {
      parseTomlFile(path);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (existsSync(layout.hooksJson)) {
    try {
      JSON.parse(readFileSync(layout.hooksJson, "utf8"));
    } catch {
      problems.push(`hooks.json is not valid JSON: ${layout.hooksJson}`);
    }
    const hooks = readFileSync(layout.hooksJson, "utf8");
    const hooksNormalized = normalizePathSeparators(hooks);
    if (!hooksNormalized.includes("--opt-in")) {
      problems.push("user hooks.json must call pre_spawn_policy.py --opt-in");
    }
    if (!hooksNormalized.includes(HOOK_MARKER) && !hooksNormalized.includes(LEGACY_HOOK_MARKER)) {
      problems.push("user hooks.json is missing Mission Ledger for Codex hook commands");
    }
    if (
      !hooksNormalized.includes(COORDINATOR_HOOK_MARKER) &&
      !hooksNormalized.includes(LEGACY_COORDINATOR_HOOK_MARKER)
    ) {
      problems.push("user hooks.json is missing coordinator babysit policy");
    }
  }

  if (existsSync(layout.mcpEntrypoint)) {
    const syntax = spawnSync(paths.nodeExecutable, ["--check", layout.mcpEntrypoint], {
      encoding: "utf8",
    });
    if (syntax.status !== 0) {
      problems.push(syntax.stderr || `MCP entrypoint failed node --check: ${layout.mcpEntrypoint}`);
    }
  }

  for (const leftover of leftoverSkillBackups(dirname(layout.skillCodex)).concat(
    leftoverSkillBackups(dirname(layout.skillAgents)),
  )) {
    warnings.push(
      `Codex still loads leftover skill backup ${leftover}. Move it out of skills/ into ${join(layout.manifestDirectory, "backups")}.`,
    );
  }

  return { problems, warnings };
}

export function parseTomlFile(path: string): void {
  const result = spawnPython(
    ["-c", "import tomllib, sys; tomllib.load(open(sys.argv[1], 'rb'))", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .map((value) => String(value ?? "").trim())
      .find((value) => value.length > 0);
    throw new Error(detail ?? `TOML parse failed: ${path}`);
  }
}

export function upsertTomlKey(source: string, table: string, key: string, value: string): string {
  const lines = splitLines(source);
  const assignment = `${key} = ${value}`;
  const range = findTable(lines, table);
  if (range === null) {
    const next = trimEndEmpty([...lines]);
    if (next.length > 0 && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push(`[${table}]`, assignment);
    return joinLines(next);
  }
  const keyPattern = keyLinePattern(key);
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index];
    if (line !== undefined && keyPattern.test(line)) {
      lines[index] = assignment;
      return joinLines(lines);
    }
  }
  lines.splice(range.start + 1, 0, assignment);
  return joinLines(lines);
}

export function dedupeTomlKey(source: string, table: string, key: string): string {
  const lines = splitLines(source);
  const range = findTable(lines, table);
  if (range === null) {
    return source;
  }
  const keyPattern = keyLinePattern(key);
  const matches: number[] = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index];
    if (line !== undefined && keyPattern.test(line)) {
      matches.push(index);
    }
  }
  if (matches.length <= 1) {
    return source;
  }
  const keep = matches[matches.length - 1];
  return joinLines(lines.filter((_, index) => index === keep || !matches.includes(index)));
}

export function countTomlKey(source: string, table: string, key: string): number {
  const lines = splitLines(source);
  const range = findTable(lines, table);
  if (range === null) {
    return 0;
  }
  const keyPattern = keyLinePattern(key);
  let count = 0;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index];
    if (line !== undefined && keyPattern.test(line)) {
      count += 1;
    }
  }
  return count;
}

export function tomlTableHasKey(source: string, table: string, key: string): boolean {
  return countTomlKey(source, table, key) > 0;
}

function plannedManagedFiles(paths: UserInstallPaths, layout: UserInstallLayout): string[] {
  return [
    layout.skillAgents,
    layout.skillCodex,
    ...AGENT_FILES.map((name) => join(layout.agentDirectory, name)),
    ...HOOK_FILES.map((name) => join(layout.hookDirectory, name)),
  ];
}

function copySkill(packageRoot: string, target: string): void {
  const source = join(packageRoot, ".codex", "skills", SKILL_NAME);
  rmSync(target, { recursive: true, force: true });
  mkdirPrivate(dirname(target));
  cpSync(source, target, { recursive: true });
}

function renderManagedConfig(paths: UserInstallPaths, layout: UserInstallLayout): string {
  const tools = MCP_TOOLS.map((name) => `  ${tomlString(name)},`).join("\n");
  const hookPolicy = join(layout.hookDirectory, "pre_spawn_policy.py");
  return `${MANAGED_BEGIN}
# User-global Mission Ledger for Codex. Does not pin the default model.
# Hook scripts live at ${hookPolicy}
# Ledger lives outside ~/.codex because Codex sandboxes that tree as read-only.
# approval_mode approve skips Codex Guardian on this local stdio MCP.

[mcp_servers.hierarchical_codex]
command = ${tomlString(paths.nodeExecutable)}
args = [${tomlString(layout.mcpEntrypoint)}]
cwd = ${tomlString(paths.packageRoot)}
required = false
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "approve"
enabled_tools = [
${tools}
]

[mcp_servers.hierarchical_codex.env]
CODEX_MISSION_LEDGER_HOME = ${tomlString(layout.stateDirectory)}

[[skills.config]]
path = ${tomlString(layout.skillAgents)}
enabled = true
${MANAGED_END}`;
}

function userHookDefinitions(
  paths: UserInstallPaths,
  layout: UserInstallLayout,
): Required<HooksFile["hooks"]> {
  const platform = paths.platform ?? process.platform;
  const runner = join(layout.hookDirectory, "run_hook.mjs");
  const hookCommand = (script: string, extra: readonly string[] = []): string =>
    formatNodeHookCommand(
      paths.nodeExecutable,
      runner,
      join(layout.hookDirectory, script),
      extra,
      platform,
    );
  return {
    PreToolUse: [
      {
        matcher: "^(spawn_agent|Agent)$",
        hooks: [
          {
            type: "command",
            command: hookCommand("pre_spawn_policy.py", ["--opt-in"]),
            timeout: 10,
            statusMessage: "Checking hierarchical spawn policy",
          },
        ],
      },
      {
        matcher: "^(wait|Wait|list_agents|send_message|followup_task)$",
        hooks: [
          {
            type: "command",
            command: hookCommand("pre_coordinator_tools.py"),
            timeout: 10,
            statusMessage: "Blocking Terra coordinator babysitting",
          },
        ],
      },
      {
        matcher: "^wait_agent$",
        hooks: [
          {
            type: "command",
            command: hookCommand("pre_coordinator_tools.py"),
            timeout: 10,
            statusMessage: "Requiring a long Terra wait_agent",
          },
        ],
      },
    ],
    SubagentStart: [
      {
        matcher: "^(terra-coordinator|luna-producer|luna-verifier|sol-advisor)$",
        hooks: [
          {
            type: "command",
            command: hookCommand("subagent_start.py"),
            timeout: 10,
            statusMessage: "Injecting control-plane protocol",
          },
        ],
      },
    ],
    SubagentStop: [
      {
        matcher: "^(terra-coordinator|luna-producer|luna-verifier)$",
        hooks: [
          {
            type: "command",
            command: hookCommand("subagent_stop.py"),
            timeout: 10,
            statusMessage: "Checking durable task handoff",
          },
        ],
      },
    ],
  };
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

interface HooksFile {
  description?: string;
  hooks: {
    PreToolUse?: HookMatcher[];
    SubagentStart?: HookMatcher[];
    SubagentStop?: HookMatcher[];
  };
}

function hooksFile(description: string | undefined, hooks: HooksFile["hooks"]): HooksFile {
  if (description === undefined) {
    return { hooks };
  }
  return { description, hooks };
}

function emptyHooksFile(): HooksFile {
  return { description: "User Codex hooks", hooks: {} };
}

function removeOurHooks(file: HooksFile): HooksFile {
  const filter = (entries: HookMatcher[] | undefined): HookMatcher[] =>
    (entries ?? [])
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((hook) => !isManagedHookCommand(hook.command)),
      }))
      .filter((entry) => entry.hooks.length > 0);
  return hooksFile(file.description, {
    ...file.hooks,
    PreToolUse: filter(file.hooks.PreToolUse),
    SubagentStart: filter(file.hooks.SubagentStart),
    SubagentStop: filter(file.hooks.SubagentStop),
  });
}

function findTable(lines: string[], table: string): { start: number; end: number } | null {
  const header = `[${table}]`;
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]?.trim() !== header) {
      continue;
    }
    let end = start + 1;
    while (end < lines.length) {
      const trimmed = lines[end]?.trim() ?? "";
      if (trimmed === MANAGED_BEGIN || trimmed === LEGACY_MANAGED_BEGIN) {
        break;
      }
      if (trimmed.startsWith("[")) {
        break;
      }
      end += 1;
    }
    return { start, end };
  }
  return null;
}

function keyLinePattern(key: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
}

function splitLines(source: string): string[] {
  if (source.length === 0) {
    return [];
  }
  return source.split(/\r?\n/u);
}

function joinLines(lines: string[]): string {
  return lines.join("\n").replace(/\n+$/u, "\n");
}

function trimEndEmpty(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1] === "") {
    next.pop();
  }
  return next;
}

function stripManagedBlock(source: string, begin: string, end: string): string {
  const pattern = new RegExp(`\\n?${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
  return source
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function stripManagedBlocks(source: string): string {
  return stripManagedBlock(
    stripManagedBlock(source, MANAGED_BEGIN, MANAGED_END),
    LEGACY_MANAGED_BEGIN,
    LEGACY_MANAGED_END,
  );
}

function stripManagedAgentBlocks(source: string): string {
  return stripManagedBlock(
    stripManagedBlock(source, AGENTS_BEGIN, AGENTS_END),
    LEGACY_AGENTS_BEGIN,
    LEGACY_AGENTS_END,
  );
}

function hasManagedBlock(source: string): boolean {
  return source.includes(MANAGED_BEGIN) || source.includes(LEGACY_MANAGED_BEGIN);
}

function managedSection(source: string): string {
  const legacy = source.indexOf(MANAGED_BEGIN) === -1;
  const begin = legacy ? LEGACY_MANAGED_BEGIN : MANAGED_BEGIN;
  const endMarker = legacy ? LEGACY_MANAGED_END : MANAGED_END;
  const start = source.indexOf(begin);
  const end = source.indexOf(endMarker, start + begin.length);
  if (start === -1 || end === -1 || end < start) {
    return "";
  }
  return source.slice(start, end + endMarker.length);
}

function readManifest(path: string): InstallManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as InstallManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function assertTomlText(source: string, label: string): void {
  const directory = mkdtempSync(join(tmpdir(), "codex-mission-ledger-toml-"));
  const path = join(directory, "config.toml");
  try {
    writeFileSync(path, source.length === 0 ? "\n" : source);
    parseTomlFile(path);
  } catch (error) {
    throw new Error(
      `Refusing to write invalid TOML for ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function leftoverSkillBackups(skillsDirectory: string): string[] {
  if (!existsSync(skillsDirectory)) {
    return [];
  }
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.includes(".bak-codex-mission-ledger-") ||
          entry.name.includes(".bak-hierarchical-codex-")),
    )
    .map((entry) => join(skillsDirectory, entry.name));
}

function backupIfExists(path: string, layout: UserInstallLayout): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const backupsDirectory = join(layout.manifestDirectory, "backups");
  mkdirPrivate(backupsDirectory);
  let backup = join(backupsDirectory, `${basename(path)}.bak-codex-mission-ledger-${stamp()}`);
  let suffix = 1;
  while (existsSync(backup)) {
    backup = join(
      backupsDirectory,
      `${basename(path)}.bak-codex-mission-ledger-${stamp()}-${suffix}`,
    );
    suffix += 1;
  }
  cpSync(path, backup, { recursive: true });
  return backup;
}

function atomicWrite(path: string, contents: string): void {
  mkdirPrivate(dirname(path));
  const directory = mkdtempSync(join(tmpdir(), "codex-mission-ledger-write-"));
  const temporary = join(directory, "file");
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    copyFileSync(temporary, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}
