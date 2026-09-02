import type {
  AgentMessage,
  ExecutionLimits,
  ExecutionPlan,
  HostAccess,
  HostApproval,
  LeafResult,
  LeafTask,
  PlanPatch,
  ReplanTrigger,
  WaitingLeafResumePoint,
} from "./contracts.js";
import { MessageBroker, type AgentMessageInput } from "./messages.js";
import { applyPlanPatch, PlanValidationError } from "./plan-validation.js";
import { classifyValidatorFailure, detectReplanTriggers } from "./policy.js";

export interface LeafRunInput {
  runId: string;
  hostAccess?: HostAccess;
  hostApproval?: HostApproval;
  task: LeafTask;
  dependencies: LeafResult[];
  attempt: number;
  retry?: {
    kind: "validation" | "reasoning";
    previousResult: LeafResult;
  };
  continuation?: {
    threadId: string;
    previousTurnId: string;
    userInput?: string;
  };
  signal: AbortSignal;
}

export interface LeafExecutor {
  runLeaf(
    input: LeafRunInput,
    postMessage: (message: AgentMessageInput) => Promise<string | null>,
  ): Promise<LeafResult>;
  deliverMessage?(taskId: string, message: AgentMessage, runId?: string): Promise<string | null>;
  interrupt?(taskId: string, runId?: string): Promise<void>;
  updatePlan?(runId: string, plan: ExecutionPlan): Promise<void>;
}

export interface ReplanHandler {
  replan(
    plan: ExecutionPlan,
    triggers: readonly ReplanTrigger[],
    results: readonly LeafResult[],
  ): Promise<PlanPatch | null>;
  answer(message: AgentMessage, results: readonly LeafResult[]): Promise<string>;
}

export interface CompletionInspector {
  inspect(plan: ExecutionPlan, results: readonly LeafResult[]): Promise<readonly ReplanTrigger[]>;
}

export interface ScheduleResult {
  plan: ExecutionPlan;
  patch: PlanPatch | null;
  leaves: LeafResult[];
  launchSkewMs: number | null;
  peakConcurrency: number;
  replanCount: number;
  usage: LeafResult["usage"];
}

export interface ScheduleResumeState {
  initialResults: readonly LeafResult[];
  waitingLeaves?: readonly WaitingLeafResumePoint[];
  userInput?: string;
  patch?: PlanPatch | null;
  replanCount?: 0 | 1;
}

export interface SchedulerOptions {
  now?: () => Date;
  /** Upper bound for waiting on an interrupt acknowledgement after cancellation. */
  interruptGraceMs?: number;
}

interface LaunchTiming {
  requestedAt: number;
  startedAt?: number;
}

interface SettledLeaf {
  taskId: string;
  result: LeafResult;
  timing: LaunchTiming;
}

export class DeterministicScheduler {
  readonly #executor: LeafExecutor;
  readonly #replanner: ReplanHandler;
  readonly #now: () => Date;
  readonly #interruptGraceMs: number;

  constructor(executor: LeafExecutor, replanner: ReplanHandler, options: SchedulerOptions = {}) {
    this.#executor = executor;
    this.#replanner = replanner;
    this.#now = options.now ?? (() => new Date());
    this.#interruptGraceMs = options.interruptGraceMs ?? 1_000;
  }

  async execute(
    runId: string,
    initialPlan: ExecutionPlan,
    limits: ExecutionLimits,
    signal?: AbortSignal,
    replanHandler?: ReplanHandler,
    completionInspector?: CompletionInspector,
    resumeState?: ScheduleResumeState,
    hostAccess?: HostAccess,
    hostApproval?: HostApproval,
  ): Promise<ScheduleResult> {
    let plan = clonePlan(initialPlan);
    validatePlanForScheduling(plan, limits);
    const executionStartedAt = this.#now().getTime();
    const deadlineAt =
      limits.deadlineMs === undefined ? null : executionStartedAt + limits.deadlineMs;
    const runAbort = createRunAbort(signal, limits.deadlineMs);
    const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
    const resume = validateInitialResults(
      plan,
      resumeState?.initialResults ?? [],
      resumeState?.waitingLeaves ?? [],
    );
    const results = new Map(resume.completed.map((result) => [result.taskId, result]));
    const attempts = new Map(
      resume.waiting.map(({ point }) => [point.taskId, Math.max(0, point.attempt - 1)]),
    );
    const waitingResults = new Map(
      resume.waiting.map(({ point, result }) => [point.taskId, result]),
    );
    const waitingContinuations = new Map(resume.waiting.map(({ point }) => [point.taskId, point]));
    const usage: LeafResult["usage"] = resume.completed.flatMap((result) => result.usage);
    const solTaskIds = new Set([
      ...plan.tasks.filter((task) => task.tier === "sol").map((task) => task.id),
      ...resume.completed
        .filter((result) => result.usage.some((item) => item.tier === "sol"))
        .map((result) => result.taskId),
    ]);
    if (solTaskIds.size > limits.maxSolLeaves) {
      throw new Error(`scheduler resume exceeds maxSolLeaves=${limits.maxSolLeaves}`);
    }
    const running = new Map<string, Promise<SettledLeaf>>();
    const launchGroups: LaunchTiming[][] = [];
    let peakConcurrency = 0;
    let replanCount = resumeState?.replanCount ?? 0;
    let appliedPatch: PlanPatch | null = structuredClone(resumeState?.patch ?? null);
    if (appliedPatch !== null && replanCount === 0) {
      throw new Error("scheduler resume patch and replanCount are inconsistent");
    }
    if (replanCount > limits.maxReplans) {
      throw new Error(`scheduler resume exceeds maxReplans=${limits.maxReplans}`);
    }
    if (appliedPatch !== null && appliedPatch.planId !== plan.planId) {
      throw new Error("scheduler resume patch does not match the active plan");
    }

    const replanner = replanHandler ?? this.#replanner;
    const broker = new MessageBroker(plan.tasks, {
      deliver: async (message) =>
        this.#executor.deliverMessage?.(String(message.toTaskId), message, runId) ?? null,
      askPlanner: async (message) => replanner.answer(message, [...results.values()]),
    });

    try {
      for (;;) {
        this.#blockTasksWithFailedDependencies(tasks, results);

        if (runAbort.signal.aborted) {
          if (running.size > 0) {
            this.#recordSettledLeaf(await Promise.race(running.values()), running, results, usage);
            continue;
          }
          this.#cancelPending(tasks, results, abortReason(runAbort.signal));
          break;
        }

        const triggerEvidence = mergeBrokerMessages([...results.values()], broker.messages);
        for (const result of triggerEvidence) {
          results.set(result.taskId, result);
        }
        const executionComplete = plan.tasks.every((task) => results.has(task.id));
        const triggers = detectReplanTriggers(plan, triggerEvidence, {
          observedAt: this.#now().toISOString(),
          executionComplete,
          validatorRepairAttempts: attempts,
        });
        if (
          executionComplete &&
          [...results.values()].every((result) => result.status === "completed") &&
          completionInspector !== undefined
        ) {
          triggers.push(...(await completionInspector.inspect(plan, [...results.values()])));
        }
        if (triggers.length > 0 && replanCount < limits.maxReplans) {
          // A patch cannot safely replace or cancel an in-flight writer. Stop filling slots and
          // apply it only after the already-launched leaves have reached terminal states.
          if (running.size > 0) {
            this.#recordSettledLeaf(await Promise.race(running.values()), running, results, usage);
            continue;
          }
          replanCount += 1;
          const patch = await replanUntilAborted(
            replanner.replan(plan, triggers, [...results.values()]),
            runAbort.signal,
          );
          if (patch === ABORTED) {
            this.#cancelPending(tasks, results, abortReason(runAbort.signal));
            break;
          }
          if (patch !== null) {
            let nextPlan: ExecutionPlan;
            const nextSolTaskIds = new Set(solTaskIds);
            try {
              nextPlan = applyPlanPatch(
                plan,
                patch,
                limits,
                [...results.values()]
                  .filter(
                    (result) =>
                      result.status === "completed" ||
                      (result.status === "indeterminate" &&
                        tasks.get(result.taskId)?.access === "workspaceWrite"),
                  )
                  .map((result) => result.taskId),
              );
              validatePlanForScheduling(nextPlan, limits);
              reserveSolTasks(nextPlan, nextSolTaskIds, limits);
            } catch (error) {
              if (!isPatchLeafCapacityError(error)) {
                throw error;
              }
              // The replan slot is consumed, but invalid model output must not erase terminal
              // leaf evidence or turn a recoverable task failure into a protocol-wide failure.
              continue;
            }
            if (runAbort.signal.aborted) {
              this.#cancelPending(tasks, results, abortReason(runAbort.signal));
              break;
            }
            await this.#executor.updatePlan?.(runId, nextPlan);
            solTaskIds.clear();
            for (const taskId of nextSolTaskIds) {
              solTaskIds.add(taskId);
            }
            reconcilePatchState(patch, nextPlan.tasks, results, attempts);
            plan = nextPlan;
            tasks.clear();
            for (const task of plan.tasks) {
              tasks.set(task.id, task);
            }
            broker.synchronizeTasks(plan.tasks);
            appliedPatch = patch;
          }
          if (!hasPendingTasks(tasks, results)) {
            break;
          }
          continue;
        }

        if (!hasPendingTasks(tasks, results)) {
          break;
        }

        const stopReason = executionStopReason(
          tasks,
          results,
          usage,
          limits,
          deadlineAt,
          this.#now,
        );
        if (stopReason !== null) {
          if (running.size > 0) {
            this.#recordSettledLeaf(await Promise.race(running.values()), running, results, usage);
            continue;
          }
          this.#cancelPending(tasks, results, stopReason);
          break;
        }

        const ready = [...tasks.values()].filter(
          (task) =>
            !results.has(task.id) &&
            !running.has(task.id) &&
            task.dependsOn.every((dependency) => results.get(dependency)?.status === "completed"),
        );
        const launchGroup: LaunchTiming[] = [];
        for (const task of ready.slice(0, limits.maxConcurrent - running.size)) {
          if (runAbort.signal.aborted) {
            break;
          }
          const timing: LaunchTiming = { requestedAt: this.#now().getTime() };
          launchGroup.push(timing);
          const promise = this.#runWithEscalation(
            runId,
            task,
            limits,
            attempts,
            results,
            waitingResults,
            waitingContinuations,
            resumeState?.userInput,
            solTaskIds,
            hostAccess,
            hostApproval,
            runAbort.signal,
            (message) => broker.post(message).then((receipt) => receipt.response),
          ).then((result): SettledLeaf => ({
            taskId: task.id,
            result,
            timing,
          }));
          running.set(task.id, promise);
          peakConcurrency = Math.max(peakConcurrency, running.size);
        }
        if (launchGroup.length > 0) {
          launchGroups.push(launchGroup);
        }

        if (running.size === 0) {
          if (hasPendingTasks(tasks, results)) {
            this.#cancelPending(tasks, results, "no runnable dependency path remains", "blocked");
          }
          break;
        }

        this.#recordSettledLeaf(await Promise.race(running.values()), running, results, usage);
      }
    } finally {
      runAbort.dispose();
    }

    return {
      plan,
      patch: appliedPatch,
      leaves: mergeBrokerMessages(
        plan.tasks
          .map((task) => results.get(task.id))
          .filter((result): result is LeafResult => result !== undefined),
        broker.messages,
      ),
      launchSkewMs: maximumLaunchSkew(launchGroups),
      peakConcurrency,
      replanCount,
      usage,
    };
  }

  #recordSettledLeaf(
    settled: SettledLeaf,
    running: Map<string, Promise<SettledLeaf>>,
    results: Map<string, LeafResult>,
    usage: LeafResult["usage"],
  ): void {
    running.delete(settled.taskId);
    const startedAt =
      settled.result.startedAt === null
        ? settled.timing.requestedAt
        : new Date(settled.result.startedAt).getTime();
    if (Number.isFinite(startedAt)) {
      settled.timing.startedAt = startedAt;
    }
    usage.push(...settled.result.usage);
    results.set(settled.result.taskId, settled.result);
  }

  async #runWithEscalation(
    runId: string,
    initialTask: LeafTask,
    limits: ExecutionLimits,
    attempts: Map<string, number>,
    results: ReadonlyMap<string, LeafResult>,
    waitingResults: Map<string, LeafResult>,
    waitingContinuations: Map<string, WaitingLeafResumePoint>,
    userInput: string | undefined,
    solTaskIds: Set<string>,
    hostAccess: HostAccess | undefined,
    hostApproval: HostApproval | undefined,
    signal: AbortSignal,
    postMessage: (message: AgentMessageInput) => Promise<string | null>,
  ): Promise<LeafResult> {
    let task = initialTask;
    const waitingResult = waitingResults.get(task.id);
    let priorUsage: LeafResult["usage"] = structuredClone(waitingResult?.usage ?? []);
    let firstStartedAt: string | null = waitingResult?.startedAt ?? null;
    let retry: LeafRunInput["retry"];
    for (;;) {
      const attempt = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, attempt);
      if (signal.aborted) {
        return interruptedResult(task, abortReason(signal), this.#now());
      }
      if (task.tier === "sol" && !reserveSolTask(task.id, solTaskIds, limits)) {
        return failedResult(
          task.id,
          `Sol leaf budget exhausted (maxSolLeaves=${limits.maxSolLeaves})`,
          this.#now(),
          "contract",
        );
      }
      let result: LeafResult;
      const continuation = waitingContinuations.get(task.id);
      if (continuation !== undefined) {
        waitingContinuations.delete(task.id);
        waitingResults.delete(task.id);
      }
      try {
        result = await runLeafUntilAborted(
          this.#executor,
          {
            runId,
            ...(hostAccess === undefined ? {} : { hostAccess }),
            ...(hostApproval === undefined ? {} : { hostApproval }),
            task,
            dependencies: task.dependsOn
              .map((id) => results.get(id))
              .filter((item): item is LeafResult => item !== undefined),
            attempt,
            ...(retry === undefined ? {} : { retry }),
            ...(continuation === undefined
              ? {}
              : {
                  continuation: {
                    threadId: continuation.threadId,
                    previousTurnId: continuation.previousTurnId,
                    ...(userInput === undefined ? {} : { userInput }),
                  },
                }),
            signal,
          },
          postMessage,
          this.#now,
          this.#interruptGraceMs,
        );
      } catch (error) {
        result = signal.aborted
          ? interruptedResult(task, abortReason(signal), this.#now())
          : failedResult(task.id, error, this.#now());
      }
      result.usage = [...priorUsage, ...result.usage];
      firstStartedAt = earlierStartedAt(firstStartedAt, result.startedAt);
      result.startedAt = firstStartedAt;
      if (result.taskId !== task.id) {
        return mismatchedTaskResult(task, result, this.#now());
      }
      if (result.failureKind === "transient") {
        return result;
      }
      const validatorFailure = classifyValidatorFailure(task, result);
      if (attempt === 1 && validatorFailure === "mechanical") {
        if (!canAffordEscalation(task, result, limits)) {
          return result;
        }
        const upgraded = upgradeTask(task, limits, solTaskIds, "validation");
        if (upgraded === null) {
          return result;
        }
        priorUsage = result.usage;
        retry = {
          kind: "validation",
          previousResult: structuredClone(result),
        };
        task = upgraded;
        continue;
      }
      const shouldEscalate =
        result.status === "failed" &&
        (result.failureKind === "reasoning" || validatorFailure === "semantic");
      if (!shouldEscalate || attempt > 1) {
        return result;
      }
      if (!canAffordEscalation(task, result, limits)) {
        return result;
      }
      const upgraded = upgradeTask(task, limits, solTaskIds, "reasoning");
      if (upgraded === null) {
        return result;
      }
      priorUsage = result.usage;
      retry = {
        kind: validatorFailure === "semantic" ? "validation" : "reasoning",
        previousResult: structuredClone(result),
      };
      task = upgraded;
    }
  }

  #blockTasksWithFailedDependencies(
    tasks: ReadonlyMap<string, LeafTask>,
    results: Map<string, LeafResult>,
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks.values()) {
        if (results.has(task.id)) {
          continue;
        }
        const failed = task.dependsOn.find((dependency) => {
          const status = results.get(dependency)?.status;
          return status !== undefined && status !== "completed";
        });
        if (failed !== undefined) {
          results.set(
            task.id,
            blockedResult(task.id, `dependency ${failed} did not complete`, this.#now()),
          );
          changed = true;
        }
      }
    }
  }

  #cancelPending(
    tasks: ReadonlyMap<string, LeafTask>,
    results: Map<string, LeafResult>,
    reason: string,
    status: "blocked" | "cancelled" = "cancelled",
  ): void {
    for (const task of tasks.values()) {
      if (!results.has(task.id)) {
        results.set(
          task.id,
          status === "blocked"
            ? blockedResult(task.id, reason, this.#now())
            : cancelledResult(task.id, reason, this.#now()),
        );
      }
    }
  }
}

export function validatePlanForScheduling(plan: ExecutionPlan, limits: ExecutionLimits): void {
  if (plan.tasks.length === 0) {
    throw new Error("execution plan must contain at least one task");
  }
  if (plan.tasks.length > limits.maxLeaves) {
    throw new Error(`execution plan exceeds maxLeaves=${limits.maxLeaves}`);
  }
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`${task.id} cannot depend on itself`);
      }
    }
  }
  const waves = computeWaves(plan.tasks);
  if (waves > limits.maxWaves) {
    throw new Error(`execution plan requires ${waves} waves; limit is ${limits.maxWaves}`);
  }
  const solLeaves = plan.tasks.filter((task) => task.tier === "sol").length;
  if (solLeaves > limits.maxSolLeaves) {
    throw new Error(`execution plan exceeds maxSolLeaves=${limits.maxSolLeaves}`);
  }
  for (const task of plan.tasks) {
    if (
      task.expectedCostUsd !== undefined &&
      (!Number.isFinite(task.expectedCostUsd) || task.expectedCostUsd < 0)
    ) {
      throw new Error(`${task.id} has an invalid expectedCostUsd`);
    }
  }
  if (limits.maxCostUsd !== undefined) {
    const missingEstimate = plan.tasks.find((task) => task.expectedCostUsd === undefined);
    if (missingEstimate !== undefined) {
      throw new Error(
        `${missingEstimate.id} must declare expectedCostUsd when maxCostUsd is enforced`,
      );
    }
    const expectedCost = plan.tasks.reduce((total, task) => total + (task.expectedCostUsd ?? 0), 0);
    if (expectedCost > limits.maxCostUsd + Number.EPSILON) {
      throw new Error(
        `execution plan expected cost ${expectedCost} exceeds maxCostUsd=${limits.maxCostUsd}`,
      );
    }
  }
}

export function computeWaves(tasks: readonly LeafTask[]): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(id)) {
      throw new Error(`execution plan contains a dependency cycle at ${id}`);
    }
    const task = byId.get(id);
    if (task === undefined) {
      throw new Error(`unknown task ${id}`);
    }
    visiting.add(id);
    const value = 1 + Math.max(0, ...task.dependsOn.map(level));
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  return Math.max(0, ...tasks.map((task) => level(task.id)));
}

function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return structuredClone(plan);
}

function validateInitialResults(
  plan: ExecutionPlan,
  initialResults: readonly LeafResult[],
  waitingLeaves: readonly WaitingLeafResumePoint[],
): {
  completed: LeafResult[];
  waiting: Array<{ point: WaitingLeafResumePoint; result: LeafResult }>;
} {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const seen = new Set<string>();
  const waitingByTask = new Map<string, WaitingLeafResumePoint>();
  for (const point of waitingLeaves) {
    if (!taskIds.has(point.taskId)) {
      throw new Error(`scheduler waiting continuation references unknown task ${point.taskId}`);
    }
    if (waitingByTask.has(point.taskId)) {
      throw new Error(`duplicate scheduler waiting continuation for ${point.taskId}`);
    }
    if (
      point.threadId.length === 0 ||
      point.previousTurnId.length === 0 ||
      !Number.isInteger(point.attempt) ||
      point.attempt <= 0
    ) {
      throw new Error(`scheduler waiting continuation for ${point.taskId} is incomplete`);
    }
    waitingByTask.set(point.taskId, structuredClone(point));
  }
  const completed: LeafResult[] = [];
  const waiting: Array<{ point: WaitingLeafResumePoint; result: LeafResult }> = [];
  for (const source of initialResults) {
    const result = structuredClone(source);
    if (!taskIds.has(result.taskId)) {
      throw new Error(`scheduler initial result references unknown task ${result.taskId}`);
    }
    if (seen.has(result.taskId)) {
      throw new Error(`duplicate scheduler initial result for ${result.taskId}`);
    }
    const point = waitingByTask.get(result.taskId);
    if (result.status === "completed") {
      if (point !== undefined) {
        throw new Error(`completed scheduler result ${result.taskId} has a waiting continuation`);
      }
      completed.push(result);
    } else if (
      point !== undefined &&
      (result.status === "blocked" || result.status === "failed") &&
      result.failureKind === "permission" &&
      result.threadId === point.threadId &&
      result.turnId === point.previousTurnId
    ) {
      waiting.push({ point, result });
      waitingByTask.delete(result.taskId);
    } else {
      throw new Error(
        `scheduler initial result for ${result.taskId} must be completed or match a permission continuation`,
      );
    }
    seen.add(result.taskId);
  }
  if (waitingByTask.size > 0) {
    throw new Error(
      `scheduler waiting continuation has no matching persisted result for ${[
        ...waitingByTask.keys(),
      ].join(", ")}`,
    );
  }
  return { completed, waiting };
}

function hasPendingTasks(
  tasks: ReadonlyMap<string, LeafTask>,
  results: ReadonlyMap<string, LeafResult>,
): boolean {
  return [...tasks.keys()].some((taskId) => !results.has(taskId));
}

function maximumLaunchSkew(groups: readonly (readonly LaunchTiming[])[]): number | null {
  const skews = groups
    .map((group) => group.flatMap((timing) => timing.startedAt ?? []))
    .filter((started) => started.length > 1)
    .map((started) => Math.max(...started) - Math.min(...started));
  return skews.length === 0 ? null : Math.max(...skews);
}

function executionStopReason(
  tasks: ReadonlyMap<string, LeafTask>,
  results: ReadonlyMap<string, LeafResult>,
  usage: LeafResult["usage"],
  limits: ExecutionLimits,
  deadlineAt: number | null,
  now: () => Date,
): string | null {
  if (deadlineAt !== null && now().getTime() >= deadlineAt) {
    return "execution deadline exceeded";
  }
  if (limits.maxCostUsd === undefined) {
    return null;
  }
  const actualCost = sumUsageCost(usage);
  if (actualCost === null) {
    return `cost accounting unavailable under maxCostUsd=${limits.maxCostUsd}`;
  }
  const pendingExpectedCost = [...tasks.values()]
    .filter((task) => !results.has(task.id))
    .reduce((total, task) => total + (task.expectedCostUsd ?? 0), 0);
  if (actualCost + pendingExpectedCost > limits.maxCostUsd + Number.EPSILON) {
    return `remaining work would exceed maxCostUsd=${limits.maxCostUsd}`;
  }
  return null;
}

function reserveSolTask(taskId: string, solTaskIds: Set<string>, limits: ExecutionLimits): boolean {
  if (solTaskIds.has(taskId)) {
    return true;
  }
  if (solTaskIds.size >= limits.maxSolLeaves) {
    return false;
  }
  solTaskIds.add(taskId);
  return true;
}

function reserveSolTasks(
  plan: ExecutionPlan,
  solTaskIds: Set<string>,
  limits: ExecutionLimits,
): void {
  for (const task of plan.tasks) {
    if (task.tier === "sol" && !reserveSolTask(task.id, solTaskIds, limits)) {
      throw new Error(`PlanPatch exceeds maxSolLeaves=${limits.maxSolLeaves}`);
    }
  }
}

function reconcilePatchState(
  patch: PlanPatch,
  nextTasks: readonly LeafTask[],
  results: Map<string, LeafResult>,
  attempts: Map<string, number>,
): void {
  const replacedTaskIds = new Set<string>();
  for (const operation of patch.operations) {
    if (operation.op === "add") {
      continue;
    }
    results.delete(operation.taskId);
    if (operation.op === "replace") {
      replacedTaskIds.add(operation.taskId);
      results.delete(operation.task.id);
    } else {
      attempts.delete(operation.taskId);
    }
  }
  if (replacedTaskIds.size === 0) {
    return;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of nextTasks) {
      const result = results.get(task.id);
      if (
        result?.status === "blocked" &&
        task.dependsOn.some((dependency) => replacedTaskIds.has(dependency))
      ) {
        results.delete(task.id);
        attempts.delete(task.id);
        replacedTaskIds.add(task.id);
        changed = true;
      }
    }
  }
}

function upgradeTask(
  task: LeafTask,
  limits: ExecutionLimits,
  solTaskIds: Set<string>,
  repairKind: "validation" | "reasoning",
): LeafTask | null {
  if (task.tier === "sol") {
    return null;
  }
  const tier = task.tier === "luna" ? "terra" : "sol";
  if (tier === "sol" && !reserveSolTask(task.id, solTaskIds, limits)) {
    return null;
  }
  return {
    ...task,
    tier,
    effort: tier === "terra" && repairKind === "validation" ? "medium" : "high",
  };
}

function isPatchLeafCapacityError(error: unknown): boolean {
  return (
    error instanceof PlanValidationError &&
    error.issues.length > 0 &&
    error.issues.every(
      (issue) => issue.path === "$.effectivePlan.tasks" && issue.code === "max_leaves",
    )
  );
}

function sumUsageCost(usage: LeafResult["usage"]): number | null {
  const costs = usage.map((item) => item.estimatedCostUsd);
  return costs.some((cost) => cost === null)
    ? null
    : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
}

function canAffordEscalation(
  task: LeafTask,
  priorResult: LeafResult,
  limits: ExecutionLimits,
): boolean {
  if (limits.maxCostUsd === undefined) {
    return true;
  }
  if (priorResult.threadId !== null && priorResult.usage.length === 0) {
    return false;
  }
  const priorCost = sumUsageCost(priorResult.usage);
  return (
    priorCost !== null &&
    priorCost + (task.expectedCostUsd ?? Number.POSITIVE_INFINITY) <=
      limits.maxCostUsd + Number.EPSILON
  );
}

function earlierStartedAt(current: string | null, candidate: string | null): string | null {
  if (current === null) {
    return candidate;
  }
  if (candidate === null) {
    return current;
  }
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(currentMs)) {
    return candidate;
  }
  return !Number.isFinite(candidateMs) || currentMs <= candidateMs ? current : candidate;
}

function mergeBrokerMessages(
  results: readonly LeafResult[],
  messages: readonly AgentMessage[],
): LeafResult[] {
  const messagesByTask = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    const bucket = messagesByTask.get(message.fromTaskId) ?? [];
    bucket.push(message);
    messagesByTask.set(message.fromTaskId, bucket);
  }
  return results.map((result) => {
    const additional = messagesByTask.get(result.taskId) ?? [];
    if (additional.length === 0) {
      return result;
    }
    const existingIds = new Set(result.messages.map((message) => message.id));
    return {
      ...result,
      messages: [
        ...result.messages,
        ...additional.filter((message) => !existingIds.has(message.id)),
      ],
    };
  });
}

interface RunAbort {
  signal: AbortSignal;
  dispose(): void;
}

function createRunAbort(parent: AbortSignal | undefined, deadlineMs: number | undefined): RunAbort {
  const controller = new AbortController();
  const forwardParentAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) {
    forwardParentAbort();
  } else {
    parent?.addEventListener("abort", forwardParentAbort, { once: true });
  }
  const deadlineTimer =
    deadlineMs === undefined
      ? null
      : setTimeout(() => controller.abort(new Error("execution deadline exceeded")), deadlineMs);
  deadlineTimer?.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      parent?.removeEventListener("abort", forwardParentAbort);
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
      }
    },
  };
}

async function runLeafUntilAborted(
  executor: LeafExecutor,
  input: LeafRunInput,
  postMessage: (message: AgentMessageInput) => Promise<string | null>,
  now: () => Date,
  interruptGraceMs: number,
): Promise<LeafResult> {
  if (input.signal.aborted) {
    return interruptedResult(input.task, abortReason(input.signal), now());
  }
  return new Promise<LeafResult>((resolve, reject) => {
    let settled = false;
    let abortRequested = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      if (abortRequested) {
        return;
      }
      abortRequested = true;
      void waitForInterrupt(
        Promise.resolve().then(
          () => executor.interrupt?.(input.task.id, input.runId) ?? Promise.resolve(),
        ),
        interruptGraceMs,
      ).then(() =>
        finish(() => resolve(interruptedResult(input.task, abortReason(input.signal), now()))),
      );
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
    }
    void executor.runLeaf(input, postMessage).then(
      (result) =>
        finish(() =>
          resolve(
            input.signal.aborted
              ? interruptedResult(input.task, abortReason(input.signal), now())
              : result,
          ),
        ),
      (error: unknown) => {
        if (!input.signal.aborted) {
          finish(() => reject(error));
        }
      },
    );
  });
}

const ABORTED = Symbol("scheduler aborted");

async function replanUntilAborted(
  replan: Promise<PlanPatch | null>,
  signal: AbortSignal,
): Promise<PlanPatch | null | typeof ABORTED> {
  if (signal.aborted) {
    return ABORTED;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void replan.then(
      (patch) => {
        signal.removeEventListener("abort", onAbort);
        resolve(patch);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForInterrupt(interrupt: Promise<void>, graceMs: number): Promise<void> {
  const boundedGraceMs = Math.max(0, graceMs);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, boundedGraceMs);
    void interrupt
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }
  return "run cancelled";
}

function interruptedResult(task: LeafTask, reason: string, completedAt: Date): LeafResult {
  if (task.access === "workspaceWrite") {
    return {
      ...failedResult(task.id, reason, completedAt, "unknown"),
      status: "indeterminate",
      summary: `${reason}; workspace changes may have occurred`,
    };
  }
  return cancelledResult(task.id, reason, completedAt);
}

function mismatchedTaskResult(task: LeafTask, received: LeafResult, completedAt: Date): LeafResult {
  const failure = {
    ...failedResult(
      task.id,
      `executor returned result for '${received.taskId}', expected '${task.id}'`,
      completedAt,
      "contract",
    ),
    threadId: received.threadId,
    turnId: received.turnId,
    usage: received.usage,
    startedAt: received.startedAt,
  };
  return task.access === "workspaceWrite"
    ? {
        ...failure,
        status: "indeterminate",
        summary: "executor returned a mismatched result; workspace changes may have occurred",
      }
    : failure;
}

function failedResult(
  taskId: string,
  error: unknown,
  completedAt: Date,
  failureKind: NonNullable<LeafResult["failureKind"]> = "unknown",
): LeafResult {
  return {
    taskId,
    status: "failed",
    summary: "leaf execution failed",
    confidence: 0,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: null,
    turnId: null,
    usage: [],
    startedAt: null,
    completedAt: completedAt.toISOString(),
    error: error instanceof Error ? error.message : String(error),
    failureKind,
  };
}

function blockedResult(taskId: string, reason: string, completedAt: Date): LeafResult {
  return {
    ...failedResult(taskId, reason, completedAt),
    status: "blocked",
    summary: reason,
    failureKind: "contract",
  };
}

function cancelledResult(taskId: string, reason: string, completedAt: Date): LeafResult {
  return {
    ...failedResult(taskId, reason, completedAt),
    status: "cancelled",
    summary: reason,
  };
}
