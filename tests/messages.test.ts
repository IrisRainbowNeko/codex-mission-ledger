import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, LeafTask } from "../src/core/contracts.js";
import { MessageBroker } from "../src/core/messages.js";

function task(id: string, communicationWith: string[] = []): LeafTask {
  return {
    id,
    objective: id,
    domain: "general",
    tier: "luna",
    effort: "low",
    access: "readOnly",
    ownedPaths: [],
    dependsOn: [],
    capabilities: [],
    validation: [],
    communicationWith,
    expectedSeconds: 60,
    difficulty: 0.1,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
  };
}

describe("MessageBroker", () => {
  it("routes only declared peers and enforces the outbound budget", async () => {
    const deliver = vi.fn(async () => "ack");
    const broker = new MessageBroker([task("a", ["b"]), task("b")], {
      deliver,
      askPlanner: async () => "planner",
    });

    await expect(
      broker.post({ type: "question", fromTaskId: "a", toTaskId: "b", body: "one" }),
    ).resolves.toMatchObject({ response: "ack" });
    await broker.post({ type: "answer", fromTaskId: "a", toTaskId: "integrator", body: "two" });
    await expect(
      broker.post({ type: "blocker", fromTaskId: "a", toTaskId: "planner", body: "three" }),
    ).rejects.toThrow("budget exhausted");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("sends contract changes to the planner and limits blocking questions", async () => {
    const planned: AgentMessage[] = [];
    const broker = new MessageBroker([task("a", ["b"]), task("b")], {
      deliver: async () => null,
      askPlanner: async (message) => {
        planned.push(message);
        return "decision";
      },
    });
    await expect(
      broker.post({
        type: "contract_change",
        fromTaskId: "a",
        toTaskId: "b",
        body: "change",
      }),
    ).rejects.toThrow("must be sent to the planner");
    await expect(
      broker.post({
        type: "question",
        fromTaskId: "a",
        toTaskId: "planner",
        body: "decide",
        blocking: true,
      }),
    ).resolves.toMatchObject({ response: "decision" });
    await expect(
      broker.post({
        type: "question",
        fromTaskId: "a",
        toTaskId: "planner",
        body: "again",
        blocking: true,
      }),
    ).rejects.toThrow("blocking message budget exhausted");
    expect(planned).toHaveLength(1);
  });

  it("records contract changes without spending a planner answer turn", async () => {
    const askPlanner = vi.fn(async () => "unused");
    const broker = new MessageBroker([task("a")], {
      deliver: async () => null,
      askPlanner,
    });

    await expect(
      broker.post({
        type: "contract_change",
        fromTaskId: "a",
        toTaskId: "planner",
        body: "the public interface must change",
        blocking: true,
      }),
    ).resolves.toMatchObject({ response: null });
    expect(askPlanner).not.toHaveBeenCalled();
    expect(broker.messages).toEqual([
      expect.objectContaining({ type: "contract_change", toTaskId: "planner" }),
    ]);
  });

  it.each(["answer", "blocker", "result"] as const)(
    "does not allow %s notifications to wake the planner",
    async (type) => {
      const askPlanner = vi.fn(async () => "unused");
      const broker = new MessageBroker([task("a")], {
        deliver: async () => null,
        askPlanner,
      });

      await expect(
        broker.post({ type, fromTaskId: "a", toTaskId: "planner", body: "notice" }),
      ).rejects.toThrow("only questions and contract changes");
      expect(askPlanner).not.toHaveBeenCalled();
    },
  );

  it("persists integrator messages without delivering them to a live leaf", async () => {
    const deliver = vi.fn(async () => null);
    const broker = new MessageBroker([task("a")], {
      deliver,
      askPlanner: async () => "planner",
    });

    await expect(
      broker.post({ type: "result", fromTaskId: "a", toTaskId: "integrator", body: "done" }),
    ).resolves.toMatchObject({ response: null });
    expect(deliver).not.toHaveBeenCalled();
    expect(broker.messages).toHaveLength(1);
  });
});
