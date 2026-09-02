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
const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const jobRoot = valueAfter("--job-root");
const priceTable = valueAfter("--price-table");

if (process.argv.includes("--uninstall")) {
  const layout = uninstallUserScope(paths);
  process.stdout.write(
    `Removed the Agent Trio V3 MCP registration and both user skills from ${layout.codexHome}.\n`,
  );
  process.stdout.write("Unrelated Codex settings and migration backups were preserved.\n");
} else {
  const result = installUserScope(paths, {
    force: process.argv.includes("--force"),
    ...(jobRoot === undefined ? {} : { jobRoot }),
    ...(priceTable === undefined ? {} : { priceTable }),
  });
  process.stdout.write(
    "Registered the Agent Trio V3 MCP tool with $agent-trio and $agent-trio-session skills.\n",
  );
  process.stdout.write(
    "Root model, native agent profiles, hooks, and AGENTS.md were not changed.\n",
  );
  if (result.removedLegacy.length > 0) {
    process.stdout.write(
      `Removed ${result.removedLegacy.length} legacy runtime paths after backup.\n`,
    );
  }
  for (const backup of result.backups) {
    process.stdout.write(`Backup: ${backup}\n`);
  }

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
    process.stdout.write("Verification passed. Restart Codex before using Agent Trio V3.\n");
  }
}
