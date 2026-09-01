import {
  AGENT_TRIO_PROTOCOL_VERSION,
  type ExecutionLimits,
  type ExecutionPlan,
  type LeafTask,
  type ModelUsage,
  type PlanPatch,
} from "./contracts.js";
import {
  assertTierAssignment,
  assertTierEffort,
  findConcurrentOwnedPathConflicts,
  normalizeExecutionLimits,
  PolicyError,
} from "./policy.js";
import type { PlannedExecutionRoute } from "./integration.js";

export interface PlanValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type PlanValidationResult<T> =
  { ok: true; value: T; issues: [] } | { ok: false; issues: PlanValidationIssue[] };

export interface PlanPatchValidationOptions {
  expectedPlanId?: string;
  basePlan?: ExecutionPlan;
  limits?: Partial<ExecutionLimits>;
  immutableTaskIds?: readonly string[];
}

export class PlanValidationError extends Error {
  readonly code = "plan_validation";
  readonly issues: readonly PlanValidationIssue[];
  readonly threadId: string | null;
  readonly usage: ModelUsage[];

  constructor(
    label: string,
    issues: readonly PlanValidationIssue[],
    details: { threadId?: string | null; usage?: readonly ModelUsage[] } = {},
  ) {
    super(
      `${label} is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    );
    this.name = "PlanValidationError";
    this.issues = issues;
    this.threadId = details.threadId ?? null;
    this.usage = structuredClone([...(details.usage ?? [])]);
  }
}

export interface PlanGraphAnalysis {
  waves: string[][];
  criticalPathSeconds: number;
  missingDependencies: Array<{ taskId: string; dependencyId: string }>;
  cycleTaskIds: string[];
}

const DOMAINS = [
  "coding",
  "algorithm",
  "research",
  "paper",
  "office",
  "autoResearch",
  "general",
] as const;
const TIERS = ["luna", "terra", "sol"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const ACCESS = ["readOnly", "workspaceWrite"] as const;
const RISKS = ["low", "medium", "high"] as const;
const FINAL_REVIEW = ["never", "riskTriggered", "always"] as const;
const CAPABILITY_KINDS = ["skill", "plugin"] as const;

export function validateExecutionPlan(
  input: unknown,
  limitOverrides: Partial<ExecutionLimits> = {},
  route?: PlannedExecutionRoute,
): PlanValidationResult<ExecutionPlan> {
  input = normalizeOptionalPlanNulls(input);
  const issues: PlanValidationIssue[] = [];
  const limits = resolveLimits(limitOverrides, issues);
  if (!isRecord(input)) {
    issue(issues, "$", "type", "must be an object.");
    return { ok: false, issues };
  }

  rejectUnknownKeys(
    input,
    [
      "protocolVersion",
      "planId",
      "objective",
      "domain",
      "assumptions",
      "tasks",
      "integration",
      "risk",
      "origin",
    ],
    "$",
    issues,
  );
  if (input["protocolVersion"] !== AGENT_TRIO_PROTOCOL_VERSION) {
    issue(
      issues,
      "$.protocolVersion",
      "protocol_version",
      `must equal ${AGENT_TRIO_PROTOCOL_VERSION}.`,
    );
  }
  validateIdentifier(input["planId"], "$.planId", issues);
  validateText(input["objective"], "$.objective", issues, { maxLength: 12_000 });
  validateEnum(input["domain"], DOMAINS, "$.domain", issues);
  validateStringArray(input["assumptions"], "$.assumptions", issues, {
    maxItems: 32,
    maxStringLength: 2_000,
  });
  validateEnum(input["risk"], RISKS, "$.risk", issues);
  if (input["origin"] !== undefined) {
    validateEnum(input["origin"], ["template", "sol"] as const, "$.origin", issues);
  }

  const rawTasks = input["tasks"];
  if (!Array.isArray(rawTasks)) {
    issue(issues, "$.tasks", "type", "must be an array.");
  } else {
    if (rawTasks.length === 0) {
      issue(issues, "$.tasks", "minimum", "must contain at least one leaf task.");
    }
    if (route === "fanout" && rawTasks.length < 2) {
      issue(issues, "$.tasks", "fanout_minimum", "fanout must contain at least two leaf tasks.");
    }
    if (route === "planned_single" && rawTasks.length !== 1) {
      issue(
        issues,
        "$.tasks",
        "planned_single_count",
        "planned_single must contain exactly one leaf task.",
      );
    }
    if (rawTasks.length > limits.maxLeaves) {
      issue(
        issues,
        "$.tasks",
        "max_leaves",
        `contains ${rawTasks.length} tasks but maxLeaves is ${limits.maxLeaves}.`,
      );
    }
    rawTasks.forEach((task, index) => validateLeafTask(task, `$.tasks[${index}]`, issues));
  }
  validateIntegration(input["integration"], "$.integration", issues);

  if (!canValidatePlanSemantics(input)) {
    return { ok: false, issues };
  }

  const plan = input;
  validatePlanSemantics(plan, limits, issues);
  return issues.length === 0 ? { ok: true, value: plan, issues: [] } : { ok: false, issues };
}

export function parseExecutionPlan(
  input: unknown,
  limits: Partial<ExecutionLimits> = {},
  route?: PlannedExecutionRoute,
): ExecutionPlan {
  const result = validateExecutionPlan(input, limits, route);
  if (!result.ok) {
    throw new PlanValidationError("ExecutionPlan", result.issues);
  }
  return result.value;
}

export function validatePlanPatch(
  input: unknown,
  options: PlanPatchValidationOptions = {},
): PlanValidationResult<PlanPatch> {
  input = normalizeOptionalPlanNulls(input);
  const issues: PlanValidationIssue[] = [];
  const limits = resolveLimits(options.limits ?? {}, issues);
  if (!isRecord(input)) {
    issue(issues, "$", "type", "must be an object.");
    return { ok: false, issues };
  }

  rejectUnknownKeys(
    input,
    ["protocolVersion", "planId", "reason", "operations", "integration"],
    "$",
    issues,
  );
  if (input["protocolVersion"] !== AGENT_TRIO_PROTOCOL_VERSION) {
    issue(
      issues,
      "$.protocolVersion",
      "protocol_version",
      `must equal ${AGENT_TRIO_PROTOCOL_VERSION}.`,
    );
  }
  validateIdentifier(input["planId"], "$.planId", issues);
  if (options.expectedPlanId !== undefined && input["planId"] !== options.expectedPlanId) {
    issue(
      issues,
      "$.planId",
      "plan_id_mismatch",
      `must equal the active plan id '${options.expectedPlanId}'.`,
    );
  }
  validateText(input["reason"], "$.reason", issues, { maxLength: 4_000 });

  const operations = input["operations"];
  if (!Array.isArray(operations)) {
    issue(issues, "$.operations", "type", "must be an array.");
  } else {
    if (operations.length === 0) {
      issue(issues, "$.operations", "minimum", "must contain at least one operation.");
    }
    if (operations.length > limits.maxLeaves * 2) {
      issue(
        issues,
        "$.operations",
        "maximum",
        `cannot contain more than ${limits.maxLeaves * 2} operations.`,
      );
    }
    operations.forEach((operation, index) =>
      validatePatchOperation(operation, `$.operations[${index}]`, issues),
    );
  }
  if (input["integration"] !== undefined) {
    validateIntegration(input["integration"], "$.integration", issues);
  }

  if (issues.length > 0 || !Array.isArray(operations)) {
    return { ok: false, issues };
  }
  const patch = input as unknown as PlanPatch;
  validatePatchSemantics(
    patch,
    options.basePlan,
    limits,
    new Set(options.immutableTaskIds ?? []),
    issues,
  );
  return issues.length === 0 ? { ok: true, value: patch, issues: [] } : { ok: false, issues };
}

export function parsePlanPatch(
  input: unknown,
  options: PlanPatchValidationOptions = {},
): PlanPatch {
  const result = validatePlanPatch(input, options);
  if (!result.ok) {
    throw new PlanValidationError("PlanPatch", result.issues);
  }
  return result.value;
}

export function applyPlanPatch(
  basePlan: ExecutionPlan,
  input: unknown,
  limits: Partial<ExecutionLimits> = {},
  immutableTaskIds: readonly string[] = [],
): ExecutionPlan {
  const patch = parsePlanPatch(input, {
    expectedPlanId: basePlan.planId,
    basePlan,
    limits,
    immutableTaskIds,
  });
  return buildPatchedPlan(basePlan, patch);
}

function validatePlanSemantics(
  plan: ExecutionPlan,
  limits: ExecutionLimits,
  issues: PlanValidationIssue[],
): void {
  const seenIds = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (task.minTier !== undefined && tierRank(task.tier) < tierRank(task.minTier)) {
      issue(
        issues,
        `$.tasks[${index}].tier`,
        "tier_below_minimum",
        `must be at least the planner minimum tier '${task.minTier}'.`,
      );
    }
    if (seenIds.has(task.id)) {
      issue(
        issues,
        `$.tasks[${index}].id`,
        "duplicate_task_id",
        `duplicates task id '${task.id}'.`,
      );
    }
    seenIds.add(task.id);
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        issue(
          issues,
          `$.tasks[${index}].dependsOn`,
          "self_dependency",
          "cannot contain the task's own id.",
        );
      }
    }
  }

  for (const [index, task] of plan.tasks.entries()) {
    for (const taskId of task.communicationWith) {
      if (taskId === task.id) {
        issue(
          issues,
          `$.tasks[${index}].communicationWith`,
          "self_communication",
          "cannot contain the task's own id.",
        );
      } else if (!seenIds.has(taskId) && taskId !== "planner" && taskId !== "integrator") {
        issue(
          issues,
          `$.tasks[${index}].communicationWith`,
          "missing_communication_target",
          `references unknown task '${taskId}'.`,
        );
      }
    }
  }

  const graph = analyzePlanGraph(plan.tasks);
  for (const missing of graph.missingDependencies) {
    const index = plan.tasks.findIndex((task) => task.id === missing.taskId);
    issue(
      issues,
      `$.tasks[${index}].dependsOn`,
      "missing_dependency",
      `references unknown task '${missing.dependencyId}'.`,
    );
  }
  if (graph.cycleTaskIds.length > 0) {
    issue(
      issues,
      "$.tasks",
      "dependency_cycle",
      `contains a dependency cycle involving ${graph.cycleTaskIds.join(", ")}.`,
    );
  }
  if (graph.waves.length > limits.maxWaves) {
    issue(
      issues,
      "$.tasks",
      "max_waves",
      `requires ${graph.waves.length} waves but maxWaves is ${limits.maxWaves}.`,
    );
  }
  const solLeaves = plan.tasks.filter((task) => task.tier === "sol").length;
  if (solLeaves > limits.maxSolLeaves) {
    issue(
      issues,
      "$.tasks",
      "max_sol_leaves",
      `contains ${solLeaves} Sol leaves but maxSolLeaves is ${limits.maxSolLeaves}.`,
    );
  }
  if (limits.deadlineMs !== undefined && graph.criticalPathSeconds * 1000 > limits.deadlineMs) {
    issue(
      issues,
      "$.tasks",
      "deadline",
      `critical path estimate exceeds the ${limits.deadlineMs}ms deadline.`,
    );
  }
  if (limits.maxCostUsd !== undefined) {
    const missingCostEstimates = plan.tasks
      .filter((task) => task.expectedCostUsd === undefined)
      .map((task) => task.id);
    if (missingCostEstimates.length > 0) {
      issue(
        issues,
        "$.tasks",
        "cost_estimate_required",
        `maxCostUsd requires expectedCostUsd on every task; missing: ${missingCostEstimates.join(", ")}.`,
      );
    } else {
      const expectedCost = plan.tasks.reduce(
        (total, task) => total + (task.expectedCostUsd ?? 0),
        0,
      );
      if (expectedCost > limits.maxCostUsd) {
        issue(
          issues,
          "$.tasks",
          "max_cost",
          `expected leaf cost ${expectedCost} exceeds maxCostUsd ${limits.maxCostUsd}.`,
        );
      }
    }
  }

  for (const conflict of findConcurrentOwnedPathConflicts(plan.tasks)) {
    issue(
      issues,
      "$.tasks",
      "ownership_overlap",
      `concurrent write ownership overlaps between '${conflict.leftTaskId}' (${conflict.leftPath}) and '${conflict.rightTaskId}' (${conflict.rightPath}); add an explicit dependency or merge the tasks.`,
    );
  }

  if (plan.risk === "high" && plan.integration.finalReview === "never") {
    issue(
      issues,
      "$.integration",
      "unvalidated_high_risk",
      "high-risk plans require a non-never final review policy.",
    );
  }
}

function tierRank(tier: LeafTask["tier"]): number {
  return tier === "luna" ? 0 : tier === "terra" ? 1 : 2;
}

function validatePatchSemantics(
  patch: PlanPatch,
  basePlan: ExecutionPlan | undefined,
  limits: ExecutionLimits,
  immutableTaskIds: ReadonlySet<string>,
  issues: PlanValidationIssue[],
): void {
  const targeted = new Set<string>();
  for (const [index, operation] of patch.operations.entries()) {
    const target = operation.op === "add" ? operation.task.id : operation.taskId;
    if (targeted.has(target)) {
      issue(
        issues,
        `$.operations[${index}]`,
        "duplicate_operation",
        `task '${target}' is targeted more than once.`,
      );
    }
    targeted.add(target);
    if (operation.op === "replace" && operation.task.id !== operation.taskId) {
      issue(
        issues,
        `$.operations[${index}].task.id`,
        "replacement_id_mismatch",
        `must equal taskId '${operation.taskId}'.`,
      );
    }
  }

  if (basePlan === undefined) {
    return;
  }
  if (patch.planId !== basePlan.planId) {
    issue(issues, "$.planId", "plan_id_mismatch", `must equal '${basePlan.planId}'.`);
    return;
  }
  const existingIds = new Set(basePlan.tasks.map((task) => task.id));
  for (const [index, operation] of patch.operations.entries()) {
    if (operation.op === "add" && existingIds.has(operation.task.id)) {
      issue(
        issues,
        `$.operations[${index}].task.id`,
        "task_already_exists",
        `task '${operation.task.id}' already exists.`,
      );
    }
    if (operation.op !== "add" && !existingIds.has(operation.taskId)) {
      issue(
        issues,
        `$.operations[${index}].taskId`,
        "unknown_task",
        `task '${operation.taskId}' does not exist.`,
      );
    }
    if (operation.op !== "add" && immutableTaskIds.has(operation.taskId)) {
      issue(
        issues,
        `$.operations[${index}].taskId`,
        "immutable_task",
        `completed task '${operation.taskId}' cannot be replaced or cancelled.`,
      );
    }
  }
  if (issues.length > 0) {
    return;
  }

  const effectivePlan = buildPatchedPlan(basePlan, patch);
  const validation = validateExecutionPlan(effectivePlan, limits);
  if (!validation.ok) {
    for (const validationIssue of validation.issues) {
      issue(
        issues,
        `$.effectivePlan${validationIssue.path.slice(1)}`,
        validationIssue.code,
        validationIssue.message,
      );
    }
  }
}

function buildPatchedPlan(basePlan: ExecutionPlan, patch: PlanPatch): ExecutionPlan {
  let tasks = basePlan.tasks.map(cloneTask);
  for (const operation of patch.operations) {
    switch (operation.op) {
      case "add":
        tasks.push(cloneTask(operation.task));
        break;
      case "replace": {
        const index = tasks.findIndex((task) => task.id === operation.taskId);
        if (index >= 0) {
          tasks[index] = cloneTask(operation.task);
        }
        break;
      }
      case "cancel":
        tasks = tasks.filter((task) => task.id !== operation.taskId);
        break;
    }
  }
  return {
    ...basePlan,
    tasks,
    integration: patch.integration ?? basePlan.integration,
  };
}

function cloneTask(task: LeafTask): LeafTask {
  return {
    ...task,
    ownedPaths: [...task.ownedPaths],
    dependsOn: [...task.dependsOn],
    capabilities: task.capabilities.map((capability) => ({ ...capability })),
    validation: task.validation.map((validation) => ({ ...validation })),
    communicationWith: [...task.communicationWith],
  };
}

export function analyzePlanGraph(tasks: readonly LeafTask[]): PlanGraphAnalysis {
  const tasksById = new Map<string, LeafTask>();
  for (const task of tasks) {
    if (!tasksById.has(task.id)) {
      tasksById.set(task.id, task);
    }
  }
  const missingDependencies: Array<{ taskId: string; dependencyId: string }> = [];
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of tasksById.keys()) {
    indegree.set(id, 0);
    children.set(id, []);
  }
  for (const task of tasksById.values()) {
    for (const dependencyId of new Set(task.dependsOn)) {
      if (!tasksById.has(dependencyId)) {
        missingDependencies.push({ taskId: task.id, dependencyId });
        continue;
      }
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      children.get(dependencyId)?.push(task.id);
    }
  }

  const waves: string[][] = [];
  let ready = [...tasksById.keys()].filter((id) => indegree.get(id) === 0).sort();
  const visited: string[] = [];
  while (ready.length > 0) {
    const wave = ready;
    waves.push(wave);
    visited.push(...wave);
    const next: string[] = [];
    for (const id of wave) {
      for (const childId of children.get(id) ?? []) {
        const remaining = (indegree.get(childId) ?? 0) - 1;
        indegree.set(childId, remaining);
        if (remaining === 0) {
          next.push(childId);
        }
      }
    }
    ready = [...new Set(next)].sort();
  }
  const visitedSet = new Set(visited);
  const cycleTaskIds = [...tasksById.keys()].filter((id) => !visitedSet.has(id)).sort();

  const durationById = new Map<string, number>();
  for (const wave of waves) {
    for (const id of wave) {
      const task = tasksById.get(id);
      if (task === undefined) {
        continue;
      }
      const dependencyDuration = task.dependsOn.reduce(
        (maximum, dependencyId) => Math.max(maximum, durationById.get(dependencyId) ?? 0),
        0,
      );
      durationById.set(id, dependencyDuration + task.expectedSeconds);
    }
  }

  return {
    waves,
    criticalPathSeconds: Math.max(0, ...durationById.values()),
    missingDependencies,
    cycleTaskIds,
  };
}

function validateLeafTask(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (!isRecord(input)) {
    issue(issues, path, "type", "must be an object.");
    return;
  }
  rejectUnknownKeys(
    input,
    [
      "id",
      "objective",
      "domain",
      "tier",
      "minTier",
      "effort",
      "access",
      "ownedPaths",
      "dependsOn",
      "capabilities",
      "validation",
      "communicationWith",
      "expectedSeconds",
      "expectedCostUsd",
      "difficulty",
      "ambiguity",
      "confidence",
      "critical",
      "validatorStrength",
    ],
    path,
    issues,
  );
  validateIdentifier(input["id"], `${path}.id`, issues);
  validateText(input["objective"], `${path}.objective`, issues, { maxLength: 8_000 });
  validateEnum(input["domain"], DOMAINS, `${path}.domain`, issues);
  validateEnum(input["tier"], TIERS, `${path}.tier`, issues);
  if (input["minTier"] !== undefined) {
    validateEnum(input["minTier"], TIERS, `${path}.minTier`, issues);
  }
  validateEnum(input["effort"], EFFORTS, `${path}.effort`, issues);
  if (includes(TIERS, input["tier"]) && includes(EFFORTS, input["effort"])) {
    try {
      assertTierEffort(input["tier"], input["effort"]);
    } catch (error) {
      if (error instanceof PolicyError) {
        issue(issues, `${path}.effort`, error.code, error.message);
      } else {
        throw error;
      }
    }
  }
  validateEnum(input["access"], ACCESS, `${path}.access`, issues);
  validateOwnedPaths(input["ownedPaths"], `${path}.ownedPaths`, issues, input["access"]);
  validateStringArray(input["dependsOn"], `${path}.dependsOn`, issues, { maxItems: 16 });
  validateCapabilities(input["capabilities"], `${path}.capabilities`, issues);
  validateValidationSpecs(input["validation"], `${path}.validation`, issues);
  validateStringArray(input["communicationWith"], `${path}.communicationWith`, issues, {
    maxItems: 16,
  });
  validatePositiveNumber(input["expectedSeconds"], `${path}.expectedSeconds`, issues);
  if (input["expectedCostUsd"] !== undefined) {
    validateNonNegativeNumber(input["expectedCostUsd"], `${path}.expectedCostUsd`, issues);
  }
  validateUnitNumber(input["difficulty"], `${path}.difficulty`, issues);
  validateUnitNumber(input["ambiguity"], `${path}.ambiguity`, issues);
  validateUnitNumber(input["confidence"], `${path}.confidence`, issues);
  if (typeof input["critical"] !== "boolean") {
    issue(issues, `${path}.critical`, "type", "must be a boolean.");
  }
  if (input["validatorStrength"] !== undefined) {
    validateEnum(
      input["validatorStrength"],
      ["none", "weak", "strong"] as const,
      `${path}.validatorStrength`,
      issues,
    );
  }
  if (
    includes(TIERS, input["tier"]) &&
    typeof input["difficulty"] === "number" &&
    Number.isFinite(input["difficulty"]) &&
    input["difficulty"] >= 0 &&
    input["difficulty"] <= 1 &&
    typeof input["ambiguity"] === "number" &&
    Number.isFinite(input["ambiguity"]) &&
    input["ambiguity"] >= 0 &&
    input["ambiguity"] <= 1 &&
    typeof input["critical"] === "boolean" &&
    Array.isArray(input["ownedPaths"])
  ) {
    try {
      assertTierAssignment(input["tier"], {
        difficulty: input["difficulty"],
        ambiguity: input["ambiguity"],
        critical: input["critical"],
        ownedPathCount: input["ownedPaths"].length,
      });
    } catch (error) {
      if (error instanceof PolicyError) {
        issue(issues, `${path}.tier`, error.code, error.message);
      } else {
        throw error;
      }
    }
  }
}

function validateIntegration(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (!isRecord(input)) {
    issue(issues, path, "type", "must be an object.");
    return;
  }
  rejectUnknownKeys(
    input,
    ["objective", "requiredOutputs", "validation", "finalReview", "aggregation"],
    path,
    issues,
  );
  validateText(input["objective"], `${path}.objective`, issues, { maxLength: 8_000 });
  validateStringArray(input["requiredOutputs"], `${path}.requiredOutputs`, issues, {
    minItems: 1,
    maxItems: 32,
    maxStringLength: 1_000,
  });
  validateValidationSpecs(input["validation"], `${path}.validation`, issues);
  validateEnum(input["finalReview"], FINAL_REVIEW, `${path}.finalReview`, issues);
  if (input["aggregation"] !== undefined) {
    validateEnum(
      input["aggregation"],
      ["auto", "deterministic", "terra"] as const,
      `${path}.aggregation`,
      issues,
    );
  }
}

function validatePatchOperation(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (!isRecord(input)) {
    issue(issues, path, "type", "must be an object.");
    return;
  }
  if (input["op"] === "add") {
    rejectUnknownKeys(input, ["op", "task"], path, issues);
    validateLeafTask(input["task"], `${path}.task`, issues);
    return;
  }
  if (input["op"] === "replace") {
    rejectUnknownKeys(input, ["op", "taskId", "task"], path, issues);
    validateIdentifier(input["taskId"], `${path}.taskId`, issues);
    validateLeafTask(input["task"], `${path}.task`, issues);
    return;
  }
  if (input["op"] === "cancel") {
    rejectUnknownKeys(input, ["op", "taskId", "reason"], path, issues);
    validateIdentifier(input["taskId"], `${path}.taskId`, issues);
    validateText(input["reason"], `${path}.reason`, issues, { maxLength: 2_000 });
    return;
  }
  issue(issues, `${path}.op`, "enum", "must be add, replace, or cancel.");
}

function validateCapabilities(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (!Array.isArray(input)) {
    issue(issues, path, "type", "must be an array.");
    return;
  }
  if (input.length > 16) {
    issue(issues, path, "maximum", "cannot contain more than 16 capabilities.");
  }
  input.forEach((capability, index) => {
    const capabilityPath = `${path}[${index}]`;
    if (!isRecord(capability)) {
      issue(issues, capabilityPath, "type", "must be an object.");
      return;
    }
    rejectUnknownKeys(capability, ["kind", "name", "path"], capabilityPath, issues);
    validateEnum(capability["kind"], CAPABILITY_KINDS, `${capabilityPath}.kind`, issues);
    validateText(capability["name"], `${capabilityPath}.name`, issues, { maxLength: 256 });
    if (capability["path"] !== undefined) {
      validateText(capability["path"], `${capabilityPath}.path`, issues, { maxLength: 2_000 });
    }
  });
}

function validateValidationSpecs(
  input: unknown,
  path: string,
  issues: PlanValidationIssue[],
): void {
  if (!Array.isArray(input)) {
    issue(issues, path, "type", "must be an array.");
    return;
  }
  if (input.length > 16) {
    issue(issues, path, "maximum", "cannot contain more than 16 validation commands.");
  }
  input.forEach((validation, index) => {
    const validationPath = `${path}[${index}]`;
    if (!isRecord(validation)) {
      issue(issues, validationPath, "type", "must be an object.");
      return;
    }
    rejectUnknownKeys(validation, ["command", "cwd", "timeoutMs"], validationPath, issues);
    validateText(validation["command"], `${validationPath}.command`, issues, {
      maxLength: 4_000,
    });
    if (validation["cwd"] !== undefined) {
      if (
        typeof validation["cwd"] !== "string" ||
        !isWorkspaceRelativePath(validation["cwd"], true)
      ) {
        issue(
          issues,
          `${validationPath}.cwd`,
          "unsafe_path",
          "must be a safe workspace-relative directory.",
        );
      }
    }
    if (
      validation["timeoutMs"] !== undefined &&
      (!Number.isInteger(validation["timeoutMs"]) || (validation["timeoutMs"] as number) <= 0)
    ) {
      issue(issues, `${validationPath}.timeoutMs`, "number", "must be a positive integer.");
    }
  });
}

function validateOwnedPaths(
  input: unknown,
  path: string,
  issues: PlanValidationIssue[],
  access: unknown,
): void {
  if (!Array.isArray(input)) {
    issue(issues, path, "type", "must be an array.");
    return;
  }
  if (access === "workspaceWrite" && input.length === 0) {
    issue(issues, path, "ownership_required", "write tasks must own at least one path.");
  }
  if (input.length > 64) {
    issue(issues, path, "maximum", "cannot contain more than 64 paths.");
  }
  const seen = new Set<string>();
  input.forEach((ownedPath, index) => {
    if (typeof ownedPath !== "string" || !isWorkspaceRelativePath(ownedPath, true)) {
      issue(
        issues,
        `${path}[${index}]`,
        "unsafe_path",
        "must be a safe workspace-relative path without traversal or globs.",
      );
      return;
    }
    const normalized = ownedPath.replace(/^\.\//, "").replace(/\/+$/, "");
    if (seen.has(normalized)) {
      issue(issues, `${path}[${index}]`, "duplicate", `duplicates owned path '${normalized}'.`);
    }
    seen.add(normalized);
  });
}

export function isWorkspaceRelativePath(path: string, allowDot: boolean): boolean {
  if (
    path.length === 0 ||
    path.length > 2_000 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:/.test(path) ||
    /[*?[\]{}]/.test(path)
  ) {
    return false;
  }
  if (allowDot && path === ".") {
    return true;
  }
  const parts = path.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  return (
    parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function validateIdentifier(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
  ) {
    issue(
      issues,
      path,
      "identifier",
      "must be a non-empty identifier using letters, digits, dot, underscore, colon, or hyphen.",
    );
  }
}

function validateText(
  input: unknown,
  path: string,
  issues: PlanValidationIssue[],
  options: { maxLength: number },
): void {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > options.maxLength ||
    input.includes("\0")
  ) {
    issue(
      issues,
      path,
      "text",
      `must be non-empty text no longer than ${options.maxLength} characters.`,
    );
  }
}

function validateStringArray(
  input: unknown,
  path: string,
  issues: PlanValidationIssue[],
  options: { minItems?: number; maxItems: number; maxStringLength?: number },
): void {
  if (!Array.isArray(input)) {
    issue(issues, path, "type", "must be an array.");
    return;
  }
  if (input.length < (options.minItems ?? 0)) {
    issue(issues, path, "minimum", `must contain at least ${options.minItems ?? 0} items.`);
  }
  if (input.length > options.maxItems) {
    issue(issues, path, "maximum", `cannot contain more than ${options.maxItems} items.`);
  }
  const seen = new Set<string>();
  input.forEach((value, index) => {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > (options.maxStringLength ?? 128) ||
      value.includes("\0")
    ) {
      issue(issues, `${path}[${index}]`, "text", "must be a non-empty bounded string.");
      return;
    }
    if (seen.has(value)) {
      issue(issues, `${path}[${index}]`, "duplicate", `duplicates '${value}'.`);
    }
    seen.add(value);
  });
}

function validatePositiveNumber(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    issue(issues, path, "number", "must be a finite positive number.");
  }
}

function validateUnitNumber(input: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) {
    issue(issues, path, "number", "must be a finite number between 0 and 1.");
  }
}

function validateNonNegativeNumber(
  input: unknown,
  path: string,
  issues: PlanValidationIssue[],
): void {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    issue(issues, path, "number", "must be a finite non-negative number.");
  }
}

function validateEnum<T extends string>(
  input: unknown,
  values: readonly T[],
  path: string,
  issues: PlanValidationIssue[],
): void {
  if (!includes(values, input)) {
    issue(issues, path, "enum", `must be one of: ${values.join(", ")}.`);
  }
}

function includes<T extends string>(values: readonly T[], input: unknown): input is T {
  return typeof input === "string" && (values as readonly string[]).includes(input);
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  issues: PlanValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issue(issues, `${path}.${key}`, "unknown_property", "is not allowed.");
    }
  }
}

function resolveLimits(
  overrides: Partial<ExecutionLimits>,
  issues: PlanValidationIssue[],
): ExecutionLimits {
  try {
    return normalizeExecutionLimits(overrides);
  } catch (error) {
    if (error instanceof PolicyError) {
      issue(issues, "$.limits", error.code, error.message);
      return { ...normalizeExecutionLimits() };
    }
    throw error;
  }
}

function issue(issues: PlanValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function canValidatePlanSemantics(
  input: Record<string, unknown>,
): input is Record<string, unknown> & ExecutionPlan {
  const tasks = input["tasks"];
  const integration = input["integration"];
  return (
    Array.isArray(tasks) &&
    tasks.every(
      (task) =>
        isRecord(task) &&
        typeof task["id"] === "string" &&
        typeof task["tier"] === "string" &&
        typeof task["access"] === "string" &&
        typeof task["expectedSeconds"] === "number" &&
        Array.isArray(task["ownedPaths"]) &&
        task["ownedPaths"].every((path) => typeof path === "string") &&
        Array.isArray(task["dependsOn"]) &&
        task["dependsOn"].every((dependency) => typeof dependency === "string") &&
        Array.isArray(task["communicationWith"]) &&
        task["communicationWith"].every((taskId) => typeof taskId === "string"),
    ) &&
    typeof input["risk"] === "string" &&
    isRecord(integration) &&
    Array.isArray(integration["validation"]) &&
    typeof integration["finalReview"] === "string"
  );
}

const validationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "cwd", "timeoutMs"],
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4_000 },
    cwd: { type: ["string", "null"], minLength: 1, maxLength: 2_000 },
    timeoutMs: { type: ["integer", "null"], minimum: 1 },
  },
} as const;

const capabilitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "name", "path"],
  properties: {
    kind: { type: "string", enum: CAPABILITY_KINDS },
    name: { type: "string", minLength: 1, maxLength: 256 },
    path: { type: ["string", "null"], minLength: 1, maxLength: 2_000 },
  },
} as const;

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;

const leafTaskSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "objective",
    "domain",
    "tier",
    "minTier",
    "effort",
    "access",
    "ownedPaths",
    "dependsOn",
    "capabilities",
    "validation",
    "communicationWith",
    "expectedSeconds",
    "expectedCostUsd",
    "difficulty",
    "ambiguity",
    "confidence",
    "critical",
    "validatorStrength",
  ],
  properties: {
    id: identifierSchema,
    objective: { type: "string", minLength: 1, maxLength: 8_000 },
    domain: { type: "string", enum: DOMAINS },
    tier: { type: "string", enum: TIERS },
    minTier: { type: ["string", "null"], enum: [...TIERS, null] },
    effort: { type: "string", enum: EFFORTS },
    access: { type: "string", enum: ACCESS },
    ownedPaths: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    dependsOn: { type: "array", maxItems: 16, items: identifierSchema },
    capabilities: { type: "array", maxItems: 16, items: capabilitySchema },
    validation: { type: "array", maxItems: 16, items: validationSchema },
    communicationWith: { type: "array", maxItems: 16, items: identifierSchema },
    expectedSeconds: { type: "number", exclusiveMinimum: 0 },
    expectedCostUsd: { type: ["number", "null"], minimum: 0 },
    difficulty: { type: "number", minimum: 0, maximum: 1 },
    ambiguity: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    critical: { type: "boolean" },
    validatorStrength: { type: ["string", "null"], enum: ["none", "weak", "strong", null] },
  },
} as const;

const integrationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["objective", "requiredOutputs", "validation", "finalReview", "aggregation"],
  properties: {
    objective: { type: "string", minLength: 1, maxLength: 8_000 },
    requiredOutputs: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    validation: { type: "array", maxItems: 16, items: validationSchema },
    finalReview: { type: "string", enum: FINAL_REVIEW },
    aggregation: {
      type: ["string", "null"],
      enum: ["auto", "deterministic", "terra", null],
    },
  },
} as const;

function createExecutionPlanJsonSchema(
  route?: PlannedExecutionRoute,
  maxLeaves = 20,
): Readonly<Record<string, unknown>> {
  const taskBounds =
    route === "fanout"
      ? { minItems: 2, maxItems: Math.max(2, maxLeaves) }
      : route === "planned_single"
        ? { minItems: 1, maxItems: 1 }
        : { minItems: 1, maxItems: maxLeaves };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [
      "protocolVersion",
      "planId",
      "objective",
      "domain",
      "assumptions",
      "tasks",
      "integration",
      "risk",
      "origin",
    ],
    properties: {
      protocolVersion: { type: "integer", enum: [AGENT_TRIO_PROTOCOL_VERSION] },
      planId: identifierSchema,
      objective: { type: "string", minLength: 1, maxLength: 12_000 },
      domain: { type: "string", enum: DOMAINS },
      assumptions: {
        type: "array",
        maxItems: 32,
        items: { type: "string", minLength: 1, maxLength: 2_000 },
      },
      tasks: { type: "array", ...taskBounds, items: leafTaskSchema },
      integration: integrationSchema,
      risk: { type: "string", enum: RISKS },
      origin: { type: ["string", "null"], enum: ["template", "sol", null] },
    },
  });
}

export const EXECUTION_PLAN_JSON_SCHEMA = createExecutionPlanJsonSchema();

export function executionPlanJsonSchemaForRoute(
  route: PlannedExecutionRoute,
  maxLeaves = 20,
): Readonly<Record<string, unknown>> {
  if (!Number.isInteger(maxLeaves) || maxLeaves < 1 || maxLeaves > 20) {
    throw new RangeError("maxLeaves must be an integer between 1 and 20");
  }
  return createExecutionPlanJsonSchema(route, maxLeaves);
}

export const PLAN_PATCH_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "planId", "reason", "operations", "integration"],
  properties: {
    protocolVersion: { type: "integer", enum: [AGENT_TRIO_PROTOCOL_VERSION] },
    planId: identifierSchema,
    reason: { type: "string", minLength: 1, maxLength: 4_000 },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "taskId", "task", "reason"],
        properties: {
          op: { type: "string", enum: ["add", "replace", "cancel"] },
          taskId: { type: ["string", "null"], minLength: 1, maxLength: 128 },
          task: { anyOf: [leafTaskSchema, { type: "null" }] },
          reason: { type: ["string", "null"], minLength: 1, maxLength: 2_000 },
        },
      },
    },
    integration: { anyOf: [integrationSchema, { type: "null" }] },
  },
});

/** App Server strict schemas require optional object members to be present. Normalize the
 * explicit null representation back to the existing TypeScript optional-field contract before
 * semantic validation and persistence. */
function normalizeOptionalPlanNulls(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const normalized: Record<string, unknown> = { ...input };
  if (normalized["origin"] === null) {
    delete normalized["origin"];
  }
  if (Array.isArray(normalized["tasks"])) {
    normalized["tasks"] = normalized["tasks"].map((task) => normalizeTaskNulls(task));
  }
  if (isRecord(normalized["integration"])) {
    normalized["integration"] = normalizeIntegrationNulls(normalized["integration"]);
  } else if (normalized["integration"] === null) {
    delete normalized["integration"];
  }
  if (Array.isArray(normalized["operations"])) {
    normalized["operations"] = normalized["operations"].map((operation) => {
      if (!isRecord(operation)) {
        return operation;
      }
      const next = { ...operation };
      // Strict App Server schemas require every union member to expose the same keys. Discard
      // fields that are semantically inapplicable even when a model filled them instead of null.
      if (next["op"] === "add") {
        delete next["taskId"];
        delete next["reason"];
      } else if (next["op"] === "replace") {
        delete next["reason"];
      } else if (next["op"] === "cancel") {
        delete next["task"];
      }
      if (next["taskId"] === null) {
        delete next["taskId"];
      }
      if (next["task"] === null) {
        delete next["task"];
      }
      if (next["reason"] === null) {
        delete next["reason"];
      }
      if ("task" in next) {
        next["task"] = normalizeTaskNulls(next["task"]);
      }
      return next;
    });
  }
  return normalized;
}

function normalizeTaskNulls(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const task: Record<string, unknown> = { ...input };
  if (task["expectedCostUsd"] === null) {
    delete task["expectedCostUsd"];
  }
  if (task["minTier"] === null) {
    delete task["minTier"];
  }
  if (task["validatorStrength"] === null) {
    delete task["validatorStrength"];
  }
  if (Array.isArray(task["capabilities"])) {
    task["capabilities"] = task["capabilities"].map((capability) => {
      if (!isRecord(capability)) {
        return capability;
      }
      const next = { ...capability };
      if (next["path"] === null) {
        delete next["path"];
      }
      return next;
    });
  }
  if (Array.isArray(task["validation"])) {
    task["validation"] = task["validation"].map((validation) =>
      normalizeValidationNulls(validation),
    );
  }
  return task;
}

function normalizeIntegrationNulls(input: Record<string, unknown>): Record<string, unknown> {
  const integration = { ...input };
  if (integration["aggregation"] === null) {
    delete integration["aggregation"];
  }
  if (Array.isArray(integration["validation"])) {
    integration["validation"] = integration["validation"].map((validation) =>
      normalizeValidationNulls(validation),
    );
  }
  return integration;
}

function normalizeValidationNulls(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const validation = { ...input };
  if (validation["cwd"] === null) {
    delete validation["cwd"];
  }
  if (validation["timeoutMs"] === null) {
    delete validation["timeoutMs"];
  }
  return validation;
}
