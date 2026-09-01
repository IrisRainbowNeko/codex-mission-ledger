#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_CODEX_CLI_VERSION, verifyCodexCliVersion } from "./app-server/index.js";
import { DEFAULT_OPENAI_PRICE_TABLE_PATH, loadPriceTable } from "./runtime.js";
import { resolvePlannerTransport } from "./planner-transport-config.js";
import {
  defaultUserInstallPaths,
  packageRootFromModule,
  verifyUserInstall,
} from "./user-install.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  warnings: string[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  verifyVersion?: typeof verifyCodexCliVersion;
}

export async function runDoctor(
  argv: readonly string[] = process.argv.slice(2),
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const packageRoot = packageRootFromModule(import.meta.url);
  const env = options.env ?? process.env;
  const checks: Check[] = [];
  const warnings: string[] = [];

  check(checks, "Node runtime", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < 20) {
      throw new Error(`Node >=20 is required; found ${process.versions.node}`);
    }
    return process.versions.node;
  });

  check(checks, "V3 project layout", () => {
    const required = [
      "src/runtime.ts",
      "src/supervisor.ts",
      "src/mcp/protocol.ts",
      "src/mcp/server.ts",
      "src/app-server/client.ts",
      "src/core/scheduler.ts",
      "dist/mcp/server.js",
    ];
    const missing = required.filter((path) => !existsSync(join(packageRoot, path)));
    if (missing.length > 0) {
      throw new Error(`missing ${missing.join(", ")}; run npm run build`);
    }
    return `${required.length} runtime files present`;
  });

  check(checks, "No recursive project integration", () => {
    const forbidden = [
      ".agents/skills/agent-trio/SKILL.md",
      ".codex/skills/agent-trio/SKILL.md",
      "profiles/luna-worker.toml",
      "profiles/terra-worker.toml",
      "profiles/sol-specialist.toml",
    ];
    const present = forbidden.filter((path) => existsSync(join(packageRoot, path)));
    if (present.length > 0) {
      throw new Error(`recursive V2 integration remains: ${present.join(", ")}`);
    }
    const agents = existsSync(join(packageRoot, "AGENTS.md"))
      ? readFileSync(join(packageRoot, "AGENTS.md"), "utf8")
      : "";
    if (/\$agent-trio|agent_trio|MISSION_ROUTE|task_claim/u.test(agents)) {
      throw new Error("project AGENTS.md still injects Agent Trio orchestration");
    }
    return "no project skill, profile, or AGENTS trigger";
  });

  if (!argv.includes("--project-only")) {
    try {
      const codexPath = env["AGENT_TRIO_CODEX_PATH"];
      const version = await (options.verifyVersion ?? verifyCodexCliVersion)({
        ...(codexPath === undefined || codexPath.trim().length === 0 ? {} : { codexPath }),
        env,
      });
      checks.push({
        name: "Codex App Server schema version",
        ok: true,
        detail: `codex-cli ${version}`,
      });
    } catch (error) {
      checks.push({
        name: "Codex App Server schema version",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const configuredPriceTable = env["AGENT_TRIO_PRICE_TABLE"];
  const priceTablePath = configuredPriceTable ?? DEFAULT_OPENAI_PRICE_TABLE_PATH;
  check(checks, "Planner transport", () => {
    const serviceTier = env["AGENT_TRIO_SERVICE_TIER"];
    const transport = resolvePlannerTransport({
      env,
      ...(serviceTier === undefined ? {} : { serviceTier }),
    });
    if (transport.kind === "app-server") {
      return `Codex App Server (${transport.source})`;
    }
    const origin = new URL(transport.baseUrl).origin;
    return `tool-free Responses API (${origin}; ${transport.source})`;
  });
  check(checks, "Model prices", () => {
    const prices = loadPriceTable(priceTablePath);
    const count = prices === undefined ? 0 : Object.keys(prices).length;
    if (count === 0) {
      throw new Error("the selected price table contains no models");
    }
    return `${String(count)} priced models (${configuredPriceTable === undefined ? "bundled default" : "configured override"})`;
  });

  if (argv.includes("--user")) {
    const report = verifyUserInstall(defaultUserInstallPaths(packageRoot));
    checks.push({
      name: "User V3 MCP installation",
      ok: report.problems.length === 0,
      detail:
        report.problems.length === 0
          ? "one agent_trio MCP registration, no recursive skill/profile instructions"
          : report.problems.join("; "),
    });
    warnings.push(...report.warnings);
  }

  const report = { ok: checks.every((item) => item.ok), checks, warnings };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const item of checks) {
      process.stdout.write(`${item.ok ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}\n`);
    }
    for (const warning of warnings) {
      process.stdout.write(`WARN  ${warning}\n`);
    }
  }
  return report;
}

function check(checks: Check[], name: string, operation: () => string): void {
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

if (isEntrypoint()) {
  void runDoctor().then((report) => {
    if (!report.ok) {
      process.exitCode = 1;
    }
  });
}

export { REQUIRED_CODEX_CLI_VERSION };

function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
