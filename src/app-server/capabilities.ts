import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  isRecursiveOrchestrationCapabilityName,
  isRecursiveOrchestrationCapabilityPath,
  isSkillSource,
  type CapabilityCatalog,
  type PluginDescriptor,
  type SkillDescriptor,
} from "../core/capabilities.js";
import { ensureConnected } from "./adapters/runtime.js";
import type { AppServer } from "./types.js";

export interface AppServerCapabilityCatalogOptions {
  appServer: AppServer;
  cwd: string;
  includePlugins?: boolean;
}

/** Capability discovery through the App Server API. */
export class AppServerCapabilityCatalog implements CapabilityCatalog {
  readonly #appServer: AppServer;
  readonly #cwd: string;
  readonly #includePlugins: boolean;

  constructor(options: AppServerCapabilityCatalogOptions) {
    this.#appServer = options.appServer;
    this.#cwd = options.cwd;
    this.#includePlugins = options.includePlugins ?? false;
  }

  async listSkills(cwd: string): Promise<SkillDescriptor[]> {
    await ensureConnected(this.#appServer);
    const response = await this.#appServer.request<unknown>("skills/list", {
      cwds: [cwd],
      forceReload: false,
    });
    if (!isRecord(response) || !Array.isArray(response["data"])) {
      throw new Error("skills/list returned an invalid response");
    }
    const skills: SkillDescriptor[] = [];
    for (const entry of response["data"]) {
      if (!isRecord(entry) || typeof entry["cwd"] !== "string" || !Array.isArray(entry["skills"])) {
        throw new Error("skills/list returned malformed catalog metadata");
      }
      if (!sameLocation(entry["cwd"], cwd)) {
        throw new Error("skills/list returned mismatched cwd metadata");
      }
      for (const skill of entry["skills"]) {
        if (
          !isRecord(skill) ||
          typeof skill["name"] !== "string" ||
          typeof skill["path"] !== "string" ||
          typeof skill["enabled"] !== "boolean" ||
          !isSkillSource(skill["scope"]) ||
          (skill["pluginId"] !== undefined &&
            skill["pluginId"] !== null &&
            typeof skill["pluginId"] !== "string")
        ) {
          throw new Error("skills/list returned malformed skill metadata");
        }
        const pluginId = skill["pluginId"] ?? null;
        if (pluginId !== null && !this.#includePlugins) {
          continue;
        }
        if (
          isRecursiveOrchestrationCapabilityName(skill["name"]) ||
          isRecursiveOrchestrationCapabilityPath(skill["path"]) ||
          (pluginId !== null && isRecursiveOrchestrationCapabilityName(pluginId))
        ) {
          continue;
        }
        skills.push({
          name: skill["name"],
          path: skill["path"],
          enabled: skill["enabled"],
          pluginId,
          source: skill["scope"],
        });
      }
    }
    return uniqueBy(
      skills,
      (skill) =>
        `${skill.name}\u0000${skill.path}\u0000${skill.source ?? ""}\u0000${skill.pluginId ?? ""}`,
    );
  }

  async listPlugins(): Promise<PluginDescriptor[]> {
    if (!this.#includePlugins) {
      return [];
    }
    await ensureConnected(this.#appServer);
    const response = await this.#appServer.request<unknown>("plugin/installed", {
      cwds: [this.#cwd],
      installSuggestionPluginNames: [],
    });
    if (!isRecord(response) || !Array.isArray(response["marketplaces"])) {
      throw new Error("plugin/installed returned an invalid response");
    }
    const plugins: PluginDescriptor[] = [];
    for (const marketplace of response["marketplaces"]) {
      if (!isRecord(marketplace) || !Array.isArray(marketplace["plugins"])) {
        throw new Error("plugin/installed returned malformed marketplace metadata");
      }
      for (const plugin of marketplace["plugins"]) {
        if (
          !isRecord(plugin) ||
          typeof plugin["id"] !== "string" ||
          typeof plugin["enabled"] !== "boolean" ||
          typeof plugin["installed"] !== "boolean"
        ) {
          throw new Error("plugin/installed returned malformed plugin metadata");
        }
        if (plugin["installed"]) {
          if (isRecursiveOrchestrationCapabilityName(plugin["id"])) {
            continue;
          }
          plugins.push({ id: plugin["id"], enabled: plugin["enabled"] });
        }
      }
    }
    return uniqueBy(plugins, (plugin) => plugin.id);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameLocation(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {
    return true;
  }
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
