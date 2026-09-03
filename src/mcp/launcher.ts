#!/usr/bin/env node

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userHome } from "../platform.js";
import { runMcpStdio } from "./server.js";

const ENV_DIRECTORY_ARGUMENT = "--env-dir";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Load simple dotenv assignments without executing the files as shell scripts. */
export function loadCodexEnvDirectory(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".env"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingDirectory(error)) {
      return [];
    }
    throw error;
  }

  for (const name of entries) {
    applyDotEnv(readFileSync(join(directory, name), "utf8"), environment);
  }
  return entries;
}

export function applyDotEnv(source: string, environment: NodeJS.ProcessEnv): void {
  for (const rawLine of source.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/u);
    if (match === null || !ENV_NAME.test(match[1] ?? "")) {
      continue;
    }
    environment[match[1]!] = parseDotEnvValue(match[2] ?? "");
  }
}

export function envDirectoryFromArguments(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const index = argv.indexOf(ENV_DIRECTORY_ARGUMENT);
  const configured = index < 0 ? undefined : argv[index + 1];
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(configured);
  }
  const codexHome = environment["CODEX_HOME"];
  return resolve(codexHome?.trim() || join(userHome(environment), ".codex"));
}

export async function main(): Promise<void> {
  loadCodexEnvDirectory(envDirectoryFromArguments());
  await runMcpStdio();
}

function parseDotEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") || value.startsWith('"')) {
    const quote = value[0]!;
    const closing = closingQuoteIndex(value, quote);
    if (closing > 0) {
      const quoted = value.slice(1, closing);
      return quote === '"' ? unescapeDoubleQuoted(quoted) : quoted;
    }
  }
  return value.replace(/\s+#.*$/u, "").trimEnd();
}

function closingQuoteIndex(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) {
      continue;
    }
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    if (quote === "'" || slashes % 2 === 0) {
      return index;
    }
  }
  return -1;
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([\\"nrt])/gu, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

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

if (isEntrypoint()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
