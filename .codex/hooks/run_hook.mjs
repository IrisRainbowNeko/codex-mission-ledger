#!/usr/bin/env node
/**
 * Cross-platform Codex hook launcher. Keep Python candidates in sync with src/python.ts.
 */
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptArg = process.argv[2];
if (scriptArg === undefined || scriptArg.length === 0) {
  process.stderr.write("usage: run_hook.mjs <script.py> [args...]\n");
  process.exit(2);
}

const script = isAbsolute(scriptArg) ? scriptArg : join(here, scriptArg);
const extra = process.argv.slice(3);
const env = process.env;
const platform = process.platform;
const versionPattern = /^Python 3\.\d+/;
const candidates = [];
const seen = new Set();

function push(executable, prefixArgs = []) {
  const key = [executable, ...prefixArgs].join(" ");
  if (executable.length === 0 || seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push({ executable, prefixArgs });
}

const explicit = env.CODEX_MISSION_LEDGER_PYTHON || env.PYTHON;
if (explicit && explicit.trim().length > 0) {
  const parts = explicit.trim().split(/\s+/u);
  push(parts[0], parts.slice(1));
}
push("python3");
if (platform === "win32") {
  push("py", ["-3"]);
  push("py");
}
push("python");

let chosen = null;
const errors = [];
for (const candidate of candidates) {
  const probe = spawnSync(candidate.executable, [...candidate.prefixArgs, "--version"], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  const output = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  if (probe.status === 0 && versionPattern.test(output)) {
    chosen = candidate;
    break;
  }
  errors.push(
    `${[candidate.executable, ...candidate.prefixArgs].join(" ")}: ${
      output || probe.error?.message || `exit ${probe.status}`
    }`,
  );
}

if (chosen === null) {
  process.stderr.write(`Python 3 is required for Codex hooks. Tried: ${errors.join("; ")}\n`);
  process.exit(2);
}

const result = spawnSync(chosen.executable, [...chosen.prefixArgs, script, ...extra], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 1);
