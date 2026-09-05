import { describe, expect, it, vi } from "vitest";
import type { ExecutionPlan, LeafResult } from "../src/core/contracts.js";
import type { PlannerTurnRequest } from "../src/core/planner.js";
import { ResponsesPlannerTransport } from "../src/responses-planner.js";

function request(kind: "execution_plan" | "plan_patch" = "execution_plan"): PlannerTurnRequest {
  return {
    kind,
    model: "gpt-5.6-sol",
    tier: "sol",
    effort: "medium",
    forkTurns: "none",
    prompt: `create ${kind}`,
    responseFormat: {
      type: "json_schema",
      name: kind,
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "number" } },
      },
    },
  };
}

function response(value: number): Response {
  return structuredResponse({ value });
}

function structuredResponse(output: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "resp-1",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(output) }],
        },
      ],
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        output_tokens: 30,
        total_tokens: 150,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("ResponsesPlannerTransport", () => {
  it("sends a tool-free structured Responses request and records priced usage", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response(1));
    const transport = new ResponsesPlannerTransport({
      baseUrl: "https://planner.example/v1/",
      apiKey: "secret",
      serviceTier: "priority",
      fetch,
      priceTable: {
        "gpt-5.6-sol": {
          inputPerMillionUsd: 4,
          cachedInputPerMillionUsd: 0.4,
          cacheWriteInputPerMillionUsd: 5,
          outputPerMillionUsd: 20,
        },
      },
    });

    const result = await transport.start(request());

    expect(result).toMatchObject({
      threadId: expect.stringMatching(/^responses-planner:/u),
      output: { value: 1 },
      usage: [
        {
          model: "gpt-5.6-sol",
          tier: "sol",
          effort: "medium",
          cachedInputTokens: 20,
          cacheWriteInputTokens: 10,
          uncachedInputTokens: 90,
          outputTokens: 30,
          totalTokens: 150,
          estimatedCostUsd: 0.001018,
          costSource: "price_table",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://planner.example/v1/responses");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      input: "create execution_plan",
      reasoning: { effort: "medium" },
      tools: [],
      store: false,
      max_output_tokens: 350,
      service_tier: "priority",
      text: {
        format: {
          type: "json_schema",
          name: "execution_plan",
          strict: true,
        },
      },
    });
  });

  it("keeps a local planner thread identity across stateless patch calls", async () => {
    let responseNumber = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response(++responseNumber),
    );
    const transport = new ResponsesPlannerTransport({
      baseUrl: "https://planner.example/v1/responses",
      apiKey: "secret",
      fetch,
    });

    const initial = await transport.start(request());
    const patched = await transport.continue(initial.threadId, request("plan_patch"));

    expect(initial.output).toEqual({ value: 1 });
    expect(patched).toMatchObject({ threadId: initial.threadId, output: { value: 2 } });
    await expect(
      transport.continue("responses-planner:unknown", request("plan_patch")),
    ).rejects.toThrow("unknown Responses planner thread");
  });

  it("registers a persisted synthetic thread for patching after process recovery", async () => {
    const fetch = vi.fn(async () => response(3));
    const transport = new ResponsesPlannerTransport({
      baseUrl: "https://planner.example/v1",
      apiKey: "secret",
      fetch,
    });
    const threadId = "responses-planner:persisted-run";

    transport.registerExistingThread({ threadId, cwd: "/workspace", runId: "run-1" });
    await transport.ensureThread(threadId);
    const patchRequest = {
      ...request("plan_patch"),
      cwd: "/workspace",
      runId: "run-1",
    } satisfies PlannerTurnRequest;

    await expect(transport.continue(threadId, patchRequest)).resolves.toMatchObject({
      threadId,
      output: { value: 3 },
    });
    expect(() =>
      transport.registerExistingThread({ threadId, cwd: "/other", runId: "run-1" }),
    ).toThrow("belongs to '/workspace'");
    expect(() =>
      transport.registerExistingThread({
        threadId: "app-server-thread",
        cwd: "/workspace",
      }),
    ).toThrow("cannot restore non-Responses planner thread");
  });

  it("performs high-risk final review on the same synthetic planner identity", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      structuredResponse({ approved: true, issues: [], replacementResponse: null }),
    );
    const transport = new ResponsesPlannerTransport({
      baseUrl: "https://planner.example/v1",
      apiKey: "secret",
      fetch,
    });
    const threadId = "responses-planner:review-run";
    transport.registerExistingThread({ threadId, cwd: "/workspace", runId: "run-review" });

    const plan: ExecutionPlan = {
      protocolVersion: 1,
      planId: "plan-review",
      objective: "Produce a correct answer",
      domain: "research",
      assumptions: [],
      tasks: [],
      integration: {
        objective: "Integrate the answer",
        requiredOutputs: ["answer"],
        validation: [],
        finalReview: "riskTriggered",
      },
      risk: "high",
    };
    const leaf: LeafResult = {
      taskId: "source-a",
      status: "completed",
      summary: "source checked",
      confidence: 0.9,
      findings: [],
      changedFiles: [],
      validation: [],
      citations: [],
      artifacts: [],
      messages: [],
      threadId: "leaf-thread",
      turnId: "leaf-turn",
      usage: [],
      startedAt: "2026-08-31T00:00:00.000Z",
      completedAt: "2026-08-31T00:00:01.000Z",
    };

    const reviewed = await transport.review({
      runId: "run-review",
      request: { objective: plan.objective, cwd: "/workspace/candidate" },
      plan,
      leaves: [leaf],
      plannerThreadId: threadId,
      signal: new AbortController().signal,
      integratedResponse: "final answer",
      integrationValidation: [],
      integratorThreadId: "integrator-thread",
    });

    expect(reviewed).toMatchObject({ approved: true, issues: [], threadId });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      reasoning: { effort: "high" },
      tools: [],
      store: false,
      text: { format: { name: "final_review", strict: true } },
    });
  });

  it("returns bounded provider errors without accepting invalid configuration", async () => {
    expect(
      () => new ResponsesPlannerTransport({ baseUrl: "file:///tmp", apiKey: "secret" }),
    ).toThrow("must use HTTP(S)");
    expect(
      () => new ResponsesPlannerTransport({ baseUrl: "https://planner.example/v1", apiKey: "" }),
    ).toThrow("apiKey must be non-empty");

    const transport = new ResponsesPlannerTransport({
      baseUrl: "https://planner.example/v1",
      apiKey: "secret",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "provider rejected schema" } }), {
          status: 400,
        }),
    });
    await expect(transport.start(request())).rejects.toThrow(
      "Responses planner HTTP 400: provider rejected schema",
    );
  });
});
