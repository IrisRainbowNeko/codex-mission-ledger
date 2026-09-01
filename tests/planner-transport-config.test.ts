import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePlannerTransport } from "../src/planner-transport-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolvePlannerTransport", () => {
  it("selects the active Responses-compatible Codex provider without extra environment variables", () => {
    const codexHome = temporaryRoot();
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model_provider = "local"',
        'service_tier = "fast"',
        "[model_providers.local]",
        'wire_api = "responses"',
        'base_url = "https://provider.example/v1"',
        "requires_openai_auth = true",
      ].join("\n"),
    );
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "secret" }));

    expect(resolvePlannerTransport({ env: { CODEX_HOME: codexHome } })).toEqual({
      kind: "responses",
      source: "codex",
      provider: "local",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "gpt-5.6-sol",
      serviceTier: "fast",
    });
  });

  it("falls back to App Server when automatic Codex provider resolution is unavailable", () => {
    const codexHome = temporaryRoot();
    expect(resolvePlannerTransport({ env: { CODEX_HOME: codexHome } })).toEqual({
      kind: "app-server",
      source: "fallback",
    });
  });

  it("honors explicit App Server selection even when Codex Responses credentials exist", () => {
    expect(
      resolvePlannerTransport({
        env: {
          AGENT_TRIO_PLANNER_TRANSPORT: "app-server",
          AGENT_TRIO_PLANNER_API_KEY: "secret",
        },
      }),
    ).toEqual({ kind: "app-server", source: "explicit" });
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-trio-planner-config-"));
  roots.push(root);
  return root;
}
