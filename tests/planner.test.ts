import { describe, expect, it } from "vitest";
import type { ExecutionPlan, LeafTask, PlanPatch, ReplanTrigger } from "../src/core/contracts.js";
import {
  applyPlanPatch,
  executionPlanJsonSchemaForRoute,
  parseExecutionPlan,
  PLAN_PATCH_JSON_SCHEMA,
  PlanValidationError,
  validateExecutionPlan,
  validatePlanPatch,
} from "../src/core/plan-validation.js";
import type { PlannerStateError } from "../src/core/planner.js";
import {
  hostSemanticPlanJsonSchemaForRoute,
  parseHostSemanticPlan,
  PlannerService,
  recommendPlannerEffort,
  type PlannerTransport,
  type PlannerTurnRequest,
  type PlannerTurnResponse,
} from "../src/core/planner.js";

function leaf(id: string, overrides: Partial<LeafTask> = {}): LeafTask {
  return {
    id,
    objective: `Implement ${id}`,
    domain: "coding",
    tier: "luna",
    effort: "medium",
    access: "workspaceWrite",
    ownedPaths: [`src/${id}.ts`],
    dependsOn: [],
    capabilities: [],
    validation: [{ command: `npm test -- ${id}`, timeoutMs: 10_000 }],
    communicationWith: [],
    expectedSeconds: 90,
    difficulty: 0.2,
    ambiguity: 0.1,
    confidence: 0.9,
    critical: false,
    ...overrides,
  };
}

function executionPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    objective: "Implement two modules",
    domain: "coding",
    assumptions: ["The repository is installed"],
    tasks: [leaf("alpha"), leaf("beta")],
    integration: {
      objective: "Integrate modules",
      requiredOutputs: ["passing implementation"],
      validation: [{ command: "npm test" }],
      finalReview: "riskTriggered",
    },
    risk: "medium",
    ...overrides,
  };
}

function replacementPatch(): PlanPatch {
  return {
    protocolVersion: 1,
    planId: "plan-1",
    reason: "Alpha validator failed",
    operations: [
      {
        op: "replace",
        taskId: "alpha",
        task: leaf("alpha", { objective: "Repair alpha" }),
      },
    ],
  };
}

const trigger: ReplanTrigger = {
  type: "validator_failure",
  taskIds: ["alpha"],
  summary: "Alpha tests failed",
  observedAt: "2026-08-28T00:05:00.000Z",
};

class FakePlannerTransport implements PlannerTransport {
  readonly starts: PlannerTurnRequest[] = [];
  readonly continuations: Array<{ threadId: string; request: PlannerTurnRequest }> = [];
  readonly registrations: Array<{ threadId: string; cwd: string; runId?: string }> = [];
  startOutput: unknown;
  patchOutput: unknown;
  continuationThreadId = "planner-thread";

  constructor(startOutput: unknown, patchOutput: unknown = replacementPatch()) {
    this.startOutput = startOutput;
    this.patchOutput = patchOutput;
  }

  async start(request: PlannerTurnRequest): Promise<PlannerTurnResponse> {
    this.starts.push(request);
    return { threadId: "planner-thread", output: this.startOutput };
  }

  async continue(threadId: string, request: PlannerTurnRequest): Promise<PlannerTurnResponse> {
    this.continuations.push({ threadId, request });
    return { threadId: this.continuationThreadId, output: this.patchOutput };
  }

  registerExistingThread(input: { threadId: string; cwd: string; runId?: string }): void {
    this.registrations.push(input);
  }
}

function hostPlan(
  tasks: Array<{
    goal: string | null;
    paths: string[];
    after: number[];
    floor: null | "luna" | "terra" | "sol";
    expectedSeconds?: number;
  }>,
  overrides: Partial<{
    access: "readOnly" | "workspaceWrite";
    merge: "deterministic" | "terra";
    risk: "low" | "medium" | "high";
  }> = {},
) {
  return {
    access: "readOnly" as const,
    merge: "deterministic" as const,
    risk: "low" as const,
    tasks: tasks.map((task) => ({ expectedSeconds: 90, ...task })),
    ...overrides,
  };
}

describe("ExecutionPlan validation", () => {
  it("accepts a bounded acyclic plan and computes all structural rules", () => {
    expect(parseExecutionPlan(executionPlan())).toEqual(executionPlan());
  });

  it("enforces route-specific leaf cardinality without weakening generic validation", () => {
    const single = executionPlan({ tasks: [leaf("only")] });

    expect(validateExecutionPlan(single).ok).toBe(true);
    expect(validateExecutionPlan(single, {}, "planned_single").ok).toBe(true);
    expect(validateExecutionPlan(single, {}, "fanout")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "fanout_minimum" })],
    });
    expect(validateExecutionPlan(executionPlan(), {}, "planned_single")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "planned_single_count" })],
    });
    expect(executionPlanJsonSchemaForRoute("fanout")).toMatchObject({
      properties: { tasks: { minItems: 2 } },
    });
    expect(executionPlanJsonSchemaForRoute("fanout", 3)).toMatchObject({
      required: expect.arrayContaining(["origin"]),
      properties: {
        tasks: {
          minItems: 2,
          maxItems: 3,
          items: {
            required: expect.arrayContaining(["minTier", "validatorStrength"]),
          },
        },
        integration: { required: expect.arrayContaining(["aggregation"]) },
      },
    });
    expect(executionPlanJsonSchemaForRoute("planned_single")).toMatchObject({
      properties: { tasks: { minItems: 1, maxItems: 1 } },
    });
  });

  it("caps the Sol output schema before planning starts", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    await new PlannerService(transport).plan({
      objective: "Implement two modules",
      cwd: "/workspace",
      limits: { maxLeaves: 2 },
    });

    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { minItems: 2, maxItems: 2 } },
    });
  });

  it("normalizes strict-schema null placeholders before semantic validation", () => {
    const strict = structuredClone(executionPlan()) as unknown as Record<string, unknown>;
    strict["origin"] = null;
    const tasks = strict["tasks"] as Array<Record<string, unknown>>;
    for (const task of tasks) {
      task["minTier"] = null;
      task["validatorStrength"] = null;
    }
    const integration = strict["integration"] as Record<string, unknown>;
    integration["aggregation"] = null;

    const parsed = parseExecutionPlan(strict);
    expect(parsed.origin).toBeUndefined();
    expect(parsed.tasks[0]?.minTier).toBeUndefined();
    expect(parsed.integration.aggregation).toBeUndefined();
  });

  it("uses an App Server-compatible strict PlanPatch operation schema", () => {
    expect(PLAN_PATCH_JSON_SCHEMA).toMatchObject({
      properties: {
        operations: {
          items: {
            required: ["op", "taskId", "task", "reason"],
            properties: { task: { anyOf: expect.any(Array) } },
          },
        },
      },
    });
    expect(JSON.stringify(PLAN_PATCH_JSON_SCHEMA)).not.toContain('"oneOf"');

    const strictPatch = {
      protocolVersion: 1,
      planId: "plan-1",
      reason: "remove alpha",
      operations: [{ op: "cancel", taskId: "alpha", task: null, reason: "obsolete" }],
      integration: null,
    };
    expect(validatePlanPatch(strictPatch, { basePlan: executionPlan() }).ok).toBe(true);

    const strictReplace = {
      protocolVersion: 1,
      planId: "plan-1",
      reason: "replace alpha",
      operations: [
        {
          op: "replace",
          taskId: "alpha",
          task: leaf("alpha", { objective: "Repair alpha" }),
          reason: "schema-required explanation",
        },
      ],
      integration: null,
    };
    expect(validatePlanPatch(strictReplace, { basePlan: executionPlan() }).ok).toBe(true);
  });

  it("accepts overlapping writer ownership when a dependency orders the edits", () => {
    const ordered = executionPlan({
      tasks: [
        leaf("alpha", { ownedPaths: ["src/core"] }),
        leaf("beta", {
          ownedPaths: ["src/core/beta.ts"],
          dependsOn: ["alpha"],
        }),
        leaf("gamma", { ownedPaths: ["src/ui"] }),
      ],
    });

    const validation = validateExecutionPlan(ordered);
    expect(validation.ok).toBe(true);
  });

  it("reports cycles, invalid tier effort, ownership overlap, and high-risk validation gaps", () => {
    const invalid = executionPlan({
      risk: "high",
      tasks: [
        leaf("alpha", {
          effort: "high",
          ownedPaths: ["src/core"],
          dependsOn: ["beta"],
        }),
        leaf("beta", {
          ownedPaths: ["src/core/beta.ts"],
          dependsOn: ["alpha"],
        }),
      ],
      integration: {
        objective: "Integrate",
        requiredOutputs: ["implementation"],
        validation: [],
        finalReview: "never",
      },
    });
    const validation = validateExecutionPlan(invalid);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "invalid_tier_effort",
          "dependency_cycle",
          "ownership_overlap",
          "unvalidated_high_risk",
        ]),
      );
    }
  });

  it("enforces leaf, wave, Sol, and deadline limits while allowing executor batching", () => {
    const tasks = [
      leaf("a", {
        tier: "sol",
        effort: "high",
        expectedSeconds: 60,
        expectedCostUsd: 0.6,
      }),
      leaf("b", {
        tier: "sol",
        effort: "xhigh",
        expectedSeconds: 60,
        expectedCostUsd: 0.6,
      }),
      leaf("c", { dependsOn: ["a"], expectedSeconds: 60, expectedCostUsd: 0.2 }),
    ];
    const validation = validateExecutionPlan(executionPlan({ tasks }), {
      maxLeaves: 3,
      maxConcurrent: 1,
      maxWaves: 1,
      maxSolLeaves: 1,
      deadlineMs: 100_000,
      maxCostUsd: 1,
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["max_waves", "max_sol_leaves", "deadline", "max_cost"]),
      );
      expect(validation.issues.map((issue) => issue.code)).not.toContain("max_concurrent");
    }
  });

  it("applies a valid patch and validates its effective graph", () => {
    const patched = applyPlanPatch(executionPlan(), replacementPatch());
    expect(patched.tasks.find((task) => task.id === "alpha")?.objective).toBe("Repair alpha");
    expect(executionPlan().tasks[0]?.objective).toBe("Implement alpha");
    expect(() =>
      applyPlanPatch(executionPlan(), {
        ...replacementPatch(),
        planId: "another-plan",
      }),
    ).toThrowError(PlanValidationError);

    const immutable = validatePlanPatch(replacementPatch(), {
      expectedPlanId: "plan-1",
      basePlan: executionPlan(),
      immutableTaskIds: ["alpha"],
    });
    expect(immutable.ok).toBe(false);
    if (!immutable.ok) {
      expect(immutable.issues.map((issue) => issue.code)).toContain("immutable_task");
    }
  });

  it("requires cancellation patches to explicitly repair every remaining reference", () => {
    const basePlan = executionPlan({
      tasks: [
        leaf("alpha"),
        leaf("beta", { dependsOn: ["alpha"] }),
        leaf("gamma", { communicationWith: ["alpha"] }),
      ],
    });
    const incompletePatch: PlanPatch = {
      protocolVersion: 1,
      planId: "plan-1",
      reason: "Alpha is no longer needed",
      operations: [{ op: "cancel", taskId: "alpha", reason: "Remove obsolete work" }],
    };

    const invalid = validatePlanPatch(incompletePatch, { basePlan });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["missing_dependency", "missing_communication_target"]),
      );
    }

    const patched = applyPlanPatch(basePlan, {
      ...incompletePatch,
      operations: [
        ...incompletePatch.operations,
        { op: "replace", taskId: "beta", task: leaf("beta") },
        { op: "replace", taskId: "gamma", task: leaf("gamma") },
      ],
    });
    expect(patched.tasks.map((task) => task.id)).toEqual(["beta", "gamma"]);
    expect(basePlan.tasks.find((task) => task.id === "beta")?.dependsOn).toEqual(["alpha"]);
    expect(basePlan.tasks.find((task) => task.id === "gamma")?.communicationWith).toEqual([
      "alpha",
    ]);
  });

  it("revalidates wave and Sol limits after add and replace operations", () => {
    const basePlan = executionPlan({ tasks: [leaf("alpha")] });
    const constrained = validatePlanPatch(
      {
        protocolVersion: 1,
        planId: "plan-1",
        reason: "Add a staged specialist",
        operations: [
          { op: "add", task: leaf("beta", { dependsOn: ["alpha"] }) },
          {
            op: "add",
            task: leaf("gamma", {
              tier: "sol",
              effort: "high",
              dependsOn: ["beta"],
              difficulty: 0.9,
            }),
          },
        ],
      },
      {
        basePlan,
        limits: { maxLeaves: 3, maxWaves: 2, maxSolLeaves: 0 },
      },
    );

    expect(constrained.ok).toBe(false);
    if (!constrained.ok) {
      expect(constrained.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["max_waves", "max_sol_leaves"]),
      );
    }
  });
});

describe("PlannerService", () => {
  it("parses bounded numeric host dependencies and rejects invalid indexes", () => {
    const task = (goal: string, after: number[]) => ({
      goal,
      paths: [],
      after,
      floor: null,
      expectedSeconds: 90,
    });

    expect(
      parseHostSemanticPlan(
        hostPlan([task("Inspect alpha", []), task("Inspect beta", [0])]),
        "fanout",
        5,
      ),
    ).toMatchObject({
      access: "readOnly",
      merge: "deterministic",
      risk: "low",
      tasks: [{ after: [] }, { after: [0] }],
    });
    expect(hostSemanticPlanJsonSchemaForRoute("fanout", 5)).toMatchObject({
      required: ["access", "merge", "risk", "tasks"],
      properties: {
        access: { enum: ["readOnly", "workspaceWrite"] },
        tasks: {
          items: {
            required: ["goal", "paths", "after", "floor", "expectedSeconds"],
            properties: {
              after: { maxItems: 0 },
              expectedSeconds: { type: "number", exclusiveMinimum: 15 },
            },
          },
        },
      },
    });
    expect(() =>
      parseHostSemanticPlan(
        hostPlan([task("Inspect alpha", []), task("Inspect beta", [2])]),
        "fanout",
        5,
      ),
    ).toThrow("out-of-range task index");
    expect(() =>
      parseHostSemanticPlan(
        hostPlan([task("Inspect alpha", [0]), task("Inspect beta", [])]),
        "fanout",
        5,
      ),
    ).toThrow("cannot contain its own task index");
  });

  it("requires real host leaf durations and rejects the 15-second fanout boundary", () => {
    const plan = {
      access: "readOnly",
      merge: "deterministic",
      risk: "low",
      tasks: [
        { goal: "Inspect alpha", paths: [], after: [], floor: null, expectedSeconds: 90 },
        { goal: "Inspect beta", paths: [], after: [], floor: null, expectedSeconds: 60 },
      ],
    };

    expect(
      parseHostSemanticPlan(plan, "fanout", 5).tasks.map((task) => task.expectedSeconds),
    ).toEqual([90, 60]);
    expect(() =>
      parseHostSemanticPlan(
        { ...plan, tasks: plan.tasks.map((task) => ({ ...task, expectedSeconds: 15 })) },
        "fanout",
        5,
      ),
    ).toThrow("must be greater than 15 for fanout");
    expect(() =>
      parseHostSemanticPlan(
        {
          ...plan,
          tasks: plan.tasks.map(({ expectedSeconds: _expectedSeconds, ...task }) => task),
        },
        "fanout",
        5,
      ),
    ).toThrow("must be a positive finite number");
  });

  it("routes malformed host semantic fields through one internal Sol repair", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const malformed = {
      ...hostPlan([
        { goal: "Inspect alpha", paths: [], after: [], floor: null },
        { goal: "Inspect beta", paths: [], after: [], floor: null },
      ]),
      merge: "invalid",
    };

    await expect(
      planner.adoptHostPlan(
        {
          objective: "Inspect two independent tasks",
          cwd: "/workspace/project",
          semanticPlan: malformed as never,
        },
        "host-malformed-run",
      ),
    ).rejects.toMatchObject({
      code: "host_plan_requires_internal_sol",
      message: expect.stringContaining("$.merge"),
    });
  });

  it("rejects a cycle after expanding numeric host dependencies", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));

    await expect(
      planner.adoptHostPlan(
        {
          objective: "Inspect two cyclic tasks",
          cwd: "/workspace/project",
          semanticPlan: hostPlan([
            { goal: "Inspect alpha", paths: [], after: [1], floor: null },
            { goal: "Inspect beta", paths: [], after: [0], floor: null },
          ]),
        },
        "host-cycle-run",
      ),
    ).rejects.toMatchObject({ code: "host_plan_requires_internal_sol" });
  });

  it("requests one structured ExecutionPlan from a Sol thread", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);
    const session = await planner.plan({
      objective: "Implement two modules",
      cwd: "/workspace/project",
      domain: "coding",
      constraints: ["Do not change public APIs"],
      capabilities: [
        { kind: "skill", name: "documents", path: "/capabilities/documents/SKILL.md" },
      ],
    });

    expect(session).toMatchObject({
      threadId: "planner-thread",
      patch: null,
      replanCount: 0,
    });
    expect(transport.starts).toHaveLength(1);
    expect(transport.starts[0]).toMatchObject({
      kind: "execution_plan",
      model: "gpt-5.6-sol",
      tier: "sol",
      effort: "low",
      forkTurns: "none",
      responseFormat: {
        type: "json_schema",
        name: "execution_plan",
        strict: true,
      },
    });
    expect(transport.starts[0]?.prompt).toContain('"Do not change public APIs"');
    expect(session.request.capabilities).toEqual([
      { kind: "skill", name: "documents", path: "/capabilities/documents/SKILL.md" },
    ]);

    session.plan.tasks[0]!.objective = "mutated by caller";
    expect(planner.getSession("planner-thread")?.plan.tasks[0]?.objective).toBe("Implement alpha");
  });

  it("uses low Sol reasoning for an explicit independent path partition", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const request = {
      objective:
        "Implement independent package roots packages/alpha and packages/beta in parallel.",
      cwd: "/workspace/project",
      domain: "coding" as const,
    };

    await new PlannerService(transport).plan(request);

    expect(recommendPlannerEffort(request, "fanout")).toBe("low");
    expect(transport.starts[0]?.effort).toBe("low");
    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { items: { properties: { g: { type: ["string", "null"] } } } } },
    });
    expect(
      recommendPlannerEffort(
        { objective: "Prove a difficult graph bound", cwd: "/workspace", domain: "algorithm" },
        "planned_single",
      ),
    ).toBe("high");
    expect(
      recommendPlannerEffort(
        {
          objective:
            "Solve independent exact cases in data/alpha/input.txt, data/beta/input.txt, and data/gamma/input.txt in parallel.",
          cwd: "/workspace",
          domain: "algorithm",
        },
        "fanout",
      ),
    ).toBe("low");
    const readOnlyTransport = new FakePlannerTransport(executionPlan());
    await new PlannerService(readOnlyTransport).plan({
      ...request,
      constraints: ["read-only benchmark: do not modify files"],
    });
    expect(readOnlyTransport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { items: { properties: { g: { type: ["string", "null"] } } } } },
    });
  });

  it("asks Sol for five leaves on a large independent read-only workspace", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const workspaceFiles = Array.from({ length: 10 }, (_, rootIndex) =>
      Array.from(
        { length: 3 },
        (_, fileIndex) =>
          `data/portfolio-${String(rootIndex + 1).padStart(2, "0")}/input-${String(fileIndex + 1)}.txt`,
      ),
    ).flat();
    const planner = new PlannerService(transport, {
      contextProvider: {
        load: async () => ({
          workspaceKind: "directory" as const,
          workspaceDirty: false,
          workspaceFiles,
          keyFiles: [],
          capabilities: [],
          economics: [],
        }),
      },
    });

    await planner.plan({
      objective: "Analyze each independent portfolio in parallel and return one combined report.",
      cwd: "/workspace/project",
      profile: "quality",
      constraints: ["read-only; do not modify files"],
      limits: { maxConcurrent: 5, maxLeaves: 8 },
    });

    expect(transport.starts[0]?.prompt).toContain('"preferredLeaves":5');
    expect(transport.starts[0]?.prompt).toContain('"maxCompactRootsPerLeaf":2');
    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { minItems: 5, maxItems: 5 } },
    });
  });

  it("does not force five leaves when many files compress into three work roots", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const workspaceFiles = Array.from({ length: 3 }, (_, rootIndex) =>
      Array.from(
        { length: 10 },
        (_, fileIndex) =>
          `data/root-${String(rootIndex + 1)}/case-${String(fileIndex + 1).padStart(2, "0")}.txt`,
      ),
    ).flat();
    const planner = new PlannerService(transport, {
      contextProvider: {
        load: async () => ({
          workspaceKind: "directory" as const,
          workspaceDirty: false,
          workspaceFiles,
          keyFiles: [],
          capabilities: [],
          economics: [],
        }),
      },
    });

    await planner.plan({
      objective: "Analyze each independent root in parallel.",
      cwd: "/workspace/project",
      profile: "quality",
      constraints: ["read-only; do not modify files"],
      limits: { maxConcurrent: 5, maxLeaves: 8 },
    });

    expect(transport.starts[0]?.prompt).not.toContain('"preferredLeaves"');
  });

  it("prefers explicit independent objective roots over nested workspace directories", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const workspaceFiles = Array.from({ length: 3 }, (_, rootIndex) =>
      Array.from({ length: 3 }, (_, caseIndex) =>
        ["requirements.txt", "input.txt"].map(
          (file) => `data/root-${String(rootIndex + 1)}/case-${String(caseIndex + 1)}/${file}`,
        ),
      ).flat(),
    ).flat();
    const planner = new PlannerService(transport, {
      contextProvider: {
        load: async () => ({
          workspaceKind: "directory" as const,
          workspaceDirty: false,
          workspaceFiles,
          keyFiles: [],
          capabilities: [],
          economics: [],
        }),
      },
    });

    await planner.plan({
      objective:
        "Read-only: process [unit:one], [unit:two], and [unit:three] from the independent roots data/root-1/, data/root-2/, and data/root-3/. in parallel.",
      cwd: "/workspace/project",
      profile: "quality",
      limits: { maxConcurrent: 5, maxLeaves: 8 },
    });

    expect(transport.starts[0]?.prompt).toContain('"preferredLeaves":3');
    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { minItems: 3, maxItems: 3 } },
    });
  });

  it("asks Sol for three leaves for nine compact office memo roots", async () => {
    const transport = new FakePlannerTransport(executionPlan({ domain: "office" }));
    const workspaceFiles = Array.from({ length: 9 }, (_, memoIndex) =>
      ["constraints.txt", "options.txt", "risk.txt", "actions.txt"].map(
        (file) => `data/office-a/memo-${String(memoIndex + 1).padStart(2, "0")}/${file}`,
      ),
    ).flat();
    const planner = new PlannerService(transport, {
      contextProvider: {
        load: async () => ({
          workspaceKind: "directory" as const,
          workspaceDirty: false,
          workspaceFiles,
          keyFiles: [],
          capabilities: [],
          economics: [],
        }),
      },
    });

    await planner.plan({
      objective: "Produce a decision memo for each independent case in parallel.",
      cwd: "/workspace/project",
      profile: "quality",
      domain: "office",
      constraints: ["read-only; do not modify files"],
      limits: { maxConcurrent: 5, maxLeaves: 8 },
    });

    expect(transport.starts[0]?.prompt).toContain('"preferredLeaves":3');
    expect(transport.starts[0]?.prompt).toContain('"maxCompactRootsPerLeaf":3');
    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { minItems: 3, maxItems: 3 } },
    });
  });

  it("expands a compact Sol micro-plan into the complete scheduler contract", async () => {
    const transport = new FakePlannerTransport({
      id: "micro-1",
      tasks: [
        {
          id: "alpha",
          objective: "Implement alpha",
          paths: ["src/alpha.ts"],
          after: [],
          floor: null,
          expectedSeconds: 200,
          difficulty: 0.2,
          ambiguity: 0.1,
          checks: ["npm test -- alpha"],
          capabilities: [],
        },
        {
          id: "beta",
          objective: "Implement beta",
          paths: ["src/beta.ts"],
          after: [],
          floor: null,
          expectedSeconds: 200,
          difficulty: 0.25,
          ambiguity: 0.15,
          checks: ["npm test -- beta"],
          capabilities: [],
        },
      ],
      merge: "deterministic",
      risk: "low",
    });
    const session = await new PlannerService(transport).plan({
      objective: "Implement alpha and beta",
      cwd: "/workspace/project",
      domain: "coding",
      limits: { maxLeaves: 2 },
    });

    expect(session.plan).toMatchObject({
      protocolVersion: 1,
      planId: "micro-1",
      origin: "sol",
      risk: "low",
      integration: { aggregation: "deterministic", finalReview: "never" },
    });
    expect(session.plan.tasks).toEqual([
      expect.objectContaining({
        id: "alpha",
        tier: "luna",
        effort: "medium",
        access: "workspaceWrite",
        validatorStrength: "strong",
      }),
      expect.objectContaining({
        id: "beta",
        tier: "luna",
        effort: "medium",
        access: "workspaceWrite",
        expectedSeconds: 200,
        validatorStrength: "strong",
      }),
    ]);
    expect(session.plan.tasks.map((task) => task.expectedSeconds)).toEqual([200, 200]);
    expect(session.plan.tasks[0]!.objective).toContain("Implement alpha and beta");
    expect(session.plan.tasks[0]!.objective).toContain("this task's ownedPaths");
    expect(session.plan.tasks[0]!.objective).toContain("complete user-visible leaf deliverable");
    expect(JSON.stringify(transport.starts[0]?.responseFormat.schema).length).toBeLessThan(2_500);
  });

  it("expands the indexed wire micro-plan without model-generated mechanical fields", async () => {
    const transport = new FakePlannerTransport({
      t: [
        { p: ["src/alpha.ts"], g: null, a: [], f: null, s: 120, c: [] },
        { p: ["src/beta.ts"], g: "Implement beta", a: [], f: "t", s: 120, c: [] },
        { p: ["src/gamma.ts"], g: "Finish gamma", a: [0], f: null, s: 40, c: [] },
      ],
      m: "d",
      r: "l",
    });
    const session = await new PlannerService(transport).plan({
      objective: "Implement alpha and beta",
      cwd: "/workspace/project",
      domain: "coding",
      limits: { maxLeaves: 3 },
    });

    expect(session.plan).toMatchObject({
      planId: "sol-plan",
      risk: "low",
      integration: { aggregation: "deterministic" },
      tasks: [
        { id: "leaf-1", tier: "luna", ownedPaths: ["src/alpha.ts"], dependsOn: [] },
        { id: "leaf-2", tier: "terra", ownedPaths: ["src/beta.ts"], dependsOn: [] },
        { id: "leaf-3", tier: "luna", ownedPaths: ["src/gamma.ts"], dependsOn: ["leaf-1"] },
      ],
    });
    expect(session.plan.tasks[0]!.objective).toContain("src/alpha.ts");
    expect(session.plan.tasks[0]!.objective).toContain(
      "do not create deliverables for unowned paths",
    );
  });

  it("uses boundary-only Sol output for explicit independent roots", async () => {
    const transport = new FakePlannerTransport({
      t: [{ p: ["packages/alpha/"] }, { p: ["packages/beta/"] }, { p: ["packages/gamma/"] }],
    });
    const planner = new PlannerService(transport, {
      deferEconomicAdmission: true,
      contextProvider: {
        load: async () => ({
          workspaceKind: "git" as const,
          workspaceDirty: false,
          workspaceFiles: [
            "packages/alpha/index.ts",
            "packages/beta/index.ts",
            "packages/gamma/index.ts",
            "validation/alpha.test.mjs",
            "validation/beta.test.mjs",
            "validation/gamma.test.mjs",
          ],
          keyFiles: [],
          capabilities: [],
          economics: [
            {
              tier: "sol" as const,
              model: "gpt-5.6-sol",
              uncachedInputPerMillion: 4,
              outputPerMillion: 20,
            },
          ],
        }),
      },
    });

    const session = await planner.plan({
      objective:
        "Implement the independent roots packages/alpha/, packages/beta/, and packages/gamma/ in parallel and make the validation tests pass.",
      cwd: "/workspace/project",
      profile: "quality",
      domain: "coding",
      limits: { maxLeaves: 5 },
    });

    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      required: ["t"],
      properties: {
        t: {
          minItems: 3,
          maxItems: 3,
          items: {
            required: ["p"],
            properties: { p: expect.any(Object) },
          },
        },
      },
    });
    expect(transport.starts[0]?.prompt).not.toContain('"economics"');
    expect(session.plan.tasks).toEqual([
      expect.objectContaining({
        tier: "luna",
        expectedSeconds: 20,
        dependsOn: [],
        ownedPaths: ["packages/alpha/"],
        validation: [{ command: "node --test validation/alpha.test.mjs" }],
        validatorStrength: "strong",
      }),
      expect.objectContaining({
        tier: "luna",
        expectedSeconds: 20,
        dependsOn: [],
        ownedPaths: ["packages/beta/"],
        validation: [{ command: "node --test validation/beta.test.mjs" }],
        validatorStrength: "strong",
      }),
      expect.objectContaining({
        tier: "luna",
        expectedSeconds: 20,
        dependsOn: [],
        ownedPaths: ["packages/gamma/"],
        validation: [{ command: "node --test validation/gamma.test.mjs" }],
        validatorStrength: "strong",
      }),
    ]);
  });

  it("keeps the full Sol micro-plan for potentially dependent work", async () => {
    const transport = new FakePlannerTransport({
      t: [
        { p: ["packages/alpha/"], g: null, a: [], f: null, s: 40, c: [] },
        { p: ["packages/beta/"], g: null, a: [0], f: null, s: 40, c: [] },
      ],
      m: "d",
      r: "l",
    });
    const planner = new PlannerService(transport);

    await expect(
      planner.plan({
        objective: "Implement packages/alpha/ first, then use it from packages/beta/.",
        cwd: "/workspace/project",
        domain: "coding",
        limits: { maxLeaves: 2 },
      }),
    ).rejects.toThrow("insufficient_ready_tasks");

    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: {
        t: {
          items: {
            required: ["p", "g", "a", "f", "s", "c"],
          },
        },
      },
    });
  });

  it("preserves internal Sol semantic boundaries after the route capped output cardinality", async () => {
    const transport = new FakePlannerTransport({
      id: "sol-five-way",
      tasks: Array.from({ length: 5 }, (_, index) => ({
        id: `module-${String(index + 1)}`,
        objective: `Inspect module ${String(index + 1)}`,
        paths: [`src/module-${String(index + 1)}.ts`],
        after: [],
        floor: null,
        expectedSeconds: 180,
        capabilities: [],
      })),
      merge: "deterministic",
      risk: "low",
    });

    const session = await new PlannerService(transport).plan({
      objective: "Inspect five independent modules",
      cwd: "/workspace/project",
      profile: "quality",
      domain: "coding",
      limits: { maxLeaves: 5 },
    });

    expect(session.plan.tasks).toHaveLength(5);
    expect(session.plan.tasks.map((task) => task.ownedPaths)).toEqual(
      Array.from({ length: 5 }, (_, index) => [`src/module-${String(index + 1)}.ts`]),
    );
  });

  it("preserves bounded internal Sol leaf boundaries for final economic admission", async () => {
    const transport = new FakePlannerTransport({
      t: Array.from({ length: 4 }, (_, index) => ({
        p: [`src/fragment-${String(index + 1)}.ts`],
        g: `Inspect fragment ${String(index + 1)}`,
        a: [],
        f: null,
        s: 40,
        c: [],
      })),
      m: "d",
      r: "l",
    });

    const session = await new PlannerService(transport).plan({
      objective: "Inspect four independent fragments",
      cwd: "/workspace/project",
      profile: "quality",
      domain: "coding",
      limits: { maxLeaves: 4 },
    });

    expect(session.plan.tasks).toHaveLength(4);
    expect(session.plan.tasks.map((task) => task.expectedSeconds)).toEqual([40, 40, 40, 40]);
    expect(session.plan.tasks.flatMap((task) => task.ownedPaths)).toEqual([
      "src/fragment-1.ts",
      "src/fragment-2.ts",
      "src/fragment-3.ts",
      "src/fragment-4.ts",
    ]);
  });

  it("adopts a host Sol plan with zero initial model usage and lazily enables one patch", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);
    const semanticPlan = hostPlan(
      ["alpha", "beta"].map((id) => ({
        goal: `Inspect ${id}`,
        paths: [],
        after: [],
        floor: null,
      })),
    );
    const session = await planner.adoptHostPlan(
      {
        objective: "Inspect alpha and beta",
        cwd: "/workspace/project",
        domain: "coding",
        semanticPlan,
      },
      "host-run",
    );

    expect(session).toMatchObject({
      threadId: "external:host-run",
      limits: { maxReplans: 1 },
      usage: [],
      plan: { planId: "host-plan", tasks: [{ tier: "luna" }, { tier: "luna" }] },
    });
    expect(session.plan.tasks[0]!.objective).toContain("Inspect alpha and beta");
    expect(session.plan.tasks[0]!.objective).toContain("complete user-visible leaf deliverable");
    expect(session.plan.tasks[0]!.objective.match(/Inspect alpha and beta/g)).toHaveLength(1);
    expect(planner.createReplanHandler(session)).toMatchObject({
      replan: expect.any(Function),
      answer: expect.any(Function),
    });
    expect(transport.starts).toHaveLength(0);

    transport.startOutput = {
      protocolVersion: 1,
      planId: "host-plan",
      reason: "The first host leaf needs repair",
      operations: [
        {
          op: "replace",
          taskId: "leaf-1",
          task: { ...session.plan.tasks[0]!, objective: "Repair the first host leaf" },
        },
      ],
    };
    const patched = await planner.requestPatch(session, [trigger]);
    expect(patched).toMatchObject({
      continuationThreadId: "planner-thread",
      replanCount: 1,
      patch: { reason: "The first host leaf needs repair" },
    });
    expect(transport.starts).toHaveLength(1);
    expect(transport.continuations).toHaveLength(0);
  });

  it("removes sibling-specific objective lines from path-scoped leaves", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const objective = [
      "Inspect two independent roots and preserve exact identifiers.",
      "The roots are data/alpha/ and data/beta/.",
      "[unit:alpha] Analyze data/alpha/ and return [item:alpha-result].",
      "[unit:beta] Analyze data/beta/ and return [item:beta-result].",
      "Do not modify files.",
    ].join("\n");
    const session = await planner.adoptHostPlan(
      {
        objective,
        cwd: "/workspace/project",
        domain: "research",
        semanticPlan: hostPlan([
          { goal: null, paths: ["data/alpha/"], after: [], floor: null },
          { goal: null, paths: ["data/beta/"], after: [], floor: null },
        ]),
      },
      "host-scoped-objective-run",
    );

    expect(session.plan.tasks[0]!.objective).toContain("[unit:alpha]");
    expect(session.plan.tasks[0]!.objective).toContain("Do not modify files.");
    expect(session.plan.tasks[0]!.objective).not.toContain("[unit:beta]");
    expect(session.plan.tasks[0]!.objective).not.toContain("The roots are data/alpha/");
    expect(session.plan.tasks[1]!.objective).toContain("[unit:beta]");
    expect(session.plan.tasks[1]!.objective).not.toContain("[unit:alpha]");
  });

  it("removes parent cardinality when Sol subdivides one unit across leaves", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const objective = [
      "Prepare three independent memos.",
      "[unit:alpha] Produce three complete memos from data/alpha/. Each memo must include exact arithmetic and every owner deadline. Begin each memo with its item marker.",
      "Do not modify files.",
    ].join("\n");
    const session = await planner.adoptHostPlan(
      {
        objective,
        cwd: "/workspace/project",
        semanticPlan: hostPlan([
          {
            goal: "Produce item alpha-01 and alpha-02",
            paths: ["data/alpha/alpha-01/", "data/alpha/alpha-02/"],
            after: [],
            floor: null,
          },
          {
            goal: "Produce item alpha-03",
            paths: ["data/alpha/alpha-03/"],
            after: [],
            floor: null,
          },
        ]),
      },
      "host-subdivided-unit-run",
    );

    expect(session.plan.tasks[0]!.objective).toContain(
      "[unit:alpha] Each memo must include exact arithmetic and every owner deadline.",
    );
    expect(session.plan.tasks[0]!.objective).not.toContain("Produce three complete memos");
    expect(session.plan.tasks[0]!.objective).toContain("Do not modify files.");
    expect(session.plan.tasks[0]!.objective).toContain(
      "exact item markers, one before each corresponding owned item: [item:alpha-01], [item:alpha-02]",
    );
    expect(session.plan.tasks[1]!.objective).toContain("[item:alpha-03]");
  });

  it("preserves the host Sol fanout granularity", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      goal: `Inspect module ${String(index + 1)}`,
      paths: [`src/module-${String(index + 1)}.ts`],
      after: [],
      floor: null,
    }));

    const session = await planner.adoptHostPlan(
      {
        objective: "Inspect five independent modules",
        cwd: "/workspace/project",
        profile: "quality",
        domain: "coding",
        semanticPlan: hostPlan(tasks),
      },
      "host-granularity-run",
    );

    expect(session.plan.tasks).toHaveLength(5);
    expect(session.plan.tasks.map((task) => task.ownedPaths)).toEqual(
      tasks.map((task) => task.paths),
    );
  });

  it("propagates only explicitly selected capabilities to host-plan leaves", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()), {
      contextProvider: {
        load: async () => ({
          workspaceKind: "directory" as const,
          workspaceDirty: false,
          workspaceFiles: [],
          keyFiles: [],
          capabilities: [
            { kind: "skill" as const, name: "documents", source: "system" as const },
            { kind: "skill" as const, name: "presentations", source: "system" as const },
          ],
          economics: [],
        }),
      },
    });

    const session = await planner.adoptHostPlan(
      {
        objective: "Prepare two document sections",
        cwd: "/workspace/project",
        profile: "quality",
        domain: "office",
        capabilities: [{ kind: "skill", name: "documents" }],
        semanticPlan: hostPlan([
          { goal: "Prepare section alpha", paths: [], after: [], floor: null },
          { goal: "Prepare section beta", paths: [], after: [], floor: null },
        ]),
      },
      "host-capability-run",
    );

    expect(session.plan.tasks.every((task) => task.capabilities.length === 1)).toBe(true);
    expect(session.plan.tasks.map((task) => task.capabilities[0])).toEqual([
      { kind: "skill", name: "documents" },
      { kind: "skill", name: "documents" },
    ]);
  });

  it("adopts disjoint bounded writers and preserves their declared write access", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);
    const session = await planner.adoptHostPlan(
      {
        objective: "Fix alpha and beta",
        cwd: "/workspace/project",
        domain: "coding",
        semanticPlan: hostPlan(
          [
            { goal: null, paths: ["src/alpha.ts"], after: [], floor: null },
            { goal: null, paths: ["src/beta.ts"], after: [], floor: null },
          ],
          { access: "workspaceWrite" },
        ),
      },
      "host-writer-run",
    );

    expect(session.plan).toMatchObject({
      risk: "low",
      integration: { aggregation: "deterministic", finalReview: "never" },
      tasks: [
        { access: "workspaceWrite", ownedPaths: ["src/alpha.ts"] },
        { access: "workspaceWrite", ownedPaths: ["src/beta.ts"] },
      ],
    });
    expect(transport.starts).toHaveLength(0);
  });

  it.each([
    ["semantic merge", { merge: "terra" as const }, "low"],
    ["medium risk", { risk: "medium" as const }, "medium"],
    ["high risk", { risk: "high" as const }, "high"],
  ])("adopts %s host plans without an eager internal Sol turn", async (_label, overrides, risk) => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);
    await expect(
      planner.adoptHostPlan(
        {
          objective: "Inspect alpha and beta",
          cwd: "/workspace/project",
          semanticPlan: hostPlan(
            [
              { goal: "Inspect alpha", paths: [], after: [], floor: null },
              { goal: "Inspect beta", paths: [], after: [], floor: null },
            ],
            overrides,
          ),
        },
        "unsafe-host-run",
      ),
    ).resolves.toMatchObject({
      plan: {
        risk,
        integration: {
          aggregation: "merge" in overrides ? overrides.merge : "deterministic",
          finalReview: "never",
        },
      },
      usage: [],
    });
    expect(transport.starts).toHaveLength(0);
  });

  it("adopts a dependent multi-wave host DAG when a later wave has real parallelism", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const session = await new PlannerService(transport).adoptHostPlan(
      {
        objective: "Inspect the manifest, then analyze two independent subsystems",
        cwd: "/workspace/project",
        domain: "coding",
        semanticPlan: hostPlan(
          [
            { goal: "Inspect the build manifest", paths: [], after: [], floor: null },
            { goal: "Analyze subsystem alpha", paths: [], after: [0], floor: null },
            { goal: "Analyze subsystem beta", paths: [], after: [0], floor: null },
          ],
          { merge: "terra", risk: "medium" },
        ),
      },
      "host-multi-wave",
    );

    expect(session.plan).toMatchObject({
      risk: "medium",
      tasks: [
        { id: "leaf-1", dependsOn: [] },
        { id: "leaf-2", dependsOn: ["leaf-1"] },
        { id: "leaf-3", dependsOn: ["leaf-1"] },
      ],
      integration: { aggregation: "terra", finalReview: "never" },
    });
    expect(transport.starts).toHaveLength(0);
  });

  it.each([
    ["an empty scope", []],
    ["the workspace root", ["."]],
    ["overlapping paths", ["src", "src/alpha.ts"]],
  ])("routes writers with %s back to the internal Sol planner", async (_label, paths) => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const firstPaths = paths.length === 2 ? [paths[0]!] : paths;
    const secondPaths = paths.length === 2 ? [paths[1]!] : ["src/beta.ts"];
    await expect(
      planner.adoptHostPlan(
        {
          objective: "Fix alpha and beta",
          cwd: "/workspace/project",
          semanticPlan: hostPlan(
            [
              { goal: "Fix alpha", paths: firstPaths, after: [], floor: null },
              { goal: "Fix beta", paths: secondPaths, after: [], floor: null },
            ],
            { access: "workspaceWrite" },
          ),
        },
        "unsafe-writer-run",
      ),
    ).rejects.toMatchObject({ code: "host_plan_requires_internal_sol" });
  });

  it("preserves read-only access for tasks scoped to workspace paths", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const session = await planner.adoptHostPlan(
      {
        objective: "Inspect alpha and beta",
        cwd: "/workspace/project",
        semanticPlan: hostPlan([
          { goal: null, paths: ["src/alpha.ts"], after: [], floor: null },
          { goal: null, paths: ["src/beta.ts"], after: [], floor: null },
        ]),
      },
      "scoped-read-run",
    );

    expect(session.plan.tasks.every((task) => task.access === "readOnly")).toBe(true);
  });

  it("allows output writes when the objective protects only input files", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    const session = await planner.adoptHostPlan(
      {
        objective: "Read observations.csv, create metrics.json, and do not modify inputs.",
        cwd: "/workspace/project",
        constraints: ["workspace-write: modify only requested deliverables"],
        semanticPlan: hostPlan(
          [
            {
              goal: "Create alpha metrics without modifying inputs",
              paths: ["data/alpha/metrics.json"],
              after: [],
              floor: null,
            },
            {
              goal: "Create beta metrics without modifying inputs",
              paths: ["data/beta/metrics.json"],
              after: [],
              floor: null,
            },
          ],
          { access: "workspaceWrite" },
        ),
      },
      "protected-input-run",
    );

    expect(session.plan.tasks.every((task) => task.access === "workspaceWrite")).toBe(true);
  });

  it("derives host task complexity from the explicit floor without another model turn", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);
    const session = await planner.adoptHostPlan(
      {
        objective: "Inspect two independent modules",
        cwd: "/workspace/project",
        semanticPlan: hostPlan([
          {
            goal: null,
            paths: ["src/cheap.ts"],
            after: [],
            floor: null,
          },
          { goal: "Inspect hard", paths: [], after: [], floor: "terra" },
        ]),
      },
      "host-tier-run",
    );

    expect(session.plan.tasks).toEqual([
      expect.objectContaining({
        id: "leaf-1",
        objective: expect.stringContaining("Inspect two independent modules"),
        tier: "luna",
        effort: "low",
        difficulty: 0.2,
        ambiguity: 0.1,
      }),
      expect.objectContaining({
        id: "leaf-2",
        tier: "terra",
        difficulty: 0.65,
        ambiguity: 0.45,
      }),
    ]);
    expect(transport.starts).toHaveLength(0);
  });

  it("rejects a null host objective without an owned path scope", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));
    await expect(
      planner.adoptHostPlan(
        {
          objective: "Research two unrelated questions",
          cwd: "/workspace/project",
          semanticPlan: hostPlan([
            { goal: null, paths: [], after: [], floor: null },
            { goal: "Research question two", paths: [], after: [], floor: null },
          ]),
        },
        "unscoped-run",
      ),
    ).rejects.toThrow("can be null only when paths provides a deterministic assigned scope");
  });

  it("continues the same thread for one minimal PlanPatch and applies it", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);
    const session = await planner.createPlan({
      objective: "Implement two modules",
      cwd: "/workspace/project",
      domain: "coding",
    });
    const patched = await planner.requestPatch(session, [trigger]);

    expect(transport.continuations).toHaveLength(1);
    expect(transport.continuations[0]).toMatchObject({
      threadId: "planner-thread",
      request: {
        kind: "plan_patch",
        tier: "sol",
        responseFormat: { name: "plan_patch", strict: true },
      },
    });
    expect(patched.patch).toEqual(replacementPatch());
    expect(patched.replanCount).toBe(1);
    expect(patched.plan.tasks.find((task) => task.id === "alpha")?.objective).toBe("Repair alpha");

    await expect(planner.replan(patched, [trigger])).rejects.toMatchObject({
      code: "replan_limit",
    } satisfies Partial<PlannerStateError>);
    expect(transport.continuations).toHaveLength(1);
  });

  it("consumes an invalid over-capacity PlanPatch without replacing the active plan", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport, { limits: { maxLeaves: 2 } });
    const session = await planner.createPlan({
      objective: "Implement two modules",
      cwd: "/workspace/project",
      domain: "coding",
    });
    const added = leaf("third", { ownedPaths: ["src/third.ts"] });
    transport.patchOutput = {
      protocolVersion: 1,
      planId: session.plan.planId,
      reason: "add another task",
      operations: [{ op: "add", task: added }],
    };

    const patched = await planner.requestPatch(session, [trigger]);

    expect(patched).toMatchObject({ patch: null, replanCount: 1 });
    expect(patched.plan).toEqual(session.plan);
    await expect(planner.requestPatch(patched, [trigger])).rejects.toMatchObject({
      code: "replan_limit",
    });
  });

  it("restores and continues the persisted planner thread without starting a new turn", async () => {
    const request = {
      objective: "Implement two modules",
      cwd: "/workspace/project",
      domain: "coding" as const,
    };
    const seedTransport = new FakePlannerTransport(executionPlan());
    const persisted = await new PlannerService(seedTransport).plan(request, "resume-run");
    persisted.usage.push({
      model: "gpt-5.6-sol",
      tier: "sol",
      effort: "high",
      cachedInputTokens: 10,
      uncachedInputTokens: 20,
      outputTokens: 5,
      totalTokens: 35,
      estimatedCostUsd: 0.02,
    });
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);

    const restored = planner.restoreSession(persisted);

    expect(transport.starts).toHaveLength(0);
    expect(transport.registrations).toEqual([
      { threadId: "planner-thread", cwd: "/workspace/project", runId: "resume-run" },
    ]);
    expect(planner.getSession("planner-thread")).toEqual(persisted);

    const patched = await planner.requestPatch(restored, [trigger]);
    expect(patched.replanCount).toBe(1);
    expect(transport.starts).toHaveLength(0);
    expect(transport.continuations).toEqual([
      expect.objectContaining({
        threadId: "planner-thread",
        request: expect.objectContaining({ kind: "plan_patch", runId: "resume-run" }),
      }),
    ]);
  });

  it("drops planner shell checks for read-only analysis leaves", async () => {
    const transport = new FakePlannerTransport({
      id: "read-only-micro",
      tasks: ["alpha", "beta"].map((id) => ({
        id,
        objective: `Audit ${id}`,
        paths: [`src/${id}.ts`],
        after: [],
        floor: null,
        expectedSeconds: 90,
        difficulty: 0.2,
        ambiguity: 0.1,
        checks: ["npx tsc --noEmit"],
        capabilities: [],
      })),
      merge: "deterministic",
      risk: "low",
    });
    const session = await new PlannerService(transport).plan({
      objective: "Audit alpha and beta without modifying files",
      cwd: "/workspace/project",
      domain: "coding",
      constraints: ["read-only: do not modify files"],
      limits: { maxLeaves: 2 },
    });

    expect(session.plan.tasks).toEqual([
      expect.objectContaining({
        access: "readOnly",
        effort: "low",
        validation: [],
        validatorStrength: "none",
      }),
      expect.objectContaining({
        access: "readOnly",
        effort: "low",
        validation: [],
        validatorStrength: "none",
      }),
    ]);
    expect(transport.starts[0]?.effort).toBe("low");
  });

  it("keeps quality planning at medium effort for semantically coupled work", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    await new PlannerService(transport).plan({
      objective: "Analyze two coupled modules and synthesize the result",
      cwd: "/workspace/project",
      domain: "coding",
      profile: "quality",
    });

    expect(transport.starts[0]?.effort).toBe("medium");
  });

  it("restores legacy patched state without reopening the consumed patch turn", async () => {
    const request = { objective: "Implement", cwd: "/workspace/project" };
    const seedTransport = new FakePlannerTransport(executionPlan());
    const seedPlanner = new PlannerService(seedTransport);
    const initial = await seedPlanner.plan(request, "legacy-run");
    const patched = await seedPlanner.requestPatch(initial, [trigger]);
    const legacyState = {
      ...patched,
      initialPlan: structuredClone(patched.plan),
    };
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport);

    const restored = planner.restoreSession(legacyState);

    expect(restored).toEqual(legacyState);
    expect(transport.starts).toHaveLength(0);
    expect(transport.registrations).toEqual([
      { threadId: "planner-thread", cwd: "/workspace/project", runId: "legacy-run" },
    ]);
    await expect(planner.requestPatch(restored, [trigger])).rejects.toMatchObject({
      code: "replan_limit",
    });
    expect(transport.continuations).toHaveLength(0);
  });

  it("reserves the single patch turn before awaiting the transport", async () => {
    let resolveContinuation: ((response: PlannerTurnResponse) => void) | undefined;
    class DeferredTransport extends FakePlannerTransport {
      override async continue(
        threadId: string,
        request: PlannerTurnRequest,
      ): Promise<PlannerTurnResponse> {
        this.continuations.push({ threadId, request });
        return new Promise((resolve) => {
          resolveContinuation = resolve;
        });
      }
    }
    const transport = new DeferredTransport(executionPlan());
    const planner = new PlannerService(transport);
    const session = await planner.plan({ objective: "Implement", cwd: "/workspace" });
    const first = planner.requestPatch(session, [trigger]);
    await expect(planner.requestPatch(session, [trigger])).rejects.toMatchObject({
      code: "replan_limit",
    });
    resolveContinuation?.({ threadId: "planner-thread", output: replacementPatch() });
    await expect(first).resolves.toMatchObject({ replanCount: 1 });
    expect(transport.continuations).toHaveLength(1);
  });

  it("rejects invalid structured output and a continuation that changes thread", async () => {
    const invalidTransport = new FakePlannerTransport({ planId: "missing-fields" });
    const invalidPlanner = new PlannerService(invalidTransport);
    await expect(
      invalidPlanner.plan({ objective: "Implement", cwd: "/workspace" }),
    ).rejects.toBeInstanceOf(PlanValidationError);

    const transport = new FakePlannerTransport(executionPlan());
    transport.continuationThreadId = "different-thread";
    const planner = new PlannerService(transport);
    const session = await planner.plan({ objective: "Implement", cwd: "/workspace" });
    await expect(planner.requestPatch(session, [trigger])).rejects.toMatchObject({
      code: "thread_mismatch",
    });
  });

  it("rejects a Sol plan that does not justify fanout", async () => {
    const transport = new FakePlannerTransport(
      executionPlan({ tasks: [leaf("only", { expectedSeconds: 20 })] }),
    );
    const planner = new PlannerService(transport);
    await expect(
      planner.plan({ objective: "small task", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "fanout_rejected" });
  });

  it("defers only economic fanout rejection when final calibrated admission is available", async () => {
    const uneconomic = executionPlan({
      tasks: [leaf("alpha", { expectedSeconds: 60 }), leaf("beta", { expectedSeconds: 60 })],
    });
    const planner = new PlannerService(new FakePlannerTransport(uneconomic), {
      deferEconomicAdmission: true,
    });

    await expect(
      planner.plan({ objective: "Implement two bounded modules", cwd: "/workspace" }),
    ).resolves.toMatchObject({ plan: { tasks: [{ id: "alpha" }, { id: "beta" }] } });
  });

  it("keeps structural fanout rejection when economic admission is deferred", async () => {
    const overlapping = executionPlan({
      tasks: [
        leaf("alpha", { ownedPaths: ["src/core"] }),
        leaf("beta", { ownedPaths: ["src/core/planner.ts"] }),
      ],
    });
    const planner = new PlannerService(new FakePlannerTransport(overlapping, overlapping), {
      deferEconomicAdmission: true,
    });

    await expect(
      planner.plan({ objective: "Implement two overlapping modules", cwd: "/workspace" }),
    ).rejects.toMatchObject({
      code: "plan_validation",
      issues: expect.arrayContaining([expect.objectContaining({ code: "ownership_overlap" })]),
    });
  });

  it.each([
    ["missing", undefined],
    ["15-second", 15],
  ])("rejects %s expectedSeconds in an internal fanout micro-plan", async (_label, duration) => {
    const tasks = ["alpha", "beta"].map((id) => ({
      id,
      objective: `Inspect ${id}`,
      paths: [],
      after: [],
      floor: null,
      ...(duration === undefined ? {} : { expectedSeconds: duration }),
      capabilities: [],
    }));
    const planner = new PlannerService(
      new FakePlannerTransport({ id: "short-plan", tasks, merge: "deterministic", risk: "low" }),
    );

    await expect(
      planner.plan({ objective: "Inspect alpha and beta", cwd: "/workspace", profile: "quality" }),
    ).rejects.toThrow(
      duration === undefined
        ? "must be a positive finite number"
        : "must be greater than 15 for fanout",
    );
  });

  it("plans one difficult non-decomposable leaf on planned_single", async () => {
    const transport = new FakePlannerTransport({
      id: "single-proof",
      tasks: [
        {
          id: "proof",
          objective: "Prove the algorithm",
          paths: [],
          after: [],
          floor: "sol",
          expectedSeconds: 20,
          capabilities: [],
        },
      ],
      merge: "deterministic",
      risk: "low",
    });
    const planner = new PlannerService(transport);

    const session = await planner.plan(
      { objective: "Prove the algorithm", cwd: "/workspace" },
      "single-run",
      undefined,
      "planned_single",
    );

    expect(session.plan.tasks).toEqual([
      expect.objectContaining({ id: "proof", tier: "sol", expectedSeconds: 20 }),
    ]);
    expect(transport.starts[0]?.prompt).toContain('"route":"single"');
    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: {
        m: { enum: ["d", "t"] },
        t: {
          minItems: 1,
          maxItems: 1,
          items: {
            properties: {
              g: { maxLength: 120 },
              p: { maxItems: 24 },
              s: { type: "number", exclusiveMinimum: 0 },
              c: { maxItems: 6 },
            },
          },
        },
      },
    });
  });

  it.each([1, 2, 3, 5])("lets adaptive Sol choose %i execution leaves", async (count) => {
    const tasks = Array.from({ length: count }, (_, index) =>
      leaf(`adaptive-${String(index + 1)}`),
    );
    const transport = new FakePlannerTransport(executionPlan({ tasks }));
    const planner = new PlannerService(transport);

    const session = await planner.plan(
      {
        objective: "Choose the useful execution shape",
        cwd: "/workspace",
        profile: "quality",
        limits: { maxLeaves: count, maxSolLeaves: Math.min(1, count) },
      },
      `adaptive-${String(count)}`,
      undefined,
      "adaptive",
    );

    expect(session.plan.tasks).toHaveLength(count);
    expect(transport.starts).toHaveLength(1);
    expect(transport.starts[0]?.prompt).toContain('"route":"adaptive"');
    expect(transport.starts[0]?.responseFormat.schema).toMatchObject({
      properties: { t: { minItems: 1, maxItems: count } },
    });
  });

  it("rejects multiple leaves on planned_single", async () => {
    const planner = new PlannerService(new FakePlannerTransport(executionPlan()));

    await expect(
      planner.plan(
        { objective: "One hard task", cwd: "/workspace" },
        undefined,
        undefined,
        "planned_single",
      ),
    ).rejects.toMatchObject({ code: "planned_single_rejected" });
  });

  it("restores planned_single state and rejects a patch that expands it", async () => {
    const single = executionPlan({ tasks: [leaf("proof")] });
    const request = { objective: "Prove the algorithm", cwd: "/workspace" };
    const persisted = await new PlannerService(new FakePlannerTransport(single)).plan(
      request,
      "single-resume",
      undefined,
      "planned_single",
    );
    const transport = new FakePlannerTransport(single, {
      protocolVersion: 1,
      planId: "plan-1",
      reason: "Add a second task",
      operations: [{ op: "add", task: leaf("extra") }],
    });
    const planner = new PlannerService(transport);
    const restored = planner.restoreSession(persisted);

    await expect(
      planner.requestPatch(restored, [{ ...trigger, taskIds: ["proof"] }]),
    ).rejects.toMatchObject({ code: "plan_patch_route_rejected" });
    expect(transport.starts).toHaveLength(0);
    expect(transport.continuations).toHaveLength(1);
    expect(transport.continuations[0]?.request.prompt).toContain(
      '"executionRoute":"planned_single"',
    );
  });

  it("honors a request that disables replanning", async () => {
    const transport = new FakePlannerTransport(executionPlan());
    const planner = new PlannerService(transport, { limits: { maxReplans: 0 } });
    const session = await planner.plan({ objective: "Implement", cwd: "/workspace" });
    await expect(planner.requestPatch(session, [trigger])).rejects.toMatchObject({
      code: "replan_disabled",
    });
    expect(transport.continuations).toHaveLength(0);
  });
});
