import { ControlPlaneError, assertCondition } from "./errors.js";
import type {
  AgentRole,
  BudgetLimits,
  MissionPortrait,
  MissionStrategy,
  ModelTier,
  PortraitLevel,
  ReasoningEffort,
  RiskLevel,
  TaskStatus,
  Usage,
  ValidatorStrength,
} from "./types.js";
import { MISSION_STRATEGIES, PORTRAIT_LEVELS, VALIDATOR_STRENGTHS } from "./types.js";

export const ALLOWED_EFFORTS: Readonly<Record<ModelTier, readonly ReasoningEffort[]>> = {
  sol: ["high", "xhigh", "max"],
  terra: ["high", "xhigh", "max"],
  luna: ["high", "xhigh", "max"],
};

/** Candidate summaries must stay short so Sol/Terra transcripts are not the report. */
export const CANDIDATE_SUMMARY_MAX_CHARS = 500;

/** Low/medium work may collapse check+verify+commit into one MCP call. Gates still run. */
export const COLLAPSIBLE_GATE_RISKS: readonly RiskLevel[] = ["low", "medium"];

/** Terra-path strategies whose root coordinator may be auto-finalized on close. */
export const TERRA_PATH_STRATEGIES: readonly MissionStrategy[] = [
  "fanout",
  "director_plan",
  "pipeline",
];

/** Skill-level bound for the workspace markdown file body (not stored on the mission). */
export const DIRECTOR_PLAN_FILE_MIN_CHARS = 750;
export const DIRECTOR_PLAN_FILE_MAX_CHARS = 8000;

/** `directorPlan` on the mission is a workspace-relative `.md` path, not the plan body. */
export const DIRECTOR_PLAN_PATH_MAX_CHARS = 200;

/** fanout must not hide a director plan in the Terra envelope. */
export const FANOUT_TERRA_OBJECTIVE_MAX_CHARS = 2000;

export const ALLOWED_MODELS_BY_ROLE: Readonly<Record<AgentRole, readonly ModelTier[]>> = {
  director: ["sol"],
  coordinator: ["terra"],
  operator: ["luna"],
  verifier: ["luna"],
  advisor: ["sol"],
};

const ALLOWED_CHILD_ROLES: Readonly<Record<AgentRole, readonly AgentRole[]>> = {
  director: ["coordinator", "advisor"],
  coordinator: ["operator", "verifier"],
  operator: [],
  verifier: [],
  advisor: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "committed",
  "failed",
  "cancelled",
  "superseded",
];

export const DEPENDENCY_SATISFIED_STATUSES: readonly TaskStatus[] = ["verified", "committed"];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  proposed: ["ready", "cancelled", "superseded"],
  ready: ["leased", "blocked", "failed", "cancelled", "superseded"],
  leased: ["running", "ready", "blocked", "failed", "cancelled"],
  running: ["candidate", "ready", "blocked", "failed", "cancelled"],
  blocked: ["ready", "leased", "running", "failed", "cancelled", "superseded"],
  candidate: ["checked", "ready", "running", "failed", "cancelled"],
  checked: ["verified", "ready", "running", "failed", "cancelled"],
  verified: ["committed", "checked", "cancelled"],
  committed: [],
  failed: ["superseded"],
  cancelled: [],
  superseded: [],
};

const BUDGET_FIELDS = [
  "tokens",
  "costUsd",
  "wallClockSeconds",
  "toolCalls",
  "maxChildren",
] as const;

type BudgetField = (typeof BUDGET_FIELDS)[number];

export function assertAssignmentPolicy(
  role: AgentRole,
  model: ModelTier,
  effort: ReasoningEffort,
  maxEffort: ReasoningEffort,
): void {
  assertCondition(
    ALLOWED_MODELS_BY_ROLE[role].includes(model),
    "policy_violation",
    `Model '${model}' is not allowed for role '${role}'.`,
    { role, model, allowedModels: [...ALLOWED_MODELS_BY_ROLE[role]] },
  );

  const efforts = ALLOWED_EFFORTS[model];
  assertCondition(
    efforts.includes(effort),
    "policy_violation",
    `Effort '${effort}' is not supported by '${model}'.`,
    { model, effort, allowedEfforts: [...efforts] },
  );
  assertCondition(
    efforts.includes(maxEffort),
    "policy_violation",
    `Maximum effort '${maxEffort}' is not supported by '${model}'.`,
    { model, maxEffort, allowedEfforts: [...efforts] },
  );
  assertCondition(
    efforts.indexOf(effort) <= efforts.indexOf(maxEffort),
    "policy_violation",
    "Initial effort cannot exceed the task's maximum effort.",
    { model, effort, maxEffort },
  );
}

export function assertParentChildPolicy(parentRole: AgentRole | null, childRole: AgentRole): void {
  if (parentRole === null) {
    assertCondition(
      childRole === "coordinator" || childRole === "advisor",
      "policy_violation",
      "Root mission tasks must be Terra coordinators or Sol advisors.",
      { childRole },
    );
    return;
  }

  assertCondition(
    ALLOWED_CHILD_ROLES[parentRole].includes(childRole),
    "policy_violation",
    `Role '${parentRole}' cannot own child role '${childRole}'.`,
    { parentRole, childRole, allowedChildRoles: [...ALLOWED_CHILD_ROLES[parentRole]] },
  );
}

export function assertRootRoleForStrategy(strategy: MissionStrategy, childRole: AgentRole): void {
  if (strategy === "direct") {
    assertCondition(
      childRole === "operator" || childRole === "advisor",
      "policy_violation",
      "direct missions may allocate one root Luna operator (or a Sol advisor), not a Terra tree.",
      { strategy, childRole },
    );
    return;
  }
  assertParentChildPolicy(null, childRole);
}

export function normalizeStrategy(strategy: MissionStrategy | undefined): MissionStrategy {
  if (strategy === undefined) {
    return "fanout";
  }
  assertCondition(
    (MISSION_STRATEGIES as readonly string[]).includes(strategy),
    "validation_error",
    `Unknown mission strategy '${String(strategy)}'.`,
    { strategy, allowed: [...MISSION_STRATEGIES] },
  );
  return strategy;
}

export function normalizePortrait(
  portrait: MissionPortrait | undefined | null,
): MissionPortrait | null {
  if (portrait === undefined || portrait === null) {
    return null;
  }
  const ambiguity = portrait.ambiguity;
  const coupling = portrait.coupling;
  const parallelism = portrait.parallelism;
  const validator = portrait.validator;
  assertCondition(
    (PORTRAIT_LEVELS as readonly string[]).includes(ambiguity) &&
      (PORTRAIT_LEVELS as readonly string[]).includes(coupling) &&
      (PORTRAIT_LEVELS as readonly string[]).includes(parallelism) &&
      (VALIDATOR_STRENGTHS as readonly string[]).includes(validator),
    "validation_error",
    "portrait requires ambiguity, coupling, and parallelism as low|medium|high, and validator as strong|weak|none.",
    { portrait },
  );
  return {
    ambiguity: ambiguity as PortraitLevel,
    coupling: coupling as PortraitLevel,
    parallelism: parallelism as PortraitLevel,
    validator: validator as ValidatorStrength,
  };
}

export function isWorkspaceMarkdownPath(value: string): boolean {
  if (value.length === 0 || value.length > DIRECTOR_PLAN_PATH_MAX_CHARS) {
    return false;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value)) {
    return false;
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  const filename = parts[parts.length - 1];
  return filename !== undefined && /^[A-Za-z0-9._-]+\.md$/.test(filename);
}

export function normalizeDirectorPlan(
  strategy: MissionStrategy,
  directorPlan: string | undefined | null,
): string | null {
  const trimmed = directorPlan?.trim() ?? "";
  if (strategy === "director_plan") {
    assertCondition(
      isWorkspaceMarkdownPath(trimmed),
      "validation_error",
      "director_plan requires directorPlan to be a workspace-relative markdown path (for example director-plan.md). Write the plan body into that project file.",
      { directorPlan: trimmed },
    );
    return trimmed;
  }
  assertCondition(
    trimmed.length === 0,
    "validation_error",
    "directorPlan must be empty unless strategy is director_plan.",
    { strategy, length: trimmed.length },
  );
  return null;
}

export function assertFanoutCoordinatorObjective(
  strategy: MissionStrategy,
  objective: string,
): void {
  if (strategy !== "fanout") {
    return;
  }
  assertCondition(
    objective.length <= FANOUT_TERRA_OBJECTIVE_MAX_CHARS,
    "policy_violation",
    `fanout Terra objective must be at most ${FANOUT_TERRA_OBJECTIVE_MAX_CHARS} characters; do not hide a plan in the envelope.`,
    { length: objective.length, max: FANOUT_TERRA_OBJECTIVE_MAX_CHARS },
  );
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new ControlPlaneError(
      "invalid_state",
      `Task cannot transition from '${from}' to '${to}'.`,
      { from, to, allowedTransitions: [...TASK_TRANSITIONS[from]] },
    );
  }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function dependenciesSatisfied(statuses: readonly TaskStatus[]): boolean {
  return statuses.every((status) => DEPENDENCY_SATISFIED_STATUSES.includes(status));
}

export function normalizeBudget(budget: BudgetLimits = {}): BudgetLimits {
  const normalized: BudgetLimits = {};
  for (const field of BUDGET_FIELDS) {
    const value = budget[field] as number | undefined;
    if (value === undefined) {
      continue;
    }
    assertCondition(
      Number.isFinite(value) && value >= 0,
      "validation_error",
      `Budget field '${field}' must be a non-negative finite number.`,
      { field, value },
    );
    normalized[field] = value;
  }
  return normalized;
}

export function normalizeUsage(usage: Partial<Usage> = {}): Usage {
  const normalized: Usage = {
    tokens: usage.tokens ?? 0,
    costUsd: usage.costUsd ?? 0,
    wallClockSeconds: usage.wallClockSeconds ?? 0,
    toolCalls: usage.toolCalls ?? 0,
  };

  for (const [field, value] of [
    ["tokens", normalized.tokens],
    ["costUsd", normalized.costUsd],
    ["wallClockSeconds", normalized.wallClockSeconds],
    ["toolCalls", normalized.toolCalls],
  ] as const) {
    assertCondition(
      Number.isFinite(value) && value >= 0,
      "validation_error",
      `Usage field '${field}' must be a non-negative finite number.`,
      { field, value },
    );
  }
  return normalized;
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    tokens: left.tokens + right.tokens,
    costUsd: left.costUsd + right.costUsd,
    wallClockSeconds: left.wallClockSeconds + right.wallClockSeconds,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

export function addBudgets(left: BudgetLimits, right: BudgetLimits): BudgetLimits {
  const result: BudgetLimits = {};
  for (const field of BUDGET_FIELDS) {
    if (field === "maxChildren") {
      continue;
    }
    const sum = (left[field] ?? 0) + (right[field] ?? 0);
    if (sum > 0) {
      result[field] = sum;
    }
  }
  return result;
}

export function assertBudgetWithin(
  requested: BudgetLimits,
  limit: BudgetLimits,
  label: string,
): void {
  for (const field of BUDGET_FIELDS) {
    const maximum = limit[field];
    if (maximum === undefined) {
      continue;
    }
    const actual = requested[field] ?? 0;
    assertCondition(actual <= maximum, "budget_exceeded", `${label} exceeds '${field}' budget.`, {
      field,
      requested: actual,
      limit: maximum,
    });
  }
}

export function assertUsageWithin(usage: Usage, limit: BudgetLimits, label: string): void {
  assertUsageFieldsWithin(usage, limit, label, ["tokens", "costUsd", "wallClockSeconds", "toolCalls"]);
}

/** Candidate submit still enforces spend caps; tool/time overage must not block a finished result. */
export function assertHardUsageWithin(usage: Usage, limit: BudgetLimits, label: string): void {
  assertUsageFieldsWithin(usage, limit, label, ["tokens", "costUsd"]);
}

export function isLeaseExpired(leaseExpiresAt: string | null, now: string): boolean {
  if (leaseExpiresAt === null) {
    return false;
  }
  return Date.parse(leaseExpiresAt) <= Date.parse(now);
}

function assertUsageFieldsWithin(
  usage: Usage,
  limit: BudgetLimits,
  label: string,
  fields: readonly BudgetField[],
): void {
  const usageByBudgetField: Partial<Record<BudgetField, number>> = {
    tokens: usage.tokens,
    costUsd: usage.costUsd,
    wallClockSeconds: usage.wallClockSeconds,
    toolCalls: usage.toolCalls,
  };

  for (const field of fields) {
    const maximum = limit[field];
    if (maximum === undefined) {
      continue;
    }
    const actual = usageByBudgetField[field] ?? 0;
    assertCondition(
      actual <= maximum,
      "budget_exceeded",
      `${label} exceeds '${field}' usage budget.`,
      { field, actual, limit: maximum },
    );
  }
}
