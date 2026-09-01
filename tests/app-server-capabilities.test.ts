import { describe, expect, it } from "vitest";
import { AppServerCapabilityCatalog } from "../src/app-server/capabilities.js";
import type {
  AppServer,
  AppServerNotification,
  AppServerState,
  InitializeResponse,
  JsonValue,
  ModelListParams,
  NotificationHandler,
  NotificationWaitOptions,
  RequestOptions,
  ServerRequestHandler,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdated,
  ThreadUsageResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "../src/app-server/types.js";

const INITIALIZED: InitializeResponse = {
  userAgent: "codex_app_server/0.151.0",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

interface RequestCall {
  method: string;
  params: unknown;
}

class CatalogAppServer implements AppServer {
  state: AppServerState = "ready";
  initializeResult: InitializeResponse | null = INITIALIZED;
  readonly requests: RequestCall[] = [];
  readonly responses = new Map<string, unknown>();
  connectCalls = 0;

  async connect(): Promise<InitializeResponse> {
    this.connectCalls += 1;
    this.state = "ready";
    return INITIALIZED;
  }

  reconnect(): Promise<InitializeResponse> {
    return this.connect();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  request<TResult = JsonValue>(
    method: string,
    params?: unknown,
    _options?: RequestOptions,
  ): Promise<TResult> {
    this.requests.push({ method, params });
    if (!this.responses.has(method)) {
      return Promise.reject(new Error(`unexpected request: ${method}`));
    }
    return Promise.resolve(this.responses.get(method) as TResult);
  }

  notify(_method: string, _params?: unknown): Promise<void> {
    return Promise.resolve();
  }

  onNotification(_handler: NotificationHandler): () => void;
  onNotification(_method: string, _handler: NotificationHandler): () => void;
  onNotification(
    _methodOrHandler: string | NotificationHandler,
    _handler?: NotificationHandler,
  ): () => void {
    return () => undefined;
  }

  waitForNotification(
    _method?: string,
    _options?: NotificationWaitOptions,
  ): Promise<AppServerNotification> {
    return Promise.reject(new Error("not implemented"));
  }

  setServerRequestHandler(_method: string, _handler: ServerRequestHandler | null): void {}

  threadStart(_params: ThreadStartParams): Promise<ThreadStartResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  threadResume(_params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  threadRead(_params: ThreadReadParams): Promise<ThreadReadResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  turnStart(_params: TurnStartParams): Promise<TurnStartResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  turnSteer(_params: TurnSteerParams): Promise<TurnSteerResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  turnInterrupt(_params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  threadUsage(_threadId: string): Promise<ThreadUsageResponse> {
    return Promise.reject(new Error("not implemented"));
  }

  modelList(_params?: ModelListParams): Promise<never> {
    return Promise.reject(new Error("not implemented"));
  }

  latestThreadTokenUsage(_threadId: string): ThreadTokenUsageUpdated | null {
    return null;
  }
}

describe("AppServerCapabilityCatalog", () => {
  it("parses skill source identity and deduplicates only identical sources", async () => {
    const server = new CatalogAppServer();
    server.responses.set("skills/list", {
      data: [
        {
          cwd: "/workspace/project",
          skills: [
            {
              name: "documents",
              path: "/skills/documents",
              enabled: true,
              pluginId: null,
              scope: "system",
              description: "ignored protocol metadata",
            },
            {
              name: "documents",
              path: "/skills/documents",
              enabled: true,
              pluginId: null,
              scope: "system",
            },
            {
              name: "documents",
              path: "/skills/documents",
              enabled: true,
              pluginId: null,
              scope: "repo",
            },
            {
              name: "documents",
              path: "/workspace/.agents/skills/documents",
              enabled: false,
              pluginId: null,
              scope: "repo",
            },
          ],
        },
      ],
    });
    const catalog = new AppServerCapabilityCatalog({
      appServer: server,
      cwd: "/workspace/default",
    });

    await expect(catalog.listSkills("/workspace/project")).resolves.toEqual([
      {
        name: "documents",
        path: "/skills/documents",
        enabled: true,
        pluginId: null,
        source: "system",
      },
      {
        name: "documents",
        path: "/skills/documents",
        enabled: true,
        pluginId: null,
        source: "repo",
      },
      {
        name: "documents",
        path: "/workspace/.agents/skills/documents",
        enabled: false,
        pluginId: null,
        source: "repo",
      },
    ]);
    expect(server.requests).toEqual([
      {
        method: "skills/list",
        params: { cwds: ["/workspace/project"], forceReload: false },
      },
    ]);
  });

  it("hides plugin-owned skills and never requests plugins when plugins are disabled", async () => {
    const server = new CatalogAppServer();
    server.responses.set("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "local-skill",
              path: "/skills/local",
              enabled: true,
              pluginId: null,
              scope: "user",
            },
            {
              name: "plugin-skill",
              path: "/plugins/office/skills/documents",
              enabled: true,
              pluginId: "office",
              scope: "system",
            },
          ],
        },
      ],
    });
    const catalog = new AppServerCapabilityCatalog({
      appServer: server,
      cwd: "/workspace",
      includePlugins: false,
    });

    await expect(catalog.listSkills("/workspace")).resolves.toEqual([
      {
        name: "local-skill",
        path: "/skills/local",
        enabled: true,
        pluginId: null,
        source: "user",
      },
    ]);
    await expect(catalog.listPlugins()).resolves.toEqual([]);
    expect(server.requests.map((request) => request.method)).toEqual(["skills/list"]);
  });

  it("never advertises recursive orchestration skills or plugins", async () => {
    const server = new CatalogAppServer();
    server.responses.set("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "agent_trio",
              path: "/skills/agent-trio",
              enabled: true,
              pluginId: null,
              scope: "repo",
            },
            {
              name: "ordinary",
              path: "/workspace/hierarchical-codex/.agents/skills/ordinary/SKILL.md",
              enabled: true,
              scope: "repo",
            },
            {
              name: "recursive-owner",
              path: "/skills/ordinary/SKILL.md",
              enabled: true,
              pluginId: "hierarchical_codex@personal",
              scope: "user",
            },
          ],
        },
      ],
    });
    server.responses.set("plugin/installed", {
      marketplaces: [
        {
          plugins: [
            { id: "hierarchical_codex", installed: true, enabled: true },
            { id: "browser", installed: true, enabled: true },
          ],
        },
      ],
    });
    const catalog = new AppServerCapabilityCatalog({
      appServer: server,
      cwd: "/workspace",
      includePlugins: true,
    });

    await expect(catalog.listSkills("/workspace")).resolves.toEqual([
      {
        name: "ordinary",
        path: "/workspace/hierarchical-codex/.agents/skills/ordinary/SKILL.md",
        enabled: true,
        pluginId: null,
        source: "repo",
      },
    ]);
    await expect(catalog.listPlugins()).resolves.toEqual([{ id: "browser", enabled: true }]);
  });

  it("returns only installed plugins, preserves enabled state, and deduplicates by id", async () => {
    const server = new CatalogAppServer();
    server.responses.set("plugin/installed", {
      marketplaces: [
        {
          name: "personal",
          plugins: [
            { id: "documents", installed: true, enabled: false, version: "1.0.0" },
            { id: "browser", installed: false, enabled: true },
          ],
        },
        {
          name: "bundled",
          plugins: [
            { id: "documents", installed: true, enabled: true },
            { id: "spreadsheets", installed: true, enabled: true },
          ],
        },
      ],
    });
    const catalog = new AppServerCapabilityCatalog({
      appServer: server,
      cwd: "/workspace/project",
      includePlugins: true,
    });

    await expect(catalog.listPlugins()).resolves.toEqual([
      { id: "documents", enabled: false },
      { id: "spreadsheets", enabled: true },
    ]);
    expect(server.requests).toEqual([
      {
        method: "plugin/installed",
        params: {
          cwds: ["/workspace/project"],
          installSuggestionPluginNames: [],
        },
      },
    ]);
  });

  it.each([
    ["invalid skill response", "skills", { data: null }, "invalid response"],
    ["invalid skill catalog entry", "skills", { data: [{}] }, "malformed catalog metadata"],
    [
      "invalid skill metadata",
      "skills",
      { data: [{ cwd: "/workspace", skills: [{ name: "broken" }] }] },
      "malformed skill metadata",
    ],
    [
      "invalid skill scope",
      "skills",
      {
        data: [
          {
            cwd: "/workspace",
            skills: [
              {
                name: "broken",
                path: "/skills/broken",
                enabled: true,
                pluginId: null,
                scope: "workspace",
              },
            ],
          },
        ],
      },
      "malformed skill metadata",
    ],
    [
      "mismatched skill cwd",
      "skills",
      { data: [{ cwd: "/other-workspace", skills: [] }] },
      "mismatched cwd metadata",
    ],
    ["invalid plugin response", "plugins", { marketplaces: null }, "invalid response"],
    [
      "invalid marketplace entry",
      "plugins",
      { marketplaces: [{}] },
      "malformed marketplace metadata",
    ],
    [
      "invalid plugin metadata",
      "plugins",
      { marketplaces: [{ plugins: [{ id: "broken" }] }] },
      "malformed plugin metadata",
    ],
  ] as const)("fails closed for %s", async (_name, capability, response, expected) => {
    const server = new CatalogAppServer();
    server.responses.set(capability === "skills" ? "skills/list" : "plugin/installed", response);
    const catalog = new AppServerCapabilityCatalog({
      appServer: server,
      cwd: "/workspace",
      includePlugins: true,
    });

    const operation =
      capability === "skills" ? catalog.listSkills("/workspace") : catalog.listPlugins();
    await expect(operation).rejects.toThrow(expected);
  });
});
