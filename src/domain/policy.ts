import { ControlPlaneError, assertCondition } from "./errors.js";
import type {
  AgentRole,
  BudgetLimits,
  ModelTier,
  ReasoningEffort,
  TaskStatus,
  Usage,
} from "./types.js";

export const ALLOWED_EFFORTS: Readonly<Record<ModelTier, readonly ReasoningEffort[]>> = {
  sol: ["high", "xhigh", "max"],
  terra: ["xhigh", "max"],
  luna: ["high", "xhigh", "max"],
};

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
  const usageByBudgetField: Partial<Record<BudgetField, number>> = {
    tokens: usage.tokens,
    costUsd: usage.costUsd,
    wallClockSeconds: usage.wallClockSeconds,
    toolCalls: usage.toolCalls,
  };

  for (const field of BUDGET_FIELDS) {
    if (field === "maxChildren") {
      continue;
    }
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
