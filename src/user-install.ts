import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userHome } from "./platform.js";

export const AGENTS_BEGIN = "<!-- agent-trio-v3 -->";
export const AGENTS_END = "<!-- /agent-trio-v3 -->";
export const LEGACY_AGENTS_BLOCKS = [
  ["<!-- agent-trio-v2 -->", "<!-- /agent-trio-v2 -->"],
  ["<!-- codex-mission-ledger -->", "<!-- /codex-mission-ledger -->"],
  ["<!-- hierarchical-codex -->", "<!-- /hierarchical-codex -->"],
] as const;

/** V3 uses explicit App Server model routing and installs no native agent profiles. */
export const PROFILE_FILES = [] as const;

const LEGACY_PROFILE_FILES = [
  "luna-worker.toml",
  "terra-worker.toml",
  "sol-specialist.toml",
  "luna-producer.toml",
  "luna-verifier.toml",
  "terra-coordinator.toml",
  "sol-advisor.toml",
] as const;
const MANIFEST_NAME = "install-manifest.json";
const LEGACY_TEXT = ["codex-mission-ledger", "hierarchical-codex"] as const;

export interface UserInstallPaths {
  packageRoot: string;
  homeDirectory: string;
  codexHome: string;
}

export interface UserInstallLayout {
  codexHome: string;
  agentsHome: string;
  skillDirectory: string;
  sessionSkillDirectory: string;
  qualitySkillDirectory: string;
  qualitySessionSkillDirectory: string;
  legacySkillDirectories: string[];
  profileDirectory: string;
  configToml: string;
  hooksJson: string;
  userAgentsMd: string;
  installDirectory: string;
  manifestPath: string;
  backupDirectory: string;
  legacyHookDirectories: string[];
  legacyManifestPaths: string[];
}

export interface UserInstallOptions {
  force?: boolean;
  /** Retained for source compatibility; V3 never changes the root model. */
  preserveRoot?: boolean;
  nodePath?: string;
  jobRoot?: string;
  priceTable?: string;
  packageRoot?: string;
  codexHome?: string;
}

export interface UserInstallResult {
  layout: UserInstallLayout;
  written: string[];
  removedLegacy: string[];
  backups: string[];
}

export interface UserVerifyReport {
  problems: string[];
  warnings: string[];
}

interface InstallManifest {
  version: 3;
  packageRoot: string;
  files: string[];
  mcpExecutable: string;
}

interface TomlBlock {
  header: string | null;
  lines: string[];
  insideLegacyMarker: boolean;
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
  };
}

export function resolveUserLayout(paths: UserInstallPaths): UserInstallLayout {
  const installDirectory = join(paths.codexHome, "agent-trio");
  return {
    codexHome: paths.codexHome,
    agentsHome: join(paths.homeDirectory, ".agents"),
    skillDirectory: join(paths.homeDirectory, ".agents", "skills", "agent-trio"),
    sessionSkillDirectory: join(paths.homeDirectory, ".agents", "skills", "agent-trio-session"),
    qualitySkillDirectory: join(paths.homeDirectory, ".agents", "skills", "agent-trio-quality"),
    qualitySessionSkillDirectory: join(
      paths.homeDirectory,
      ".agents",
      "skills",
      "agent-trio-quality-session",
    ),
    legacySkillDirectories: [
      join(paths.codexHome, "skills", "agent-trio"),
      join(paths.codexHome, "skills", "sol-terra-luna"),
      join(paths.homeDirectory, ".agents", "skills", "sol-terra-luna"),
    ],
    profileDirectory: join(paths.codexHome, "agents"),
    configToml: join(paths.codexHome, "config.toml"),
    hooksJson: join(paths.codexHome, "hooks.json"),
    userAgentsMd: join(paths.codexHome, "AGENTS.md"),
    installDirectory,
    manifestPath: join(installDirectory, MANIFEST_NAME),
    backupDirectory: join(installDirectory, "backups"),
    legacyHookDirectories: [
      join(paths.codexHome, "hooks", "codex-mission-ledger"),
      join(paths.codexHome, "hooks", "hierarchical-codex"),
    ],
    legacyManifestPaths: [
      join(paths.codexHome, "codex-mission-ledger", MANIFEST_NAME),
      join(paths.codexHome, "hierarchical-codex", MANIFEST_NAME),
    ],
  };
}

export function installUserScope(
  paths: UserInstallPaths,
  options: UserInstallOptions = {},
): UserInstallResult {
  const layout = resolveUserLayout(paths);
  assertInstallable(paths);
  mkdirPrivate(layout.installDirectory);
  const previousManifest = readManifest(layout.manifestPath);

  const backups: string[] = [];

  const existingConfig = readOptional(layout.configToml);
  const nextConfig = mergeUserConfig(existingConfig, {
    ...options,
    packageRoot: paths.packageRoot,
    codexHome: paths.codexHome,
    jobRoot: options.jobRoot ?? join(layout.installDirectory, "jobs"),
  });
  if (nextConfig !== existingConfig) {
    if (existingConfig.length > 0) {
      backups.push(backupPath(layout.configToml, layout.backupDirectory));
    }
    atomicWrite(layout.configToml, nextConfig);
  }

  const existingHooks = readOptional(layout.hooksJson);
  if (existingHooks.length > 0) {
    const nextHooks = cleanupLegacyHooksJson(existingHooks);
    if (nextHooks !== existingHooks) {
      backups.push(backupPath(layout.hooksJson, layout.backupDirectory));
      atomicWrite(layout.hooksJson, nextHooks);
    }
  }

  const existingAgents = readOptional(layout.userAgentsMd);
  const nextAgents = stripAgentBlocks(existingAgents);
  if (nextAgents !== existingAgents) {
    if (existingAgents.length > 0) {
      backups.push(backupPath(layout.userAgentsMd, layout.backupDirectory));
    }
    atomicWrite(layout.userAgentsMd, nextAgents);
  }

  const removedLegacy = migrateLegacyFiles(layout, backups);
  replaceUserSkill(
    sourceSkillDirectory(paths.packageRoot, "agent-trio"),
    layout.skillDirectory,
    previousManifest?.files.includes(layout.skillDirectory) ?? false,
    layout.backupDirectory,
    backups,
    removedLegacy,
  );
  replaceUserSkill(
    sourceSkillDirectory(paths.packageRoot, "agent-trio-session"),
    layout.sessionSkillDirectory,
    previousManifest?.files.includes(layout.sessionSkillDirectory) ?? false,
    layout.backupDirectory,
    backups,
    removedLegacy,
  );
  replaceUserSkill(
    sourceSkillDirectory(paths.packageRoot, "agent-trio-quality"),
    layout.qualitySkillDirectory,
    previousManifest?.files.includes(layout.qualitySkillDirectory) ?? false,
    layout.backupDirectory,
    backups,
    removedLegacy,
  );
  replaceUserSkill(
    sourceSkillDirectory(paths.packageRoot, "agent-trio-quality-session"),
    layout.qualitySessionSkillDirectory,
    previousManifest?.files.includes(layout.qualitySessionSkillDirectory) ?? false,
    layout.backupDirectory,
    backups,
    removedLegacy,
  );
  const manifest: InstallManifest = {
    version: 3,
    packageRoot: paths.packageRoot,
    files: [
      layout.skillDirectory,
      layout.sessionSkillDirectory,
      layout.qualitySkillDirectory,
      layout.qualitySessionSkillDirectory,
    ],
    mcpExecutable: mcpLauncher(paths.packageRoot),
  };
  atomicWrite(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    layout,
    written: [
      layout.configToml,
      layout.skillDirectory,
      layout.sessionSkillDirectory,
      layout.qualitySkillDirectory,
      layout.qualitySessionSkillDirectory,
      layout.userAgentsMd,
      layout.manifestPath,
    ],
    removedLegacy,
    backups,
  };
}

export function uninstallUserScope(paths: UserInstallPaths): UserInstallLayout {
  const layout = resolveUserLayout(paths);
  const manifest = readManifest(layout.manifestPath);
  for (const path of manifest?.files ?? []) {
    rmSync(path, { recursive: true, force: true });
  }
  if (existsSync(layout.configToml)) {
    atomicWrite(layout.configToml, removeAgentTrioMcp(readFileSync(layout.configToml, "utf8")));
  }
  if (existsSync(layout.userAgentsMd)) {
    atomicWrite(layout.userAgentsMd, stripAgentBlocks(readFileSync(layout.userAgentsMd, "utf8")));
  }
  rmSync(layout.manifestPath, { force: true });
  return layout;
}

export function verifyUserInstall(paths: UserInstallPaths): UserVerifyReport {
  const layout = resolveUserLayout(paths);
  const problems: string[] = [];
  const warnings: string[] = [];
  const skillMd = join(layout.skillDirectory, "SKILL.md");
  const skillMetadata = join(layout.skillDirectory, "agents", "openai.yaml");
  const sessionSkillMd = join(layout.sessionSkillDirectory, "SKILL.md");
  const sessionSkillMetadata = join(layout.sessionSkillDirectory, "agents", "openai.yaml");
  const qualitySkillMd = join(layout.qualitySkillDirectory, "SKILL.md");
  const qualitySkillMetadata = join(layout.qualitySkillDirectory, "agents", "openai.yaml");
  const qualitySessionSkillMd = join(layout.qualitySessionSkillDirectory, "SKILL.md");
  const qualitySessionSkillMetadata = join(
    layout.qualitySessionSkillDirectory,
    "agents",
    "openai.yaml",
  );
  const required = [
    layout.configToml,
    layout.manifestPath,
    skillMd,
    skillMetadata,
    sessionSkillMd,
    sessionSkillMetadata,
    qualitySkillMd,
    qualitySkillMetadata,
    qualitySessionSkillMd,
    qualitySessionSkillMetadata,
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      problems.push(`missing ${path}`);
    }
  }

  const config = readOptional(layout.configToml);
  if (containsLegacyRuntime(config)) {
    problems.push("config.toml still contains the legacy MCP or hook runtime");
  }
  if (countTomlTable(config, "mcp_servers.agent_trio") !== 1) {
    problems.push("config.toml must contain exactly one mcp_servers.agent_trio table");
  }
  if (!config.includes(JSON.stringify(mcpLauncher(paths.packageRoot)))) {
    problems.push("mcp_servers.agent_trio does not point to this V3 package");
  }
  if (!config.includes(JSON.stringify(paths.codexHome))) {
    problems.push("mcp_servers.agent_trio does not load this Codex home environment");
  }
  if (!/default_tools_approval_mode\s*=\s*"approve"/u.test(config)) {
    problems.push("mcp_servers.agent_trio must auto-approve its trusted local tool");
  }

  const manifest = readManifest(layout.manifestPath);
  if (!manifest?.files.includes(layout.skillDirectory)) {
    problems.push("install manifest does not own the Agent Trio skill");
  }
  if (!manifest?.files.includes(layout.sessionSkillDirectory)) {
    problems.push("install manifest does not own the Agent Trio Session skill");
  }
  if (!manifest?.files.includes(layout.qualitySkillDirectory)) {
    problems.push("install manifest does not own the Agent Trio Quality skill");
  }
  if (!manifest?.files.includes(layout.qualitySessionSkillDirectory)) {
    problems.push("install manifest does not own the Agent Trio Quality Session skill");
  }
  const skillText = readOptional(skillMd);
  if (
    !/^name:\s*agent-trio\s*$/mu.test(skillText) ||
    !skillText.includes("`agent_trio` MCP") ||
    !skillText.includes("`monitorFirst=true`") ||
    !/exactly one\s+`action=status`\s+call/mu.test(skillText) ||
    !hasSafeMcpInvocationContract(skillText) ||
    !/MCP\s+Apps monitor/mu.test(skillText)
  ) {
    problems.push("installed agent-trio skill does not implement embedded Monitor delegation");
  }
  const metadataText = readOptional(skillMetadata);
  if (!/^\s*allow_implicit_invocation:\s*false\s*$/mu.test(metadataText)) {
    problems.push("installed agent-trio skill must be explicit-only");
  }
  if (!/^\s*value:\s*"agent_trio"\s*$/mu.test(metadataText)) {
    problems.push("installed agent-trio skill must declare the agent_trio MCP dependency");
  }
  const sessionSkillText = readOptional(sessionSkillMd);
  if (
    !/^name:\s*agent-trio-session\s*$/mu.test(sessionSkillText) ||
    !sessionSkillText.includes("`agent_trio` MCP") ||
    !sessionSkillText.includes("`monitorFirst=true`") ||
    !/exactly one\s+`action=status`\s+call/mu.test(sessionSkillText) ||
    !hasSafeMcpInvocationContract(sessionSkillText) ||
    !/MCP\s+Apps monitor/mu.test(sessionSkillText) ||
    !sessionSkillText.includes("previously invoked $agent-trio-session")
  ) {
    problems.push(
      "installed agent-trio-session skill does not implement bounded conversation continuation",
    );
  }
  const sessionMetadataText = readOptional(sessionSkillMetadata);
  if (!/^\s*allow_implicit_invocation:\s*true\s*$/mu.test(sessionMetadataText)) {
    problems.push("installed agent-trio-session skill must allow related follow-up invocation");
  }
  if (!/^\s*value:\s*"agent_trio"\s*$/mu.test(sessionMetadataText)) {
    problems.push("installed agent-trio-session skill must declare the agent_trio MCP dependency");
  }
  verifyProfileSkill(
    problems,
    readOptional(qualitySkillMd),
    readOptional(qualitySkillMetadata),
    "agent-trio-quality",
    false,
  );
  verifyProfileSkill(
    problems,
    readOptional(qualitySessionSkillMd),
    readOptional(qualitySessionSkillMetadata),
    "agent-trio-quality-session",
    true,
  );

  const agentsText = readOptional(layout.userAgentsMd);
  if (containsAgentInstructions(agentsText)) {
    problems.push("AGENTS.md still contains Agent Trio orchestration instructions");
  }
  const hooksText = readOptional(layout.hooksJson);
  if (hasLegacyText(hooksText)) {
    problems.push("hooks.json still contains a legacy Agent Trio command");
  }
  for (const path of [...layout.legacySkillDirectories, ...layout.legacyHookDirectories]) {
    if (existsSync(path)) {
      problems.push(`legacy integration remains at ${path}`);
    }
  }
  for (const name of LEGACY_PROFILE_FILES) {
    const path = join(layout.profileDirectory, name);
    if (existsSync(path)) {
      problems.push(`legacy profile remains at ${path}`);
    }
  }

  if (!config.includes("AGENT_TRIO_PRICE_TABLE")) {
    warnings.push(
      "No MCP price-table path is configured; custom providers must expose server USD usage or set AGENT_TRIO_PRICE_TABLE.",
    );
  }
  return { problems, warnings };
}

function verifyProfileSkill(
  problems: string[],
  skillText: string,
  metadataText: string,
  name: "agent-trio-quality" | "agent-trio-quality-session",
  implicit: boolean,
): void {
  if (
    !new RegExp(`^name:\\s*${name}\\s*$`, "mu").test(skillText) ||
    !skillText.includes("`profile=quality`") ||
    !skillText.includes("`monitorFirst=true`") ||
    !hasSafeMcpInvocationContract(skillText) ||
    !/MCP\s+Apps monitor/mu.test(skillText)
  ) {
    problems.push(`installed ${name} skill does not implement quality-profile delegation`);
  }
  if (
    !new RegExp(`^\\s*allow_implicit_invocation:\\s*${String(implicit)}\\s*$`, "mu").test(
      metadataText,
    )
  ) {
    problems.push(`installed ${name} skill has the wrong implicit invocation policy`);
  }
  if (!/^\s*value:\s*"agent_trio"\s*$/mu.test(metadataText)) {
    problems.push(`installed ${name} skill must declare the agent_trio MCP dependency`);
  }
}

function hasSafeMcpInvocationContract(skillText: string): boolean {
  return (
    skillText.includes("flat top-level fields") &&
    skillText.includes("Never wrap the whole argument object") &&
    skillText.includes("Only if submit succeeds") &&
    skillText.includes("If submit returns an MCP/tool error") &&
    skillText.includes("do not call status") &&
    /valid only\s+inside `semanticPlan`/mu.test(skillText) &&
    /never send either as a top-level\s+tool argument/mu.test(skillText) &&
    /With `strategy=direct`, omit\s+`semanticPlan`/mu.test(skillText) &&
    skillText.includes("`directTier`") &&
    /exactly\s+`luna` or `terra`/mu.test(skillText) &&
    skillText.includes("danger-full-access") &&
    skillText.includes("`fullAccess`") &&
    skillText.includes("Do not send `mode` or `selectedCapabilities`") &&
    skillText.includes("call containing only that action")
  );
}

export function mergeUserConfig(source: string, options: UserInstallOptions = {}): string {
  const packageRoot = options.packageRoot ?? process.cwd();
  const jobRoot = options.jobRoot ?? join(packageRoot, ".agent-trio-jobs");
  const codexHome = options.codexHome ?? process.env["CODEX_HOME"] ?? join(userHome(), ".codex");
  const nodePath = options.nodePath ?? process.execPath;
  const next = cleanupLegacyConfig(source).trimEnd();
  const block = [
    "[mcp_servers.agent_trio]",
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(mcpLauncher(packageRoot))}, "--env-dir", ${JSON.stringify(codexHome)}]`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 86400",
    'default_tools_approval_mode = "approve"',
    "",
    "[mcp_servers.agent_trio.env]",
    `AGENT_TRIO_JOB_ROOT = ${JSON.stringify(jobRoot)}`,
    ...(options.priceTable === undefined
      ? []
      : [`AGENT_TRIO_PRICE_TABLE = ${JSON.stringify(options.priceTable)}`]),
  ].join("\n");
  return `${next.length === 0 ? block : `${next}\n\n${block}`}\n`;
}

export function cleanupLegacyConfig(source: string): string {
  const blocks = splitTomlBlocks(source);
  const remove = new Set<number>();

  for (const [index, block] of blocks.entries()) {
    const header = block.header ?? "";
    const body = block.lines.join("\n");
    if (
      /^\[mcp_servers\.(?:agent_trio|hierarchical_codex|codex_mission_ledger)(?:\.|\])/u.test(
        header,
      )
    ) {
      remove.add(index);
      continue;
    }
    if (header === "[[skills.config]]" && /(?:agent-trio|sol-terra-luna)/u.test(body)) {
      remove.add(index);
      continue;
    }
    if (header === "[hooks.state]" && block.insideLegacyMarker && body.trim() === "[hooks.state]") {
      remove.add(index);
      continue;
    }
    if (/^\[hooks\.state\./u.test(header) && block.insideLegacyMarker) {
      remove.add(index);
    }
  }

  for (const [index, block] of blocks.entries()) {
    const match = block.header?.match(/^\[\[hooks\.([A-Za-z]+)\]\]$/u);
    if (match === null || match === undefined) {
      continue;
    }
    let end = index + 1;
    while (end < blocks.length) {
      const header = blocks[end]?.header ?? "";
      if (header === `[[hooks.${match[1]}.hooks]]`) {
        end += 1;
        continue;
      }
      break;
    }
    const group = blocks
      .slice(index, end)
      .flatMap((item) => item.lines)
      .join("\n");
    if (hasLegacyText(group)) {
      for (let cursor = index; cursor < end; cursor += 1) {
        remove.add(cursor);
      }
    }
  }

  const retained = blocks
    .filter((_, index) => !remove.has(index))
    .flatMap((block) => block.lines)
    .filter((line) => !isLegacyMarkerOrComment(line));
  return normalizeBlankLines(retained.join("\n"));
}

function removeAgentTrioMcp(source: string): string {
  const retained = splitTomlBlocks(source)
    .filter((block) => !/^\[mcp_servers\.agent_trio(?:\.|\])/u.test(block.header ?? ""))
    .flatMap((block) => block.lines);
  return normalizeBlankLines(retained.join("\n"));
}

function countTomlTable(source: string, table: string): number {
  const header = `[${table}]`;
  return source.split(/\r?\n/u).filter((line) => line.trim() === header).length;
}

function mcpLauncher(packageRoot: string): string {
  return join(packageRoot, "dist", "mcp", "launcher.js");
}

function sourceSkillDirectory(
  packageRoot: string,
  name: "agent-trio" | "agent-trio-session" | "agent-trio-quality" | "agent-trio-quality-session",
): string {
  return join(packageRoot, "skills", name);
}

export function cleanupLegacyHooksJson(source: string): string {
  if (!hasLegacyText(source)) {
    return source;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return source;
  }
  const cleaned = scrubManagedCommands(parsed);
  return `${JSON.stringify(cleaned, null, 2)}\n`;
}

export function mergeUserAgentsMd(source: string, projectInstructions: string): string {
  void projectInstructions;
  return stripAgentBlocks(source);
}

export function stripAgentBlocks(source: string): string {
  let next = stripDelimitedBlock(source, AGENTS_BEGIN, AGENTS_END);
  for (const [begin, end] of LEGACY_AGENTS_BLOCKS) {
    next = stripDelimitedBlock(next, begin, end);
  }
  return `${next.trim()}${next.trim().length > 0 ? "\n" : ""}`;
}

export function countTomlKey(source: string, table: string, key: string): number {
  const lines = source.split(/\r?\n/u);
  const range = findTomlTable(lines, table);
  if (range === null) {
    return 0;
  }
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
  return lines.slice(range.start + 1, range.end).filter((line) => pattern.test(line)).length;
}

export function upsertTomlKey(source: string, table: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/u);
  const range = findTomlTable(lines, table);
  const assignment = `${key} = ${value}`;
  if (range === null) {
    const trimmed = trimTrailingEmpty(lines);
    if (trimmed.length > 0) {
      trimmed.push("");
    }
    trimmed.push(`[${table}]`, assignment);
    return trimmed.join("\n");
  }
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
  const matches: number[] = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (pattern.test(lines[index] ?? "")) {
      matches.push(index);
    }
  }
  if (matches.length === 0) {
    lines.splice(range.start + 1, 0, assignment);
    return lines.join("\n");
  }
  lines[matches[0] ?? 0] = assignment;
  for (const index of matches.slice(1).reverse()) {
    lines.splice(index, 1);
  }
  return lines.join("\n");
}

export function upsertTopLevelTomlKey(source: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/u);
  const firstTable = lines.findIndex((line) => /^\s*\[/u.test(line));
  const end = firstTable < 0 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
  const matches: number[] = [];
  for (let index = 0; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) {
      matches.push(index);
    }
  }
  const assignment = `${key} = ${value}`;
  if (matches.length === 0) {
    lines.splice(0, 0, assignment);
    return lines.join("\n");
  }
  lines[matches[0] ?? 0] = assignment;
  for (const index of matches.slice(1).reverse()) {
    lines.splice(index, 1);
  }
  return lines.join("\n");
}

function assertInstallable(paths: UserInstallPaths): void {
  const required = [
    join(paths.packageRoot, "package.json"),
    join(paths.packageRoot, "src", "mcp", "server.ts"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio"), "SKILL.md"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio"), "agents", "openai.yaml"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio-session"), "SKILL.md"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio-session"), "agents", "openai.yaml"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio-quality"), "SKILL.md"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio-quality"), "agents", "openai.yaml"),
    join(sourceSkillDirectory(paths.packageRoot, "agent-trio-quality-session"), "SKILL.md"),
    join(
      sourceSkillDirectory(paths.packageRoot, "agent-trio-quality-session"),
      "agents",
      "openai.yaml",
    ),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Install sources missing: ${missing.join(", ")}`);
  }
}

function migrateLegacyFiles(layout: UserInstallLayout, backups: string[]): string[] {
  const paths = [
    ...layout.legacySkillDirectories,
    ...layout.legacyHookDirectories,
    ...layout.legacyManifestPaths,
    ...LEGACY_PROFILE_FILES.map((name) => join(layout.profileDirectory, name)),
  ];
  const removed: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    backups.push(backupPath(path, layout.backupDirectory));
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

function replaceUserSkill(
  source: string,
  destination: string,
  previouslyManaged: boolean,
  backupDirectory: string,
  backups: string[],
  removedLegacy: string[],
): void {
  if (existsSync(destination)) {
    if (!previouslyManaged) {
      backups.push(backupPath(destination, backupDirectory));
      removedLegacy.push(destination);
    }
    rmSync(destination, { recursive: true, force: true });
  }
  mkdirPrivate(dirname(destination));
  cpSync(source, destination, { recursive: true });
}

function splitTomlBlocks(source: string): TomlBlock[] {
  const blocks: TomlBlock[] = [];
  let current: TomlBlock = { header: null, lines: [], insideLegacyMarker: false };
  let insideLegacyMarker = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*# >>> (?:codex-mission-ledger|hierarchical-codex)\s*$/u.test(line)) {
      insideLegacyMarker = true;
    }
    const header = line.trim().match(/^\[\[?.+?\]\]?$/u)?.[0] ?? null;
    if (header !== null) {
      if (current.lines.length > 0) {
        blocks.push(current);
      }
      current = { header, lines: [line], insideLegacyMarker };
    } else {
      current.lines.push(line);
      current.insideLegacyMarker ||= insideLegacyMarker;
    }
    if (/^\s*# <<< (?:codex-mission-ledger|hierarchical-codex)\s*$/u.test(line)) {
      insideLegacyMarker = false;
    }
  }
  if (current.lines.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

function findTomlTable(lines: string[], table: string): { start: number; end: number } | null {
  const header = `[${table}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?.+?\]\]?\s*$/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function stripDelimitedBlock(source: string, begin: string, end: string): string {
  let next = source;
  while (true) {
    const start = next.indexOf(begin);
    if (start < 0) {
      return next;
    }
    const finish = next.indexOf(end, start + begin.length);
    next =
      finish < 0 ? next.slice(0, start) : next.slice(0, start) + next.slice(finish + end.length);
  }
}

function scrubManagedCommands(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubManagedCommands(item)).filter((item) => item !== undefined);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["command"] === "string" && hasLegacyText(record["command"])) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, scrubManagedCommands(item)]),
  );
}

export function containsLegacyRuntime(source: string): boolean {
  return /mcp_servers\.(?:hierarchical_codex|codex_mission_ledger)|(?:codex-mission-ledger|hierarchical-codex)\/(?:pre_|subagent_|run_hook)|task_claim|MISSION_ROUTE/u.test(
    source,
  );
}

function containsAgentInstructions(source: string): boolean {
  return /(?:agent-trio-v[123]|\$agent-trio|agent_trio|task_claim|MISSION_ROUTE|codex-mission-ledger)/u.test(
    source,
  );
}

function hasLegacyText(source: string): boolean {
  return LEGACY_TEXT.some((text) => source.includes(text));
}

function isLegacyMarkerOrComment(line: string): boolean {
  return (
    /^\s*# (?:>>>|<<<) (?:codex-mission-ledger|hierarchical-codex)\s*$/u.test(line) ||
    /^\s*# (?:User-global Mission Ledger|Hook scripts live|Ledger lives outside|approval_mode approve)/u.test(
      line,
    )
  );
}

function normalizeBlankLines(source: string): string {
  return `${source.trim().replace(/\n{3,}/gu, "\n\n")}\n`;
}

function readManifest(path: string): { files: string[] } | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { files?: unknown };
    return Array.isArray(parsed.files) && parsed.files.every((item) => typeof item === "string")
      ? { files: parsed.files }
      : null;
  } catch {
    return null;
  }
}

function backupPath(path: string, backupDirectory: string): string {
  mkdirPrivate(backupDirectory);
  const safeName = path.replace(/^[/\\]+/u, "").replaceAll(/[\\/:]/gu, "_");
  let target = join(backupDirectory, `${Date.now()}-${safeName}`);
  let suffix = 0;
  while (existsSync(target)) {
    suffix += 1;
    target = join(backupDirectory, `${Date.now()}-${suffix}-${safeName}`);
  }
  cpSync(path, target, { recursive: true });
  return target;
}

function atomicWrite(path: string, content: string): void {
  mkdirPrivate(dirname(path));
  const temporary = `${path}.tmp-agent-trio-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function trimTrailingEmpty(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.at(-1)?.trim() === "") {
    copy.pop();
  }
  return copy;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
