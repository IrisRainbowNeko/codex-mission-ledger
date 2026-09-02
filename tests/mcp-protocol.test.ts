import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BatchResult } from "../src/core/contracts.js";
import {
  AGENT_TRIO_TOOL_DESCRIPTION,
  AGENT_TRIO_TOOL_SCHEMA,
  AgentTrioMcpProtocol,
  parseAgentTrioRequest,
} from "../src/mcp/protocol.js";

function result(): BatchResult {
  return {
    protocolVersion: 1,
    runId: "run-1",
    status: "completed",
    plan: null,
    patch: null,
    leaves: [],
    finalResponse: "done",
    metrics: null,
  };
}

describe("AgentTrioMcpProtocol", () => {
  it("keeps bounded single-deliverable work on the root fast path", () => {
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain(
      "a finite exact calculation over a handful of local inputs",
    );
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain(
      "a domain label such as algorithm or research is not by itself a reason",
    );
  });

  it("parses bounded resume input and rejects input for every other action", () => {
    const exactBoundary = `${"\u754c".repeat(1_365)}a`;
    expect(AGENT_TRIO_TOOL_SCHEMA.properties.input).toEqual({
      type: "string",
      maxLength: 4_096,
    });
    expect(
      parseAgentTrioRequest({
        action: "resume",
        runId: "run-1",
        input: "permission granted",
      }),
    ).toEqual({ action: "resume", runId: "run-1", input: "permission granted" });

    expect(
      parseAgentTrioRequest({
        action: "resume",
        runId: "run-1",
        input: exactBoundary,
      }),
    ).toEqual({ action: "resume", runId: "run-1", input: exactBoundary });

    expect(() =>
      parseAgentTrioRequest({
        action: "resume",
        runId: "run-1",
        input: `${exactBoundary}b`,
      }),
    ).toThrow("input must not exceed 4 KiB");

    for (const action of ["run", "submit", "status", "cancel"] as const) {
      const request =
        action === "run" || action === "submit"
          ? { action, objective: "task", cwd: "/workspace", input: "not allowed" }
          : { action, runId: "run-1", input: "not allowed" };
      expect(() => parseAgentTrioRequest(request)).toThrow(
        "input is only valid when action is resume",
      );
    }
  });

  it("parses the bounded Monitor-first submit and one blocking status wait", () => {
    expect(AGENT_TRIO_TOOL_SCHEMA.properties.monitorFirst).toEqual({ type: "boolean" });
    expect(AGENT_TRIO_TOOL_SCHEMA.properties.wait).toEqual({ type: "boolean" });
    expect(
      parseAgentTrioRequest({
        action: "submit",
        objective: "inspect a project",
        cwd: "/workspace",
        strategy: "auto",
        monitorFirst: true,
      }),
    ).toMatchObject({ action: "submit", monitorFirst: true });
    expect(parseAgentTrioRequest({ action: "status", runId: "run-1", wait: true })).toEqual({
      action: "status",
      runId: "run-1",
      wait: true,
    });
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect a project",
        cwd: "/workspace",
        monitorFirst: true,
      }),
    ).toThrow("monitorFirst is only valid when action is submit");
    expect(() => parseAgentTrioRequest({ action: "cancel", runId: "run-1", wait: true })).toThrow(
      "unknown agent_trio argument: wait",
    );
  });

  it("accepts only an explicit caller permission mode on start actions", () => {
    expect(AGENT_TRIO_TOOL_SCHEMA.properties.hostAccess).toMatchObject({
      enum: ["readOnly", "workspaceWrite", "fullAccess"],
    });
    expect(
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect the host",
        cwd: "/workspace",
        hostAccess: "fullAccess",
      }),
    ).toMatchObject({ hostAccess: "fullAccess" });
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect the host",
        cwd: "/workspace",
        hostAccess: "root",
      }),
    ).toThrow("hostAccess must be readOnly, workspaceWrite, or fullAccess");
    expect(() =>
      parseAgentTrioRequest({ action: "status", runId: "run-1", hostAccess: "fullAccess" }),
    ).toThrow("unknown agent_trio argument: hostAccess");
  });

  it("accepts only an explicit caller approval mode on start actions", () => {
    expect(AGENT_TRIO_TOOL_SCHEMA.properties.hostApproval).toMatchObject({
      enum: ["never", "approveForMe"],
    });
    expect(
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect the host",
        cwd: "/workspace",
        hostApproval: "approveForMe",
      }),
    ).toMatchObject({ hostApproval: "approveForMe" });
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect the host",
        cwd: "/workspace",
        hostApproval: "always",
      }),
    ).toThrow("hostApproval must be never or approveForMe");
    expect(() =>
      parseAgentTrioRequest({ action: "status", runId: "run-1", hostApproval: "approveForMe" }),
    ).toThrow("unknown agent_trio argument: hostApproval");
  });

  it("parses explicit direct capabilities and rejects unresolved paths", () => {
    expect(
      parseAgentTrioRequest({
        action: "run",
        objective: "edit a document",
        cwd: "/workspace",
        capabilities: [
          {
            kind: "skill",
            name: "documents",
            path: "/skills/documents/SKILL.md",
          },
          { kind: "plugin", name: "browser@openai-bundled" },
        ],
      }),
    ).toMatchObject({
      capabilities: [
        {
          kind: "skill",
          name: "documents",
          path: "/skills/documents/SKILL.md",
        },
        { kind: "plugin", name: "browser@openai-bundled" },
      ],
    });
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "edit a document",
        cwd: "/workspace",
        capabilities: [{ kind: "skill", name: "documents", path: "relative/SKILL.md" }],
      }),
    ).toThrow("path must be absolute");
  });

  it("accepts a calling-Sol direct tier only for delegated direct execution", () => {
    expect(
      parseAgentTrioRequest({
        action: "run",
        objective: "solve a bounded reconciliation",
        cwd: "/workspace",
        strategy: "direct",
        directTier: "luna",
      }),
    ).toMatchObject({ strategy: "direct", directTier: "luna" });
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "solve a bounded reconciliation",
        cwd: "/workspace",
        directTier: "luna",
      }),
    ).toThrow("directTier requires strategy=direct");
  });

  it("accepts a bounded host-Sol semantic plan", () => {
    const semanticPlan = {
      access: "readOnly" as const,
      merge: "deterministic" as const,
      risk: "low" as const,
      tasks: ["alpha", "beta"].map((id) => ({
        goal: `inspect ${id}`,
        paths: [],
        after: [],
        floor: null,
        expectedSeconds: 90,
      })),
    };
    expect(
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect two modules",
        cwd: "/workspace",
        strategy: "fanout",
        semanticPlan,
      }),
    ).toMatchObject({ semanticPlan });
    expect(AGENT_TRIO_TOOL_SCHEMA.properties.semanticPlan).toMatchObject({
      required: ["access", "merge", "risk", "tasks"],
      properties: {
        access: { enum: ["readOnly", "workspaceWrite"] },
        merge: { enum: ["deterministic", "terra"] },
        risk: { enum: ["low", "medium", "high"] },
        tasks: {
          minItems: 2,
          maxItems: 20,
          items: {
            additionalProperties: false,
            required: ["goal", "paths", "after", "floor", "expectedSeconds"],
            properties: {
              expectedSeconds: { type: "number", exclusiveMinimum: 15 },
            },
          },
        },
      },
    });
    const hostTaskProperties = (
      AGENT_TRIO_TOOL_SCHEMA.properties.semanticPlan as {
        properties: { tasks: { items: { properties: Readonly<Record<string, unknown>> } } };
      }
    ).properties.tasks.items.properties;
    for (const derived of [
      "id",
      "objective",
      "difficulty",
      "ambiguity",
      "checks",
      "capabilities",
    ]) {
      expect(hostTaskProperties).not.toHaveProperty(derived);
    }
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect two modules",
        cwd: "/workspace",
        strategy: "fanout",
        semanticPlan: {
          ...semanticPlan,
          tasks: semanticPlan.tasks.map((task) => ({ ...task, checks: [] })),
        },
      }),
    ).toThrow("unknown property 'checks'");
    expect(
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect two modules",
        cwd: "/workspace",
        strategy: "fanout",
        semanticPlan: {
          ...semanticPlan,
          tasks: semanticPlan.tasks.map((task) => ({ ...task, goal: null, paths: [] })),
        },
      }),
    ).toMatchObject({ semanticPlan: { tasks: [{ goal: null }, { goal: null }] } });
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect two modules",
        cwd: "/workspace",
        strategy: "fanout",
        semanticPlan: {
          ...semanticPlan,
          tasks: semanticPlan.tasks.map((task) => ({ ...task, expectedSeconds: 15 })),
        },
      }),
    ).toThrow("must be greater than 15 for fanout");
    expect(() =>
      parseAgentTrioRequest({
        action: "run",
        objective: "inspect two modules",
        cwd: "/workspace",
        strategy: "fanout",
        semanticPlan: {
          ...semanticPlan,
          tasks: semanticPlan.tasks.map(({ expectedSeconds: _expectedSeconds, ...task }) => task),
        },
      }),
    ).toThrow("must be a positive finite number");
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain(
      "For nontrivial work use objective, cwd, and strategy=auto without semanticPlan",
    );
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain("over 15 seconds of actual Luna wall time");
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain("not a fixed total-duration threshold");
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain('semanticPlan={"access":"readOnly"');
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain('"expectedSeconds":90');
    expect(AGENT_TRIO_TOOL_DESCRIPTION).toContain("Tasks never contain id");
    expect(AGENT_TRIO_TOOL_DESCRIPTION).not.toContain("Use strategy=direct");
  });

  it("exposes one tool and rejects a cwd outside client roots", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const handle = vi.fn();
    const protocol = new AgentTrioMcpProtocol({ service: { handle }, input, output });
    const running = protocol.run();
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: { roots: {} } },
      })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await vi.waitFor(() => expect(text).toContain("roots/list"));
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "agent-trio-roots-1",
        result: { roots: [{ uri: pathToFileURL("/tmp").href }] },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: { action: "run", objective: "test", cwd: "/" },
        },
      })}\n`,
    );
    await vi.waitFor(() => expect(text).toContain("outside the MCP workspace roots"));
    input.end();
    await running;

    const messages = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const list = messages.find((message) => message["id"] === 2);
    expect(list).toMatchObject({
      result: { tools: [{ name: "agent_trio", defer_loading: true }] },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("accepts an absolute cwd when the MCP client does not support roots", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const handle = vi.fn(async () => result());
    const protocol = new AgentTrioMcpProtocol({ service: { handle }, input, output });
    const running = protocol.run();
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: { action: "run", objective: "test", cwd: "/tmp", strategy: "auto" },
        },
      })}\n`,
    );
    await vi.waitFor(() => expect(text).toContain('"id":2'));
    input.end();
    await running;

    expect(handle).toHaveBeenCalledWith({
      action: "run",
      objective: "test",
      cwd: "/tmp",
      strategy: "auto",
      runId: expect.any(String),
    });
    expect(text).toContain('"finalResponse":"done"');
    expect(text).not.toContain("workspace roots");
  });

  it("assigns a run id and emits the monitor URL through MCP progress", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const handle = vi.fn(async (request: { runId?: string }) => ({
      ...result(),
      runId: request.runId ?? "missing",
    }));
    const protocol = new AgentTrioMcpProtocol({
      service: { handle },
      input,
      output,
      createRunId: () => "generated-run",
      monitorUrlForRun: (runId) => `http://127.0.0.1:43173/runs/${runId}?token=test`,
    });
    const running = protocol.run();
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: {
            action: "run",
            objective: "inspect",
            cwd: "/tmp",
            strategy: "auto",
          },
          _meta: { progressToken: "progress-1" },
        },
      })}\n`,
    );
    input.end();
    await running;

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run", runId: "generated-run" }),
    );
    const messages = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "notifications/progress",
        params: expect.objectContaining({
          progressToken: "progress-1",
          message: expect.stringContaining("/runs/generated-run?token=test"),
        }),
      }),
    );
    const response = messages.find((message) => message["id"] === 2) as {
      result: { content: Array<{ text: string }>; structuredContent: BatchResult };
    };
    expect(response.result.structuredContent.monitorUrl).toContain(
      "/runs/generated-run?token=test",
    );
    expect(response.result.structuredContent.finalResponse).toBe(
      "[Open Agent Trio Monitor](http://127.0.0.1:43173/runs/generated-run?token=test)\n\ndone",
    );
    expect(response.result.content[0]!.text).toContain("Open Agent Trio Monitor");
  });

  it("drains in-flight request handlers after graceful EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    let finish: ((value: BatchResult) => void) | undefined;
    const delayedResult = new Promise<BatchResult>((resolve) => {
      finish = resolve;
    });
    const handle = vi.fn(() => delayedResult);
    const protocol = new AgentTrioMcpProtocol({ service: { handle }, input, output });
    const running = protocol.run();
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agent_trio",
          arguments: { action: "status", runId: "run-1" },
        },
      })}\n`,
    );
    input.end();

    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(text).not.toContain('"id":2');
    finish?.(result());
    await running;

    expect(text).toContain('"id":2');
    expect(text).toContain('"finalResponse":"done"');
  });

  it("returns managed job failures as data instead of MCP transport errors", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const failed: BatchResult = {
      ...result(),
      status: "failed",
      finalResponse: null,
      error: "leaf failed",
    };
    const protocol = new AgentTrioMcpProtocol({
      service: { handle: vi.fn(async () => failed) },
      input,
      output,
    });
    const running = protocol.run();
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_trio", arguments: { action: "status", runId: "run-1" } } })}\n`,
    );
    input.end();
    await running;

    const response = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((message) => message["id"] === 2) as { result: Record<string, unknown> };
    expect(response.result).toMatchObject({
      isError: false,
      structuredContent: { status: "failed", error: "leaf failed" },
    });
  });
});
