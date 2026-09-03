import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityResolver } from "../src/core/capabilities.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CapabilityResolver", () => {
  it("loads only requested skills and marks plugin-backed skills isolated", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const doc = join(root, "documents");
    const sheet = join(root, "spreadsheets");
    mkdirSync(doc);
    mkdirSync(sheet);
    const resolver = new CapabilityResolver(
      {
        listSkills: async () => [
          {
            name: "documents",
            path: doc,
            enabled: true,
            pluginId: "office",
            source: "system",
          },
          {
            name: "spreadsheets",
            path: sheet,
            enabled: true,
            pluginId: null,
            source: "user",
          },
        ],
        listPlugins: async () => [],
      },
      { allowPlugins: true },
    );
    const result = await resolver.resolve([{ kind: "skill", name: "documents" }], root);
    expect(result.skills.map((skill) => skill.name)).toEqual(["documents"]);
    expect(result.skills[0]?.source).toBe("system");
    expect(result.requiresIsolatedProcess).toBe(true);
  });

  it("requires an exact path for duplicate names and preserves the selected source", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const repoSkill = join(root, "repo-documents");
    const systemSkill = join(root, "system-documents");
    mkdirSync(repoSkill);
    mkdirSync(systemSkill);
    const resolver = new CapabilityResolver({
      listSkills: async () => [
        {
          name: "documents",
          path: repoSkill,
          enabled: true,
          pluginId: null,
          source: "repo",
        },
        {
          name: "documents",
          path: systemSkill,
          enabled: true,
          pluginId: null,
          source: "system",
        },
      ],
      listPlugins: async () => [],
    });

    await expect(resolver.resolve([{ kind: "skill", name: "documents" }], root)).rejects.toThrow(
      "requested skill is ambiguous",
    );
    await expect(
      resolver.resolve([{ kind: "skill", name: "documents", path: systemSkill }], root),
    ).resolves.toMatchObject({
      skills: [
        {
          name: "documents",
          path: systemSkill,
          pluginId: null,
          source: "system",
        },
      ],
    });
  });

  it("does not collapse identical paths reported by different sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const skill = join(root, "documents");
    mkdirSync(skill);
    const resolver = new CapabilityResolver({
      listSkills: async () => [
        {
          name: "documents",
          path: skill,
          enabled: true,
          pluginId: null,
          source: "repo",
        },
        {
          name: "documents",
          path: skill,
          enabled: true,
          pluginId: null,
          source: "user",
        },
      ],
      listPlugins: async () => [],
    });

    await expect(
      resolver.resolve([{ kind: "skill", name: "documents", path: skill }], root),
    ).rejects.toThrow("requested skill is ambiguous");
  });

  it("rejects plugin-backed skills even when an injected catalog exposes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const doc = join(root, "documents");
    mkdirSync(doc);
    const resolver = new CapabilityResolver({
      listSkills: async () => [{ name: "documents", path: doc, enabled: true, pluginId: "office" }],
      listPlugins: async () => [],
    });

    await expect(resolver.resolve([{ kind: "skill", name: "documents" }], root)).rejects.toThrow(
      "plugin-backed skill capabilities are disabled",
    );
  });

  it.each([
    "agent-trio",
    "agent-trio-session",
    "agent-trio-quality",
    "agent-trio-quality-session",
    "hierarchical_codex",
    "codex mission ledger",
  ])("always rejects recursive orchestration capability %s", async (name) => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const skill = join(root, "agent-trio");
    mkdirSync(skill);
    const resolver = new CapabilityResolver({
      listSkills: async () => [{ name, path: skill, enabled: true, pluginId: null }],
      listPlugins: async () => [],
    });
    await expect(resolver.resolve([{ kind: "skill", name }], root)).rejects.toThrow("forbidden");
  });

  it("rejects recursive plugins and skills owned by recursive plugins", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const skill = join(root, "ordinary");
    mkdirSync(skill);
    const resolver = new CapabilityResolver(
      {
        listSkills: async () => [
          {
            name: "ordinary",
            path: skill,
            enabled: true,
            pluginId: "hierarchical_codex@personal",
            source: "user",
          },
        ],
        listPlugins: async () => [{ id: "agent-trio@personal", enabled: true }],
      },
      { allowPlugins: true },
    );

    await expect(
      resolver.resolve([{ kind: "plugin", name: "agent-trio@personal" }], root),
    ).rejects.toThrow("forbidden");
    await expect(resolver.resolve([{ kind: "skill", name: "ordinary" }], root)).rejects.toThrow(
      "forbidden",
    );
  });

  it("rejects a deceptively named skill whose own directory is recursive", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-trio-cap-"));
    roots.push(root);
    const skill = join(root, "agent-trio");
    mkdirSync(skill);
    const resolver = new CapabilityResolver({
      listSkills: async () => [{ name: "ordinary", path: skill, enabled: true, pluginId: null }],
      listPlugins: async () => [],
    });

    await expect(resolver.resolve([{ kind: "skill", name: "ordinary" }], root)).rejects.toThrow(
      "forbidden",
    );
  });
});
