import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultUserStateDirectory, mkdirPrivate, processIdentity, tempRoot } from "./platform.js";

export const CONTROL_PLANE_DB_NAME = "control-plane.sqlite";
export const PRODUCT_NAME = "Mission Ledger for Codex";
export const PROJECT_STATE_DIRECTORY = ".codex-mission-ledger";
export const STATE_DIRECTORY = "codex-mission-ledger";
export const LEGACY_PROJECT_STATE_DIRECTORY = ".hierarchical-codex";
export const LEGACY_STATE_DIRECTORY = "hierarchical-codex";

export interface ControlPlaneConfig {
  homeDirectory: string;
  databasePath: string;
  artifactDirectory: string;
  maxArtifactBytes: number;
  defaultLeaseSeconds: number;
  maxLeaseSeconds: number;
  eventPageSize: number;
}

export interface LoadConfigOptions {
  warn?: (message: string) => void;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function defaultProjectHome(cwd: string): string {
  return resolve(cwd, PROJECT_STATE_DIRECTORY);
}

export function xdgStateHome(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return defaultUserStateDirectory(STATE_DIRECTORY, environment, platform);
}

export function ephemeralStateHome(environment: NodeJS.ProcessEnv): string {
  return resolve(tempRoot(environment), STATE_DIRECTORY, processIdentity(environment));
}

function legacyXdgStateHome(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return defaultUserStateDirectory(LEGACY_STATE_DIRECTORY, environment, platform);
}

function legacyEphemeralStateHome(environment: NodeJS.ProcessEnv): string {
  return resolve(tempRoot(environment), LEGACY_STATE_DIRECTORY, processIdentity(environment));
}

export function directoryAllowsWrites(directory: string): boolean {
  try {
    mkdirPrivate(directory);
    const probe = join(directory, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function sqliteFileAllowsWrites(databasePath: string): boolean {
  if (!existsSync(databasePath)) {
    return true;
  }
  try {
    const handle = new DatabaseSync(databasePath);
    try {
      handle.exec("BEGIN IMMEDIATE");
      handle.exec("ROLLBACK");
      return true;
    } finally {
      handle.close();
    }
  } catch {
    return false;
  }
}

export function controlPlaneHomeIsWritable(homeDirectory: string): boolean {
  return (
    directoryAllowsWrites(homeDirectory) &&
    sqliteFileAllowsWrites(join(homeDirectory, CONTROL_PLANE_DB_NAME))
  );
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function resolveWritableHome(
  requestedHome: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): string {
  const candidates = uniquePaths([
    requestedHome,
    xdgStateHome(environment),
    legacyXdgStateHome(environment),
    ephemeralStateHome(environment),
    legacyEphemeralStateHome(environment),
  ]);
  const selected = candidates.find((candidate) => controlPlaneHomeIsWritable(candidate));
  if (selected === undefined) {
    throw new Error(
      `${PRODUCT_NAME} has no writable state directory. Tried: ${candidates.join(", ")}`,
    );
  }
  if (selected !== requestedHome) {
    const warn = options.warn ?? ((message: string) => console.error(message));
    warn(
      `${PRODUCT_NAME}: control plane home "${requestedHome}" is not writable; using "${selected}". Codex sandboxes often treat ~/.codex as read-only.`,
    );
  }
  return selected;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: LoadConfigOptions = {},
): ControlPlaneConfig {
  const canonicalHome = environment["CODEX_MISSION_LEDGER_HOME"];
  const legacyHome = environment["HIERARCHICAL_CODEX_HOME"];
  const canonicalProjectHome = defaultProjectHome(cwd);
  const legacyProjectHome = resolve(cwd, LEGACY_PROJECT_STATE_DIRECTORY);
  const legacyGlobalHome = legacyXdgStateHome(environment);
  const legacyGlobalDatabase = join(legacyGlobalHome, CONTROL_PLANE_DB_NAME);
  const requestedHome = resolve(
    canonicalHome ??
      legacyHome ??
      ((existsSync(legacyProjectHome) && !existsSync(canonicalProjectHome)) ||
      (existsSync(join(legacyProjectHome, CONTROL_PLANE_DB_NAME)) &&
        !existsSync(join(canonicalProjectHome, CONTROL_PLANE_DB_NAME)))
        ? legacyProjectHome
        : existsSync(legacyGlobalDatabase) &&
            !existsSync(join(canonicalProjectHome, CONTROL_PLANE_DB_NAME))
          ? legacyGlobalHome
          : canonicalProjectHome),
  );
  if (canonicalHome === undefined && legacyHome !== undefined) {
    options.warn?.("HIERARCHICAL_CODEX_HOME is deprecated; use CODEX_MISSION_LEDGER_HOME.");
  }
  const homeDirectory = resolveWritableHome(requestedHome, environment, options);
  const databasePath = resolve(
    environment["CODEX_MISSION_LEDGER_DB"] ??
      environment["HIERARCHICAL_CODEX_DB"] ??
      resolve(homeDirectory, CONTROL_PLANE_DB_NAME),
  );
  const artifactDirectory = resolve(
    environment["CODEX_MISSION_LEDGER_ARTIFACTS"] ??
      environment["HIERARCHICAL_CODEX_ARTIFACTS"] ??
      resolve(homeDirectory, "artifacts"),
  );

  return {
    homeDirectory,
    databasePath,
    artifactDirectory,
    maxArtifactBytes: positiveInteger(
      environment["CODEX_MISSION_LEDGER_MAX_ARTIFACT_BYTES"] ??
        environment["HIERARCHICAL_CODEX_MAX_ARTIFACT_BYTES"],
      5 * 1024 * 1024,
      "CODEX_MISSION_LEDGER_MAX_ARTIFACT_BYTES",
    ),
    defaultLeaseSeconds: positiveInteger(
      environment["CODEX_MISSION_LEDGER_DEFAULT_LEASE_SECONDS"] ??
        environment["HIERARCHICAL_CODEX_DEFAULT_LEASE_SECONDS"],
      15 * 60,
      "CODEX_MISSION_LEDGER_DEFAULT_LEASE_SECONDS",
    ),
    maxLeaseSeconds: positiveInteger(
      environment["CODEX_MISSION_LEDGER_MAX_LEASE_SECONDS"] ??
        environment["HIERARCHICAL_CODEX_MAX_LEASE_SECONDS"],
      4 * 60 * 60,
      "CODEX_MISSION_LEDGER_MAX_LEASE_SECONDS",
    ),
    eventPageSize: positiveInteger(
      environment["CODEX_MISSION_LEDGER_EVENT_PAGE_SIZE"] ??
        environment["HIERARCHICAL_CODEX_EVENT_PAGE_SIZE"],
      250,
      "CODEX_MISSION_LEDGER_EVENT_PAGE_SIZE",
    ),
  };
}
