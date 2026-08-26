import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { quoteHookCommandArg } from "./platform.js";

export interface PythonInvocation {
  executable: string;
  prefixArgs: string[];
}

const VERSION_PATTERN = /^Python 3\.\d+/;

let cachedDefault: PythonInvocation | undefined;

export function formatPythonInvocation(python: PythonInvocation): string {
  return [python.executable, ...python.prefixArgs].join(" ");
}

export function pythonCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PythonInvocation[] {
  const candidates: PythonInvocation[] = [];
  const seen = new Set<string>();
  const push = (invocation: PythonInvocation): void => {
    const key = formatPythonInvocation(invocation);
    if (seen.has(key) || invocation.executable.length === 0) {
      return;
    }
    seen.add(key);
    candidates.push(invocation);
  };

  const explicit = environment["CODEX_MISSION_LEDGER_PYTHON"] ?? environment["PYTHON"];
  if (explicit !== undefined && explicit.trim().length > 0) {
    const parts = explicit.trim().split(/\s+/u);
    const executable = parts[0];
    if (executable !== undefined) {
      push({ executable, prefixArgs: parts.slice(1) });
    }
  }
  push({ executable: "python3", prefixArgs: [] });
  if (platform === "win32") {
    push({ executable: "py", prefixArgs: ["-3"] });
    push({ executable: "py", prefixArgs: [] });
  }
  push({ executable: "python", prefixArgs: [] });
  return candidates;
}

export function resolvePythonInvocation(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PythonInvocation {
  const useCache = environment === process.env && platform === process.platform;
  if (useCache && cachedDefault !== undefined) {
    return cachedDefault;
  }
  const errors: string[] = [];
  for (const candidate of pythonCandidates(environment, platform)) {
    const result = spawnSync(candidate.executable, [...candidate.prefixArgs, "--version"], {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0 && VERSION_PATTERN.test(output)) {
      if (useCache) {
        cachedDefault = candidate;
      }
      return candidate;
    }
    const detail = output || result.error?.message || `exit ${String(result.status)}`;
    errors.push(`${formatPythonInvocation(candidate)}: ${detail}`);
  }
  throw new Error(
    `Python 3.10+ is required for Codex hooks (python3, py -3, or python). Tried: ${errors.join("; ")}`,
  );
}

export function spawnPython(
  args: readonly string[],
  options: SpawnSyncOptions & { encoding: BufferEncoding },
  invocation?: PythonInvocation,
): SpawnSyncReturns<string>;
export function spawnPython(
  args: readonly string[],
  options?: SpawnSyncOptions,
  invocation?: PythonInvocation,
): SpawnSyncReturns<string | Buffer>;
export function spawnPython(
  args: readonly string[],
  options: SpawnSyncOptions = {},
  invocation?: PythonInvocation,
): SpawnSyncReturns<string | Buffer> {
  const python =
    invocation ??
    resolvePythonInvocation((options.env as NodeJS.ProcessEnv | undefined) ?? process.env);
  return spawnSync(python.executable, [...python.prefixArgs, ...args], {
    windowsHide: true,
    ...options,
  });
}

export function formatPythonHookCommand(
  invocation: PythonInvocation,
  scriptPath: string,
  extraArgs: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string {
  return [
    quoteHookCommandArg(invocation.executable, platform),
    ...invocation.prefixArgs,
    quoteHookCommandArg(scriptPath, platform),
    ...extraArgs,
  ].join(" ");
}

export function formatNodeHookCommand(
  nodeExecutable: string,
  runnerPath: string,
  scriptPath: string,
  extraArgs: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string {
  return [
    quoteHookCommandArg(nodeExecutable, platform),
    quoteHookCommandArg(runnerPath, platform),
    quoteHookCommandArg(scriptPath, platform),
    ...extraArgs,
  ].join(" ");
}
