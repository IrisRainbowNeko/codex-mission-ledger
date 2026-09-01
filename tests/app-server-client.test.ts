import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppServerConnectionError,
  AppServerProtocolError,
  AppServerRequestError,
  CodexAppServerClient,
  ServerRequestError,
  textInput,
  type AppServerConnection,
  type JsonValue,
} from "../src/app-server/index.js";
import { AppServerAdapterError, runtimeFor } from "../src/app-server/adapters/runtime.js";

type WireMessage = Record<string, unknown>;

const INITIALIZE_RESULT = {
  userAgent: "codex_app_server/0.151.0",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

class FakeServer {
  readonly fromClient = new PassThrough();
  readonly toClient = new PassThrough();
  readonly messages: WireMessage[] = [];
  closeCalls = 0;
  onMessage: (message: WireMessage) => void = () => undefined;
  private clientBuffer = "";

  constructor() {
    this.fromClient.setEncoding("utf8");
    this.fromClient.on("data", (chunk: string) => {
      this.clientBuffer += chunk;
      let newline = this.clientBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.clientBuffer.slice(0, newline);
        this.clientBuffer = this.clientBuffer.slice(newline + 1);
        if (line.length > 0) {
          const message = JSON.parse(line) as WireMessage;
          this.messages.push(message);
          this.onMessage(message);
        }
        newline = this.clientBuffer.indexOf("\n");
      }
    });
  }

  get connection(): AppServerConnection {
    return {
      readable: this.toClient,
      writable: this.fromClient,
      close: async () => {
        this.closeCalls += 1;
        this.toClient.end();
        this.fromClient.end();
      },
    };
  }

  send(message: unknown): void {
    this.toClient.write(`${JSON.stringify(message)}\n`);
  }

  sendBytes(bytes: Buffer): void {
    this.toClient.write(bytes);
  }

  respond(message: WireMessage, result: unknown): void {
    this.send({ id: message["id"], result });
  }

  installHandshake(beforeResponse?: () => void): void {
    this.onMessage = (message) => {
      if (message["method"] === "initialize") {
        beforeResponse?.();
        this.respond(message, INITIALIZE_RESULT);
      }
    };
  }
}

const clients: CodexAppServerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
});

function createClient(server: FakeServer): CodexAppServerClient {
  const client = new CodexAppServerClient({
    connectionFactory: () => server.connection,
    requestTimeoutMs: 1_000,
  });
  clients.push(client);
  return client;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("CodexAppServerClient", () => {
  it("performs initialize/initialized and retains notifications emitted during the handshake", async () => {
    const server = new FakeServer();
    server.installHandshake(() => {
      server.send({
        method: "thread/started",
        params: { thread: { id: "early-thread" } },
        emittedAtMs: 42,
      });
    });
    const client = createClient(server);

    await expect(client.connect()).resolves.toEqual(INITIALIZE_RESULT);
    expect(client.state).toBe("ready");
    expect(server.messages[0]).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { version: "0.151.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(server.messages[1]).toEqual({ method: "initialized" });
    await expect(client.waitForNotification("thread/started")).resolves.toEqual({
      method: "thread/started",
      params: { thread: { id: "early-thread" } },
      emittedAtMs: 42,
    });
  });

  it("accepts the userAgent emitted by the pinned desktop app-server", async () => {
    const server = new FakeServer();
    server.onMessage = (message) => {
      if (message["method"] === "initialize") {
        server.respond(message, {
          ...INITIALIZE_RESULT,
          userAgent:
            "Codex Desktop/0.151.0 (Arch Linux Rolling Release; x86_64) dumb (codex-agent-trio; 0.151.0)",
        });
      }
    };
    const client = createClient(server);

    await expect(client.connect()).resolves.toMatchObject({
      userAgent:
        "Codex Desktop/0.151.0 (Arch Linux Rolling Release; x86_64) dumb (codex-agent-trio; 0.151.0)",
    });
  });

  it("rejects an initialize response from a different app-server version", async () => {
    const server = new FakeServer();
    server.onMessage = (message) => {
      if (message["method"] === "initialize") {
        server.respond(message, { ...INITIALIZE_RESULT, userAgent: "codex_app_server/0.152.0" });
      }
    };
    const client = createClient(server);

    await expect(client.connect()).rejects.toThrow(
      "codex app-server 0.151.0 is required; initialize returned 'codex_app_server/0.152.0'",
    );
    expect(client.state).toBe("disconnected");
    expect(server.closeCalls).toBe(1);
  });

  it("routes concurrent responses by id even when the server replies out of order", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();

    const first = client.request<{ value: string }>("test/first", { order: 1 });
    const second = client.request<{ value: string }>("test/second", { order: 2 });
    await tick();
    const firstRequest = server.messages.find((message) => message["method"] === "test/first");
    const secondRequest = server.messages.find((message) => message["method"] === "test/second");
    expect(firstRequest).toBeDefined();
    expect(secondRequest).toBeDefined();

    server.respond(secondRequest ?? {}, { value: "second" });
    server.respond(firstRequest ?? {}, { value: "first" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: "first" },
      { value: "second" },
    ]);
  });

  it("decodes fragmented UTF-8 JSONL, routes subscribers, and caches token usage", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();
    const subscriber = vi.fn();
    client.onNotification("thread/tokenUsage/updated", subscriber);

    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      label: "\u4f7f\u7528\u91cf",
      tokenUsage: {
        total: {
          totalTokens: 13,
          inputTokens: 8,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        last: {
          totalTokens: 13,
          inputTokens: 8,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 128_000,
      },
    };
    const frame = Buffer.from(
      `${JSON.stringify({ method: "thread/tokenUsage/updated", params })}\r\n`,
      "utf8",
    );
    const split = frame.indexOf(Buffer.from("\u4f7f", "utf8")) + 1;
    server.sendBytes(frame.subarray(0, split));
    server.sendBytes(frame.subarray(split));
    await tick();

    expect(subscriber).toHaveBeenCalledOnce();
    expect(client.latestThreadTokenUsage("thread-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: params.tokenUsage,
    });
    await expect(client.waitForNotification("thread/tokenUsage/updated")).resolves.toMatchObject({
      params: { label: "\u4f7f\u7528\u91cf" },
    });
  });

  it("defaults cache-write counts for legacy token notifications", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();

    const params = {
      threadId: "thread-legacy-cache",
      turnId: "turn-legacy-cache",
      tokenUsage: {
        total: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 3,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        last: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 3,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        modelContextWindow: null,
      },
    };
    server.send({ method: "thread/tokenUsage/updated", params });
    await tick();

    expect(client.latestThreadTokenUsage("thread-legacy-cache")).toMatchObject({
      tokenUsage: {
        total: { cacheWriteInputTokens: 0 },
        last: { cacheWriteInputTokens: 0 },
      },
    });
  });

  it("isolates exceptions from notification subscribers and waiter predicates", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const errors: Error[] = [];
    const client = new CodexAppServerClient({
      connectionFactory: () => server.connection,
      onError: (error) => errors.push(error),
    });
    clients.push(client);
    await client.connect();
    client.onNotification(() => {
      throw new Error("subscriber failed");
    });
    const waiter = client.waitForNotification("test/event", {
      predicate: () => {
        throw new Error("predicate failed");
      },
    });

    server.send({ method: "test/event", params: { value: 1 } });

    await expect(waiter).rejects.toThrow("predicate failed");
    await tick();
    expect(errors).toEqual([expect.objectContaining({ message: "subscriber failed" })]);
    expect(client.state).toBe("ready");
    await expect(client.waitForNotification("test/event")).resolves.toMatchObject({
      params: { value: 1 },
    });
  });

  it("answers dynamic tool and approval server requests through registered hooks", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = new CodexAppServerClient({
      connectionFactory: () => server.connection,
      onDynamicToolCall: async (request) => ({
        contentItems: [{ type: "inputText", text: `ran ${request.params.tool}` }],
        success: true,
      }),
      onApprovalRequest: async (request) => ({
        decision: request.method.includes("fileChange") ? "decline" : "accept",
      }),
    });
    clients.push(client);
    await client.connect();

    server.send({
      id: "server-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "lookup",
        arguments: { key: "value" },
      },
    });
    server.send({
      id: "server-approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    });
    await tick();

    expect(server.messages).toContainEqual({
      id: "server-tool-1",
      result: {
        contentItems: [{ type: "inputText", text: "ran lookup" }],
        success: true,
      },
    });
    expect(server.messages).toContainEqual({
      id: "server-approval-1",
      result: { decision: "decline" },
    });
  });

  it("returns JSON-RPC errors for missing handlers and deliberate hook failures", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    client.setServerRequestHandler("custom/fail", () => {
      throw new ServerRequestError(451, "denied", { reason: "policy" });
    });
    await client.connect();

    server.send({ id: 80, method: "custom/missing", params: {} });
    server.send({ id: 81, method: "custom/fail", params: {} });
    await tick();

    expect(server.messages).toContainEqual({
      id: 80,
      error: { code: -32601, message: "no handler registered for custom/missing" },
    });
    expect(server.messages).toContainEqual({
      id: 81,
      error: { code: 451, message: "denied", data: { reason: "policy" } },
    });
  });

  it("maps the V2 thread, turn, command, usage, and model helpers to their wire methods", async () => {
    const server = new FakeServer();
    const results: Record<string, JsonValue> = {
      "thread/start": {
        thread: { id: "thread-1" },
        model: "model",
        modelProvider: "openai",
        cwd: "/repo",
      },
      "thread/resume": {
        thread: { id: "thread-1" },
        model: "model",
        modelProvider: "openai",
        cwd: "/repo",
      },
      "thread/fork": {
        thread: { id: "thread-fork" },
        model: "model",
        modelProvider: "openai",
        cwd: "/repo",
      },
      "thread/inject_items": {},
      "thread/revert": {
        thread: { id: "thread-1" },
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      },
      "thread/read": { thread: { id: "thread-1" } },
      "turn/start": { turn: { id: "turn-1" } },
      "turn/steer": { turnId: "turn-1" },
      "turn/interrupt": {},
      "command/exec": { exitCode: 0, stdout: "ok\n", stderr: "" },
      "account/usage/read": {
        summary: {
          lifetimeTokens: null,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
        threadUsage: null,
      },
      "model/list": { data: [], nextCursor: null },
    };
    server.onMessage = (message) => {
      const method = message["method"];
      if (method === "initialize") {
        server.respond(message, INITIALIZE_RESULT);
      } else if (typeof method === "string" && method in results) {
        server.respond(message, results[method]);
      }
    };
    const client = createClient(server);
    await client.connect();

    await client.threadStart({ cwd: "/repo", dynamicTools: [] });
    await client.threadResume({ threadId: "thread-1", excludeTurns: true });
    await client.threadInjectItems({
      threadId: "thread-1",
      items: [{ type: "message", role: "user", content: [] }],
    });
    await client.threadFork({
      threadId: "thread-1",
      model: "model",
      cwd: "/repo",
      excludeTurns: true,
    });
    await client.threadRevert({ threadId: "thread-1", beforeTurnId: "turn-1" });
    await client.threadRead({ threadId: "thread-1", includeTurns: true });
    await client.turnStart({ threadId: "thread-1", input: [textInput("start")] });
    await client.turnSteer({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [textInput("steer")],
    });
    await client.turnInterrupt({ threadId: "thread-1", turnId: "turn-1" });
    await client.commandExec({
      command: ["npm", "test"],
      cwd: "/repo",
      timeoutMs: 5_000,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    await client.threadUsage("thread-1");
    await client.modelList({ includeHidden: true });

    expect(
      server.messages
        .filter((message) => message["id"] !== undefined && message["method"] !== "initialize")
        .map((message) => [message["method"], message["params"]]),
    ).toEqual([
      ["thread/start", { cwd: "/repo", dynamicTools: [] }],
      ["thread/resume", { threadId: "thread-1", excludeTurns: true }],
      [
        "thread/inject_items",
        {
          threadId: "thread-1",
          items: [{ type: "message", role: "user", content: [] }],
        },
      ],
      [
        "thread/fork",
        {
          threadId: "thread-1",
          model: "model",
          cwd: "/repo",
          excludeTurns: true,
        },
      ],
      ["thread/revert", { threadId: "thread-1", beforeTurnId: "turn-1" }],
      ["thread/read", { threadId: "thread-1", includeTurns: true }],
      ["turn/start", { threadId: "thread-1", input: [textInput("start")] }],
      [
        "turn/steer",
        { threadId: "thread-1", expectedTurnId: "turn-1", input: [textInput("steer")] },
      ],
      ["turn/interrupt", { threadId: "thread-1", turnId: "turn-1" }],
      [
        "command/exec",
        {
          command: ["npm", "test"],
          cwd: "/repo",
          timeoutMs: 5_000,
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      ],
      ["account/usage/read", { threadId: "thread-1" }],
      ["model/list", { includeHidden: true }],
    ]);
  });

  it("surfaces RPC errors without losing their code and data", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();
    const request = client.request("test/error", {});
    await tick();
    const message = server.messages.find((candidate) => candidate["method"] === "test/error");
    server.send({
      id: message?.["id"],
      error: { code: -32000, message: "failed", data: { retryable: false } },
    });

    const assertion = expect(request).rejects.toBeInstanceOf(AppServerRequestError);
    await assertion;
    await request.catch((error: unknown) => {
      expect(error).toMatchObject({ code: -32000, data: { retryable: false } });
    });
  });

  it("rejects rather than orphaning a request when an error envelope is malformed", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();
    const request = client.request("test/bad-error", {});
    await tick();
    const message = server.messages.find((candidate) => candidate["method"] === "test/bad-error");
    const rejected = expect(request).rejects.toBeInstanceOf(AppServerProtocolError);

    server.send({ id: message?.["id"], error: { code: "bad", message: "failed" } });

    await rejected;
    expect(client.state).toBe("disconnected");
  });

  it("rejects pending work on reconnect and uses a fresh connection with monotonic ids", async () => {
    const firstServer = new FakeServer();
    const secondServer = new FakeServer();
    firstServer.installHandshake();
    secondServer.installHandshake();
    const servers = [firstServer, secondServer];
    let factoryIndex = 0;
    const client = new CodexAppServerClient({
      connectionFactory: () => {
        const server = servers[factoryIndex];
        factoryIndex += 1;
        if (server === undefined) {
          throw new Error("unexpected extra connection");
        }
        return server.connection;
      },
    });
    clients.push(client);
    await client.connect();
    const pending = client.request("test/pending", {});
    const pendingAssertion = expect(pending).rejects.toBeInstanceOf(AppServerConnectionError);

    await client.reconnect();
    await pendingAssertion;
    expect(firstServer.closeCalls).toBe(1);
    expect(secondServer.messages[0]).toMatchObject({ id: 3, method: "initialize" });
    expect(client.state).toBe("ready");
  });

  it("does not let a delayed server request from an old connection write to the new one", async () => {
    const firstServer = new FakeServer();
    const secondServer = new FakeServer();
    firstServer.installHandshake();
    secondServer.installHandshake();
    const servers = [firstServer, secondServer];
    let factoryIndex = 0;
    let releaseHandler: (() => void) | undefined;
    let handlerStarted: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const client = new CodexAppServerClient({
      connectionFactory: () => {
        const server = servers[factoryIndex++];
        if (server === undefined) {
          throw new Error("unexpected extra connection");
        }
        return server.connection;
      },
    });
    clients.push(client);
    client.setServerRequestHandler("custom/slow", async () => {
      handlerStarted?.();
      await handlerGate;
      return { accepted: true };
    });
    await client.connect();
    firstServer.send({ id: "old-server-request", method: "custom/slow", params: {} });
    await started;

    await client.reconnect();
    releaseHandler?.();
    await tick();
    await tick();

    expect(secondServer.messages).not.toContainEqual({
      id: "old-server-request",
      result: { accepted: true },
    });
    expect(client.state).toBe("ready");
  });

  it("rejects active turn joins immediately when the transport disconnects", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();
    const runtime = runtimeFor(client);
    const waiting = runtime.waitForTurn("thread-1", "turn-1", { timeoutMs: 10_000 });
    const rejected = expect(waiting).rejects.toBeInstanceOf(AppServerConnectionError);

    server.toClient.end();

    await rejected;
  });

  it("retains terminal completions for late cancellation confirmation", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();
    const runtime = runtimeFor(client);
    server.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [],
          error: null,
          startedAt: 1_787_875_200,
          completedAt: 1_787_875_201,
        },
      },
    });
    await tick();

    const first = await runtime.waitForTurn("thread-1", "turn-1");
    const second = await runtime.waitForTurn("thread-1", "turn-1");

    expect(second).toEqual(first);
  });

  it("rejects turn joins on a malformed completion instead of timing out", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const client = createClient(server);
    await client.connect();
    const runtime = runtimeFor(client);
    const waiting = runtime.waitForTurn("thread-1", "turn-1", { timeoutMs: 10_000 });
    const rejected = expect(waiting).rejects.toBeInstanceOf(AppServerAdapterError);
    server.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "unknown", items: [] } },
    });

    await rejected;
  });

  it("waits for a canceled connection attempt before reconnecting with a fresh factory call", async () => {
    const canceledServer = new FakeServer();
    const activeServer = new FakeServer();
    activeServer.installHandshake();
    let releaseFirst: ((connection: AppServerConnection) => void) | undefined;
    const firstConnection = new Promise<AppServerConnection>((resolve) => {
      releaseFirst = resolve;
    });
    let factoryCalls = 0;
    const client = new CodexAppServerClient({
      connectionFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? firstConnection : activeServer.connection;
      },
    });
    clients.push(client);
    const initialConnect = client.connect();
    const initialRejection =
      expect(initialConnect).rejects.toBeInstanceOf(AppServerConnectionError);
    const reconnect = client.reconnect();

    releaseFirst?.(canceledServer.connection);

    await initialRejection;
    await expect(reconnect).resolves.toEqual(INITIALIZE_RESULT);
    expect(factoryCalls).toBe(2);
    expect(canceledServer.closeCalls).toBe(1);
    expect(activeServer.messages[0]).toMatchObject({ method: "initialize" });
  });

  it("closes the connection and rejects pending requests on malformed protocol input", async () => {
    const server = new FakeServer();
    server.installHandshake();
    const errors: Error[] = [];
    const client = new CodexAppServerClient({
      connectionFactory: () => server.connection,
      onError: (error) => errors.push(error),
    });
    clients.push(client);
    await client.connect();
    const pending = client.request("test/pending", {});
    const rejected = expect(pending).rejects.toBeInstanceOf(AppServerProtocolError);
    server.sendBytes(Buffer.from("{not-json}\n"));

    await rejected;
    expect(client.state).toBe("disconnected");
    expect(errors[0]).toBeInstanceOf(AppServerProtocolError);
    expect(server.closeCalls).toBe(1);
  });
});
