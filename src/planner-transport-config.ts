import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { userHome } from "./platform.js";

export type PlannerTransportMode = "auto" | "app-server" | "responses";

export type ResolvedPlannerTransport =
  | { kind: "app-server"; source: "explicit" | "fallback" }
  | {
      kind: "responses";
      source: "environment" | "codex";
      baseUrl: string;
      apiKey: string;
      model: string;
      serviceTier?: string;
      provider?: string;
    };

export interface PlannerTransportResolutionOptions {
  env: NodeJS.ProcessEnv;
  serviceTier?: string;
}

/** Resolve the lightweight planner from explicit variables or the active local Codex provider. */
export function resolvePlannerTransport(
  options: Readonly<PlannerTransportResolutionOptions>,
): ResolvedPlannerTransport {
  const mode = plannerTransportMode(options.env);
  if (mode === "app-server") {
    return { kind: "app-server", source: "explicit" };
  }

  const explicitKey = firstNonEmpty(
    options.env["AGENT_TRIO_PLANNER_API_KEY"],
    options.env["OPENAI_API_KEY"],
  );
  const explicitBaseUrl = firstNonEmpty(options.env["AGENT_TRIO_PLANNER_BASE_URL"]);
  if (explicitKey !== undefined || explicitBaseUrl !== undefined) {
    if (explicitKey === undefined) {
      throw new Error("Responses planner requires AGENT_TRIO_PLANNER_API_KEY or OPENAI_API_KEY");
    }
    return {
      kind: "responses",
      source: "environment",
      baseUrl: validateBaseUrl(explicitBaseUrl ?? "https://api.openai.com/v1"),
      apiKey: explicitKey,
      model: firstNonEmpty(options.env["AGENT_TRIO_PLANNER_MODEL"]) ?? "gpt-5.6-sol",
      ...optionalServiceTier(options.env, options.serviceTier),
    };
  }

  const codex = resolveCodexResponsesProvider(options.env, options.serviceTier);
  if (codex !== null) {
    return codex;
  }
  if (mode === "responses") {
    throw new Error(
      "Responses planner requires explicit credentials or a Responses-compatible local Codex provider",
    );
  }
  return { kind: "app-server", source: "fallback" };
}

export function plannerTransportMode(environment: NodeJS.ProcessEnv): PlannerTransportMode {
  const value = firstNonEmpty(environment["AGENT_TRIO_PLANNER_TRANSPORT"]) ?? "auto";
  if (value !== "auto" && value !== "app-server" && value !== "responses") {
    throw new Error("AGENT_TRIO_PLANNER_TRANSPORT must be auto, app-server, or responses");
  }
  return value;
}

function resolveCodexResponsesProvider(
  environment: NodeJS.ProcessEnv,
  serviceTier: string | undefined,
): Extract<ResolvedPlannerTransport, { kind: "responses" }> | null {
  const codexHome = resolve(environment["CODEX_HOME"] ?? `${userHome(environment)}/.codex`);
  let config: Record<string, unknown>;
  let auth: Record<string, unknown>;
  try {
    config = asRecord(parseToml(readFileSync(resolve(codexHome, "config.toml"), "utf8")));
    auth = asRecord(JSON.parse(readFileSync(resolve(codexHome, "auth.json"), "utf8")) as unknown);
  } catch {
    return null;
  }

  const providerName = nonEmptyString(config["model_provider"]);
  const providers = recordOrNull(config["model_providers"]);
  const provider = providerName === undefined ? null : recordOrNull(providers?.[providerName]);
  if (providerName === undefined || provider === null || provider["wire_api"] !== "responses") {
    return null;
  }
  const baseUrl = nonEmptyString(provider["base_url"]);
  const apiKey = nonEmptyString(auth["OPENAI_API_KEY"]);
  if (baseUrl === undefined || apiKey === undefined) {
    return null;
  }
  return {
    kind: "responses",
    source: "codex",
    provider: providerName,
    baseUrl: validateBaseUrl(baseUrl),
    apiKey,
    model: firstNonEmpty(environment["AGENT_TRIO_PLANNER_MODEL"]) ?? "gpt-5.6-sol",
    ...optionalServiceTier(environment, serviceTier, nonEmptyString(config["service_tier"])),
  };
}

function optionalServiceTier(
  environment: NodeJS.ProcessEnv,
  serviceTier: string | undefined,
  configuredTier?: string,
): { serviceTier?: string } {
  const value = firstNonEmpty(
    environment["AGENT_TRIO_PLANNER_SERVICE_TIER"],
    serviceTier,
    configuredTier,
  );
  return value === undefined ? {} : { serviceTier: value };
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Responses planner base URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Responses planner base URL must use HTTP(S)");
  }
  return value;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized !== undefined && normalized.length > 0) {
      return normalized;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = recordOrNull(value);
  if (record === null) {
    throw new TypeError("configuration root must be an object");
  }
  return record;
}
