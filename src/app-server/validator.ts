import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskAccess, ValidationResult, ValidationSpec } from "../core/contracts.js";
import type {
  CommandExecParams,
  CommandExecResponse,
  RequestOptions,
  SandboxPolicy,
} from "./types.js";

const MAX_SUMMARY_OUTPUT_CHARS = 4_000;
const SHELL_OPERATORS = new Set([";", "|", "&", "<", ">"]);

export interface CommandExecPort {
  commandExec(params: CommandExecParams, options?: RequestOptions): Promise<CommandExecResponse>;
}

export interface AppServerValidatorInput {
  appServer: CommandExecPort;
  specs: readonly ValidationSpec[];
  baseCwd: string;
  access: TaskAccess;
  signal: AbortSignal;
}

export class ValidationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationCommandError";
  }
}

/**
 * Execute plan validators as argv vectors. No shell is involved, so shell
 * control operators are rejected instead of being interpreted ambiguously.
 */
export async function runAppServerValidators(
  input: AppServerValidatorInput,
): Promise<ValidationResult[]> {
  throwIfAborted(input.signal);
  if (!isAbsolute(input.baseCwd)) {
    throw new TypeError("validator baseCwd must be an absolute path");
  }

  const trustedBase = await realpath(input.baseCwd);
  const sandboxPolicy = validationSandbox(input.access, trustedBase);
  const run = async (spec: ValidationSpec): Promise<ValidationResult> => {
    throwIfAborted(input.signal);
    try {
      const cwd = await resolveValidatorCwd(trustedBase, spec.cwd);
      const params: CommandExecParams = {
        command: parseValidationCommand(spec.command),
        cwd,
        sandboxPolicy,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      };
      const options: RequestOptions = { signal: input.signal, timeoutMs: 0 };
      const response = await input.appServer.commandExec(params, options);
      assertCommandExecResponse(response);
      return resultFromResponse(spec.command, response);
    } catch (error) {
      if (input.signal.aborted) {
        throw abortError(input.signal);
      }
      return {
        command: spec.command,
        status: "failed",
        summary: `validator could not run: ${errorMessage(error)}`,
      };
    }
  };

  if (input.access === "readOnly") {
    return Promise.all(input.specs.map(run));
  }

  const results: ValidationResult[] = [];
  for (const spec of input.specs) {
    results.push(await run(spec));
  }

  return results;
}

/** Parse a small, explicit shell-like quoting grammar into an argv vector. */
export function parseValidationCommand(command: string): string[] {
  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const finishToken = (): void => {
    if (tokenStarted) {
      argv.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) {
      continue;
    }
    if (character === "\0" || character === "\n" || character === "\r") {
      throw new ValidationCommandError("validation command contains a forbidden control character");
    }

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        index += 1;
        const escaped = command[index];
        if (escaped === undefined || escaped === "\n" || escaped === "\r") {
          throw new ValidationCommandError("validation command ends with an invalid escape");
        }
        token += escaped;
      } else {
        token += character;
      }
      continue;
    }

    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      const escaped = command[index];
      if (escaped === undefined || escaped === "\n" || escaped === "\r") {
        throw new ValidationCommandError("validation command ends with an invalid escape");
      }
      token += escaped;
      tokenStarted = true;
      continue;
    }
    if (SHELL_OPERATORS.has(character) || character === "`") {
      throw new ValidationCommandError(
        `shell operator '${character}' is not supported; provide one executable command`,
      );
    }
    if (character === "$" && command[index + 1] === "(") {
      throw new ValidationCommandError("command substitution is not supported");
    }

    token += character;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw new ValidationCommandError(`validation command has an unterminated ${quote} quote`);
  }
  finishToken();
  if (argv.length === 0 || argv[0]?.length === 0) {
    throw new ValidationCommandError("validation command must name an executable");
  }
  return argv;
}

async function resolveValidatorCwd(
  baseCwd: string,
  requested: string | undefined,
): Promise<string> {
  const candidate = resolve(baseCwd, requested ?? ".");
  const resolvedCandidate = await realpath(candidate);
  const fromBase = relative(baseCwd, resolvedCandidate);
  if (fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new ValidationCommandError("validation cwd resolves outside the trusted workspace");
  }
  return resolvedCandidate;
}

function validationSandbox(access: TaskAccess, baseCwd: string): SandboxPolicy {
  return access === "readOnly"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [baseCwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
}

function resultFromResponse(command: string, response: CommandExecResponse): ValidationResult {
  const output = formatOutput(response.stdout, response.stderr);
  return {
    command,
    status: response.exitCode === 0 ? "passed" : "failed",
    summary: `exit code ${response.exitCode}${output.length === 0 ? "" : `\n${output}`}`,
  };
}

function formatOutput(stdout: string, stderr: string): string {
  const sections = [
    ...(stdout.trim().length === 0 ? [] : [`stdout:\n${stdout.trim()}`]),
    ...(stderr.trim().length === 0 ? [] : [`stderr:\n${stderr.trim()}`]),
  ];
  const output = sections.join("\n");
  if (output.length <= MAX_SUMMARY_OUTPUT_CHARS) {
    return output;
  }
  const omitted = output.length - MAX_SUMMARY_OUTPUT_CHARS;
  return `[${omitted} earlier characters omitted]\n${output.slice(-MAX_SUMMARY_OUTPUT_CHARS)}`;
}

function assertCommandExecResponse(response: CommandExecResponse): void {
  if (
    !Number.isInteger(response.exitCode) ||
    typeof response.stdout !== "string" ||
    typeof response.stderr !== "string"
  ) {
    throw new TypeError("command/exec returned an invalid response");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("validation aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
