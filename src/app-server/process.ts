import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CODEX_APP_SERVER_VERSION } from "../core/contracts.js";
import type { AppServerConnection, AppServerConnectionFactory } from "./types.js";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const FORCE_CLOSE_TIMEOUT_MS = 1_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_ISOLATED_CONFIG_BYTES = 128 * 1024;
const DEFAULT_ISOLATED_CONFIG = [
  "project_doc_max_bytes = 0",
  "project_doc_fallback_filenames = []",
  "[agents]",
  "enabled = false",
  "[features]",
  "multi_agent = false",
  "plugins = false",
  "",
].join("\n");

export type AppServerTransport = "stdio" | "proxy";
export const REQUIRED_CODEX_CLI_VERSION = CODEX_APP_SERVER_VERSION;

export type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** How an App Server process obtains its Codex home directory. */
export type CodexHomeIsolationMode = "inherit" | "temporary" | "projected" | "explicit";

export type ProjectedCodexHomeFile = "auth.json" | "config.toml";

/**
 * Process-level isolation settings.
 *
 * `temporary` creates a private, instruction-free CODEX_HOME and removes it when the
 * connection factory is disposed. It deliberately does not copy auth.json or the user's
 * config. Supply non-secret config explicitly through `configToml` or CLI `extraArgs`.
 * `projected` is an explicit opt-in convenience: it creates a temporary home and symlinks only
 * caller-selected `auth.json`/`config.toml` files from `sourceHome`; no credential bytes are
 * copied or read by this package. The source files remain under the caller's ownership.
 * `explicit` is for a caller-owned projected home and is never removed by this package.
 */
export interface CodexHomeIsolationOptions {
  mode?: CodexHomeIsolationMode;
  /** Existing home to use in `explicit` mode. Must be absolute. */
  path?: string;
  /** Parent directory for the lazily-created home in `temporary` mode. */
  parentDirectory?: string;
  /** Optional non-secret config written to a temporary home. */
  configToml?: string;
  /** Existing home whose selected files are symlinked in `projected` mode. Must be absolute. */
  sourceHome?: string;
  /** Files to symlink in `projected` mode. Defaults to both auth.json and config.toml. */
  files?: readonly ProjectedCodexHomeFile[];
}

/** A connection factory with an explicit lifecycle for temporary process resources. */
export interface ManagedAppServerConnectionFactory extends AppServerConnectionFactory {
  /** Absolute temporary home, or null before first connection / for inherited mode. */
  readonly isolatedCodexHome: string | null;
  /** Idempotently remove temporary process resources. */
  dispose(): Promise<void>;
}

export interface CodexCliVersionOptions {
  codexPath?: string;
  expectedVersion?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnCodex;
}

export interface CodexProcessOptions extends CodexCliVersionOptions {
  transport?: AppServerTransport;
  socketPath?: string;
  extraArgs?: string[];
  /** Defaults to `inherit` for the low-level factory; the production runtime opts into `temporary`. */
  codexHomeIsolation?: CodexHomeIsolationOptions;
  verifyVersion?: boolean;
  closeTimeoutMs?: number;
  onStderr?: (chunk: string) => void;
  /** One isolated root-only MCP bridge appended after recursive-MCP safety disables. */
  isolatedAgentTrioMcpServer?: {
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    startupTimeoutSec?: number;
    toolTimeoutSec?: number;
  };
}

export class CodexCliVersionError extends Error {}

export class CodexProcessError extends Error {}

/** Verify the executable before starting a transport; no model turn is launched. */
export async function verifyCodexCliVersion(options: CodexCliVersionOptions = {}): Promise<string> {
  const command = options.codexPath ?? "codex";
  const expectedVersion = options.expectedVersion ?? REQUIRED_CODEX_CLI_VERSION;
  const child = spawnCodex(options.spawnProcess, command, ["--version"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = requireReadable(child.stdout, "version stdout");
  const stderr = requireReadable(child.stderr, "version stderr");
  const [status, stdoutText, stderrText] = await Promise.all([
    childStatus(child),
    collectText(stdout),
    collectText(stderr),
  ]);
  if (status.error !== null) {
    throw new CodexCliVersionError(`failed to run ${command} --version: ${status.error.message}`);
  }
  if (status.code !== 0) {
    throw new CodexCliVersionError(
      `${command} --version exited with ${String(status.code)}: ${stderrText.trim()}`,
    );
  }

  const versionLine = stdoutText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^codex-cli\s+\S+$/u.test(line));
  const actualVersion = versionLine?.replace(/^codex-cli\s+/u, "");
  if (actualVersion === undefined) {
    throw new CodexCliVersionError(
      `${command} --version did not return a codex-cli version: ${stdoutText.trim()}`,
    );
  }
  if (actualVersion !== expectedVersion) {
    throw new CodexCliVersionError(
      `codex-cli ${expectedVersion} is required; found ${actualVersion}`,
    );
  }
  return actualVersion;
}

/**
 * Create a fresh stdio or daemon-proxy process for each connect/reconnect.
 * Version verification is enabled by default and pinned to contracts.ts.
 */
export function createCodexAppServerConnectionFactory(
  options: CodexProcessOptions = {},
): ManagedAppServerConnectionFactory {
  if (!isNonNegativeFinite(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS)) {
    throw new RangeError("closeTimeoutMs must be a non-negative finite number");
  }
  if (options.transport !== "proxy" && options.socketPath !== undefined) {
    throw new TypeError("socketPath is only valid for the proxy transport");
  }
  const homeProjection = new CodexHomeProjection(options.codexHomeIsolation);

  const connectionFactory = (async () => {
    const processEnv = await homeProjection.environment(options.env);
    if (options.verifyVersion !== false) {
      await verifyCodexCliVersion({ ...options, env: processEnv });
    }

    const command = options.codexPath ?? "codex";
    const transport = options.transport ?? "stdio";
    const args =
      transport === "stdio"
        ? [
            "app-server",
            "--stdio",
            ...(options.extraArgs ?? []),
            ...homeProjection.safetyArgs(),
            ...isolatedAgentTrioMcpArgs(options.isolatedAgentTrioMcpServer),
          ]
        : [
            "app-server",
            "proxy",
            ...(options.socketPath === undefined ? [] : ["--sock", options.socketPath]),
            ...(options.extraArgs ?? []),
            ...homeProjection.safetyArgs(),
            ...isolatedAgentTrioMcpArgs(options.isolatedAgentTrioMcpServer),
          ];
    const child = spawnCodex(options.spawnProcess, command, args, {
      cwd: options.cwd,
      env: processEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const writable = requireWritable(child.stdin, "app-server stdin");
    const readable = requireReadable(child.stdout, "app-server stdout");
    const stderr = requireReadable(child.stderr, "app-server stderr");
    let diagnostics = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      options.onStderr?.(chunk);
      diagnostics = `${diagnostics}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
    });

    const statusPromise = childStatus(child);
    let intentionalClose = false;
    const closed = statusPromise.then((status) => {
      if (intentionalClose) {
        return;
      }
      if (status.error !== null) {
        throw new CodexProcessError(`codex app-server failed: ${status.error.message}`);
      }
      const suffix = diagnostics.trim().length > 0 ? `: ${diagnostics.trim()}` : "";
      throw new CodexProcessError(
        `codex app-server exited with ${String(status.code)}${status.signal === null ? "" : ` (${status.signal})`}${suffix}`,
      );
    });

    const connection: AppServerConnection = {
      readable,
      writable,
      closed,
      close: async () => {
        intentionalClose = true;
        if (child.exitCode !== null || child.signalCode !== null) {
          await statusPromise;
          return;
        }
        writable.end();
        const exitedGracefully = await settlesWithin(
          statusPromise,
          options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
        );
        if (exitedGracefully) {
          return;
        }
        child.kill("SIGTERM");
        const exitedAfterTerminate = await settlesWithin(statusPromise, FORCE_CLOSE_TIMEOUT_MS);
        if (!exitedAfterTerminate) {
          if (!child.kill("SIGKILL")) {
            throw new CodexProcessError("failed to kill codex app-server after close timeout");
          }
          const exitedAfterKill = await settlesWithin(statusPromise, FORCE_CLOSE_TIMEOUT_MS);
          if (!exitedAfterKill) {
            throw new CodexProcessError("codex app-server did not exit after SIGKILL");
          }
        }
      },
    };
    return connection;
  }) as ManagedAppServerConnectionFactory;
  Object.defineProperty(connectionFactory, "isolatedCodexHome", {
    enumerable: true,
    get: () => homeProjection.path,
  });
  connectionFactory.dispose = () => homeProjection.dispose();
  return connectionFactory;
}

function isolatedAgentTrioMcpArgs(
  server: CodexProcessOptions["isolatedAgentTrioMcpServer"],
): string[] {
  if (server === undefined) {
    return [];
  }
  if (server.command.trim().length === 0) {
    throw new TypeError("isolatedAgentTrioMcpServer.command must be non-empty");
  }
  const startupTimeoutSec = server.startupTimeoutSec ?? 30;
  const toolTimeoutSec = server.toolTimeoutSec ?? 86_400;
  for (const [label, value] of [
    ["startupTimeoutSec", startupTimeoutSec],
    ["toolTimeoutSec", toolTimeoutSec],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`isolatedAgentTrioMcpServer.${label} must be positive`);
    }
  }
  const env = Object.fromEntries(
    Object.entries(server.env ?? {}).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new TypeError(`isolatedAgentTrioMcpServer.env key is invalid: ${key}`);
      }
      return [key, value];
    }),
  );
  const inline = [
    `command=${JSON.stringify(server.command)}`,
    `args=[${(server.args ?? []).map((argument) => JSON.stringify(argument)).join(",")}]`,
    `env={${Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(",")}}`,
    "enabled=true",
    'default_tools_approval_mode="approve"',
    `startup_timeout_sec=${String(startupTimeoutSec)}`,
    `tool_timeout_sec=${String(toolTimeoutSec)}`,
  ].join(",");
  return ["-c", `mcp_servers.agent_trio={${inline}}`];
}

type NormalizedCodexHomeIsolation =
  | { mode: "inherit" }
  | { mode: "explicit"; path: string }
  | { mode: "temporary"; parentDirectory: string; configToml: string }
  | {
      mode: "projected";
      parentDirectory: string;
      sourceHome: string;
      files: readonly ProjectedCodexHomeFile[];
    };

/**
 * Owns one projected home for the lifetime of a connection factory. Keeping this state outside
 * the individual connection means reconnects see the same CODEX_HOME and persisted App Server
 * state, while runtime.close() can remove it deterministically.
 */
class CodexHomeProjection {
  readonly #options: NormalizedCodexHomeIsolation;
  #path: string | null = null;
  #creation: Promise<string> | null = null;
  #disposePromise: Promise<void> | null = null;
  #disposed = false;

  constructor(options: CodexHomeIsolationOptions | undefined) {
    this.#options = normalizeCodexHomeIsolation(options);
    if (this.#options.mode === "explicit") {
      this.#path = this.#options.path;
    }
  }

  get path(): string | null {
    return this.#path;
  }

  async environment(baseEnvironment: NodeJS.ProcessEnv | undefined): Promise<NodeJS.ProcessEnv> {
    if (this.#disposed) {
      throw new CodexProcessError("codex app-server connection factory has been disposed");
    }
    if (this.#options.mode === "inherit") {
      return baseEnvironment ?? process.env;
    }
    const path =
      this.#options.mode === "explicit" ? this.#options.path : await this.ensureTemporaryHome();
    return { ...(baseEnvironment ?? process.env), CODEX_HOME: path };
  }

  /** CLI-level overrides remain effective even when projected config.toml contains unsafe values. */
  safetyArgs(): readonly string[] {
    if (this.#options.mode === "inherit") {
      return [];
    }
    return [
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "project_doc_fallback_filenames=[]",
      "-c",
      "agents.enabled=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.hooks=false",
      "-c",
      "skills.config=[]",
      "-c",
      'mcp_servers.agent_trio={command="agent-trio-disabled",enabled=false}',
      "-c",
      'mcp_servers.hierarchical_codex={command="agent-trio-disabled",enabled=false}',
      "-c",
      'mcp_servers.codex_mission_ledger={command="agent-trio-disabled",enabled=false}',
    ];
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    this.#disposePromise = (async () => {
      this.#disposed = true;
      // A connection may be opening while runtime.close() starts. Wait for that creation before
      // removing the directory, otherwise a late mkdir/write can resurrect an apparently closed
      // home.
      await this.#creation?.catch(() => undefined);
      if (
        (this.#options.mode !== "temporary" && this.#options.mode !== "projected") ||
        this.#path === null
      ) {
        return;
      }
      await rm(this.#path, { recursive: true, force: true });
    })();
    return this.#disposePromise;
  }

  private async ensureTemporaryHome(): Promise<string> {
    if (this.#path !== null) {
      return this.#path;
    }
    if (this.#options.mode !== "temporary" && this.#options.mode !== "projected") {
      throw new CodexProcessError("temporary CODEX_HOME projection is not configured");
    }
    const { parentDirectory } = this.#options;
    if (this.#creation === null) {
      this.#creation = (async () => {
        await mkdir(parentDirectory, { recursive: true });
        const path = await mkdtemp(join(parentDirectory, "agent-trio-codex-home-"));
        try {
          if (this.#options.mode === "temporary") {
            await writeFile(join(path, "config.toml"), this.#options.configToml, {
              encoding: "utf8",
              mode: 0o600,
            });
          } else {
            await this.projectFiles(path);
          }
        } catch (error) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        this.#path = path;
        return path;
      })().finally(() => {
        this.#creation = null;
      });
    }
    return this.#creation;
  }

  private async projectFiles(targetHome: string): Promise<void> {
    if (this.#options.mode !== "projected") {
      return;
    }
    for (const file of this.#options.files) {
      const source = join(this.#options.sourceHome, file);
      const metadata = await stat(source);
      if (!metadata.isFile()) {
        throw new CodexProcessError(
          `projected CODEX_HOME source '${source}' is not a regular file`,
        );
      }
      // A symlink keeps credentials in the caller-owned home; this process never reads or copies
      // the file contents. The explicit projected mode is the caller's authorization boundary.
      await symlink(source, join(targetHome, file), "file");
    }
  }
}

function normalizeCodexHomeIsolation(
  options: CodexHomeIsolationOptions | undefined,
): NormalizedCodexHomeIsolation {
  const mode = options?.mode ?? (options?.path === undefined ? "inherit" : "explicit");
  const path = options?.path;
  const parentDirectory = options?.parentDirectory;
  const configToml = options?.configToml;
  const sourceHome = options?.sourceHome;
  const files = options?.files;
  if (mode !== "inherit" && mode !== "temporary" && mode !== "projected" && mode !== "explicit") {
    throw new TypeError(`unsupported CODEX_HOME isolation mode '${String(mode)}'`);
  }
  if (mode === "inherit") {
    if (
      path !== undefined ||
      parentDirectory !== undefined ||
      configToml !== undefined ||
      sourceHome !== undefined ||
      files !== undefined
    ) {
      throw new TypeError(
        "inherit CODEX_HOME isolation cannot specify path, parentDirectory, configToml, sourceHome, or files",
      );
    }
    return { mode };
  }
  if (mode === "explicit") {
    if (path === undefined || path.trim().length === 0 || !isAbsolute(path)) {
      throw new TypeError("explicit CODEX_HOME isolation requires an absolute path");
    }
    if (parentDirectory !== undefined || configToml !== undefined) {
      throw new TypeError(
        "explicit CODEX_HOME isolation cannot specify parentDirectory or configToml",
      );
    }
    if (sourceHome !== undefined || files !== undefined) {
      throw new TypeError("explicit CODEX_HOME isolation cannot specify sourceHome or files");
    }
    return { mode, path: resolve(path) };
  }
  if (mode === "projected") {
    if (path !== undefined || configToml !== undefined) {
      throw new TypeError("projected CODEX_HOME isolation cannot specify path or configToml");
    }
    if (sourceHome === undefined || sourceHome.trim().length === 0 || !isAbsolute(sourceHome)) {
      throw new TypeError("projected CODEX_HOME isolation requires an absolute sourceHome");
    }
    const projectedFiles: ProjectedCodexHomeFile[] =
      files === undefined ? ["auth.json", "config.toml"] : [...files];
    if (
      projectedFiles.length === 0 ||
      projectedFiles.some((file) => file !== "auth.json" && file !== "config.toml") ||
      new Set(projectedFiles).size !== projectedFiles.length
    ) {
      throw new TypeError(
        "projected CODEX_HOME files must uniquely contain auth.json or config.toml",
      );
    }
    return {
      mode,
      parentDirectory: resolve(parentDirectory ?? tmpdir()),
      sourceHome: resolve(sourceHome),
      files: projectedFiles,
    };
  }
  if (path !== undefined) {
    throw new TypeError("temporary CODEX_HOME isolation cannot specify path; use explicit mode");
  }
  if (sourceHome !== undefined) {
    if (configToml !== undefined || sourceHome.trim().length === 0 || !isAbsolute(sourceHome)) {
      throw new TypeError("projected CODEX_HOME isolation requires an absolute sourceHome");
    }
    const projectedFiles: ProjectedCodexHomeFile[] =
      files === undefined ? ["auth.json", "config.toml"] : [...files];
    if (
      projectedFiles.length === 0 ||
      projectedFiles.some((file) => file !== "auth.json" && file !== "config.toml") ||
      new Set(projectedFiles).size !== projectedFiles.length
    ) {
      throw new TypeError(
        "projected CODEX_HOME files must uniquely contain auth.json or config.toml",
      );
    }
    return {
      mode: "projected",
      parentDirectory: resolve(parentDirectory ?? tmpdir()),
      sourceHome: resolve(sourceHome),
      files: projectedFiles,
    };
  }
  if (files !== undefined) {
    throw new TypeError(
      "temporary CODEX_HOME isolation requires sourceHome when files are specified",
    );
  }
  const resolvedParent = resolve(parentDirectory ?? tmpdir());
  const resolvedConfig = configToml ?? DEFAULT_ISOLATED_CONFIG;
  const normalizedConfig = resolvedConfig.endsWith("\n") ? resolvedConfig : `${resolvedConfig}\n`;
  if (Buffer.byteLength(normalizedConfig, "utf8") > MAX_ISOLATED_CONFIG_BYTES) {
    throw new RangeError(`temporary CODEX_HOME config exceeds ${MAX_ISOLATED_CONFIG_BYTES} bytes`);
  }
  return {
    mode: "temporary",
    parentDirectory: resolvedParent,
    configToml: normalizedConfig,
  };
}

type ChildStatus = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

function spawnCodex(
  injected: SpawnCodex | undefined,
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  try {
    return (injected ?? spawn)(command, args, options);
  } catch (error) {
    throw new CodexProcessError(
      `failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function childStatus(child: ChildProcess): Promise<ChildStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: ChildStatus): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("error", onError);
      child.off("close", onClose);
      resolve(status);
    };
    const onError = (error: Error): void => {
      finish({ code: null, signal: null, error });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ code, signal, error: null });
    };
    child.once("error", onError);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode, error: null });
    }
  });
}

function collectText(readable: Readable): Promise<string> {
  readable.setEncoding("utf8");
  let output = "";
  return new Promise((resolve, reject) => {
    readable.on("data", (chunk: string) => {
      output += chunk;
    });
    readable.once("end", () => resolve(output));
    readable.once("error", reject);
  });
}

function requireReadable(stream: Readable | null, name: string): Readable {
  if (stream === null) {
    throw new CodexProcessError(`${name} was not piped`);
  }
  return stream;
}

function requireWritable(stream: Writable | null, name: string): Writable {
  if (stream === null) {
    throw new CodexProcessError(`${name} was not piped`);
  }
  return stream;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) {
    return false;
  }
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });
  const settled = promise.then(() => true);
  const result = await Promise.race([settled, timedOut]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return result;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
