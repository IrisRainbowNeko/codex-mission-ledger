import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { CapabilityRef } from "./contracts.js";

const RECURSIVE_ORCHESTRATION_NAMES = new Set([
  "agent-trio",
  "hierarchical-codex",
  "codex-mission-ledger",
]);

export const SKILL_SOURCES = ["user", "repo", "system", "admin"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillDescriptor {
  name: string;
  path: string;
  enabled: boolean;
  pluginId: string | null;
  /** App Server's skill scope, retained as source identity when available. */
  source?: SkillSource;
}

export interface PluginDescriptor {
  id: string;
  enabled: boolean;
}

export interface CapabilityCatalog {
  listSkills(cwd: string): Promise<SkillDescriptor[]>;
  listPlugins(): Promise<PluginDescriptor[]>;
}

export interface ResolvedSkill {
  kind: "skill";
  name: string;
  path: string;
  pluginId: string | null;
  source?: SkillSource;
}

export interface ResolvedPlugin {
  kind: "plugin";
  name: string;
}

export interface ResolvedCapabilities {
  skills: ResolvedSkill[];
  plugins: ResolvedPlugin[];
  requiresIsolatedProcess: boolean;
}

export interface CapabilityResolverOptions {
  allowPlugins?: boolean;
  forbiddenSkillNames?: readonly string[];
  forbiddenRoots?: readonly string[];
}

/** Resolves only explicitly requested capabilities and excludes this framework's own skill. */
export class CapabilityResolver {
  readonly #catalog: CapabilityCatalog;
  readonly #allowPlugins: boolean;
  readonly #forbiddenNames: Set<string>;
  readonly #forbiddenRoots: string[];

  constructor(catalog: CapabilityCatalog, options: CapabilityResolverOptions = {}) {
    this.#catalog = catalog;
    this.#allowPlugins = options.allowPlugins ?? false;
    this.#forbiddenNames = new Set(
      (options.forbiddenSkillNames ?? [...RECURSIVE_ORCHESTRATION_NAMES]).map(
        normalizeCapabilityName,
      ),
    );
    this.#forbiddenRoots = (options.forbiddenRoots ?? []).map((root) => realpathSync(root));
  }

  async resolve(requested: readonly CapabilityRef[], cwd: string): Promise<ResolvedCapabilities> {
    const recursiveRequest = requested.find((item) =>
      isRecursiveOrchestrationCapabilityName(item.name),
    );
    if (recursiveRequest !== undefined) {
      throw new Error(
        `${recursiveRequest.kind} ${recursiveRequest.name} is forbidden in Agent Trio workers`,
      );
    }

    const skillRequests = requested.filter((item) => item.kind === "skill");
    const pluginRequests = requested.filter((item) => item.kind === "plugin");
    const catalogSkills = skillRequests.length === 0 ? [] : await this.#catalog.listSkills(cwd);
    const catalogPlugins = pluginRequests.length === 0 ? [] : await this.#catalog.listPlugins();

    const skills = skillRequests.map((request) => {
      if (this.#forbiddenNames.has(normalizeCapabilityName(request.name))) {
        throw new Error(`skill ${request.name} is forbidden in Agent Trio workers`);
      }
      const matches = uniqueBy(
        catalogSkills.filter(
          (skill) =>
            skill.enabled &&
            skill.name === request.name &&
            (request.path === undefined || realPathEquals(skill.path, request.path)),
        ),
        skillDescriptorKey,
      );
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `requested skill not found: ${request.name}`
            : `requested skill is ambiguous: ${request.name}`,
        );
      }
      const match = matches[0];
      if (match === undefined) {
        throw new Error(`requested skill not found: ${request.name}`);
      }
      let path: string;
      try {
        path = realpathSync(match.path);
      } catch {
        throw new Error(`requested skill path is unavailable: ${request.name}`);
      }
      if (
        isRecursiveOrchestrationCapabilityPath(path) ||
        this.#isForbiddenPath(path) ||
        (match.pluginId !== null && isRecursiveOrchestrationCapabilityName(match.pluginId))
      ) {
        throw new Error(`skill ${request.name} resolves inside a forbidden root`);
      }
      if (match.pluginId !== null && !this.#allowPlugins) {
        throw new Error(`plugin-backed skill capabilities are disabled: ${request.name}`);
      }
      return {
        kind: "skill" as const,
        name: match.name,
        path,
        pluginId: match.pluginId,
        ...(match.source === undefined ? {} : { source: match.source }),
      };
    });

    const plugins = pluginRequests.map((request) => {
      if (!this.#allowPlugins) {
        throw new Error(`plugin capabilities are disabled: ${request.name}`);
      }
      const matches = catalogPlugins.filter(
        (plugin) => plugin.enabled && plugin.id === request.name,
      );
      if (matches.length !== 1) {
        throw new Error(`requested plugin not found or ambiguous: ${request.name}`);
      }
      return { kind: "plugin" as const, name: request.name };
    });

    return {
      skills: uniqueBy(
        skills,
        (skill) =>
          `${skill.name}\u0000${skill.path}\u0000${skill.source ?? ""}\u0000${skill.pluginId ?? ""}`,
      ),
      plugins: uniqueBy(plugins, (plugin) => plugin.name),
      requiresIsolatedProcess:
        plugins.length > 0 || skills.some((skill) => skill.pluginId !== null),
    };
  }

  #isForbiddenPath(real: string): boolean {
    return this.#forbiddenRoots.some((root) => {
      const rel = relative(root, real);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }
}

export function isRecursiveOrchestrationCapabilityName(value: string): boolean {
  const normalized = normalizeCapabilityName(value);
  return (
    RECURSIVE_ORCHESTRATION_NAMES.has(normalized) ||
    [...RECURSIVE_ORCHESTRATION_NAMES].some((name) => normalized.startsWith(`${name}@`))
  );
}

/** Checks the skill's own directory, without treating an ancestor workspace name as the skill. */
export function isRecursiveOrchestrationCapabilityPath(value: string): boolean {
  const segments = value.split(/[\\/]/u).filter(Boolean);
  const leaf = segments.at(-1);
  if (leaf === undefined) {
    return false;
  }
  const candidate = leaf.toLowerCase() === "skill.md" ? segments.at(-2) : leaf;
  return candidate !== undefined && isRecursiveOrchestrationCapabilityName(candidate);
}

export function isSkillSource(value: unknown): value is SkillSource {
  return typeof value === "string" && (SKILL_SOURCES as readonly string[]).includes(value);
}

function realPathEquals(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function skillDescriptorKey(skill: SkillDescriptor): string {
  let path = skill.path;
  try {
    path = realpathSync(path);
  } catch {
    // The resolver will reject an unavailable selected path with a stable error.
  }
  return `${skill.name}\u0000${path}\u0000${skill.source ?? ""}\u0000${skill.pluginId ?? ""}`;
}

function normalizeCapabilityName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\$/u, "")
    .replace(/[\s_]+/gu, "-");
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}
