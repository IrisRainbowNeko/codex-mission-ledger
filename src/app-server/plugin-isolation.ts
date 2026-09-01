import type { PluginDescriptor, ResolvedCapabilities } from "../core/capabilities.js";

/** Build final CLI overrides so an isolated process loads only explicitly selected plugins. */
export function buildPluginIsolationArgs(
  installedPlugins: readonly PluginDescriptor[],
  capabilities: ResolvedCapabilities,
): string[] {
  const selected = new Set([
    ...capabilities.plugins.map((plugin) => plugin.name),
    ...capabilities.skills.flatMap((skill) => (skill.pluginId === null ? [] : [skill.pluginId])),
  ]);
  if (selected.size === 0) {
    throw new Error("plugin isolation requires at least one selected plugin");
  }

  const installed = new Set(installedPlugins.map((plugin) => plugin.id));
  const missing = [...selected].filter((pluginId) => !installed.has(pluginId));
  if (missing.length > 0) {
    throw new Error(`selected plugins are no longer installed: ${missing.join(", ")}`);
  }

  const args = ["--enable", "plugins"];
  for (const pluginId of [...installed].sort()) {
    args.push(
      "-c",
      `plugins.${tomlQuotedKey(pluginId)}.enabled=${selected.has(pluginId) ? "true" : "false"}`,
    );
  }
  return args;
}

function tomlQuotedKey(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}
