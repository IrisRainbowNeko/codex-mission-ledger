#!/usr/bin/env node

import {
  defaultUserInstallPaths,
  installUserScope,
  packageRootFromModule,
  uninstallUserScope,
  verifyUserInstall,
} from "./user-install.js";

const packageRoot = packageRootFromModule(import.meta.url);
const paths = defaultUserInstallPaths(packageRoot);
const uninstall = process.argv.includes("--uninstall");
const force = process.argv.includes("--force");

if (uninstall) {
  const layout = uninstallUserScope(paths);
  process.stdout.write(`Removed Mission Ledger for Codex managed files from ${layout.codexHome}\n`);
  process.stdout.write(`Feature flags and ${layout.stateDirectory} state were kept.\n`);
} else {
  const result = installUserScope(paths, { force });
  process.stdout.write(
    "Installed Mission Ledger for Codex for Codex CLI and the VS Code extension.\n",
  );
  process.stdout.write(`MCP entrypoint: ${result.layout.mcpEntrypoint}\n`);
  process.stdout.write(`Skill: ${result.layout.skillAgents}\n`);
  process.stdout.write(`State: ${result.layout.stateDirectory}\n`);
  if (result.backedUpConfig !== null) {
    process.stdout.write(`Config backup: ${result.backedUpConfig}\n`);
  }
  for (const backup of result.backedUpConflicts) {
    process.stdout.write(`Conflict backup: ${backup}\n`);
  }
}

if (!uninstall) {
  const report = verifyUserInstall(paths);
  for (const warning of report.warnings) {
    process.stdout.write(`WARN  ${warning}\n`);
  }
  if (report.problems.length > 0) {
    for (const problem of report.problems) {
      process.stderr.write(`VERIFY FAIL  ${problem}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write("Verification passed for files and TOML.\n");
    process.stdout.write("Restart VS Code, start a new Codex chat, run /hooks and trust the\n");
    process.stdout.write(
      "Mission Ledger for Codex commands, then /mcp and $agent-trio <mission>.\n",
    );
  }
}
