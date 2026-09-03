import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BatchResult } from "../src/core/contracts.js";
import { createMcpServer, runMcpStdio } from "../src/mcp/server.js";

function result(runId: string, status: BatchResult["status"] = "pending"): BatchResult {
  return {
    protocolVersion: 1,
    runId,
    status,
    plan: null,
    patch: null,
    leaves: [],
    finalResponse: status === "completed" ? "ok" : null,
    metrics: null,
  };
}

function writeWorkspaceHandshake(input: PassThrough): void {
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: { roots: {} } },
    }) + "\n",
  );
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "agent-trio-roots-1",
      result: { roots: [{ uri: pathToFileURL("/tmp").href }] },
    }) + "\n",
  );
}

function writeSubmit(input: PassThrough, id: number, runId?: string): void {
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "agent_trio",
        arguments: {
          action: "submit",
          objective: "durable task",
          cwd: "/tmp",
          ...(runId === undefined ? {} : { runId }),
        },
      },
    }) + "\n",
  );
}

describe("V3 MCP server", () => {
  it("runs the protocol over stdio and exposes exactly agent_trio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => chunks.push(chunk));
    const handle = vi.fn();
    const running = createMcpServer({ handle }, input, output).run();

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }) + "\n",
    );
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await vi.waitFor(() => expect(chunks.join("")).toContain('"id":2'));
    input.end();
    await running;

    const messages = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const list = messages.find((message) => message["id"] === 2);
    expect(list).toMatchObject({
      result: { tools: [{ name: "agent_trio", defer_loading: true }] },
    });
    expect((list as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it("forwards agent_trio calls to the shared service", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const text: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => text.push(chunk));
    const result = { runId: "run-1", status: "completed", finalResponse: "ok", leaves: [] };
    const handle = vi.fn().mockResolvedValue(result);
    const running = createMcpServer({ handle }, input, output).run();
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: {} },
      }) + "\n",
    );
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "agent_trio", arguments: { action: "status", runId: "run-1" } },
      }) + "\n",
    );
    await vi.waitFor(() => expect(text.join("")).toContain('"id":2'));
    input.end();
    await running;
    expect(handle).toHaveBeenCalledWith({ action: "status", runId: "run-1" });
  });

  it("forwards optional resume input unchanged", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const handle = vi.fn(async () => result("run-1", "completed"));
    const running = createMcpServer({ handle }, input, output).run();
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: {} },
      }) + "\n",
    );
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: {
            action: "resume",
            runId: "run-1",
            input: "permission granted",
          },
        },
      }) + "\n",
    );
    await vi.waitFor(() => expect(text).toContain('"id":2'));
    input.end();
    await running;

    expect(handle).toHaveBeenCalledWith({
      action: "resume",
      runId: "run-1",
      input: "permission granted",
    });
  });

  it("dispatches submit to the detached supervisor with one generated run id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = vi.fn();
    const generateRunId = vi.fn(() => "generated-run");
    const launchSupervisor = vi.fn(async (request) => result(request.runId));
    const running = createMcpServer({ handle }, input, output, process.stderr, {
      generateRunId,
      launchSupervisor,
    }).run();

    writeWorkspaceHandshake(input);
    writeSubmit(input, 2);
    input.end();
    await running;

    expect(generateRunId).toHaveBeenCalledOnce();
    expect(launchSupervisor).toHaveBeenCalledWith({
      action: "submit",
      objective: "durable task",
      cwd: "/tmp",
      runId: "generated-run",
      profile: "balanced",
      constraints: ["agent-trio:root-dispatch"],
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("preserves a supplied submit run id and does not generate another", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = vi.fn();
    const generateRunId = vi.fn(() => "should-not-be-used");
    const launchSupervisor = vi.fn(async (request) => result(request.runId));
    const running = createMcpServer({ handle }, input, output, process.stderr, {
      generateRunId,
      launchSupervisor,
    }).run();

    writeWorkspaceHandshake(input);
    writeSubmit(input, 2, "supplied-run");
    input.end();
    await running;

    expect(generateRunId).not.toHaveBeenCalled();
    expect(launchSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit", runId: "supplied-run" }),
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("starts Monitor-first work with foreground semantics and waits once by run id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const handle = vi.fn();
    const waitForSettlement = vi.fn(async () => result("visible-run", "completed"));
    const launchSupervisor = vi.fn(async (request) => result(request.runId));
    const running = createMcpServer({ handle, waitForSettlement }, input, output, process.stderr, {
      generateRunId: () => "visible-run",
      launchSupervisor,
      monitorUrlForRun: (runId) => `http://127.0.0.1:43173/runs/${runId}?token=test`,
    }).run();

    writeWorkspaceHandshake(input);
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: {
            action: "submit",
            objective: "visible foreground task",
            cwd: "/tmp",
            strategy: "auto",
            monitorFirst: true,
          },
        },
      }) + "\n",
    );
    await vi.waitFor(() => expect(text).toContain('"id":2'));
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: { action: "status", runId: "visible-run", wait: true },
        },
      }) + "\n",
    );
    input.end();
    await running;

    expect(launchSupervisor).toHaveBeenCalledWith({
      action: "run",
      objective: "visible foreground task",
      cwd: "/tmp",
      strategy: "auto",
      runId: "visible-run",
      profile: "balanced",
      constraints: ["agent-trio:root-dispatch"],
    });
    expect(waitForSettlement).toHaveBeenCalledOnce();
    expect(waitForSettlement).toHaveBeenCalledWith("visible-run");
    expect(handle).not.toHaveBeenCalled();
    expect(text).toContain("Open Agent Trio Monitor");
  });

  it("loads and closes the default runtime around the stdio protocol", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const close = vi.fn();
    const handle = vi.fn();
    const createRuntime = vi.fn(async () => ({ service: { handle }, close }));

    const running = runMcpStdio({ createRuntime, input, output });
    input.end();
    await running;

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("writes the supervisor acceptance before closing the runtime at EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    let accept: ((value: BatchResult) => void) | undefined;
    const accepted = new Promise<BatchResult>((resolve) => {
      accept = resolve;
    });
    const handle = vi.fn();
    const close = vi.fn(() => {
      expect(text).toContain('"id":9');
      expect(text).toContain('"runId":"durable-run"');
    });
    const launchSupervisor = vi.fn(() => accepted);
    const running = runMcpStdio({
      createRuntime: async () => ({ service: { handle }, close }),
      input,
      output,
      launchSupervisor,
      generateRunId: () => "durable-run",
    });

    writeWorkspaceHandshake(input);
    writeSubmit(input, 9);
    input.end();
    await vi.waitFor(() => expect(launchSupervisor).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    accept?.(result("durable-run"));
    await running;

    expect(handle).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
