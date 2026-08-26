#!/usr/bin/env node

import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadConfig } from "./config.js";
import { ControlPlane } from "./control-plane.js";
import { ControlPlaneDatabase } from "./infra/database.js";
import { ArtifactStore } from "./infra/artifact-store.js";
import { Repository } from "./infra/repository.js";
import { createMcpServer } from "./mcp/server.js";
import { mkdirPrivate } from "./platform.js";
import { formatPythonInvocation, resolvePythonInvocation, spawnPython } from "./python.js";
import {
  defaultUserInstallPaths,
  packageRootFromModule,
  parseTomlFile,
  resolveUserLayout,
  verifyUserInstall,
} from "./user-install.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const root = process.cwd();
const userMode = process.argv.includes("--user");
const jsonOutput = process.argv.includes("--json");
const config = loadConfig();
const checks: Check[] = [];
const userWarnings: string[] = [];

function check(name: string, operation: () => string): void {
  try {
    checks.push({ name, ok: true, detail: operation() });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

check("Node runtime", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error(`Node >=22.5 is required; found ${process.versions.node}.`);
  }
  return process.versions.node;
});

check("Project layout", () => {
  const required = [
    "AGENTS.md",
    ".agents/skills/agent-trio/SKILL.md",
    ".codex/skills/agent-trio/SKILL.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/hooks/pre_coordinator_tools.py",
    ".codex/hooks/run_hook.mjs",
    ".codex/agents/terra-coordinator.toml",
    ".codex/agents/luna-producer.toml",
    ".codex/agents/luna-verifier.toml",
    ".codex/agents/sol-advisor.toml",
  ];
  const missing = required.filter((path) => !existsSync(resolve(root, path)));
  if (missing.length > 0) {
    throw new Error(`Missing: ${missing.join(", ")}`);
  }
  return `${required.length} required integration files present`;
});

check("Built MCP entrypoint", () => {
  const entrypoint = resolve(root, "dist/cli.js");
  if (!existsSync(entrypoint)) {
    throw new Error("dist/cli.js is missing; run npm run build.");
  }
  return entrypoint;
});

check("MCP project configuration", () => {
  const source = readFileSync(resolve(root, ".codex/config.toml"), "utf8");
  for (const requiredText of [
    "[mcp_servers.hierarchical_codex]",
    'args = ["dist/cli.js"]',
    "required = true",
    'default_tools_approval_mode = "approve"',
  ]) {
    if (!source.includes(requiredText)) {
      throw new Error(`Missing expected config fragment: ${requiredText}`);
    }
  }
  return "Mission Ledger for Codex stdio server is required";
});

check("Python hook runtime", () => {
  const python = resolvePythonInvocation();
  const result = spawnPython(["--version"], { encoding: "utf8" }, python);
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.error?.message || "Python is unavailable."));
  }
  return `${formatPythonInvocation(python)} ${(result.stdout || result.stderr).toString().trim()}`;
});

if (userMode) {
  const paths = defaultUserInstallPaths(packageRootFromModule(import.meta.url));
  const layout = resolveUserLayout(paths);
  const report = verifyUserInstall(paths);

  check("User config TOML", () => {
    if (!existsSync(layout.configToml)) {
      throw new Error(`${layout.configToml} is missing; run npm run install:user.`);
    }
    parseTomlFile(layout.configToml);
    return layout.configToml;
  });

  check("User-global Mission Ledger for Codex", () => {
    if (report.problems.length > 0) {
      throw new Error(report.problems.join("; "));
    }
    return `${layout.codexHome} and ${layout.skillAgents}`;
  });

  check("User agent profiles", () => {
    const profiles = [
      "terra-coordinator.toml",
      "luna-producer.toml",
      "luna-verifier.toml",
      "sol-advisor.toml",
    ].map((name) => join(layout.agentDirectory, name));
    for (const path of profiles) {
      if (!existsSync(path)) {
        throw new Error(`Missing profile ${path}`);
      }
      parseTomlFile(path);
    }
    return `${profiles.length} user agent profiles parsed`;
  });

  check("User control-plane state directory", () => {
    mkdirPrivate(layout.stateDirectory);
    accessSync(layout.stateDirectory, constants.R_OK | constants.W_OK);
    return layout.stateDirectory;
  });

  check("User MCP server constructs", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-mission-ledger-doctor-mcp-"));
    const database = new ControlPlaneDatabase(":memory:");
    try {
      createMcpServer(
        new ControlPlane(new Repository(database), new ArtifactStore(directory, 1024), {
          defaultLeaseSeconds: 60,
          maxLeaseSeconds: 120,
          eventPageSize: 10,
        }),
      );
      return "createMcpServer() succeeded";
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  userWarnings.push(...report.warnings);
}

check("Codex TOML syntax", () => {
  const files = [
    ".codex/config.toml",
    ".codex/agents/terra-coordinator.toml",
    ".codex/agents/luna-producer.toml",
    ".codex/agents/luna-verifier.toml",
    ".codex/agents/sol-advisor.toml",
  ].map((path) => resolve(root, path));
  const source = [
    "import sys, tomllib",
    "for path in sys.argv[1:]:",
    "    with open(path, 'rb') as stream:",
    "        tomllib.load(stream)",
  ].join("\n");
  const result = spawnPython(["-c", source, ...files], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || "Failed to parse Codex TOML."));
  }
  return `${files.length} TOML files parsed`;
});

check("Codex hooks JSON", () => {
  const path = resolve(root, ".codex/hooks.json");
  void JSON.parse(readFileSync(path, "utf8"));
  return path;
});

check("SQLite runtime", () => {
  const database = new ControlPlaneDatabase(":memory:");
  database.close();
  return "node:sqlite available and schema migration succeeded";
});

check("Control-plane storage", () => {
  mkdirPrivate(config.homeDirectory);
  accessSync(config.homeDirectory, constants.R_OK | constants.W_OK);
  return config.homeDirectory;
});

const ok = checks.every((item) => item.ok);
if (jsonOutput) {
  process.stdout.write(`${JSON.stringify({ ok, checks, warnings: userWarnings })}\n`);
} else {
  for (const item of checks) {
    process.stdout.write(`${item.ok ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}\n`);
  }
  for (const warning of userWarnings) {
    process.stdout.write(`WARN  ${warning}\n`);
  }
}

if (!ok) {
  process.exitCode = 1;
}
