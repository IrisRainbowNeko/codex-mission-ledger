import { describe, expect, it } from "vitest";
import { buildPluginIsolationArgs } from "../src/app-server/plugin-isolation.js";

describe("buildPluginIsolationArgs", () => {
  it("disables every unselected plugin and enables only selected plugin roots", () => {
    expect(
      buildPluginIsolationArgs(
        [
          { id: "browser@openai-bundled", enabled: true },
          { id: "documents@openai-primary-runtime", enabled: true },
          { id: "visualize@openai-bundled", enabled: true },
        ],
        {
          plugins: [{ kind: "plugin", name: "browser@openai-bundled" }],
          skills: [
            {
              kind: "skill",
              name: "documents",
              path: "/plugins/documents/SKILL.md",
              pluginId: "documents@openai-primary-runtime",
            },
          ],
          requiresIsolatedProcess: true,
        },
      ),
    ).toEqual([
      "--enable",
      "plugins",
      "-c",
      'plugins."browser@openai-bundled".enabled=true',
      "-c",
      'plugins."documents@openai-primary-runtime".enabled=true',
      "-c",
      'plugins."visualize@openai-bundled".enabled=false',
    ]);
  });

  it("fails closed if the selected plugin disappeared after capability resolution", () => {
    expect(() =>
      buildPluginIsolationArgs([], {
        plugins: [{ kind: "plugin", name: "browser@openai-bundled" }],
        skills: [],
        requiresIsolatedProcess: true,
      }),
    ).toThrow("selected plugins are no longer installed");
  });
});
