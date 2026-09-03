import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { MCP_MONITOR_APP_JS, MCP_MONITOR_HTML } from "../src/mcp/app.js";

describe("Agent Trio MCP App", () => {
  it("ships a self-contained bridge UI without localhost or SSE dependencies", () => {
    expect(() => new Script(MCP_MONITOR_APP_JS)).not.toThrow();
    expect(MCP_MONITOR_HTML).toContain("Agent Trio Monitor");
    expect(MCP_MONITOR_APP_JS).toContain('bridgeRequest("tools/call"');
    expect(MCP_MONITOR_APP_JS).toContain('method === "ui/notifications/tool-input"');
    expect(MCP_MONITOR_APP_JS).toContain("monitorCursor");
    expect(MCP_MONITOR_APP_JS).toContain("terminalStates.has(status) && !nextIsImmediate");
    expect(MCP_MONITOR_APP_JS).toContain("poll(nextIsImmediate)");
    expect(MCP_MONITOR_APP_JS).not.toContain("EventSource");
    expect(MCP_MONITOR_APP_JS).not.toContain("fetch(");
    expect(MCP_MONITOR_APP_JS).not.toContain("127.0.0.1");
  });

  it("bounds retained events and renders completed items as conversations", () => {
    expect(MCP_MONITOR_APP_JS).toContain("state.events.length > 1500");
    expect(MCP_MONITOR_APP_JS).toContain("buildConversationEvents");
    expect(MCP_MONITOR_APP_JS).toContain("item.type) || itemTypeFromMethod");
    expect(MCP_MONITOR_APP_JS).toContain('/"response"\\s*:\\s*"/');
  });

  it("renders profile, semantic route, leaf shape, and prediction ratios", () => {
    expect(MCP_MONITOR_APP_JS).toContain('["Profile"');
    expect(MCP_MONITOR_APP_JS).toContain('["Route source"');
    expect(MCP_MONITOR_APP_JS).toContain('["Tier mix"');
    expect(MCP_MONITOR_APP_JS).toContain("metrics.estimatedCostRatio");
    expect(MCP_MONITOR_APP_JS).toContain("metrics.estimatedLatencyRatio");
  });
});
