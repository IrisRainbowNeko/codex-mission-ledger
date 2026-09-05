import { describe, expect, it } from "vitest";
import { compactDisplayMonitorEvent, projectMonitorEvents } from "../src/monitor/display.js";

describe("monitor display projection", () => {
  it("keeps identity and readable text when a message exceeds the transport event limit", () => {
    const [event] = projectMonitorEvents([
      {
        type: "app_server",
        at: "2026-09-03T00:00:00.000Z",
        role: "direct",
        threadId: "thread-1",
        turnId: "turn-1",
        method: "item/completed",
        data: {
          item: {
            id: "message-1",
            type: "agentMessage",
            text: JSON.stringify({ response: "answer ".repeat(10_000) }),
          },
        },
      },
    ]);

    expect(event).toMatchObject({
      type: "display",
      displayKey: "thread-1|turn-1|message-1",
      displayKind: "agent-message",
      displayLabel: "Direct agent",
      displayComplete: true,
    });
    expect(event?.displayText).toMatch(/^answer answer/u);
    const compact = compactDisplayMonitorEvent(event!, 2_000);
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(2_000);
    expect(compact).toMatchObject({
      displayKey: "thread-1|turn-1|message-1",
      displayKind: "agent-message",
      displayTruncated: true,
    });
    expect(compact.displayText).toContain("answer");
  });

  it("coalesces command lifecycle and output updates into one logical entry", () => {
    const events = projectMonitorEvents([
      {
        type: "app_server",
        role: "leaf",
        threadId: "thread-1",
        turnId: "turn-1",
        method: "item/started",
        data: {
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "npm test",
            status: "inProgress",
          },
        },
      },
      {
        type: "app_server",
        role: "leaf",
        threadId: "thread-1",
        turnId: "turn-1",
        method: "item/commandExecution/outputDelta",
        data: { itemId: "command-1", delta: "all tests passed" },
      },
      {
        type: "app_server",
        role: "leaf",
        threadId: "thread-1",
        turnId: "turn-1",
        method: "item/completed",
        data: {
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "npm test",
            status: "completed",
          },
        },
      },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        displayKey: "thread-1|turn-1|command-1",
        displayKind: "command",
        displayCommand: "npm test",
        displayOutput: "all tests passed",
        displayStatus: "completed",
        displayComplete: true,
      }),
    ]);
  });

  it("replays the 211-event regression shape as a non-empty item conversation", () => {
    const events: unknown[] = [];
    for (let index = 0; index < 3; index += 1) {
      events.push({ type: "remote_turn", threadId: `thread-${String(index)}` });
    }
    for (let index = 0; index < 10; index += 1) {
      events.push(itemEvent("item/started", `reasoning-${String(index)}`, "reasoning"));
      events.push(itemEvent("item/completed", `reasoning-${String(index)}`, "reasoning"));
    }
    for (let index = 0; index < 6; index += 1) {
      events.push(
        itemEvent("item/started", `command-${String(index)}`, "commandExecution", {
          command: `command ${String(index)}`,
          status: "inProgress",
        }),
      );
      events.push(
        itemEvent("item/completed", `command-${String(index)}`, "commandExecution", {
          command: `command ${String(index)}`,
          aggregatedOutput: "output",
          status: "completed",
        }),
      );
    }
    for (let index = 0; index < 5; index += 1) {
      events.push(itemEvent("item/started", `message-${String(index)}`, "agentMessage"));
      events.push(itemEvent("item/completed", `message-${String(index)}`, "agentMessage"));
    }
    for (let index = 0; index < 145; index += 1) {
      events.push({
        type: "app_server",
        role: "direct",
        threadId: "thread-1",
        turnId: "turn-1",
        method: "item/agentMessage/delta",
        data: { itemId: "message-4", delta: `chunk-${String(index)} ` },
      });
    }
    for (let index = 0; index < 21; index += 1) {
      events.push({ type: "app_server", method: "thread/tokenUsage/updated", data: {} });
    }

    expect(events).toHaveLength(211);
    const conversation = projectMonitorEvents(events).filter(
      (event) => event.displayText || event.displayCommand || event.displayOutput,
    );
    expect(conversation).toHaveLength(7);
    expect(conversation.at(-1)).toMatchObject({
      displayKey: "thread-1|turn-1|message-4",
      displayKind: "agent-message",
    });
    expect(conversation.at(-1)?.displayText).toContain("chunk-144");
  });
});

function itemEvent(
  method: string,
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "app_server",
    role: "direct",
    threadId: "thread-1",
    turnId: "turn-1",
    method,
    data: { item: { id, type, ...extra } },
  };
}
