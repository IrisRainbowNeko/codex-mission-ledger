import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function userHome(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const ordered =
    platform === "win32"
      ? [environment["USERPROFILE"], environment["HOME"]]
      : [environment["HOME"], environment["USERPROFILE"]];
  for (const candidate of ordered) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      return resolve(candidate.trim());
    }
  }
  return resolve(homedir());
}

export function tempRoot(environment: NodeJS.ProcessEnv = process.env): string {
  for (const key of ["TMPDIR", "TEMP", "TMP"] as const) {
    const value = environment[key];
    if (value !== undefined && value.trim().length > 0) {
      return resolve(value.trim());
    }
  }
  return resolve(tmpdir());
}

export function processIdentity(environment: NodeJS.ProcessEnv = process.env): string {
  if (typeof process.getuid === "function") {
    return String(process.getuid());
  }
  for (const key of ["USERNAME", "USER"] as const) {
    const value = environment[key];
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "user";
}

export function defaultUserStateDirectory(
  productDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const xdg = environment["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.trim().length > 0) {
    return resolve(xdg.trim(), productDirectory);
  }
  if (platform === "win32") {
    const local = environment["LOCALAPPDATA"];
    const root =
      local !== undefined && local.trim().length > 0
        ? local.trim()
        : join(userHome(environment, platform), "AppData", "Local");
    return resolve(root, productDirectory);
  }
  return resolve(userHome(environment, platform), ".local", "share", productDirectory);
}

export function quoteHookCommandArg(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

export function textContainsPath(text: string, path: string): boolean {
  if (text.includes(path)) {
    return true;
  }
  const jsonInner = JSON.stringify(path).slice(1, -1);
  if (text.includes(jsonInner)) {
    return true;
  }
  const slash = normalizePathSeparators(path);
  return (
    slash !== path && (text.includes(slash) || text.includes(JSON.stringify(slash).slice(1, -1)))
  );
}

export function isManagedHookCommand(command: string): boolean {
  const normalized = normalizePathSeparators(command);
  return (
    normalized.includes("hooks/codex-mission-ledger/") ||
    normalized.includes("hooks/hierarchical-codex/")
  );
}

export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
