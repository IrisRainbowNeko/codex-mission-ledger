import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CONTROL_PLANE_DB_NAME = "control-plane.sqlite";

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
  return resolve(cwd, ".hierarchical-codex");
}

export function xdgStateHome(environment: NodeJS.ProcessEnv): string {
  const xdg = environment["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.trim().length > 0) {
    return resolve(xdg, "hierarchical-codex");
  }
  const home = environment["HOME"] ?? homedir();
  return resolve(home, ".local", "share", "hierarchical-codex");
}

export function ephemeralStateHome(environment: NodeJS.ProcessEnv): string {
  const root = environment["TMPDIR"] ?? environment["TMP"] ?? tmpdir();
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return resolve(root, "hierarchical-codex", uid);
}

export function directoryAllowsWrites(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
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
    ephemeralStateHome(environment),
  ]);
  const selected = candidates.find((candidate) => controlPlaneHomeIsWritable(candidate));
  if (selected === undefined) {
    throw new Error(
      `hierarchical-codex has no writable state directory. Tried: ${candidates.join(", ")}`,
    );
  }
  if (selected !== requestedHome) {
    const warn = options.warn ?? ((message: string) => console.error(message));
    warn(
      `hierarchical-codex: control plane home "${requestedHome}" is not writable; using "${selected}". Codex sandboxes often treat ~/.codex as read-only.`,
    );
  }
  return selected;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: LoadConfigOptions = {},
): ControlPlaneConfig {
  const requestedHome = resolve(environment["HIERARCHICAL_CODEX_HOME"] ?? defaultProjectHome(cwd));
  const homeDirectory = resolveWritableHome(requestedHome, environment, options);
  const databasePath = resolve(
    environment["HIERARCHICAL_CODEX_DB"] ?? resolve(homeDirectory, CONTROL_PLANE_DB_NAME),
  );
  const artifactDirectory = resolve(
    environment["HIERARCHICAL_CODEX_ARTIFACTS"] ?? resolve(homeDirectory, "artifacts"),
  );

  return {
    homeDirectory,
    databasePath,
    artifactDirectory,
    maxArtifactBytes: positiveInteger(
      environment["HIERARCHICAL_CODEX_MAX_ARTIFACT_BYTES"],
      5 * 1024 * 1024,
      "HIERARCHICAL_CODEX_MAX_ARTIFACT_BYTES",
    ),
    defaultLeaseSeconds: positiveInteger(
      environment["HIERARCHICAL_CODEX_DEFAULT_LEASE_SECONDS"],
      15 * 60,
      "HIERARCHICAL_CODEX_DEFAULT_LEASE_SECONDS",
    ),
    maxLeaseSeconds: positiveInteger(
      environment["HIERARCHICAL_CODEX_MAX_LEASE_SECONDS"],
      60 * 60,
      "HIERARCHICAL_CODEX_MAX_LEASE_SECONDS",
    ),
    eventPageSize: positiveInteger(
      environment["HIERARCHICAL_CODEX_EVENT_PAGE_SIZE"],
      250,
      "HIERARCHICAL_CODEX_EVENT_PAGE_SIZE",
    ),
  };
}
