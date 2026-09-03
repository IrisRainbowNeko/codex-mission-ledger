import type {
  ExecutionLimits,
  ExecutionPlan,
  JobMode,
  LeafResult,
  LeafTask,
  ModelTier,
  OptimizationProfile,
  ReasoningEffort,
  ReplanTrigger,
  ValidatorStrength,
} from "./contracts.js";
import type { PlannedExecutionRoute } from "./integration.js";

export const QUALITY_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  maxConcurrent: 5,
  maxLeaves: 8,
  maxWaves: 3,
  maxSolLeaves: 1,
  maxReplans: 1,
});

export const BALANCED_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  maxConcurrent: 3,
  maxLeaves: 3,
  maxWaves: 3,
  maxSolLeaves: 1,
  maxReplans: 1,
});

/** Backwards-compatible alias for callers that do not have a request profile. */
export const DEFAULT_EXECUTION_LIMITS = QUALITY_EXECUTION_LIMITS;

/** Hard safety bounds for a single planner session. */
export const MAX_EXECUTION_LIMITS: Readonly<
  Pick<ExecutionLimits, "maxConcurrent" | "maxLeaves" | "maxWaves" | "maxSolLeaves" | "maxReplans">
> = Object.freeze({
  maxConcurrent: 5,
  maxLeaves: 20,
  maxWaves: 3,
  maxSolLeaves: 1,
  maxReplans: 1,
});

export const ALLOWED_EFFORTS_BY_TIER: Readonly<Record<ModelTier, readonly ReasoningEffort[]>> = {
  luna: ["low", "medium"],
  terra: ["medium", "high"],
  sol: ["high", "xhigh"],
};

export const FANOUT_MIN_TASKS = 2;
export const FANOUT_MAX_TASKS = 20;
// Keep only a startup-amortization floor. Sol owns semantic decomposition; runtime code rejects
// leaves too short to repay launch overhead.
export const FANOUT_MIN_TASK_SECONDS = 15;
export const BALANCED_FANOUT_MIN_TASK_SECONDS = 30;
export const FOREGROUND_MAX_LEAVES = 8;
export const DURABLE_MAX_LEAVES = 20;
export const BALANCED_FOREGROUND_MAX_LEAVES = 3;
export const BALANCED_DURABLE_MAX_LEAVES = 5;
export const REPLAN_LOW_CONFIDENCE_THRESHOLD = 0.7;
export const REPLAN_DEVIATION_RATIO = 1.3;

const TIER_RANK: Readonly<Record<ModelTier, number>> = {
  luna: 0,
  terra: 1,
  sol: 2,
};

const LIMIT_NAMES = [
  "maxConcurrent",
  "maxLeaves",
  "maxWaves",
  "maxSolLeaves",
  "maxReplans",
] as const;

export class PolicyError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeExecutionLimits(
  overrides: Partial<ExecutionLimits> = {},
  profile: OptimizationProfile = "quality",
): ExecutionLimits {
  const normalized: ExecutionLimits = {
    ...(profile === "balanced" ? BALANCED_EXECUTION_LIMITS : QUALITY_EXECUTION_LIMITS),
  };

  for (const name of LIMIT_NAMES) {
    const value = overrides[name];
    if (value === undefined) {
      continue;
    }
    const minimum = name === "maxSolLeaves" || name === "maxReplans" ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new PolicyError(
        "invalid_limit",
        `${name} must be an integer greater than or equal to ${minimum}.`,
        { name, value },
      );
    }
    if (value > MAX_EXECUTION_LIMITS[name]) {
      throw new PolicyError(
        "limit_exceeded",
        `${name} cannot exceed ${MAX_EXECUTION_LIMITS[name]}.`,
        { name, value, maximum: MAX_EXECUTION_LIMITS[name] },
      );
    }
    normalized[name] = value;
  }

  if (normalized.maxSolLeaves > normalized.maxLeaves) {
    throw new PolicyError("invalid_limit", "maxSolLeaves cannot exceed maxLeaves.", {
      maxSolLeaves: normalized.maxSolLeaves,
      maxLeaves: normalized.maxLeaves,
    });
  }

  if (overrides.deadlineMs !== undefined) {
    assertFiniteNonNegative(overrides.deadlineMs, "deadlineMs", false);
    normalized.deadlineMs = overrides.deadlineMs;
  }
  if (overrides.maxCostUsd !== undefined) {
    assertFiniteNonNegative(overrides.maxCostUsd, "maxCostUsd", true);
    normalized.maxCostUsd = overrides.maxCostUsd;
  }
  return normalized;
}

export function normalizeExecutionLimitsForMode(
  mode: JobMode,
  overrides: Partial<ExecutionLimits> = {},
  profile: OptimizationProfile = "quality",
): ExecutionLimits {
  const normalized = normalizeExecutionLimits(overrides, profile);
  if (profile === "balanced" && mode === "durable" && overrides.maxLeaves === undefined) {
    normalized.maxLeaves = BALANCED_DURABLE_MAX_LEAVES;
  }
  const maximum =
    profile === "balanced"
      ? mode === "foreground"
        ? BALANCED_FOREGROUND_MAX_LEAVES
        : BALANCED_DURABLE_MAX_LEAVES
      : mode === "foreground"
        ? FOREGROUND_MAX_LEAVES
        : DURABLE_MAX_LEAVES;
  if (normalized.maxLeaves > maximum) {
    throw new PolicyError("limit_exceeded", `${mode} runs cannot exceed ${maximum} leaves.`, {
      name: "maxLeaves",
      value: normalized.maxLeaves,
      maximum,
      mode,
    });
  }
  return normalized;
}

export function fanoutMinTaskSeconds(profile: OptimizationProfile = "quality"): number {
  return profile === "balanced" ? BALANCED_FANOUT_MIN_TASK_SECONDS : FANOUT_MIN_TASK_SECONDS;
}

function assertFiniteNonNegative(value: number, name: string, allowZero: boolean): void {
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) {
    throw new PolicyError(
      "invalid_limit",
      `${name} must be a finite ${allowZero ? "non-negative" : "positive"} number.`,
      { name, value },
    );
  }
}

export function tierSupportsEffort(tier: ModelTier, effort: ReasoningEffort): boolean {
  return ALLOWED_EFFORTS_BY_TIER[tier].includes(effort);
}

export function assertTierEffort(tier: ModelTier, effort: ReasoningEffort): void {
  if (!tierSupportsEffort(tier, effort)) {
    throw new PolicyError(
      "invalid_tier_effort",
      `${tier} does not support ${effort} effort under the Agent Trio policy.`,
      { tier, effort, allowed: [...ALLOWED_EFFORTS_BY_TIER[tier]] },
    );
  }
}

export interface TierRecommendationInput {
  difficulty: number;
  ambiguity: number;
  critical?: boolean;
  ownedPathCount?: number;
}

export function recommendTier(input: TierRecommendationInput): ModelTier {
  assertUnitScore(input.difficulty, "difficulty");
  assertUnitScore(input.ambiguity, "ambiguity");
  const critical = input.critical ?? false;
  const ownedPathCount = input.ownedPathCount ?? 0;
  if (!Number.isInteger(ownedPathCount) || ownedPathCount < 0) {
    throw new PolicyError("invalid_score", "ownedPathCount must be a non-negative integer.", {
      ownedPathCount,
    });
  }

  if (
    input.difficulty >= 0.85 ||
    input.ambiguity >= 0.8 ||
    (critical && (input.difficulty >= 0.7 || input.ambiguity >= 0.65))
  ) {
    return "sol";
  }
  if (
    critical ||
    input.difficulty >= 0.4 ||
    input.ambiguity >= 0.35 ||
    (ownedPathCount >= 4 && input.difficulty >= 0.3)
  ) {
    return "terra";
  }
  return "luna";
}

export function recommendEffort(
  tier: ModelTier,
  input: Pick<TierRecommendationInput, "difficulty" | "ambiguity">,
): ReasoningEffort {
  assertUnitScore(input.difficulty, "difficulty");
  assertUnitScore(input.ambiguity, "ambiguity");
  const complexity = Math.max(input.difficulty, input.ambiguity);
  switch (tier) {
    case "luna":
      return complexity < 0.25 ? "low" : "medium";
    case "terra":
      return complexity < 0.65 ? "medium" : "high";
    case "sol":
      return complexity < 0.9 ? "high" : "xhigh";
  }
}

/**
 * Selects the cheapest model that is sufficient for one bounded leaf.
 *
 * Planner difficulty describes the leaf itself, not the parent request. A large parent
 * task therefore does not automatically promote every small child to Terra. `minTier` is
 * an explicit semantic floor; the current `tier` field is treated as a planner hint and
 * may be lowered when local evidence shows that Luna is sufficient.
 */
export function recommendEffectiveTier(
  task: Pick<
    LeafTask,
    | "tier"
    | "minTier"
    | "difficulty"
    | "ambiguity"
    | "critical"
    | "validation"
    | "validatorStrength"
    | "domain"
  > &
    Partial<Pick<LeafTask, "objective" | "capabilities">>,
): ModelTier {
  const minTier = task.minTier ?? "luna";
  if (minTier === "sol") {
    return "sol";
  }
  if (minTier === "terra") {
    return "terra";
  }
  if (task.difficulty >= 0.85 || task.ambiguity >= 0.8) {
    return "sol";
  }

  const semanticTerraWork =
    task.domain === "office" ||
    (task.capabilities ?? []).some((capability) =>
      /(?:document|spreadsheet|presentation|powerpoint|ppt)/i.test(capability.name),
    ) ||
    /\b(?:recover|recovery|resume|checkpoint|rollback|transaction|idempoten|state machine|corrupt|conflict resolution|code review|paper review|peer review|synthesi[sz]e)\b/i.test(
      task.objective ?? "",
    ) ||
    /(?:恢复|续跑|断点|回滚|事务|幂等|状态机|损坏|冲突消解|代码审查|论文评审|审稿|综合分析)/u.test(
      task.objective ?? "",
    );
  if (semanticTerraWork) {
    return "terra";
  }

  const validatorStrength: ValidatorStrength =
    task.validatorStrength ?? (task.validation.length > 0 ? "strong" : "weak");
  const algorithmicRisk =
    task.domain === "algorithm" && (task.difficulty >= 0.7 || task.ambiguity >= 0.6);
  if (algorithmicRisk || task.difficulty >= 0.7 || task.ambiguity >= 0.55) {
    return "terra";
  }
  if (task.critical && validatorStrength === "none") {
    return "terra";
  }
  return "luna";
}

/** Rebalances planner hints without another model turn or a semantic plan repair. */
export function rebalanceExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const tier = recommendEffectiveTier(task);
      return {
        ...task,
        tier,
        effort:
          tier === "luna"
            ? (task.access === "workspaceWrite" && task.domain !== "office") ||
              task.domain === "algorithm"
              ? "medium"
              : task.critical
                ? recommendEffort(tier, task)
                : "low"
            : recommendEffort(tier, task),
      };
    }),
  };
}

export function tierAtLeast(actual: ModelTier, minimum: ModelTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[minimum];
}

export interface TierAssignmentDecision {
  valid: boolean;
  recommended: ModelTier;
  reason: "sufficient" | "tier_too_low" | "unnecessary_sol";
}

export function evaluateTierAssignment(
  tier: ModelTier,
  input: TierRecommendationInput,
): TierAssignmentDecision {
  const recommended = recommendTier(input);
  if (!tierAtLeast(tier, recommended)) {
    return { valid: false, recommended, reason: "tier_too_low" };
  }
  if (tier === "sol" && recommended !== "sol") {
    return { valid: false, recommended, reason: "unnecessary_sol" };
  }
  return { valid: true, recommended, reason: "sufficient" };
}

export function assertTierAssignment(tier: ModelTier, input: TierRecommendationInput): void {
  const decision = evaluateTierAssignment(tier, input);
  if (!decision.valid) {
    throw new PolicyError(
      decision.reason,
      decision.reason === "tier_too_low"
        ? `${tier} is below the recommended ${decision.recommended} tier.`
        : "Sol is reserved for genuinely difficult or ambiguous work.",
      { tier, recommended: decision.recommended },
    );
  }
}

function assertUnitScore(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PolicyError("invalid_score", `${name} must be between 0 and 1.`, { name, value });
  }
}

export type FanoutRejectionReason =
  | "too_few_tasks"
  | "too_many_tasks"
  | "insufficient_ready_tasks"
  | "short_task"
  | "invalid_duration"
  | "invalid_dependency_graph"
  | "ownership_overlap"
  | "insufficient_serial_work"
  | "no_time_saving";

export interface FanoutAdmissionOptions {
  limits?: Partial<ExecutionLimits>;
  directSeconds?: number;
  planningSeconds?: number;
  launchSeconds?: number;
  integrationSeconds?: number;
  minTaskSeconds?: number;
  minSerialSeconds?: number;
  maxTasks?: number;
  /** Maximum fanout/direct wall-time ratio accepted by the product. */
  maxLatencyRatio?: number;
  /** Validate only the executable DAG shape; the route optimizer applies hard timing constraints. */
  deferEconomics?: boolean;
}

export interface FanoutAdmission {
  admitted: boolean;
  reasons: FanoutRejectionReason[];
  directSeconds: number;
  estimatedFanoutSeconds: number;
  readyTaskCount: number;
}

export type PlannedExecutionAdmission =
  | (FanoutAdmission & { route: "fanout" })
  | {
      route: "planned_single";
      admitted: boolean;
      reasons: Array<"not_exactly_one_task">;
      taskCount: number;
    };

/**
 * Applies route-specific admission without treating a difficult single task as
 * an uneconomic one-leaf fanout.
 */
export function evaluatePlannedExecutionAdmission(
  candidate: ExecutionPlan | readonly LeafTask[],
  route: PlannedExecutionRoute,
  options: FanoutAdmissionOptions = {},
): PlannedExecutionAdmission {
  if (route === "fanout") {
    return { route, ...evaluateFanoutAdmission(candidate, options) };
  }

  const tasks: readonly LeafTask[] = Array.isArray(candidate)
    ? candidate
    : (candidate as ExecutionPlan).tasks;
  return {
    route,
    admitted: tasks.length === 1,
    reasons: tasks.length === 1 ? [] : ["not_exactly_one_task"],
    taskCount: tasks.length,
  };
}

export function evaluateFanoutAdmission(
  candidate: ExecutionPlan | readonly LeafTask[],
  options: FanoutAdmissionOptions = {},
): FanoutAdmission {
  const tasks: readonly LeafTask[] = Array.isArray(candidate)
    ? candidate
    : (candidate as ExecutionPlan).tasks;
  const limits = normalizeExecutionLimits(options.limits ?? {});
  const maxTasks = options.maxTasks ?? Math.min(FANOUT_MAX_TASKS, limits.maxLeaves);
  const minTaskSeconds = options.minTaskSeconds ?? FANOUT_MIN_TASK_SECONDS;
  const minSerialSeconds = options.minSerialSeconds ?? 0;
  const planningSeconds = options.planningSeconds ?? 10;
  const launchSeconds = options.launchSeconds ?? 5;
  const integrationSeconds = options.integrationSeconds ?? 15;
  const maxLatencyRatio = options.maxLatencyRatio ?? 0.7;
  const deferEconomics = options.deferEconomics ?? false;

  for (const [name, value] of [
    ["maxTasks", maxTasks],
    ["minTaskSeconds", minTaskSeconds],
    ["minSerialSeconds", minSerialSeconds],
    ["planningSeconds", planningSeconds],
    ["launchSeconds", launchSeconds],
    ["integrationSeconds", integrationSeconds],
  ] as const) {
    assertFiniteNonNegative(value, name, name !== "maxTasks");
  }
  if (!Number.isInteger(maxTasks)) {
    throw new PolicyError("invalid_limit", "maxTasks must be an integer.", { maxTasks });
  }
  if (!Number.isFinite(maxLatencyRatio) || maxLatencyRatio <= 0 || maxLatencyRatio > 1) {
    throw new PolicyError(
      "invalid_limit",
      "maxLatencyRatio must be greater than 0 and at most 1.",
      { maxLatencyRatio },
    );
  }
  if (maxTasks > FANOUT_MAX_TASKS) {
    throw new PolicyError(
      "limit_exceeded",
      `maxTasks cannot exceed the hard leaf cap of ${FANOUT_MAX_TASKS}.`,
      { maxTasks, maximum: FANOUT_MAX_TASKS },
    );
  }

  const reasons = new Set<FanoutRejectionReason>();
  if (tasks.length < FANOUT_MIN_TASKS) {
    reasons.add("too_few_tasks");
  }
  if (tasks.length > maxTasks || tasks.length > limits.maxLeaves) {
    reasons.add("too_many_tasks");
  }

  const validDurationTasks = tasks.filter(
    (task) => Number.isFinite(task.expectedSeconds) && task.expectedSeconds > 0,
  );
  const longTasks = validDurationTasks.filter(
    (task) => deferEconomics || task.expectedSeconds > minTaskSeconds,
  );
  const parallelTaskIds = new Set<string>();
  for (let leftIndex = 0; leftIndex < longTasks.length; leftIndex += 1) {
    const left = longTasks[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < longTasks.length; rightIndex += 1) {
      const right = longTasks[rightIndex];
      if (
        right !== undefined &&
        !taskTransitivelyDependsOn(tasks, left.id, right.id) &&
        !taskTransitivelyDependsOn(tasks, right.id, left.id)
      ) {
        parallelTaskIds.add(left.id);
        parallelTaskIds.add(right.id);
      }
    }
  }
  const readyTaskCount = parallelTaskIds.size;
  if (readyTaskCount < FANOUT_MIN_TASKS) {
    reasons.add("insufficient_ready_tasks");
  }
  if (tasks.some((task) => !Number.isFinite(task.expectedSeconds) || task.expectedSeconds <= 0)) {
    reasons.add("invalid_duration");
  } else if (!deferEconomics && longTasks.length < FANOUT_MIN_TASKS) {
    reasons.add("short_task");
  }

  if (findConcurrentOwnedPathConflicts(tasks).length > 0) {
    reasons.add("ownership_overlap");
  }

  const criticalPathSeconds = estimateCriticalPathSeconds(tasks);
  if (criticalPathSeconds === null) {
    reasons.add("invalid_dependency_graph");
  }
  const serialSeconds = tasks.reduce(
    (total, task) => total + (Number.isFinite(task.expectedSeconds) ? task.expectedSeconds : 0),
    0,
  );
  if (serialSeconds < minSerialSeconds) {
    reasons.add("insufficient_serial_work");
  }
  const directSeconds = options.directSeconds ?? serialSeconds;
  assertFiniteNonNegative(directSeconds, "directSeconds", true);
  const concurrencyFloor =
    serialSeconds / Math.max(1, Math.min(limits.maxConcurrent, tasks.length));
  const parallelWorkSeconds = Math.max(criticalPathSeconds ?? serialSeconds, concurrencyFloor);
  const estimatedFanoutSeconds =
    planningSeconds + launchSeconds + parallelWorkSeconds + integrationSeconds;
  if (!deferEconomics && estimatedFanoutSeconds > directSeconds * maxLatencyRatio) {
    reasons.add("no_time_saving");
  }

  return {
    admitted: reasons.size === 0,
    reasons: [...reasons],
    directSeconds,
    estimatedFanoutSeconds,
    readyTaskCount,
  };
}

/** Alias kept intentionally terse for scheduler call sites. */
export const admitFanout = evaluateFanoutAdmission;

export interface OwnedPathConflict {
  leftTaskId: string;
  rightTaskId: string;
  leftPath: string;
  rightPath: string;
}

export function findOwnedPathConflicts(tasks: readonly LeafTask[]): OwnedPathConflict[] {
  const writers = tasks.filter((task) => task.access === "workspaceWrite");
  const conflicts: OwnedPathConflict[] = [];
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex += 1) {
    const left = writers[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex += 1) {
      const right = writers[rightIndex];
      if (right === undefined) {
        continue;
      }
      for (const leftPath of left.ownedPaths) {
        for (const rightPath of right.ownedPaths) {
          if (ownedPathsOverlap(leftPath, rightPath)) {
            conflicts.push({
              leftTaskId: left.id,
              rightTaskId: right.id,
              leftPath,
              rightPath,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

/** Ownership may overlap only when the plan explicitly orders the writers. */
export function findConcurrentOwnedPathConflicts(tasks: readonly LeafTask[]): OwnedPathConflict[] {
  return findOwnedPathConflicts(tasks).filter((conflict) => {
    const leftDependsOnRight = taskTransitivelyDependsOn(
      tasks,
      conflict.leftTaskId,
      conflict.rightTaskId,
    );
    const rightDependsOnLeft = taskTransitivelyDependsOn(
      tasks,
      conflict.rightTaskId,
      conflict.leftTaskId,
    );
    return leftDependsOnRight === rightDependsOnLeft;
  });
}

export function taskTransitivelyDependsOn(
  tasks: readonly LeafTask[],
  taskId: string,
  dependencyId: string,
): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const visit = (currentId: string): boolean => {
    if (currentId === dependencyId) {
      return true;
    }
    if (visited.has(currentId)) {
      return false;
    }
    visited.add(currentId);
    return byId.get(currentId)?.dependsOn.some(visit) ?? false;
  };
  return taskId !== dependencyId && visit(taskId);
}

export function ownedPathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeOwnedPath(left);
  const normalizedRight = normalizeOwnedPath(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return true;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

export function ownedPathContains(ownedPath: string, candidatePath: string): boolean {
  const normalizedOwned = normalizeOwnedPath(ownedPath);
  const normalizedCandidate = normalizeOwnedPath(candidatePath);
  return (
    normalizedOwned.length === 0 ||
    normalizedCandidate === normalizedOwned ||
    normalizedCandidate.startsWith(`${normalizedOwned}/`)
  );
}

function normalizeOwnedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function estimateCriticalPathSeconds(tasks: readonly LeafTask[]): number | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  if (tasksById.size !== tasks.length) {
    return null;
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const durationThrough = (task: LeafTask): number | null => {
    const cached = memo.get(task.id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(task.id)) {
      return null;
    }
    visiting.add(task.id);
    let dependencyDuration = 0;
    for (const dependencyId of task.dependsOn) {
      const dependency = tasksById.get(dependencyId);
      if (dependency === undefined) {
        visiting.delete(task.id);
        return null;
      }
      const duration = durationThrough(dependency);
      if (duration === null) {
        visiting.delete(task.id);
        return null;
      }
      dependencyDuration = Math.max(dependencyDuration, duration);
    }
    visiting.delete(task.id);
    const total = dependencyDuration + task.expectedSeconds;
    memo.set(task.id, total);
    return total;
  };

  let criticalPath = 0;
  for (const task of tasks) {
    const duration = durationThrough(task);
    if (duration === null) {
      return null;
    }
    criticalPath = Math.max(criticalPath, duration);
  }
  return criticalPath;
}

export interface ReplanConflict {
  taskIds: readonly string[];
  summary: string;
}

export interface ReplanDetectionOptions {
  observedAt: string;
  executionComplete?: boolean;
  missingRequiredOutputs?: readonly string[];
  conflicts?: readonly ReplanConflict[];
  scopeChange?: ReplanConflict;
  /** Leaf attempts observed by the scheduler; a mechanical repair is exhausted after one retry. */
  validatorRepairAttempts?: ReadonlyMap<string, number>;
}

export type ValidatorFailureClassification = "none" | "mechanical" | "semantic";

/**
 * A validator failure is mechanically repairable only when it is fully attributable to the
 * leaf's declared checks and carries no competing leaf failure classification.
 */
export function classifyValidatorFailure(
  task: LeafTask | undefined,
  result: LeafResult,
): ValidatorFailureClassification {
  const failed = result.validation.filter((validation) => validation.status === "failed");
  if (failed.length === 0) {
    return result.status === "failed" && result.failureKind === "validation" ? "semantic" : "none";
  }
  if (task === undefined || task.validation.length === 0) {
    return "semantic";
  }
  if (result.status !== "completed" && result.failureKind !== "validation") {
    return "semantic";
  }
  if (result.failureKind !== undefined && result.failureKind !== "validation") {
    return "semantic";
  }
  const declaredCommands = new Set(task.validation.map((validation) => validation.command));
  return failed.every((validation) => declaredCommands.has(validation.command))
    ? "mechanical"
    : "semantic";
}

export function detectReplanTriggers(
  plan: ExecutionPlan,
  results: readonly LeafResult[],
  options: ReplanDetectionOptions,
): ReplanTrigger[] {
  if (!Number.isFinite(Date.parse(options.observedAt))) {
    throw new PolicyError("invalid_timestamp", "observedAt must be an ISO-compatible timestamp.", {
      observedAt: options.observedAt,
    });
  }
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const triggers: ReplanTrigger[] = [];
  const add = (type: ReplanTrigger["type"], taskIds: readonly string[], summary: string): void => {
    triggers.push({
      type,
      taskIds: [...new Set(taskIds)].sort(),
      summary,
      observedAt: options.observedAt,
    });
  };

  const missingOutputs = options.missingRequiredOutputs ?? [];
  const contractFailureTaskIds = results
    .filter(
      (result) =>
        result.turnId !== null &&
        result.failureKind === "contract" &&
        (result.status === "blocked" || result.status === "failed"),
    )
    .map((result) => result.taskId);
  const incompleteTaskIds = contractFailureTaskIds;
  if (missingOutputs.length > 0 || incompleteTaskIds.length > 0) {
    const details = [
      missingOutputs.length > 0 ? `missing outputs: ${missingOutputs.join(", ")}` : "",
      incompleteTaskIds.length > 0 ? `incomplete tasks: ${incompleteTaskIds.join(", ")}` : "",
    ].filter((value) => value.length > 0);
    add("contract_incomplete", incompleteTaskIds, details.join("; "));
  }

  const criticalBlockers = results.filter(
    (result) =>
      taskById.get(result.taskId)?.critical === true &&
      (result.status === "blocked" || result.status === "failed") &&
      result.failureKind !== "permission" &&
      result.messages.some((message) => message.type === "blocker" && message.blocking),
  );
  if (criticalBlockers.length > 0) {
    add(
      "critical_blocker",
      criticalBlockers.map((result) => result.taskId),
      criticalBlockers.map((result) => result.summary).join("; "),
    );
  }

  const conflicts = options.conflicts ?? [];
  if (conflicts.length > 0) {
    add(
      "result_conflict",
      conflicts.flatMap((conflict) => conflict.taskIds),
      conflicts.map((conflict) => conflict.summary).join("; "),
    );
  }

  const failedValidators = results.filter((result) => {
    if (result.status !== "completed" && result.failureKind !== "validation") {
      return false;
    }
    const classification = classifyValidatorFailure(taskById.get(result.taskId), result);
    return (
      classification === "semantic" ||
      (classification === "mechanical" &&
        (options.validatorRepairAttempts?.get(result.taskId) ?? 0) > 1)
    );
  });
  if (failedValidators.length > 0) {
    add(
      "validator_failure",
      failedValidators.map((result) => result.taskId),
      "One or more deterministic validators failed.",
    );
  }

  const lowConfidence = results.filter(
    (result) =>
      result.status === "completed" &&
      taskById.get(result.taskId)?.critical === true &&
      result.confidence < REPLAN_LOW_CONFIDENCE_THRESHOLD,
  );
  if (lowConfidence.length > 0) {
    add(
      "low_confidence",
      lowConfidence.map((result) => result.taskId),
      `Result confidence fell below ${REPLAN_LOW_CONFIDENCE_THRESHOLD}.`,
    );
  }

  const overDuration = results.filter((result) => {
    const task = taskById.get(result.taskId);
    if (task === undefined || result.startedAt === null) {
      return false;
    }
    const elapsedSeconds = (Date.parse(result.completedAt) - Date.parse(result.startedAt)) / 1000;
    return (
      Number.isFinite(elapsedSeconds) &&
      elapsedSeconds > task.expectedSeconds * REPLAN_DEVIATION_RATIO
    );
  });
  const overCost = results.filter((result) => {
    const expectedCost = taskById.get(result.taskId)?.expectedCostUsd;
    if (expectedCost === undefined || expectedCost <= 0) {
      return false;
    }
    const costs = result.usage.map((usage) => usage.estimatedCostUsd);
    if (costs.some((cost) => cost === null)) {
      return false;
    }
    const actualCost = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
    return actualCost > expectedCost * REPLAN_DEVIATION_RATIO;
  });
  // Once every leaf is terminal, a budget patch cannot shorten the current critical path. The
  // completed measurements remain available to the planner's historical latency estimates.
  if (options.executionComplete !== true && (overDuration.length > 0 || overCost.length > 0)) {
    add(
      "budget_deviation",
      [...overDuration.map((result) => result.taskId), ...overCost.map((result) => result.taskId)],
      "Observed duration or cost exceeded its allowed estimate ratio.",
    );
  }

  const changedOutsideScope = results.filter((result) => {
    const task = taskById.get(result.taskId);
    return (
      task !== undefined &&
      result.changedFiles.some(
        (changedPath) =>
          !task.ownedPaths.some((ownedPath) => ownedPathContains(ownedPath, changedPath)),
      )
    );
  });
  const contractChanges = results.flatMap((result) =>
    result.messages
      .filter((message) => message.type === "contract_change")
      .map((message) => ({ taskId: result.taskId, summary: message.body })),
  );
  if (
    changedOutsideScope.length > 0 ||
    contractChanges.length > 0 ||
    options.scopeChange !== undefined
  ) {
    add(
      "scope_change",
      [
        ...changedOutsideScope.map((result) => result.taskId),
        ...contractChanges.map((change) => change.taskId),
        ...(options.scopeChange?.taskIds ?? []),
      ],
      options.scopeChange?.summary ??
        (contractChanges.map((change) => change.summary).join("; ") ||
          "A worker changed files outside its ownership contract."),
    );
  }

  if (plan.risk === "high" && options.executionComplete === true) {
    const unvalidated = results.filter((result) => {
      const task = taskById.get(result.taskId);
      return (
        task?.critical === true &&
        result.status === "completed" &&
        !result.validation.some((validation) => validation.status === "passed")
      );
    });
    if (unvalidated.length > 0) {
      add(
        "unvalidated_high_risk",
        unvalidated.map((result) => result.taskId),
        "A critical high-risk result has no passing validator.",
      );
    }
  }

  return triggers;
}
