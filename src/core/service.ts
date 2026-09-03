import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  watch,
  type FSWatcher,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AgentTrioRequest,
  BatchMetrics,
  BatchResult,
  BatchUsageBreakdown,
  ExecutionLimits,
  ExecutionPlan,
  JobSnapshot,
  JobStatus,
  LeafResult,
  ModelUsage,
  PlannerSessionState,
  ReplanTrigger,
  RemoteTurnRef,
  RunRequest,
  ValidationResult,
  ValidationSpec,
  WaitingInputCheckpoint,
} from "./contracts.js";
import { AGENT_TRIO_PROTOCOL_VERSION } from "./contracts.js";
import type {
  AdmissionController,
  AgentOutcome,
  DeterministicValidator,
  DirectExecutor,
  FinalReviewer,
  IntegrationPlanIssue,
  ReattachResult,
  RecoveryAdapter,
  ResultIntegrator,
  WorkspaceController,
  WaitingTurnContext,
} from "./integration.js";
import { WaitingInputError } from "./integration.js";
import type { JobStore } from "./job-store.js";
import { assertMatchingRequest, hashRunRequest } from "./job-store.js";
import type { PlannerService, PlannerSession } from "./planner.js";
import type {
  CompletionInspector,
  DeterministicScheduler,
  ReplanHandler,
  ScheduleResult,
} from "./scheduler.js";
import { normalizeExecutionLimitsForMode } from "./policy.js";
import { canAutomaticallyReduce, reduceLeafResults } from "./reducer.js";
import type { RouteOptimizer } from "./router.js";

type PlannerPort = Pick<PlannerService, "plan"> &
  Partial<
    Pick<PlannerService, "adoptHostPlan" | "createReplanHandler" | "getSession" | "restoreSession">
  >;
type SchedulerPort = Pick<DeterministicScheduler, "execute">;

export interface AgentTrioServiceOptions {
  store: JobStore;
  admission: AdmissionController;
  directExecutor: DirectExecutor;
  planner: PlannerPort;
  scheduler: SchedulerPort;
  integrator: ResultIntegrator;
  finalReviewer?: FinalReviewer;
  validator?: DeterministicValidator;
  recovery?: RecoveryAdapter;
  workspace?: WorkspaceController;
  routeOptimizer?: RouteOptimizer;
  costEstimator?: NonLeafCostEstimator;
  now?: () => Date;
  createRunId?: () => string;
  controlPollMs?: number;
  monitorUrlForRun?: (runId: string) => string | undefined;
}

export interface StartRequest extends RunRequest {
  runId?: string;
}

export type NonLeafCostStage =
  | "admission"
  | "direct"
  | "planning"
  | "plan_patch"
  | "planner_answer"
  | "integration"
  | "final_review";

export interface NonLeafCostEstimateInput {
  stage: NonLeafCostStage;
  request: RunRequest;
  /** Bounded structured data used to approximate the turn-specific prompt size. */
  context: unknown;
}

export interface NonLeafCostEstimator {
  estimateUsd(input: NonLeafCostEstimateInput): number | null;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<BatchResult>;
}

interface MutableRunState {
  snapshot: JobSnapshot;
  startedAt: Date;
  planningMs: number;
  integrationMs: number;
  extraUsage: ModelUsage[];
  usageByStage: MutableUsageByStage;
  workspaceUncertain: boolean;
  routeReason?: string;
  selectedLeafCount?: number;
  plannerSkipped?: boolean;
  integrationSkipped?: boolean;
  routeSource: "host_sol" | "internal_sol" | "deterministic_direct" | undefined;
  estimatedDirectCostUsd: number | null | undefined;
  estimatedFanoutCostUsd: number | null | undefined;
  estimatedDirectSeconds: number | null | undefined;
  estimatedFanoutSeconds: number | null | undefined;
}

type UsageStage = keyof BatchUsageBreakdown;
type MutableUsageByStage = Record<UsageStage, ModelUsage[]>;

export class AgentTrioServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentTrioServiceError";
    this.code = code;
  }
}

class UncertainFinalReviewError extends Error {
  constructor(remoteError: unknown, accountingError?: unknown) {
    const accountingDetail =
      accountingError === undefined
        ? ""
        : `; cost accounting also failed: ${plainErrorMessage(accountingError)}`;
    super(
      `Sol final review did not return a confirmed response: ${plainErrorMessage(remoteError)}${accountingDetail}; integration checkpoint and recovery state were preserved`,
    );
    this.name = "UncertainFinalReviewError";
  }
}

export class AgentTrioService {
  readonly #store: JobStore;
  readonly #admission: AdmissionController;
  readonly #directExecutor: DirectExecutor;
  readonly #planner: PlannerPort;
  readonly #scheduler: SchedulerPort;
  readonly #integrator: ResultIntegrator;
  readonly #finalReviewer: FinalReviewer | undefined;
  readonly #validator: DeterministicValidator | undefined;
  readonly #recovery: RecoveryAdapter | undefined;
  readonly #workspace: WorkspaceController | undefined;
  readonly #routeOptimizer: RouteOptimizer | undefined;
  readonly #costEstimator: NonLeafCostEstimator | undefined;
  readonly #now: () => Date;
  readonly #createRunId: () => string;
  readonly #controlPollMs: number;
  readonly #monitorUrlForRun: ((runId: string) => string | undefined) | undefined;
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: AgentTrioServiceOptions) {
    this.#store = options.store;
    this.#admission = options.admission;
    this.#directExecutor = options.directExecutor;
    this.#planner = options.planner;
    this.#scheduler = options.scheduler;
    this.#integrator = options.integrator;
    this.#finalReviewer = options.finalReviewer;
    this.#validator = options.validator;
    this.#recovery = options.recovery;
    this.#workspace = options.workspace;
    this.#routeOptimizer = options.routeOptimizer;
    this.#costEstimator = options.costEstimator;
    this.#now = options.now ?? (() => new Date());
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#controlPollMs = options.controlPollMs ?? 100;
    this.#monitorUrlForRun = options.monitorUrlForRun;
    if (!Number.isFinite(this.#controlPollMs) || this.#controlPollMs <= 0) {
      throw new RangeError("controlPollMs must be a positive finite number");
    }
  }

  async handle(request: AgentTrioRequest): Promise<BatchResult> {
    switch (request.action) {
      case "run":
        return this.run(withoutAction(request));
      case "submit":
        return this.submit(withoutAction(request));
      case "status":
        return this.status(request.runId);
      case "resume":
        return this.resume(request.runId, request.input);
      case "cancel":
        return this.cancel(request.runId);
    }
  }

  async run(input: StartRequest): Promise<BatchResult> {
    const request = normalizeStartRequest(input, "foreground");
    const runId = input.runId ?? this.#createRunId();
    const existing = this.#findExisting(runId, request);
    if (existing !== null) {
      const active = this.#active.get(runId);
      return active === undefined
        ? this.#resultForUser(existing.result)
        : this.#resultForUser(await active.promise);
    }
    return this.#resultForUser(await this.#startNew(runId, request).promise);
  }

  async submit(input: StartRequest): Promise<BatchResult> {
    const request = normalizeStartRequest(input, "durable");
    const runId = input.runId ?? this.#createRunId();
    const existing = this.#findExisting(runId, request);
    if (existing !== null) {
      return this.#resultForUser(existing.result);
    }
    const active = this.#startNew(runId, request);
    void active.promise.catch(() => undefined);
    return this.#resultForUser(this.#requireSnapshot(runId).result);
  }

  status(runId: string): BatchResult {
    return this.#resultForUser(this.#requireSnapshot(runId).result);
  }

  async waitForSettlement(runId: string): Promise<BatchResult> {
    const active = this.#active.get(runId);
    if (active !== undefined) {
      return this.#resultForUser(await active.promise);
    }
    const initial = this.#requireSnapshot(runId);
    if (isSettled(initial.result.status)) {
      return this.#resultForUser(initial.result);
    }
    return new Promise<BatchResult>((resolve, reject) => {
      let watcher: FSWatcher | null = null;
      let finished = false;
      const close = (): void => {
        watcher?.close();
        watcher = null;
      };
      const fail = (error: unknown): void => {
        if (finished) {
          return;
        }
        finished = true;
        close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const check = (): void => {
        if (finished) {
          return;
        }
        try {
          const snapshot = this.#requireSnapshot(runId);
          if (!isSettled(snapshot.result.status)) {
            return;
          }
          finished = true;
          close();
          resolve(this.#resultForUser(snapshot.result));
        } catch (error) {
          fail(error);
        }
      };
      try {
        watcher = watch(this.#store.jobDirectory(runId), (_event, filename) => {
          if (filename === null || filename === "job.json") {
            check();
          }
        });
        watcher.once("error", fail);
        // Close the race between the initial read and watcher registration.
        check();
      } catch (error) {
        fail(error);
      }
    });
  }

  async resume(runId: string, input?: string): Promise<BatchResult> {
    const userInput = normalizeResumeInput(input);
    const active = this.#active.get(runId);
    if (active !== undefined) {
      return this.#resultForUser(await active.promise);
    }
    const initial = this.#requireSnapshot(runId);
    if (isTerminal(initial.result.status)) {
      return this.#resultForUser(initial.result);
    }
    if (this.#recovery === undefined) {
      throw new AgentTrioServiceError(
        "reattach_unavailable",
        `run ${runId} cannot resume safely without a thread reattachment adapter`,
      );
    }

    const lock = this.#store.acquire(runId);
    let snapshot: JobSnapshot;
    try {
      snapshot = this.#requireSnapshot(runId);
    } catch (error) {
      lock.release();
      throw error;
    }
    if (isTerminal(snapshot.result.status)) {
      lock.release();
      return this.#resultForUser(snapshot.result);
    }
    const controller = new AbortController();
    const stopControl = this.#watchCancellation(runId, controller);
    const operation = this.#resumeLocked(snapshot, controller.signal, userInput)
      .catch((error: unknown) => this.#finishRecoveryError(snapshot, error, controller.signal))
      .finally(() => {
        stopControl();
        lock.release();
        if (this.#active.get(runId)?.promise === operation) {
          this.#active.delete(runId);
        }
      });
    this.#active.set(runId, { controller, promise: operation });
    return this.#resultForUser(await operation);
  }

  async cancel(runId: string): Promise<BatchResult> {
    const active = this.#active.get(runId);
    if (active !== undefined) {
      active.controller.abort(new Error("run cancelled"));
      const result = await active.promise;
      const snapshot = this.#requireSnapshot(runId);
      if (latestNonterminalRemoteTurns(snapshot.remoteTurns).length === 0) {
        return this.#resultForUser(result);
      }
    }

    return this.#cancelPersisted(runId);
  }

  async #cancelPersisted(runId: string): Promise<BatchResult> {
    let lock: ReturnType<JobStore["acquire"]>;
    try {
      lock = this.#store.acquire(runId);
    } catch (error) {
      if (!isActiveLockError(error, runId)) {
        throw error;
      }
      requestCancellation(this.#store, runId, this.#now());
      return this.#awaitControlledCancellation(runId);
    }
    try {
      return await this.#cancelLocked(this.#requireSnapshot(runId));
    } finally {
      lock.release();
    }
  }

  async #awaitControlledCancellation(runId: string): Promise<BatchResult> {
    for (;;) {
      const snapshot = this.#requireSnapshot(runId);
      const pending = latestNonterminalRemoteTurns(snapshot.remoteTurns);
      if (
        pending.length === 0 &&
        (isTerminal(snapshot.result.status) || snapshot.result.status === "indeterminate")
      ) {
        clearCancellationRequest(this.#store, runId);
        return cloneResult(snapshot.result);
      }
      let lock: ReturnType<JobStore["acquire"]>;
      try {
        lock = this.#store.acquire(runId);
      } catch (error) {
        if (!isActiveLockError(error, runId)) {
          throw error;
        }
        await wait(this.#controlPollMs);
        continue;
      }
      try {
        return await this.#cancelLocked(this.#requireSnapshot(runId));
      } finally {
        lock.release();
      }
    }
  }

  async #cancelLocked(snapshot: JobSnapshot): Promise<BatchResult> {
    const pending = latestNonterminalRemoteTurns(snapshot.remoteTurns);
    if (pending.length === 0) {
      if (isTerminal(snapshot.result.status) || hasIndeterminateWriterSnapshot(snapshot)) {
        clearCancellationRequest(this.#store, snapshot.result.runId);
        return cloneResult(snapshot.result);
      }
      return this.#completeCancellation(snapshot);
    }
    if (this.#recovery?.cancel === undefined) {
      clearCancellationRequest(this.#store, snapshot.result.runId);
      throw new AgentTrioServiceError(
        "cancel_unavailable",
        `run ${snapshot.result.runId} has remote work but no cancellation adapter`,
      );
    }

    let cancellation: Awaited<ReturnType<NonNullable<RecoveryAdapter["cancel"]>>>;
    try {
      cancellation = await this.#recovery.cancel({ snapshot: cloneSnapshot(snapshot) });
    } catch (error) {
      return this.#indeterminateCancellation(
        snapshot,
        `cancellation could not be confirmed: ${plainErrorMessage(error)}`,
      );
    }
    snapshot.remoteTurns = mergeRemoteTurns(snapshot.remoteTurns, cancellation.remoteTurns);
    const stillPending = latestNonterminalRemoteTurns(snapshot.remoteTurns);
    if (!cancellation.allTerminal || stillPending.length > 0) {
      const reasons =
        cancellation.reasons.length === 0
          ? ["one or more remote turns remain nonterminal"]
          : cancellation.reasons;
      return this.#indeterminateCancellation(snapshot, reasons.join("; "));
    }
    return this.#completeCancellation(snapshot);
  }

  async #completeCancellation(snapshot: JobSnapshot): Promise<BatchResult> {
    try {
      if (snapshot.result.plan !== null) {
        await this.#workspace?.cleanup(snapshot.result.runId);
      }
    } catch (error) {
      return this.#indeterminateCancellation(
        snapshot,
        `remote work stopped, but workspace cleanup failed: ${plainErrorMessage(error)}`,
      );
    }
    return this.#persistCancellation(snapshot, "cancelled", "run cancelled");
  }

  #indeterminateCancellation(snapshot: JobSnapshot, reason: string): BatchResult {
    return this.#persistCancellation(
      snapshot,
      "indeterminate",
      `${reason}; workspace and recovery state were preserved`,
    );
  }

  #persistCancellation(
    snapshot: JobSnapshot,
    status: "cancelled" | "indeterminate",
    error: string,
  ): BatchResult {
    const completedAt = this.#now();
    const unfinished: BatchResult = {
      ...cloneResult(snapshot.result),
      status,
      finalResponse: null,
      metrics: null,
      error,
    };
    const metrics = finishSnapshotMetrics(snapshot, unfinished, completedAt);
    const result: BatchResult = { ...unfinished, metrics };
    delete result.needsAction;
    checkpointFinishedMetrics(snapshot, metrics);
    const next = { ...snapshot, result, updatedAt: completedAt.toISOString() };
    this.#save(next, status);
    clearCancellationRequest(this.#store, snapshot.result.runId);
    return cloneResult(result);
  }

  #startNew(runId: string, request: RunRequest): ActiveRun {
    const lock = this.#store.acquire(runId);
    try {
      const raced = this.#store.load(runId);
      if (raced !== null) {
        assertMatchingRequest(raced, request);
        lock.release();
        const completed = Promise.resolve(cloneResult(raced.result));
        return { controller: new AbortController(), promise: completed };
      }

      const snapshot = initialSnapshot(
        runId,
        request,
        this.#now(),
        this.#monitorUrlForRun?.(runId),
      );
      this.#save(snapshot, "created");
      const controller = new AbortController();
      const state: MutableRunState = {
        snapshot,
        startedAt: parseSnapshotDate(snapshot.startedAt, this.#now()),
        planningMs: 0,
        integrationMs: 0,
        extraUsage: [],
        usageByStage: emptyUsageByStage(),
        workspaceUncertain: false,
        estimatedDirectCostUsd: undefined,
        estimatedFanoutCostUsd: undefined,
        estimatedDirectSeconds: undefined,
        estimatedFanoutSeconds: undefined,
        routeSource: undefined,
      };
      const stopControl = this.#watchCancellation(runId, controller);
      const operation = this.#execute(state, controller.signal)
        .catch((error: unknown) => this.#finishError(state, error, controller.signal))
        .finally(() => {
          stopControl();
          lock.release();
          if (this.#active.get(runId)?.promise === operation) {
            this.#active.delete(runId);
          }
        });
      const active = { controller, promise: operation };
      this.#active.set(runId, active);
      return active;
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  async #execute(state: MutableRunState, signal: AbortSignal): Promise<BatchResult> {
    const budget = createServiceBudget(state.snapshot.request, state.startedAt, signal, this.#now);
    try {
      return await this.#executeWithinBudget(state, budget.signal, budget);
    } finally {
      budget.dispose();
    }
  }

  #reserveNonLeafCost(
    state: MutableRunState,
    budget: ServiceBudget,
    stage: NonLeafCostStage,
    context: unknown,
    additionalUsage: readonly ModelUsage[] = [],
  ): CostReservation {
    const estimate = budget.costLimited
      ? (this.#costEstimator?.estimateUsd({
          stage,
          request: structuredClone(state.snapshot.request),
          context,
        }) ?? null)
      : null;
    return budget.reserve([...state.extraUsage, ...additionalUsage], stageLabel(stage), estimate);
  }

  #settleFailedNonLeafCall(
    budget: ServiceBudget,
    reservation: CostReservation,
    totalUsage: readonly ModelUsage[],
  ): void {
    if (budget.signal.aborted) {
      budget.release(reservation);
      return;
    }
    budget.settle(reservation, totalUsage, []);
  }

  #throwUncertainFinalReviewCall(
    budget: ServiceBudget,
    reservation: CostReservation,
    totalUsage: readonly ModelUsage[],
    remoteError: unknown,
  ): never {
    let accountingError: unknown;
    try {
      this.#settleFailedNonLeafCall(budget, reservation, totalUsage);
    } catch (error) {
      accountingError = error;
    }
    throw new UncertainFinalReviewError(remoteError, accountingError);
  }

  async #executeWithinBudget(
    state: MutableRunState,
    signal: AbortSignal,
    budget: ServiceBudget,
  ): Promise<BatchResult> {
    const { request } = state.snapshot;
    const runId = state.snapshot.result.runId;
    if (
      this.#routeOptimizer !== undefined &&
      (request.semanticPlan !== undefined ||
        request.strategy === "fanout" ||
        request.directTier !== undefined ||
        !requestRequiresCapabilityAdmission(request.objective, request.capabilities))
    ) {
      const decision = await this.#routeOptimizer.decide({ runId, request, signal });
      this.#throwIfAborted(signal);
      // The local route is deliberately model-free, so no admission usage or thread is recorded.
      return this.#executeAdmissionDecision(state, decision, signal, budget);
    }
    const admissionReservation = this.#reserveNonLeafCost(state, budget, "admission", {
      objective: request.objective,
      domain: request.domain ?? "general",
      constraints: request.constraints ?? [],
      capabilities: request.capabilities ?? [],
    });
    let decision: Awaited<ReturnType<AdmissionController["decide"]>>;
    try {
      decision = await this.#admission.decide({ runId, request, signal });
    } catch (error) {
      this.#settleFailedNonLeafCall(budget, admissionReservation, state.extraUsage);
      throw error;
    }
    this.#throwIfAborted(signal);
    const admissionUsage = decision.usage ?? [];
    recordUsage(state, "admission", admissionUsage);
    const accountedAdmissionUsage =
      admissionUsage.length > 0
        ? admissionUsage
        : decision.route === "direct"
          ? (decision.outcome?.usage ?? [])
          : [];
    budget.settle(
      admissionReservation,
      admissionUsage.length > 0
        ? state.extraUsage
        : [...state.extraUsage, ...accountedAdmissionUsage],
      accountedAdmissionUsage,
    );
    return this.#executeAdmissionDecision(state, decision, signal, budget);
  }

  async #executeAdmissionDecision(
    state: MutableRunState,
    decision: Awaited<ReturnType<AdmissionController["decide"]>>,
    signal: AbortSignal,
    budget: ServiceBudget,
  ): Promise<BatchResult> {
    const { request } = state.snapshot;
    const runId = state.snapshot.result.runId;
    state.snapshot.coordinatorThreadId = decision.threadId ?? null;
    state.routeReason = decision.reason;
    state.estimatedDirectCostUsd = decision.estimatedDirectCostUsd;
    state.estimatedFanoutCostUsd = decision.estimatedFanoutCostUsd;
    state.estimatedDirectSeconds = decision.estimatedDirectSeconds;
    state.estimatedFanoutSeconds = decision.estimatedFanoutSeconds;
    state.routeSource = decision.routeSource;
    state.plannerSkipped = decision.route === "direct";

    if (decision.route === "waiting_input") {
      this.#checkpointWaitingTurn(state, "admission", decision.needsAction, decision.waitingTurn);
      return this.#finish(state, "waiting_input", {
        needsAction: decision.needsAction,
        error: decision.reason,
      });
    }
    if (decision.route === "direct") {
      this.#transition(state, "running");
      let outcome: AgentOutcome;
      if (decision.outcome !== undefined) {
        outcome = decision.outcome;
      } else {
        const directReservation = this.#reserveNonLeafCost(state, budget, "direct", {
          objective: request.objective,
          constraints: request.constraints ?? [],
          capabilities: request.capabilities ?? [],
        });
        try {
          outcome = await this.#directExecutor.execute({ runId, request, signal });
        } catch (error) {
          this.#settleFailedNonLeafCall(budget, directReservation, state.extraUsage);
          throw error;
        }
        recordUsage(state, "direct", outcome.usage);
        budget.settle(directReservation, state.extraUsage, outcome.usage);
      }
      this.#throwIfAborted(signal);
      if (decision.outcome !== undefined) {
        recordUsage(state, "direct", outcome.usage);
      }
      state.snapshot.integratorThreadId = outcome.threadId;
      if (outcome.status === "waiting_input" && outcome.needsAction !== undefined) {
        this.#checkpointWaitingTurn(state, "direct", outcome.needsAction, outcome.waitingTurn);
      } else {
        delete state.snapshot.waitingInputCheckpoint;
      }
      return this.#finishOutcome(state, outcome);
    }

    this.#transition(state, "planning");
    const planningRequest = withSuggestedLeafLimit(request, decision.suggestedMaxLeaves);
    const useHostPlan =
      planningRequest.semanticPlan !== undefined && this.#planner.adoptHostPlan !== undefined;
    let adoptedHostPlan = false;
    let planningReservation: CostReservation | null = useHostPlan
      ? null
      : this.#reserveNonLeafCost(state, budget, "planning", {
          objective: request.objective,
          domain: request.domain ?? "general",
          constraints: request.constraints ?? [],
          limits: planningRequest.limits ?? {},
        });
    if (useHostPlan) {
      state.plannerSkipped = true;
    }
    const planningStarted = this.#now();
    let session: PlannerSession;
    try {
      if (useHostPlan) {
        try {
          session = await this.#planner.adoptHostPlan!(
            planningRequest,
            runId,
            decision.route === "adaptive" ? "fanout" : decision.route,
          );
          adoptedHostPlan = true;
        } catch (error) {
          if (plannerFailureDetails(error)?.code !== "host_plan_requires_internal_sol") {
            throw error;
          }
          state.plannerSkipped = false;
          state.routeSource = "internal_sol";
          planningReservation = this.#reserveNonLeafCost(state, budget, "planning", {
            objective: request.objective,
            domain: request.domain ?? "general",
            constraints: request.constraints ?? [],
            limits: planningRequest.limits ?? {},
            hostPlanFallback: "unsafe_for_fast_path",
          });
          const internalPlanningRequest = structuredClone(planningRequest);
          delete internalPlanningRequest.semanticPlan;
          session = await this.#planner.plan(
            internalPlanningRequest,
            runId,
            signal,
            decision.route,
          );
        }
      } else {
        session = await this.#planner.plan(planningRequest, runId, signal, decision.route);
      }
    } catch (error) {
      const plannerFailure = plannerFailureDetails(error);
      if (planningReservation !== null) {
        if (plannerFailure !== null) {
          state.snapshot.plannerThreadId = plannerFailure.threadId;
          recordUsage(state, "planning", plannerFailure.usage);
          budget.settle(planningReservation, state.extraUsage, plannerFailure.usage);
        } else {
          this.#settleFailedNonLeafCall(budget, planningReservation, state.extraUsage);
        }
      }
      if (decision.route !== "fanout" || plannerFailure?.code !== "fanout_rejected") {
        throw error;
      }
      const fallbackReason = plainErrorMessage(error);
      state.routeReason = `${decision.reason}; planner fallback: ${fallbackReason}`;
      return this.#executeDirectAfterPlanning(state, signal, budget, fallbackReason);
    } finally {
      state.planningMs += elapsedMs(planningStarted, this.#now());
    }
    this.#throwIfAborted(signal);
    state.snapshot.plannerThreadId = session.threadId;
    state.snapshot.result.plan = structuredClone(session.plan);
    state.snapshot.plannerSession = structuredClone(session);
    state.selectedLeafCount = session.plan.tasks.length;
    if (hasWorkspaceWriters(session.plan)) {
      state.snapshot.workspaceCommitState = "pending";
    }
    const initialPlannerUsage = plannerUsage(session);
    recordUsage(state, "planning", initialPlannerUsage);
    if (planningReservation !== null) {
      budget.settle(planningReservation, state.extraUsage, initialPlannerUsage);
    }
    const executionRoute = session.plan.tasks.length === 1 ? "planned_single" : "fanout";
    if (decision.route === "adaptive") {
      state.routeReason =
        executionRoute === "planned_single"
          ? "internal Sol selected one execution leaf"
          : `internal Sol selected a ${String(session.plan.tasks.length)}-leaf DAG`;
    }
    if (executionRoute === "fanout" && this.#routeOptimizer?.assessPlan !== undefined) {
      const finalAdmission = await this.#routeOptimizer.assessPlan({
        runId,
        request,
        plan: session.plan,
        source: adoptedHostPlan ? "host" : "internal",
        signal,
      });
      state.routeReason = finalAdmission.reason;
      state.estimatedDirectCostUsd = finalAdmission.estimatedDirectCostUsd;
      state.estimatedFanoutCostUsd = finalAdmission.estimatedFanoutCostUsd;
      state.estimatedDirectSeconds = finalAdmission.estimatedDirectSeconds;
      state.estimatedFanoutSeconds = finalAdmission.estimatedFanoutSeconds;
      state.routeSource = finalAdmission.routeSource ?? state.routeSource;
      if (finalAdmission.route !== "fanout") {
        state.snapshot.result.plan = null;
        delete state.snapshot.plannerSession;
        state.selectedLeafCount = 0;
        state.snapshot.workspaceCommitState = "not_applicable";
        return this.#executeDirectAfterPlanning(state, signal, budget, "final_plan_hard_rejection");
      }
    }
    this.#transition(state, "running");

    return this.#continueFanout(state, session, signal, budget);
  }

  async #executeDirectAfterPlanning(
    state: MutableRunState,
    signal: AbortSignal,
    budget: ServiceBudget,
    fallbackReason: string,
  ): Promise<BatchResult> {
    const { request } = state.snapshot;
    const runId = state.snapshot.result.runId;
    this.#transition(state, "running");
    const fallbackReservation = this.#reserveNonLeafCost(state, budget, "direct", {
      objective: request.objective,
      constraints: request.constraints ?? [],
      fallbackReason,
    });
    let outcome: AgentOutcome;
    try {
      outcome = await this.#directExecutor.execute({ runId, request, signal });
    } catch (error) {
      this.#settleFailedNonLeafCall(budget, fallbackReservation, state.extraUsage);
      throw error;
    }
    this.#throwIfAborted(signal);
    recordUsage(state, "direct", outcome.usage);
    budget.settle(fallbackReservation, state.extraUsage, outcome.usage);
    state.snapshot.integratorThreadId = outcome.threadId;
    if (outcome.status === "waiting_input" && outcome.needsAction !== undefined) {
      this.#checkpointWaitingTurn(state, "direct", outcome.needsAction, outcome.waitingTurn);
    } else {
      delete state.snapshot.waitingInputCheckpoint;
    }
    return this.#finishOutcome(state, outcome);
  }

  async #continueFanout(
    state: MutableRunState,
    session: PlannerSession,
    signal: AbortSignal,
    budget: ServiceBudget,
    recovery?: {
      initialLeaves: readonly LeafResult[];
      workspaceWritersMayHaveRun: boolean;
      waitingInput?: WaitingInputCheckpoint;
      userInput?: string;
    },
  ): Promise<BatchResult> {
    const { request } = state.snapshot;
    const runId = state.snapshot.result.runId;
    const plannerUsageBaseline = session.usage.length;

    if (
      hasWorkspaceWriters(session.plan) &&
      state.snapshot.workspaceCommitState !== "pending" &&
      state.snapshot.workspaceCommitState !== "applied"
    ) {
      state.snapshot.workspaceCommitState = "pending";
      state.snapshot.updatedAt = this.#now().toISOString();
      this.#checkpointState(state);
      this.#save(state.snapshot, "workspace_pending");
    }

    const plannerAccounting = { sessionUsageCount: 0 };
    const replanHandler = this.#checkpointingReplanHandler(
      state,
      session.threadId,
      this.#planner.createReplanHandler?.(session, signal),
      budget,
      plannerUsageBaseline,
      plannerAccounting,
    );
    const integrationState: {
      outcome: AgentOutcome | null;
      triggers: ReplanTrigger[];
      validation: ValidationResult[] | null;
      candidateCwd: string | null;
    } = { outcome: null, triggers: [], validation: null, candidateCwd: null };
    let integrationContinuation =
      recovery?.waitingInput?.kind === "integration" ? recovery.waitingInput : null;
    const schedulerLimits = budget.remainingLimits(session.limits, state.extraUsage);
    const completionInspector: CompletionInspector | undefined =
      request.integrate === false
        ? undefined
        : {
            inspect: async (activePlan, leaves) => {
              if (!allPlanTasksCompleted(activePlan, leaves)) {
                throw new AgentTrioServiceError(
                  "integration_before_completion",
                  "Terra integration cannot run before every planned leaf completes",
                );
              }
              const leafUsage = leaves.flatMap((leaf) => leaf.usage);
              replaceStageUsage(state, "leaves", leafUsage);
              budget.assertCost(
                state.extraUsage,
                leafUsage,
                leaves.some((leaf) => leaf.threadId !== null),
                "leaf execution",
              );
              state.snapshot.result.plan = structuredClone(activePlan);
              state.snapshot.result.leaves = [...structuredClone(leaves)];
              this.#transition(state, "integrating");
              const aggregation = activePlan.integration.aggregation ?? "auto";
              const useDeterministicReducer =
                aggregation === "deterministic" ||
                (aggregation === "auto" && canAutomaticallyReduce(activePlan, leaves));
              const candidateCwd =
                useDeterministicReducer && !hasWorkspaceWriters(activePlan)
                  ? request.cwd
                  : ((await this.#workspace?.prepareValidation?.(runId, leaves)) ?? request.cwd);
              integrationState.candidateCwd = candidateCwd;
              const candidateRequest = {
                ...request,
                cwd: candidateCwd,
              };
              if (useDeterministicReducer) {
                state.integrationSkipped = true;
                integrationState.outcome = reduceLeafResults(activePlan, leaves);
                integrationState.triggers = [];
                state.snapshot.integratorThreadId = null;
                if (
                  integrationState.outcome.status === "completed" &&
                  integrationState.outcome.response !== null
                ) {
                  const validationSpecs = activePlan.integration.validation;
                  integrationState.validation =
                    validationSpecs.length === 0
                      ? []
                      : await runIntegrationValidation(
                          this.#validator,
                          validationSpecs,
                          candidateCwd,
                          signal,
                        );
                  integrationState.triggers.push(
                    ...integrationValidationTriggers(
                      activePlan,
                      integrationState.validation,
                      this.#now(),
                    ),
                  );
                } else {
                  integrationState.validation = null;
                }
                Object.assign(
                  schedulerLimits,
                  budget.remainingLimits(session.limits, state.extraUsage),
                );
                if (integrationState.triggers.length > 0) {
                  this.#transition(state, "running");
                }
                return integrationState.triggers;
              }
              const validationSpecs = activePlan.integration.validation;
              if (validationSpecs.length === 0) {
                integrationState.validation = [];
              } else {
                budget.assertAvailable("aggregate validation");
                integrationState.validation = await runIntegrationValidation(
                  this.#validator,
                  validationSpecs,
                  candidateCwd,
                  signal,
                );
                integrationState.triggers = integrationValidationTriggers(
                  activePlan,
                  integrationState.validation,
                  this.#now(),
                );
                if (integrationState.triggers.length > 0) {
                  Object.assign(
                    schedulerLimits,
                    budget.remainingLimits(session.limits, state.extraUsage),
                  );
                  this.#transition(state, "running");
                  return integrationState.triggers;
                }
              }
              budget.assertAvailable("Terra integration");
              const integrationReservation = this.#reserveNonLeafCost(
                state,
                budget,
                "integration",
                {
                  plan: activePlan,
                  leaves: compactLeafResults(leaves),
                },
              );
              const integrationStarted = this.#now();
              try {
                const waitingIntegration = integrationContinuation;
                if (waitingIntegration !== null) {
                  if (waitingIntegration.planId !== activePlan.planId) {
                    throw new AgentTrioServiceError(
                      "integration_resume_plan_mismatch",
                      "the waiting Terra integration does not match the active plan",
                    );
                  }
                  if (this.#integrator.resumeIntegration === undefined) {
                    throw new AgentTrioServiceError(
                      "integration_resume_unavailable",
                      "the persisted Terra integration thread cannot be continued by this runtime",
                    );
                  }
                  integrationState.outcome = await this.#integrator.resumeIntegration({
                    runId,
                    request: candidateRequest,
                    plan: activePlan,
                    leaves,
                    coordinatorThreadId: state.snapshot.coordinatorThreadId,
                    plannerThreadId: session.threadId,
                    signal,
                    continuation: waitingTurnContext(waitingIntegration.turn),
                    ...(recovery?.userInput === undefined ? {} : { userInput: recovery.userInput }),
                  });
                } else {
                  integrationState.outcome = await this.#integrator.integrate({
                    runId,
                    request: candidateRequest,
                    plan: activePlan,
                    leaves,
                    coordinatorThreadId: state.snapshot.coordinatorThreadId,
                    plannerThreadId: session.threadId,
                    signal,
                  });
                }
              } catch (error) {
                this.#settleFailedNonLeafCall(budget, integrationReservation, state.extraUsage);
                throw error;
              } finally {
                state.integrationMs += elapsedMs(integrationStarted, this.#now());
              }
              this.#throwIfAborted(signal);
              const outcome = integrationState.outcome;
              recordUsage(state, "integration", outcome.usage);
              budget.settle(integrationReservation, state.extraUsage, outcome.usage);
              state.snapshot.integratorThreadId = outcome.threadId;
              if (integrationContinuation !== null) {
                integrationContinuation = null;
                delete state.snapshot.waitingInputCheckpoint;
              }
              integrationState.triggers = integrationIssueTriggers(
                activePlan,
                outcome.planIssues ?? [],
                this.#now(),
              );
              if (outcome.status !== "completed" || outcome.response === null) {
                integrationState.validation = null;
              }
              Object.assign(
                schedulerLimits,
                budget.remainingLimits(session.limits, state.extraUsage),
              );
              if (integrationState.triggers.length > 0) {
                this.#transition(state, "running");
              }
              return integrationState.triggers;
            },
          };

    let workspacePrepared = false;
    let retainWorkspace = false;
    let workspaceDeferredForCommit = false;
    let schedulerStarted = false;
    let schedulerCompleted = false;
    let scheduled: ScheduleResult;
    const cleanupDeferredWorkspace = async (): Promise<void> => {
      if (!workspaceDeferredForCommit) {
        return;
      }
      workspaceDeferredForCommit = false;
      await this.#workspace?.cleanup(runId);
    };
    try {
      if (this.#workspace !== undefined) {
        if (recovery?.workspaceWritersMayHaveRun === true) {
          if (this.#workspace.resume === undefined) {
            throw new AgentTrioServiceError(
              "workspace_recovery_unavailable",
              "a workspace writer may have executed, but the workspace controller cannot resume persisted state",
            );
          }
          await this.#workspace.resume({
            runId,
            request,
            plan: session.plan,
            results: recovery.initialLeaves,
          });
          state.workspaceUncertain = false;
        } else {
          await this.#workspace.prepare({ runId, request, plan: session.plan });
        }
        workspacePrepared = true;
      }
      schedulerStarted = true;
      scheduled =
        recovery === undefined
          ? await this.#scheduler.execute(
              runId,
              session.plan,
              schedulerLimits,
              signal,
              replanHandler,
              completionInspector,
              undefined,
              request.hostAccess,
              request.hostApproval,
            )
          : await this.#scheduler.execute(
              runId,
              session.plan,
              schedulerLimits,
              signal,
              replanHandler,
              completionInspector,
              {
                initialResults: recovery.initialLeaves,
                ...(recovery.waitingInput?.kind === "leaves"
                  ? { waitingLeaves: recovery.waitingInput.leaves }
                  : {}),
                ...(recovery.userInput === undefined ? {} : { userInput: recovery.userInput }),
                patch: session.patch,
                replanCount: session.replanCount,
              },
              request.hostAccess,
              request.hostApproval,
            );
      schedulerCompleted = true;
      retainWorkspace = hasIndeterminateWriterSchedule(scheduled);
      const waitingPermissionLeaf = scheduled.leaves.some(
        (leaf) =>
          (leaf.status === "blocked" || leaf.status === "failed") &&
          leaf.failureKind === "permission",
      );
      if (
        hasWorkspaceWriters(scheduled.plan) &&
        (waitingPermissionLeaf || integrationState.outcome?.status === "waiting_input")
      ) {
        retainWorkspace = true;
      }
      if (
        !signal.aborted &&
        !retainWorkspace &&
        request.integrate !== false &&
        integrationState.outcome === null &&
        allPlanTasksCompleted(scheduled.plan, scheduled.leaves) &&
        completionInspector !== undefined
      ) {
        integrationState.triggers = [
          ...(await completionInspector.inspect(scheduled.plan, scheduled.leaves)),
        ];
      }
      workspaceDeferredForCommit =
        !signal.aborted &&
        !retainWorkspace &&
        allPlanTasksCompleted(scheduled.plan, scheduled.leaves) &&
        (request.integrate === false ||
          (integrationState.outcome?.status === "completed" &&
            integrationState.outcome.response !== null &&
            integrationState.triggers.length === 0));
    } finally {
      const persisted = this.#store.load(runId);
      if (persisted !== null) {
        state.snapshot.remoteTurns = mergeRemoteTurns(
          state.snapshot.remoteTurns,
          persisted.remoteTurns,
        );
      }
      if (
        signal.aborted &&
        (latestNonterminalRemoteTurns(state.snapshot.remoteTurns).some(
          (turn) => turn.access === "workspaceWrite",
        ) ||
          (schedulerStarted &&
            !schedulerCompleted &&
            session.plan.tasks.some((task) => task.access === "workspaceWrite")))
      ) {
        retainWorkspace = true;
      }
      state.workspaceUncertain ||= retainWorkspace;
      if (workspacePrepared && !retainWorkspace && !workspaceDeferredForCommit) {
        await this.#workspace?.cleanup(runId);
      }
    }
    state.snapshot.result.plan = structuredClone(scheduled.plan);
    state.snapshot.result.patch =
      scheduled.patch === null ? null : structuredClone(scheduled.patch);
    state.snapshot.result.leaves = structuredClone(scheduled.leaves);
    replaceStageUsage(state, "leaves", scheduled.usage);
    budget.assertCost(
      state.extraUsage,
      scheduled.usage,
      scheduled.leaves.some((leaf) => leaf.threadId !== null),
      "leaf execution",
    );
    const currentPlanner = this.#planner.getSession?.(session.threadId);
    if (currentPlanner !== null && currentPlanner !== undefined) {
      const plannerContinuationUsage = currentPlanner.usage.slice(
        plannerUsageBaseline + plannerAccounting.sessionUsageCount,
      );
      if (plannerContinuationUsage.length > 0) {
        recordUsage(state, "replan", plannerContinuationUsage);
        budget.assertCost(
          state.extraUsage,
          plannerContinuationUsage,
          scheduled.replanCount > 0,
          "Sol PlanPatch",
        );
      }
    }
    if (signal.aborted) {
      await cleanupDeferredWorkspace();
      const cancellationUnconfirmed =
        retainWorkspace || latestNonterminalRemoteTurns(state.snapshot.remoteTurns).length > 0;
      const budgetFailure = isBudgetFailure(signal.reason);
      return this.#finish(
        state,
        cancellationUnconfirmed ? "indeterminate" : budgetFailure ? "failed" : "cancelled",
        {
          error: cancellationUnconfirmed
            ? `${budgetFailure ? plainErrorMessage(signal.reason) : "run cancellation is unconfirmed"}; workspace and recovery state were preserved`
            : budgetFailure
              ? plainErrorMessage(signal.reason)
              : "run cancelled",
        },
        scheduled,
      );
    }

    const waitingLeaves = scheduled.leaves.filter(
      (leaf) =>
        (leaf.status === "blocked" || leaf.status === "failed") &&
        leaf.failureKind === "permission",
    );
    const waitingLeaf = waitingLeaves[0];
    if (waitingLeaf !== undefined) {
      this.#checkpointWaitingLeaves(state, scheduled.plan, waitingLeaves);
      return this.#finish(
        state,
        "waiting_input",
        {
          needsAction: waitingLeaf.error ?? waitingLeaf.summary,
          error: "leaf requires external permission or input",
        },
        scheduled,
      );
    }
    if (recovery?.waitingInput?.kind === "leaves") {
      delete state.snapshot.waitingInputCheckpoint;
    }
    const incomplete = scheduled.leaves.filter((leaf) => leaf.status !== "completed");
    if (incomplete.length > 0) {
      delete state.snapshot.waitingInputCheckpoint;
      const status: JobStatus = incomplete.some((leaf) => leaf.status === "indeterminate")
        ? "indeterminate"
        : incomplete.some((leaf) => leaf.status === "cancelled")
          ? "cancelled"
          : "failed";
      return this.#finish(state, status, { error: summarizeIncomplete(incomplete) }, scheduled);
    }

    if (request.integrate === false) {
      try {
        if (workspaceDeferredForCommit) {
          await this.#integrateWorkspace(state, scheduled.plan, scheduled.leaves);
        }
        delete state.snapshot.waitingInputCheckpoint;
        return this.#finish(
          state,
          "completed",
          { finalResponse: summarizeLeaves(scheduled.leaves) },
          scheduled,
        );
      } finally {
        await cleanupDeferredWorkspace();
      }
    }

    if (integrationState.outcome === null && completionInspector !== undefined) {
      integrationState.triggers = [
        ...(await completionInspector.inspect(scheduled.plan, scheduled.leaves)),
      ];
    }
    if (integrationState.triggers.length > 0) {
      const summaries = integrationState.triggers.map((trigger) => trigger.summary).join("; ");
      const onlyValidationFailures = integrationState.triggers.every(
        (trigger) => trigger.type === "validator_failure",
      );
      return this.#finish(
        state,
        "failed",
        {
          error: onlyValidationFailures
            ? `integration validation failed after the PlanPatch limit: ${summaries}`
            : `integration issues remain after the PlanPatch limit: ${summaries}`,
        },
        scheduled,
      );
    }
    const integrated = integrationState.outcome;
    if (integrated === null) {
      throw new AgentTrioServiceError(
        "integration_missing",
        "completed leaves did not produce a Terra integration outcome",
      );
    }
    if (integrated.status !== "completed" || integrated.response === null) {
      if (integrated.status === "waiting_input" && integrated.needsAction !== undefined) {
        this.#checkpointWaitingIntegration(
          state,
          scheduled,
          integrated.needsAction,
          integrated.waitingTurn,
        );
      } else {
        delete state.snapshot.waitingInputCheckpoint;
      }
      return this.#finishOutcome(state, integrated, scheduled);
    }
    try {
      const integrationValidation =
        integrationState.validation ??
        (await runIntegrationValidation(
          this.#validator,
          scheduled.plan.integration.validation,
          integrationState.candidateCwd ?? request.cwd,
          signal,
        ));
      let finalOutcome: AgentOutcome = { ...integrated, validation: integrationValidation };
      if (requiresFinalReview(scheduled, integrationValidation)) {
        if (this.#finalReviewer === undefined) {
          throw new AgentTrioServiceError(
            "review_unavailable",
            "the execution plan requires a Sol final review but no reviewer is configured",
          );
        }
        this.#checkpointIntegration(
          state,
          scheduled,
          integrated.response,
          integrationValidation,
          integrated.threadId,
        );
        const reviewReservation = this.#reserveNonLeafCost(state, budget, "final_review", {
          plan: scheduled.plan,
          leaves: compactLeafResults(scheduled.leaves),
          integratedResponse: integrated.response,
          integrationValidation,
        });
        let reviewed: Awaited<ReturnType<FinalReviewer["review"]>>;
        try {
          reviewed = await this.#finalReviewer.review({
            runId,
            request: {
              ...request,
              cwd: integrationState.candidateCwd ?? request.cwd,
            },
            plan: scheduled.plan,
            leaves: scheduled.leaves,
            coordinatorThreadId: state.snapshot.coordinatorThreadId,
            plannerThreadId: session.threadId,
            signal,
            integratedResponse: integrated.response,
            integrationValidation,
            integratorThreadId: integrated.threadId,
          });
        } catch (error) {
          this.#throwUncertainFinalReviewCall(budget, reviewReservation, state.extraUsage, error);
        }
        this.#throwIfAborted(signal);
        if (reviewed.threadId !== session.threadId) {
          throw new AgentTrioServiceError(
            "review_thread_mismatch",
            `final review used ${reviewed.threadId}, expected planner thread ${session.threadId}`,
          );
        }
        recordUsage(state, "finalReview", reviewed.usage);
        budget.settle(reviewReservation, state.extraUsage, reviewed.usage);
        if (reviewed.approved) {
          finalOutcome = { ...integrated, validation: integrationValidation };
        } else if (reviewed.replacementResponse !== undefined) {
          finalOutcome = {
            ...integrated,
            response: reviewed.replacementResponse,
            validation: integrationValidation,
          };
        } else {
          finalOutcome = {
            status: "failed",
            response: null,
            threadId: reviewed.threadId,
            usage: reviewed.usage,
            validation: integrationValidation,
            error: `Sol final review rejected the result: ${reviewed.issues.join("; ")}`,
          };
        }
      }
      const failedIntegrationValidation = integrationValidation.filter(
        (validation) => validation.status === "failed",
      );
      if (failedIntegrationValidation.length > 0) {
        await cleanupDeferredWorkspace();
        delete state.snapshot.integrationCheckpoint;
        return this.#finish(
          state,
          "failed",
          {
            error: `integration validation failed: ${failedIntegrationValidation
              .map((validation) => `${validation.command}: ${validation.summary}`)
              .join("; ")}`,
          },
          scheduled,
        );
      }
      if (
        workspaceDeferredForCommit &&
        finalOutcome.status === "completed" &&
        finalOutcome.response !== null
      ) {
        await this.#integrateWorkspace(state, scheduled.plan, scheduled.leaves);
      }
      await cleanupDeferredWorkspace();
      delete state.snapshot.integrationCheckpoint;
      return this.#finishOutcome(state, finalOutcome, scheduled);
    } catch (error) {
      if (error instanceof UncertainFinalReviewError) {
        if (hasWorkspaceWriters(state.snapshot.result.plan ?? session.plan)) {
          state.workspaceUncertain = true;
        } else {
          try {
            await cleanupDeferredWorkspace();
          } catch {
            state.workspaceUncertain = true;
          }
        }
        throw error;
      }
      await cleanupDeferredWorkspace();
      delete state.snapshot.integrationCheckpoint;
      throw error;
    }
  }

  #checkpointIntegration(
    state: MutableRunState,
    scheduled: ScheduleResult,
    response: string,
    validation: readonly ValidationResult[],
    integratorThreadId: string | null,
  ): void {
    state.snapshot.integrationCheckpoint = {
      planId: scheduled.plan.planId,
      leafIdentities: scheduled.leaves.map((leaf) => ({
        taskId: leaf.taskId,
        threadId: leaf.threadId,
        turnId: leaf.turnId,
        completedAt: leaf.completedAt,
      })),
      response,
      validation: structuredClone([...validation]),
      integratorThreadId,
      launchSkewMs: scheduled.launchSkewMs,
      peakConcurrency: scheduled.peakConcurrency,
      replanCount: scheduled.replanCount,
      updatedAt: this.#now().toISOString(),
    };
    state.snapshot.updatedAt = state.snapshot.integrationCheckpoint.updatedAt;
    this.#checkpointState(state);
    this.#save(state.snapshot, "integration_checkpointed");
  }

  #checkpointWaitingTurn(
    state: MutableRunState,
    kind: "admission" | "direct",
    needsAction: string,
    turn: WaitingTurnContext | undefined,
  ): void {
    if (turn === undefined) {
      delete state.snapshot.waitingInputCheckpoint;
      return;
    }
    const updatedAt = this.#now().toISOString();
    state.snapshot.waitingInputCheckpoint = {
      kind,
      turn: {
        threadId: turn.threadId,
        previousTurnId: turn.previousTurnId,
        cwd: turn.cwd,
        needsAction,
        capabilities: structuredClone(turn.capabilities),
        updatedAt,
      },
    };
    this.#persistWaitingCheckpoint(state, needsAction, updatedAt);
  }

  #checkpointWaitingLeaves(
    state: MutableRunState,
    plan: ExecutionPlan,
    leaves: readonly LeafResult[],
  ): void {
    const points = leaves.map((leaf) => {
      if (leaf.threadId === null || leaf.turnId === null) {
        return null;
      }
      const ref = state.snapshot.remoteTurns
        .filter(
          (candidate) =>
            candidate.role === "leaf" &&
            candidate.taskId === leaf.taskId &&
            candidate.threadId === leaf.threadId &&
            candidate.turnId === leaf.turnId &&
            candidate.state === "terminal",
        )
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      if (ref === undefined) {
        return null;
      }
      return {
        taskId: leaf.taskId,
        threadId: leaf.threadId,
        previousTurnId: leaf.turnId,
        attempt: ref.attempt ?? 1,
        needsAction: leaf.error ?? leaf.summary,
      };
    });
    if (points.some((point) => point === null)) {
      delete state.snapshot.waitingInputCheckpoint;
      return;
    }
    const updatedAt = this.#now().toISOString();
    state.snapshot.waitingInputCheckpoint = {
      kind: "leaves",
      planId: plan.planId,
      leaves: points.filter((point): point is NonNullable<typeof point> => point !== null),
      updatedAt,
    };
    this.#persistWaitingCheckpoint(state, points[0]!.needsAction, updatedAt);
  }

  #checkpointWaitingIntegration(
    state: MutableRunState,
    scheduled: ScheduleResult,
    needsAction: string,
    turn: WaitingTurnContext | undefined,
  ): void {
    if (turn === undefined) {
      delete state.snapshot.waitingInputCheckpoint;
      return;
    }
    const updatedAt = this.#now().toISOString();
    state.snapshot.waitingInputCheckpoint = {
      kind: "integration",
      planId: scheduled.plan.planId,
      turn: {
        threadId: turn.threadId,
        previousTurnId: turn.previousTurnId,
        cwd: turn.cwd,
        needsAction,
        capabilities: structuredClone(turn.capabilities),
        updatedAt,
      },
      leafIdentities: scheduled.leaves.map((leaf) => ({
        taskId: leaf.taskId,
        threadId: leaf.threadId,
        turnId: leaf.turnId,
        completedAt: leaf.completedAt,
      })),
    };
    this.#persistWaitingCheckpoint(state, needsAction, updatedAt);
  }

  #persistWaitingCheckpoint(state: MutableRunState, needsAction: string, updatedAt: string): void {
    state.snapshot.result.status = "waiting_input";
    state.snapshot.result.finalResponse = null;
    state.snapshot.result.needsAction = needsAction;
    state.snapshot.updatedAt = updatedAt;
    this.#checkpointState(state);
    this.#save(state.snapshot, "waiting_input_checkpointed");
  }

  async #resumeFinalReview(
    state: MutableRunState,
    session: PlannerSession,
    continuation: NonNullable<ReattachResult["continuation"]>,
    signal: AbortSignal,
    budget: ServiceBudget,
  ): Promise<BatchResult> {
    const checkpoint = continuation.finalReview;
    if (checkpoint === undefined) {
      throw new AgentTrioServiceError(
        "invalid_recovery_state",
        "final-review recovery is missing its integration checkpoint",
      );
    }
    if (this.#finalReviewer === undefined) {
      throw new AgentTrioServiceError(
        "review_unavailable",
        "the recovered execution requires a Sol final review but no reviewer is configured",
      );
    }
    if (continuation.initialLeaves.some((leaf) => leaf.status !== "completed")) {
      throw new AgentTrioServiceError(
        "invalid_recovery_state",
        "final-review recovery requires every planned leaf to be complete",
      );
    }

    const { request } = state.snapshot;
    const runId = state.snapshot.result.runId;
    const scheduled: ScheduleResult = {
      plan: structuredClone(session.plan),
      patch: session.patch === null ? null : structuredClone(session.patch),
      leaves: structuredClone(continuation.initialLeaves),
      launchSkewMs: checkpoint.launchSkewMs,
      peakConcurrency: checkpoint.peakConcurrency,
      replanCount: checkpoint.replanCount,
      usage: continuation.initialLeaves.flatMap((leaf) => structuredClone(leaf.usage)),
    };
    let workspaceAttached = false;
    try {
      if (continuation.workspaceWritersMayHaveRun) {
        await this.#workspace!.resume!({
          runId,
          request,
          plan: session.plan,
          results: continuation.initialLeaves,
        });
        workspaceAttached = true;
        state.workspaceUncertain = false;
      }
      const candidateCwd = continuation.workspaceWritersMayHaveRun
        ? ((await this.#workspace?.prepareValidation?.(runId, continuation.initialLeaves)) ??
          request.cwd)
        : request.cwd;
      const reviewReservation = this.#reserveNonLeafCost(state, budget, "final_review", {
        plan: session.plan,
        leaves: compactLeafResults(continuation.initialLeaves),
        integratedResponse: checkpoint.integratedResponse,
        integrationValidation: checkpoint.integrationValidation,
      });
      let reviewed: Awaited<ReturnType<FinalReviewer["review"]>>;
      try {
        reviewed = await this.#finalReviewer.review({
          runId,
          request: { ...request, cwd: candidateCwd },
          plan: session.plan,
          leaves: continuation.initialLeaves,
          coordinatorThreadId: state.snapshot.coordinatorThreadId,
          plannerThreadId: session.threadId,
          signal,
          integratedResponse: checkpoint.integratedResponse,
          integrationValidation: checkpoint.integrationValidation,
          integratorThreadId: checkpoint.integratorThreadId,
        });
      } catch (error) {
        this.#throwUncertainFinalReviewCall(budget, reviewReservation, state.extraUsage, error);
      }
      this.#throwIfAborted(signal);
      if (reviewed.threadId !== session.threadId) {
        throw new AgentTrioServiceError(
          "review_thread_mismatch",
          `final review used ${reviewed.threadId}, expected planner thread ${session.threadId}`,
        );
      }
      recordUsage(state, "finalReview", reviewed.usage);
      budget.settle(reviewReservation, state.extraUsage, reviewed.usage);

      let finalOutcome: AgentOutcome;
      if (reviewed.approved) {
        finalOutcome = {
          status: "completed",
          response: checkpoint.integratedResponse,
          threadId: checkpoint.integratorThreadId,
          usage: [],
          validation: checkpoint.integrationValidation,
        };
      } else if (reviewed.replacementResponse !== undefined) {
        finalOutcome = {
          status: "completed",
          response: reviewed.replacementResponse,
          threadId: reviewed.threadId,
          usage: [],
          validation: checkpoint.integrationValidation,
        };
      } else {
        finalOutcome = {
          status: "failed",
          response: null,
          threadId: reviewed.threadId,
          usage: [],
          validation: checkpoint.integrationValidation,
          error: `Sol final review rejected the result: ${reviewed.issues.join("; ")}`,
        };
      }

      const failedIntegrationValidation = checkpoint.integrationValidation.filter(
        (validation) => validation.status === "failed",
      );
      if (failedIntegrationValidation.length > 0) {
        if (workspaceAttached) {
          await this.#workspace!.cleanup(runId);
          workspaceAttached = false;
        }
        delete state.snapshot.integrationCheckpoint;
        return this.#finish(
          state,
          "failed",
          {
            error: `integration validation failed: ${failedIntegrationValidation
              .map((validation) => `${validation.command}: ${validation.summary}`)
              .join("; ")}`,
          },
          scheduled,
        );
      }

      if (
        continuation.workspaceWritersMayHaveRun &&
        finalOutcome.status === "completed" &&
        finalOutcome.response !== null
      ) {
        await this.#integrateWorkspace(state, session.plan, continuation.initialLeaves);
      }
      if (workspaceAttached) {
        await this.#workspace!.cleanup(runId);
        workspaceAttached = false;
      }
      delete state.snapshot.integrationCheckpoint;
      return this.#finishOutcome(state, finalOutcome, scheduled);
    } catch (error) {
      if (error instanceof UncertainFinalReviewError) {
        state.workspaceUncertain ||= continuation.workspaceWritersMayHaveRun;
        throw error;
      }
      if (workspaceAttached) {
        try {
          await this.#workspace!.cleanup(runId);
        } catch {
          state.workspaceUncertain = true;
        }
      }
      throw error;
    }
  }

  async #integrateWorkspace(
    state: MutableRunState,
    plan: ExecutionPlan,
    leaves: readonly LeafResult[],
  ): Promise<void> {
    if (this.#workspace === undefined) {
      return;
    }
    await this.#workspace.integrate(state.snapshot.result.runId, leaves);
    if (!hasWorkspaceWriters(plan)) {
      return;
    }
    state.snapshot.workspaceCommitState = "applied";
    state.snapshot.updatedAt = this.#now().toISOString();
    this.#checkpointState(state);
    this.#save(state.snapshot, "workspace_applied");
  }

  #checkpointingReplanHandler(
    state: MutableRunState,
    threadId: string,
    handler: ReplanHandler | undefined,
    budget: ServiceBudget,
    plannerUsageBaseline: number,
    accounting: { sessionUsageCount: number },
  ): ReplanHandler | undefined {
    if (handler === undefined) {
      return undefined;
    }
    const checkpoint = (): void => {
      const current = this.#planner.getSession?.(threadId);
      if (current === null || current === undefined) {
        return;
      }
      state.snapshot.plannerSession = structuredClone(current);
      state.snapshot.plannerThreadId = current.continuationThreadId ?? current.threadId;
      state.snapshot.result.plan = structuredClone(current.plan);
      state.snapshot.result.patch = current.patch === null ? null : structuredClone(current.patch);
      if (hasWorkspaceWriters(current.plan) && state.snapshot.workspaceCommitState !== "applied") {
        state.snapshot.workspaceCommitState = "pending";
      }
      this.#checkpointState(state);
      this.#save(state.snapshot, "planner_session");
    };
    const call = async <T>(
      stage: "plan_patch" | "planner_answer",
      context: unknown,
      results: readonly LeafResult[],
      operation: () => Promise<T>,
    ): Promise<T> => {
      const resultUsage = results.flatMap((result) => result.usage);
      const uncheckpointedResultUsage = state.usageByStage.leaves.length === 0 ? resultUsage : [];
      const reservation = this.#reserveNonLeafCost(
        state,
        budget,
        stage,
        context,
        uncheckpointedResultUsage,
      );
      try {
        const value = await operation();
        const current = this.#planner.getSession?.(threadId);
        const usage =
          current === null || current === undefined
            ? []
            : current.usage.slice(plannerUsageBaseline + accounting.sessionUsageCount);
        accounting.sessionUsageCount += usage.length;
        recordUsage(state, "replan", usage);
        budget.settle(reservation, [...state.extraUsage, ...uncheckpointedResultUsage], usage);
        checkpoint();
        return value;
      } catch (error) {
        const current = this.#planner.getSession?.(threadId);
        const sessionUsage =
          current === null || current === undefined
            ? []
            : current.usage.slice(plannerUsageBaseline + accounting.sessionUsageCount);
        accounting.sessionUsageCount += sessionUsage.length;
        const failureUsage = plannerFailureDetails(error)?.usage ?? [];
        const usage = sessionUsage.length > 0 ? sessionUsage : failureUsage;
        if (usage.length > 0) {
          recordUsage(state, "replan", usage);
          budget.settle(reservation, [...state.extraUsage, ...uncheckpointedResultUsage], usage);
          checkpoint();
        } else {
          this.#settleFailedNonLeafCall(budget, reservation, [
            ...state.extraUsage,
            ...uncheckpointedResultUsage,
          ]);
        }
        throw error;
      }
    };
    return {
      replan: (plan, triggers, results) =>
        call("plan_patch", { plan, triggers, results: compactLeafResults(results) }, results, () =>
          handler.replan(plan, triggers, results),
        ),
      answer: (message, results) =>
        call("planner_answer", { message, results: compactLeafResults(results) }, results, () =>
          handler.answer(message, results),
        ),
    };
  }

  async #resumeLocked(
    snapshot: JobSnapshot,
    signal: AbortSignal,
    userInput: string | undefined,
  ): Promise<BatchResult> {
    const budget = createServiceBudget(
      snapshot.request,
      snapshotStartedAt(snapshot, this.#now()),
      signal,
      this.#now,
    );
    try {
      budget.assertAvailable("recovery reattachment");
      reconcileCheckpointedRemoteUsage(snapshot, true);
      const unaccountedTurns = unaccountedNonLeafTurns(snapshot);
      if (snapshot.request.limits?.maxCostUsd !== undefined && unaccountedTurns.length > 0) {
        throw new AgentTrioServiceError(
          "cost_accounting_unavailable",
          `recovery cannot account for remote turns under maxCostUsd=${snapshot.request.limits.maxCostUsd}: ${unaccountedTurns.join(", ")}`,
        );
      }
      const persistedUsage = usageForSnapshot(snapshot);
      budget.assertCost(persistedUsage, [], false, "persisted run");
      const recovered = await this.#recovery!.reattach({
        snapshot: cloneSnapshot(snapshot),
        signal: budget.signal,
      });
      validateRecoveredResult(snapshot, recovered.result);
      assertRecoveredWorkspaceCommitted(snapshot, recovered.result);
      snapshot.result = cloneResult(recovered.result);
      snapshot.coordinatorThreadId =
        recovered.coordinatorThreadId === undefined
          ? snapshot.coordinatorThreadId
          : recovered.coordinatorThreadId;
      snapshot.plannerThreadId =
        recovered.plannerThreadId === undefined
          ? snapshot.plannerThreadId
          : recovered.plannerThreadId;
      snapshot.integratorThreadId =
        recovered.integratorThreadId === undefined
          ? snapshot.integratorThreadId
          : recovered.integratorThreadId;
      const recoveredAt = this.#now();
      snapshot.updatedAt = recoveredAt.toISOString();
      if (recovered.continuation === undefined) {
        snapshot.result.metrics = finishSnapshotMetrics(snapshot, snapshot.result, recoveredAt);
        checkpointFinishedMetrics(snapshot, snapshot.result.metrics);
        this.#save(snapshot, `resumed:${snapshot.result.status}`);
        return cloneResult(snapshot.result);
      }

      const waitingInput = recovered.continuation.waitingInput;
      if (
        waitingInput !== undefined &&
        (waitingInput.kind === "admission" || waitingInput.kind === "direct")
      ) {
        snapshot.result.status = "running";
        snapshot.result.finalResponse = null;
        delete snapshot.result.needsAction;
        delete snapshot.result.error;
        const state = recoveredWaitingRunState(snapshot, this.#now());
        this.#transition(state, "running");
        try {
          return await this.#resumeCoordinatorWaiting(
            state,
            waitingInput,
            userInput,
            budget.signal,
            budget,
          );
        } catch (error) {
          return this.#finishError(state, error, signal);
        }
      }

      const plannerState = plannerSessionForSnapshot(snapshot);
      if (plannerState === null || this.#planner.restoreSession === undefined) {
        throw new AgentTrioServiceError(
          "planner_recovery_unavailable",
          `run ${snapshot.result.runId} has no restorable planner session`,
        );
      }
      const session = this.#planner.restoreSession(plannerState);
      snapshot.plannerSession = structuredClone(session);
      snapshot.plannerThreadId = session.continuationThreadId ?? session.threadId;
      // A recovered admission thread may belong to a dead App Server process. Starting a fresh
      // read-only Terra integration turn is cheaper than risking an invalid continuation or replay.
      snapshot.coordinatorThreadId = null;
      snapshot.result.status = "running";
      snapshot.result.finalResponse = null;
      delete snapshot.result.needsAction;
      delete snapshot.result.error;
      const state = recoveredRunState(
        snapshot,
        session,
        this.#now(),
        recovered.continuation.finalReview !== undefined
          ? "final_review"
          : waitingInput?.kind === "integration"
            ? "waiting_integration"
            : waitingInput?.kind === "leaves"
              ? "waiting_leaves"
              : "schedule",
      );
      state.workspaceUncertain = recovered.continuation.workspaceWritersMayHaveRun;
      this.#transition(state, "running");

      if (
        recovered.continuation.workspaceWritersMayHaveRun &&
        (this.#workspace === undefined || this.#workspace.resume === undefined)
      ) {
        recordUsage(
          state,
          "leaves",
          recovered.continuation.initialLeaves.flatMap((leaf) => leaf.usage),
        );
        return this.#finish(state, "indeterminate", {
          error:
            "a workspace writer may have executed, but the workspace controller has no persistent recovery capability",
        });
      }

      try {
        if (recovered.continuation.finalReview !== undefined) {
          return await this.#resumeFinalReview(
            state,
            session,
            recovered.continuation,
            budget.signal,
            budget,
          );
        }
        return await this.#continueFanout(state, session, budget.signal, budget, {
          initialLeaves: recovered.continuation.initialLeaves,
          workspaceWritersMayHaveRun: recovered.continuation.workspaceWritersMayHaveRun,
          ...(recovered.continuation.waitingInput === undefined
            ? {}
            : { waitingInput: recovered.continuation.waitingInput }),
          ...(userInput === undefined ? {} : { userInput }),
        });
      } catch (error) {
        return this.#finishError(state, error, signal);
      }
    } finally {
      budget.dispose();
    }
  }

  async #resumeCoordinatorWaiting(
    state: MutableRunState,
    checkpoint: Extract<WaitingInputCheckpoint, { kind: "admission" | "direct" }>,
    userInput: string | undefined,
    signal: AbortSignal,
    budget: ServiceBudget,
  ): Promise<BatchResult> {
    const { request } = state.snapshot;
    const runId = state.snapshot.result.runId;
    const continuation = waitingTurnContext(checkpoint.turn);
    if (checkpoint.kind === "admission") {
      if (this.#admission.resumeAdmission === undefined) {
        throw new AgentTrioServiceError(
          "admission_resume_unavailable",
          "the persisted Terra admission thread cannot be continued by this runtime",
        );
      }
      const reservation = this.#reserveNonLeafCost(state, budget, "admission", {
        objective: request.objective,
        continuation: checkpoint.turn.previousTurnId,
        userInput: userInput ?? null,
      });
      let decision: Awaited<ReturnType<NonNullable<AdmissionController["resumeAdmission"]>>>;
      try {
        decision = await this.#admission.resumeAdmission({
          runId,
          request,
          continuation,
          ...(userInput === undefined ? {} : { userInput }),
          signal,
        });
      } catch (error) {
        this.#settleFailedNonLeafCall(budget, reservation, state.extraUsage);
        throw error;
      }
      this.#throwIfAborted(signal);
      const usage = decision.usage ?? [];
      recordUsage(state, "admission", usage);
      budget.settle(reservation, state.extraUsage, usage);
      return this.#executeAdmissionDecision(state, decision, signal, budget);
    }

    if (this.#directExecutor.resumeDirect === undefined) {
      throw new AgentTrioServiceError(
        "direct_resume_unavailable",
        "the persisted direct thread cannot be continued by this runtime",
      );
    }
    const reservation = this.#reserveNonLeafCost(state, budget, "direct", {
      objective: request.objective,
      continuation: checkpoint.turn.previousTurnId,
      userInput: userInput ?? null,
    });
    let outcome: AgentOutcome;
    try {
      outcome = await this.#directExecutor.resumeDirect({
        runId,
        request,
        continuation,
        ...(userInput === undefined ? {} : { userInput }),
        signal,
      });
    } catch (error) {
      this.#settleFailedNonLeafCall(budget, reservation, state.extraUsage);
      throw error;
    }
    this.#throwIfAborted(signal);
    recordUsage(state, "direct", outcome.usage);
    budget.settle(reservation, state.extraUsage, outcome.usage);
    state.snapshot.integratorThreadId = outcome.threadId;
    if (outcome.status === "waiting_input" && outcome.needsAction !== undefined) {
      this.#checkpointWaitingTurn(state, "direct", outcome.needsAction, outcome.waitingTurn);
    } else {
      delete state.snapshot.waitingInputCheckpoint;
    }
    return this.#finishOutcome(state, outcome);
  }

  #finishRecoveryError(snapshot: JobSnapshot, error: unknown, signal: AbortSignal): BatchResult {
    const persisted = this.#store.load(snapshot.result.runId);
    if (persisted !== null) {
      snapshot.remoteTurns = mergeRemoteTurns(snapshot.remoteTurns, persisted.remoteTurns);
    }
    const completedAt = this.#now();
    const waiting = error instanceof WaitingInputError;
    const budgetFailure = isBudgetFailure(error);
    const writerUncertain = latestNonterminalRemoteTurns(snapshot.remoteTurns).some(
      (turn) => turn.access === "workspaceWrite",
    );
    const cancellationUnconfirmed =
      signal.aborted && latestNonterminalRemoteTurns(snapshot.remoteTurns).length > 0;
    const unfinished: BatchResult = {
      ...cloneResult(snapshot.result),
      status: signal.aborted
        ? cancellationUnconfirmed
          ? "indeterminate"
          : "cancelled"
        : waiting
          ? "waiting_input"
          : budgetFailure && !writerUncertain
            ? "failed"
            : "indeterminate",
      finalResponse: null,
      metrics: null,
      ...(waiting ? { needsAction: error.needsAction } : {}),
      error: errorMessage(error, signal),
    };
    const metrics = finishSnapshotMetrics(snapshot, unfinished, completedAt);
    const result: BatchResult = { ...unfinished, metrics };
    checkpointFinishedMetrics(snapshot, metrics);
    const next = { ...snapshot, result, updatedAt: completedAt.toISOString() };
    this.#save(next, result.status);
    return cloneResult(result);
  }

  #finishError(state: MutableRunState, error: unknown, signal: AbortSignal): BatchResult {
    if (error instanceof WaitingInputError) {
      return this.#finish(state, "waiting_input", {
        needsAction: error.needsAction,
        error: error.message,
      });
    }
    const persisted = this.#store.load(state.snapshot.result.runId);
    if (persisted !== null) {
      state.snapshot.remoteTurns = mergeRemoteTurns(
        state.snapshot.remoteTurns,
        persisted.remoteTurns,
      );
    }
    const remoteStageUncertain = error instanceof UncertainFinalReviewError;
    const cancellationUnconfirmed =
      signal.aborted &&
      (remoteStageUncertain ||
        state.workspaceUncertain ||
        latestNonterminalRemoteTurns(state.snapshot.remoteTurns).length > 0);
    return this.#finish(
      state,
      signal.aborted
        ? cancellationUnconfirmed
          ? "indeterminate"
          : "cancelled"
        : remoteStageUncertain || state.workspaceUncertain
          ? "indeterminate"
          : "failed",
      {
        error: cancellationUnconfirmed
          ? "run cancellation is unconfirmed; workspace and recovery state were preserved"
          : errorMessage(error, signal),
      },
    );
  }

  #finishOutcome(
    state: MutableRunState,
    outcome: AgentOutcome,
    scheduled?: ScheduleResult,
  ): BatchResult {
    if (outcome.status === "completed" && outcome.response === null) {
      return this.#finish(
        state,
        "failed",
        { error: "agent completed without a user-facing response" },
        scheduled,
      );
    }
    return this.#finish(
      state,
      outcome.status,
      {
        ...(outcome.response === null ? {} : { finalResponse: outcome.response }),
        ...(outcome.needsAction === undefined ? {} : { needsAction: outcome.needsAction }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
      scheduled,
    );
  }

  #finish(
    state: MutableRunState,
    status: JobStatus,
    details: { finalResponse?: string; needsAction?: string; error?: string },
    scheduled?: ScheduleResult,
  ): BatchResult {
    const completedAt = this.#now();
    const usage = state.extraUsage;
    const selectedPlan = scheduled?.plan ?? state.snapshot.result.plan;
    const result: BatchResult = {
      ...state.snapshot.result,
      status,
      finalResponse: details.finalResponse ?? null,
      metrics: {
        profile: state.snapshot.request.profile ?? "balanced",
        startedAt: state.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        elapsedMs: elapsedMs(state.startedAt, completedAt),
        planningMs: state.planningMs,
        integrationMs: state.integrationMs,
        launchSkewMs: scheduled?.launchSkewMs ?? null,
        peakConcurrency: scheduled?.peakConcurrency ?? 0,
        replanCount: scheduled?.replanCount ?? 0,
        userInterventionCount: status === "waiting_input" ? 1 : 0,
        usage: structuredClone(usage),
        estimatedCostUsd: sumCost(usage),
        ...(state.routeReason === undefined ? {} : { routeReason: state.routeReason }),
        ...(state.selectedLeafCount !== undefined
          ? { selectedLeafCount: state.selectedLeafCount }
          : scheduled === undefined
            ? {}
            : { selectedLeafCount: scheduled.plan.tasks.length }),
        ...(state.plannerSkipped === undefined ? {} : { plannerSkipped: state.plannerSkipped }),
        ...(state.integrationSkipped === undefined
          ? {}
          : { integrationSkipped: state.integrationSkipped }),
        ...(state.estimatedDirectCostUsd === undefined
          ? {}
          : { estimatedDirectCostUsd: state.estimatedDirectCostUsd }),
        ...(state.estimatedFanoutCostUsd === undefined
          ? {}
          : { estimatedFanoutCostUsd: state.estimatedFanoutCostUsd }),
        ...(state.routeSource === undefined ? {} : { routeSource: state.routeSource }),
        ...(selectedPlan === null
          ? state.snapshot.request.domain === undefined
            ? {}
            : { selectedDomain: state.snapshot.request.domain }
          : {
              selectedDomain: selectedPlan.domain,
              selectedWaveCount: planWaveCount(selectedPlan),
              selectedTierCounts: planTierCounts(selectedPlan),
              estimatedSerialSeconds: planSerialSeconds(selectedPlan),
              estimatedCriticalPathSeconds: planCriticalPathSeconds(selectedPlan),
            }),
        ...(state.estimatedDirectSeconds === undefined
          ? {}
          : { estimatedDirectSeconds: state.estimatedDirectSeconds }),
        ...(state.estimatedFanoutSeconds === undefined
          ? {}
          : { estimatedFanoutSeconds: state.estimatedFanoutSeconds }),
        ...optionalRatio(
          "estimatedCostRatio",
          state.estimatedFanoutCostUsd,
          state.estimatedDirectCostUsd,
        ),
        ...optionalRatio(
          "estimatedLatencyRatio",
          state.estimatedFanoutSeconds,
          state.estimatedDirectSeconds,
        ),
        ...optionalRatio(
          "predictionCostErrorRatio",
          sumCost(usage),
          selectedPlan === null ? state.estimatedDirectCostUsd : state.estimatedFanoutCostUsd,
        ),
        ...optionalRatio(
          "predictionLatencyErrorRatio",
          elapsedMs(state.startedAt, completedAt) / 1_000,
          selectedPlan === null ? state.estimatedDirectSeconds : state.estimatedFanoutSeconds,
        ),
        usageByStage: materializeUsageByStage(state.usageByStage),
      },
      ...(details.needsAction === undefined ? {} : { needsAction: details.needsAction }),
      ...(details.error === undefined ? {} : { error: details.error }),
    };
    if (details.needsAction === undefined) {
      delete result.needsAction;
    }
    if (details.error === undefined) {
      delete result.error;
    }
    state.snapshot.result = result;
    state.snapshot.updatedAt = completedAt.toISOString();
    this.#checkpointState(state);
    this.#save(state.snapshot, status);
    return cloneResult(result);
  }

  #transition(state: MutableRunState, status: JobStatus): void {
    state.snapshot.result.status = status;
    state.snapshot.updatedAt = this.#now().toISOString();
    this.#checkpointState(state);
    this.#save(state.snapshot, status);
  }

  #checkpointState(state: MutableRunState): void {
    state.snapshot.startedAt = state.startedAt.toISOString();
    state.snapshot.planningMs = state.planningMs;
    state.snapshot.integrationMs = state.integrationMs;
    state.snapshot.usageByStage = materializeUsageByStage(state.usageByStage);
  }

  #findExisting(runId: string, request: RunRequest): JobSnapshot | null {
    const snapshot = this.#store.load(runId);
    if (snapshot !== null) {
      assertMatchingRequest(snapshot, request);
    }
    return snapshot;
  }

  #requireSnapshot(runId: string): JobSnapshot {
    const snapshot = this.#store.load(runId);
    if (snapshot === null) {
      throw new AgentTrioServiceError("run_not_found", `unknown runId: ${runId}`);
    }
    return snapshot;
  }

  #resultForUser(result: BatchResult): BatchResult {
    const copy = cloneResult(result);
    const monitorUrl = copy.monitorUrl ?? this.#monitorUrlForRun?.(copy.runId);
    if (monitorUrl !== undefined) {
      copy.monitorUrl = monitorUrl;
    }
    return copy;
  }

  #save(snapshot: JobSnapshot, event: string): void {
    const persisted = this.#store.load(snapshot.result.runId);
    if (persisted !== null) {
      snapshot.remoteTurns = mergeRemoteTurns(snapshot.remoteTurns, persisted.remoteTurns);
    }
    reconcileCheckpointedRemoteUsage(snapshot, false);
    this.#store.save(cloneSnapshot(snapshot));
    this.#store.appendEvent(snapshot.result.runId, {
      type: event,
      at: snapshot.updatedAt,
    });
  }

  #watchCancellation(runId: string, controller: AbortController): () => void {
    const check = (): void => {
      if (!cancellationRequested(this.#store, runId)) {
        return;
      }
      if (!controller.signal.aborted) {
        controller.abort(new Error("run cancelled"));
      }
      clearCancellationRequest(this.#store, runId);
    };
    check();
    const timer = setInterval(check, this.#controlPollMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("run cancelled");
    }
  }
}

interface ServiceBudget {
  signal: AbortSignal;
  costLimited: boolean;
  dispose(): void;
  assertAvailable(stage: string): void;
  reserve(
    totalUsage: readonly ModelUsage[],
    stage: string,
    estimatedCostUsd: number | null,
  ): CostReservation;
  settle(
    reservation: CostReservation,
    totalUsage: readonly ModelUsage[],
    stageUsage: readonly ModelUsage[],
  ): void;
  release(reservation: CostReservation): void;
  assertCost(
    totalUsage: readonly ModelUsage[],
    stageUsage: readonly ModelUsage[],
    remoteTurn: boolean,
    stage: string,
  ): void;
  remainingLimits(limits: ExecutionLimits, totalUsage: readonly ModelUsage[]): ExecutionLimits;
}

interface CostReservation {
  id: symbol;
  stage: string;
  estimatedCostUsd: number;
  active: boolean;
}

function createServiceBudget(
  request: RunRequest,
  startedAt: Date,
  parentSignal: AbortSignal,
  now: () => Date,
): ServiceBudget {
  const deadlineMs = request.limits?.deadlineMs;
  const deadlineAt = deadlineMs === undefined ? null : startedAt.getTime() + deadlineMs;
  const maxCostUsd = request.limits?.maxCostUsd;
  const reservations = new Map<symbol, CostReservation>();
  const controller = new AbortController();
  let costFailure: AgentTrioServiceError | null = null;
  const abortFromParent = (): void => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  let timer: NodeJS.Timeout | null = null;
  if (deadlineAt !== null && !controller.signal.aborted) {
    const remaining = deadlineAt - now().getTime();
    const deadlineError = new AgentTrioServiceError(
      "deadline_exceeded",
      `run deadline of ${deadlineMs}ms exceeded`,
    );
    if (remaining <= 0) {
      controller.abort(deadlineError);
    } else {
      timer = setTimeout(() => controller.abort(deadlineError), remaining);
      timer.unref();
    }
  }

  const assertAvailable = (stage: string): void => {
    if (costFailure !== null) {
      throw costFailure;
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new AgentTrioServiceError("deadline_exceeded", `run budget expired before ${stage}`);
    }
    if (maxCostUsd === 0) {
      return failCost("cost_budget_exceeded", `maxCostUsd=0 leaves no budget for ${stage}`);
    }
  };

  const failCost = (code: string, message: string): never => {
    const error = new AgentTrioServiceError(code, message);
    costFailure ??= error;
    throw error;
  };

  const accountedCost = (usage: readonly ModelUsage[], stage: string): number => {
    const cost = sumCost(usage);
    if (cost === null) {
      return failCost(
        "cost_accounting_unavailable",
        `${stage} returned usage without a USD cost under maxCostUsd=${maxCostUsd}`,
      );
    }
    return cost;
  };

  const activeReservationCost = (): number =>
    [...reservations.values()].reduce(
      (total, reservation) => total + reservation.estimatedCostUsd,
      0,
    );

  const release = (reservation: CostReservation): void => {
    if (!reservation.active) {
      return;
    }
    reservations.delete(reservation.id);
    reservation.active = false;
  };

  return {
    signal: controller.signal,
    costLimited: maxCostUsd !== undefined,
    dispose: () => {
      parentSignal.removeEventListener("abort", abortFromParent);
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
    assertAvailable,
    reserve: (totalUsage, stage, estimatedCostUsd) => {
      assertAvailable(stage);
      const reservation: CostReservation = {
        id: Symbol(stage),
        stage,
        estimatedCostUsd: estimatedCostUsd ?? 0,
        active: false,
      };
      if (maxCostUsd === undefined) {
        return reservation;
      }
      if (estimatedCostUsd === null || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
        return failCost(
          "cost_estimate_unavailable",
          `${stage} has no reliable pre-call USD estimate under maxCostUsd=${maxCostUsd}`,
        );
      }
      const committed = accountedCost(totalUsage, stage);
      const projected = committed + activeReservationCost() + estimatedCostUsd;
      if (projected > maxCostUsd + Number.EPSILON) {
        return failCost(
          "cost_budget_exceeded",
          `${stage} requires an estimated ${estimatedCostUsd} USD, raising reserved cost to ${projected}, above maxCostUsd=${maxCostUsd}`,
        );
      }
      reservation.estimatedCostUsd = estimatedCostUsd;
      reservation.active = true;
      reservations.set(reservation.id, reservation);
      return reservation;
    },
    settle: (reservation, totalUsage, stageUsage) => {
      release(reservation);
      if (maxCostUsd === undefined) {
        return;
      }
      if (reservation.estimatedCostUsd > 0 && stageUsage.length === 0) {
        return failCost(
          "cost_accounting_unavailable",
          `${reservation.stage} did not report usage under maxCostUsd=${maxCostUsd}`,
        );
      }
      accountedCost(stageUsage, reservation.stage);
      const cost = accountedCost(totalUsage, reservation.stage);
      if (cost > maxCostUsd + Number.EPSILON) {
        return failCost(
          "cost_budget_exceeded",
          `${reservation.stage} raised total cost to ${cost}, above maxCostUsd=${maxCostUsd}`,
        );
      }
    },
    release,
    assertCost: (totalUsage, stageUsage, remoteTurn, stage) => {
      if (maxCostUsd === undefined) {
        return;
      }
      if (remoteTurn && stageUsage.length === 0) {
        return failCost(
          "cost_accounting_unavailable",
          `${stage} did not report usage under maxCostUsd=${maxCostUsd}`,
        );
      }
      const cost = accountedCost(totalUsage, stage);
      if (cost > maxCostUsd + Number.EPSILON) {
        return failCost(
          "cost_budget_exceeded",
          `${stage} raised total cost to ${cost}, above maxCostUsd=${maxCostUsd}`,
        );
      }
    },
    remainingLimits: (limits, totalUsage) => {
      assertAvailable("leaf execution");
      const remaining: ExecutionLimits = { ...limits };
      if (deadlineAt !== null) {
        const remainingMs = deadlineAt - now().getTime();
        if (remainingMs <= 0) {
          throw new AgentTrioServiceError("deadline_exceeded", "run deadline exceeded");
        }
        remaining.deadlineMs = Math.max(1, Math.min(limits.deadlineMs ?? remainingMs, remainingMs));
      }
      if (maxCostUsd !== undefined) {
        const availableCost = Math.max(
          0,
          maxCostUsd - accountedCost(totalUsage, "planning") - activeReservationCost(),
        );
        remaining.maxCostUsd = Math.min(limits.maxCostUsd ?? availableCost, availableCost);
      }
      return remaining;
    },
  };
}

function withoutAction(
  request: Extract<AgentTrioRequest, { action: "run" | "submit" }>,
): StartRequest {
  return {
    objective: request.objective,
    cwd: request.cwd,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    ...(request.hostAccess === undefined ? {} : { hostAccess: request.hostAccess }),
    ...(request.hostApproval === undefined ? {} : { hostApproval: request.hostApproval }),
    ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
    ...(request.directTier === undefined ? {} : { directTier: request.directTier }),
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    ...(request.domain === undefined ? {} : { domain: request.domain }),
    ...(request.constraints === undefined ? {} : { constraints: [...request.constraints] }),
    ...(request.capabilities === undefined
      ? {}
      : { capabilities: request.capabilities.map((capability) => ({ ...capability })) }),
    ...(request.semanticPlan === undefined
      ? {}
      : { semanticPlan: structuredClone(request.semanticPlan) }),
    ...(request.limits === undefined ? {} : { limits: { ...request.limits } }),
    ...(request.integrate === undefined ? {} : { integrate: request.integrate }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
  };
}

function requestRequiresCapabilityAdmission(
  objective: string,
  capabilities: RunRequest["capabilities"],
): boolean {
  if (capabilities !== undefined && capabilities.length > 0) {
    return true;
  }
  return /\b(browser|plugin|skill|document|spreadsheet|presentation|slide|capability)\b/i.test(
    objective,
  );
}

function withSuggestedLeafLimit(request: RunRequest, suggested: number | undefined): RunRequest {
  if (suggested === undefined) {
    return request;
  }
  const requested = request.limits?.maxLeaves;
  const profileMaximum = request.profile === "quality" ? 20 : request.mode === "durable" ? 5 : 3;
  const maxLeaves = Math.min(profileMaximum, requested ?? suggested, suggested);
  return {
    ...request,
    limits: { ...(request.limits ?? {}), maxLeaves },
  };
}

function normalizeStartRequest(
  input: StartRequest,
  defaultMode: "foreground" | "durable",
): RunRequest {
  const objective = input.objective.trim();
  const cwd = input.cwd.trim();
  if (objective.length === 0 || cwd.length === 0) {
    throw new AgentTrioServiceError("invalid_request", "objective and cwd must both be non-empty");
  }
  if (input.mode !== undefined && input.mode !== defaultMode) {
    throw new AgentTrioServiceError(
      "invalid_request",
      `${defaultMode === "foreground" ? "run" : "submit"} requests must use ${defaultMode} mode`,
    );
  }
  if (input.directTier !== undefined && input.strategy !== "direct") {
    throw new AgentTrioServiceError("invalid_request", "directTier requires strategy=direct");
  }
  const profile = input.profile ?? "balanced";
  if (profile !== "balanced" && profile !== "quality") {
    throw new AgentTrioServiceError("invalid_request", "profile must be balanced or quality");
  }
  if (
    input.hostAccess !== undefined &&
    input.hostAccess !== "readOnly" &&
    input.hostAccess !== "workspaceWrite" &&
    input.hostAccess !== "fullAccess"
  ) {
    throw new AgentTrioServiceError(
      "invalid_request",
      "hostAccess must be readOnly, workspaceWrite, or fullAccess",
    );
  }
  if (
    input.hostApproval !== undefined &&
    input.hostApproval !== "never" &&
    input.hostApproval !== "approveForMe"
  ) {
    throw new AgentTrioServiceError(
      "invalid_request",
      "hostApproval must be never or approveForMe",
    );
  }
  normalizeExecutionLimitsForMode(defaultMode, input.limits ?? {}, profile);
  return {
    objective,
    cwd,
    profile,
    ...(input.hostAccess === undefined ? {} : { hostAccess: input.hostAccess }),
    ...(input.hostApproval === undefined ? {} : { hostApproval: input.hostApproval }),
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.directTier === undefined ? {} : { directTier: input.directTier }),
    mode: defaultMode,
    ...(input.domain === undefined ? {} : { domain: input.domain }),
    ...(input.constraints === undefined ? {} : { constraints: [...input.constraints] }),
    ...(input.capabilities === undefined
      ? {}
      : { capabilities: input.capabilities.map((capability) => ({ ...capability })) }),
    ...(input.semanticPlan === undefined
      ? {}
      : { semanticPlan: structuredClone(input.semanticPlan) }),
    ...(input.limits === undefined ? {} : { limits: { ...input.limits } }),
    ...(input.integrate === undefined ? {} : { integrate: input.integrate }),
  };
}

function normalizeResumeInput(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const normalized = input.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(normalized, "utf8") > 4_096) {
    throw new AgentTrioServiceError("invalid_request", "resume input must not exceed 4 KiB");
  }
  return normalized;
}

function initialSnapshot(
  runId: string,
  request: RunRequest,
  now: Date,
  monitorUrl?: string,
): JobSnapshot {
  return {
    protocolVersion: AGENT_TRIO_PROTOCOL_VERSION,
    requestHash: hashRunRequest(request),
    request: structuredClone(request),
    result: {
      protocolVersion: AGENT_TRIO_PROTOCOL_VERSION,
      runId,
      status: "pending",
      plan: null,
      patch: null,
      leaves: [],
      finalResponse: null,
      metrics: null,
      ...(monitorUrl === undefined ? {} : { monitorUrl }),
    },
    remoteTurns: [],
    coordinatorThreadId: null,
    plannerThreadId: null,
    integratorThreadId: null,
    workspaceCommitState: "not_applicable",
    plannerSession: null,
    startedAt: now.toISOString(),
    planningMs: 0,
    integrationMs: 0,
    usageByStage: materializeUsageByStage(emptyUsageByStage()),
    updatedAt: now.toISOString(),
  };
}

function plannerSessionForSnapshot(snapshot: JobSnapshot): PlannerSessionState | null {
  if (snapshot.plannerSession !== null && snapshot.plannerSession !== undefined) {
    return {
      ...structuredClone(snapshot.plannerSession),
      runId: snapshot.plannerSession.runId ?? snapshot.result.runId,
    };
  }
  const plan = snapshot.result.plan;
  if (plan === null || snapshot.plannerThreadId === null) {
    return null;
  }
  const usageByStage = snapshot.usageByStage ?? snapshot.result.metrics?.usageByStage;
  const usage = [...(usageByStage?.planning.usage ?? []), ...(usageByStage?.replan.usage ?? [])];
  return {
    runId: snapshot.result.runId,
    threadId: snapshot.plannerThreadId,
    request: structuredClone(snapshot.request),
    limits: normalizeExecutionLimitsForMode(
      snapshot.request.mode ?? "foreground",
      snapshot.request.limits ?? {},
      snapshot.request.profile ?? "balanced",
    ),
    initialPlan: structuredClone(plan),
    plan: structuredClone(plan),
    patch: snapshot.result.patch === null ? null : structuredClone(snapshot.result.patch),
    replanCount: snapshot.result.patch === null ? 0 : 1,
    usage: structuredClone(usage),
  };
}

function recoveredRunState(
  snapshot: JobSnapshot,
  session: PlannerSession,
  now: Date,
  mode: "schedule" | "waiting_leaves" | "waiting_integration" | "final_review" = "schedule",
): MutableRunState {
  const usageByStage = mutableUsageForSnapshot(snapshot);
  if (mode !== "final_review") {
    // The resumed scheduler reports all trusted initial leaves plus newly executed leaves once.
    usageByStage.leaves = [];
  }
  if (mode === "schedule" || mode === "waiting_leaves") {
    usageByStage.integration = [];
  }
  usageByStage.finalReview = [];
  const accountedPlannerUsage = usageByStage.planning.length + usageByStage.replan.length;
  const missingPlannerUsage = session.usage.slice(accountedPlannerUsage);
  if (session.patch === null) {
    usageByStage.planning.push(...structuredClone(missingPlannerUsage));
  } else {
    usageByStage.replan.push(...structuredClone(missingPlannerUsage));
  }
  return {
    snapshot,
    startedAt: snapshotStartedAt(snapshot, now),
    planningMs: nonNegativeDuration(snapshot.planningMs ?? snapshot.result.metrics?.planningMs),
    integrationMs: nonNegativeDuration(
      snapshot.integrationMs ?? snapshot.result.metrics?.integrationMs,
    ),
    extraUsage: Object.values(usageByStage).flatMap((usage) => usage),
    usageByStage,
    workspaceUncertain: false,
    estimatedDirectCostUsd: snapshot.result.metrics?.estimatedDirectCostUsd,
    estimatedFanoutCostUsd: snapshot.result.metrics?.estimatedFanoutCostUsd,
    estimatedDirectSeconds: snapshot.result.metrics?.estimatedDirectSeconds,
    estimatedFanoutSeconds: snapshot.result.metrics?.estimatedFanoutSeconds,
    routeSource: snapshot.result.metrics?.routeSource,
  };
}

function recoveredWaitingRunState(snapshot: JobSnapshot, now: Date): MutableRunState {
  const usageByStage = mutableUsageForSnapshot(snapshot);
  return {
    snapshot,
    startedAt: snapshotStartedAt(snapshot, now),
    planningMs: nonNegativeDuration(snapshot.planningMs ?? snapshot.result.metrics?.planningMs),
    integrationMs: nonNegativeDuration(
      snapshot.integrationMs ?? snapshot.result.metrics?.integrationMs,
    ),
    extraUsage: Object.values(usageByStage).flatMap((usage) => usage),
    usageByStage,
    workspaceUncertain: false,
    estimatedDirectCostUsd: snapshot.result.metrics?.estimatedDirectCostUsd,
    estimatedFanoutCostUsd: snapshot.result.metrics?.estimatedFanoutCostUsd,
    estimatedDirectSeconds: snapshot.result.metrics?.estimatedDirectSeconds,
    estimatedFanoutSeconds: snapshot.result.metrics?.estimatedFanoutSeconds,
    routeSource: snapshot.result.metrics?.routeSource,
  };
}

function waitingTurnContext(
  turn: Extract<WaitingInputCheckpoint, { turn: unknown }>["turn"],
): WaitingTurnContext {
  return {
    threadId: turn.threadId,
    previousTurnId: turn.previousTurnId,
    cwd: turn.cwd,
    capabilities: structuredClone(turn.capabilities),
  };
}

function mutableUsageForSnapshot(snapshot: JobSnapshot): MutableUsageByStage {
  const source = snapshot.usageByStage ?? snapshot.result.metrics?.usageByStage;
  if (source === undefined) {
    return emptyUsageByStage();
  }
  return {
    admission: structuredClone(source.admission.usage),
    direct: structuredClone(source.direct.usage),
    planning: structuredClone(source.planning.usage),
    replan: structuredClone(source.replan.usage),
    leaves: structuredClone(source.leaves.usage),
    integration: structuredClone(source.integration.usage),
    finalReview: structuredClone(source.finalReview.usage),
  };
}

function snapshotStartedAt(snapshot: JobSnapshot, fallback: Date): Date {
  for (const candidate of [
    snapshot.startedAt,
    snapshot.result.metrics?.startedAt,
    snapshot.updatedAt,
  ]) {
    if (candidate === undefined) {
      continue;
    }
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

function parseSnapshotDate(value: string | undefined, fallback: Date): Date {
  if (value !== undefined) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

function nonNegativeDuration(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

function integrationIssueTriggers(
  plan: NonNullable<BatchResult["plan"]>,
  issues: readonly IntegrationPlanIssue[],
  now: Date,
): ReplanTrigger[] {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  return issues.map((issue) => {
    const unknown = issue.taskIds.find((taskId) => !taskIds.has(taskId));
    if (unknown !== undefined) {
      throw new AgentTrioServiceError(
        "invalid_integration_issue",
        `Terra integration issue references unknown task '${unknown}'`,
      );
    }
    return {
      type: issue.type,
      taskIds: [...new Set(issue.taskIds)].sort(),
      summary: issue.summary,
      observedAt: now.toISOString(),
    };
  });
}

function integrationValidationTriggers(
  plan: NonNullable<BatchResult["plan"]>,
  validation: readonly ValidationResult[],
  now: Date,
): ReplanTrigger[] {
  const failed = validation.filter((result) => result.status === "failed");
  if (failed.length === 0) {
    return [];
  }
  return [
    {
      type: "validator_failure",
      taskIds: plan.tasks.map((task) => task.id),
      summary: `Aggregate validation failed: ${failed
        .map((result) => `${result.command}: ${result.summary}`)
        .join("; ")}`.slice(0, 1_024),
      observedAt: now.toISOString(),
    },
  ];
}

async function runIntegrationValidation(
  validator: DeterministicValidator | undefined,
  specs: readonly ValidationSpec[],
  baseCwd: string,
  signal: AbortSignal,
): Promise<ValidationResult[]> {
  if (specs.length === 0) {
    return [];
  }
  if (validator === undefined) {
    return specs.map((spec) => ({
      command: spec.command,
      status: "failed",
      summary: "validator could not run: deterministic validator is unavailable",
    }));
  }
  const results = await validator.validate({
    specs,
    baseCwd,
    access: "workspaceWrite",
    signal,
  });
  if (
    results.length !== specs.length ||
    results.some((result, index) => result.command !== specs[index]?.command)
  ) {
    return specs.map((spec) => ({
      command: spec.command,
      status: "failed",
      summary: "validator returned an incomplete or mismatched result set",
    }));
  }
  return [...results];
}

function requiresFinalReview(
  scheduled: ScheduleResult,
  integrationValidation: readonly ValidationResult[],
): boolean {
  const policy = scheduled.plan.integration.finalReview;
  if (policy === "never") {
    return false;
  }
  if (policy === "always") {
    return true;
  }
  if (scheduled.plan.risk === "high") {
    return true;
  }
  if (scheduled.patch !== null) {
    return true;
  }
  if (integrationValidation.some((validation) => validation.status === "failed")) {
    return true;
  }
  return scheduled.leaves.some((leaf) => {
    const task = scheduled.plan.tasks.find((candidate) => candidate.id === leaf.taskId);
    return (
      (task?.critical === true && leaf.confidence < 0.7) ||
      leaf.validation.some((validation) => validation.status === "failed")
    );
  });
}

function plannerUsage(session: PlannerSession): ModelUsage[] {
  const candidate = session as PlannerSession & { usage?: unknown };
  return Array.isArray(candidate.usage) ? structuredClone(candidate.usage as ModelUsage[]) : [];
}

function stageLabel(stage: NonLeafCostStage): string {
  switch (stage) {
    case "admission":
      return "Terra admission";
    case "direct":
      return "direct execution";
    case "planning":
      return "Sol planning";
    case "plan_patch":
      return "Sol PlanPatch";
    case "planner_answer":
      return "Sol planner answer";
    case "integration":
      return "Terra integration";
    case "final_review":
      return "Sol final review";
  }
}

function compactLeafResults(leaves: readonly LeafResult[]): Array<{
  taskId: string;
  status: LeafResult["status"];
  summary: string;
  confidence: number;
  changedFiles: string[];
  validation: ValidationResult[];
  error: string | null;
}> {
  return leaves.map((leaf) => ({
    taskId: leaf.taskId,
    status: leaf.status,
    summary: leaf.summary,
    confidence: leaf.confidence,
    changedFiles: [...leaf.changedFiles],
    validation: structuredClone(leaf.validation),
    error: leaf.error ?? null,
  }));
}

function plannerFailureDetails(
  error: unknown,
): { code: string; threadId: string | null; usage: ModelUsage[] } | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as { code?: unknown; threadId?: unknown; usage?: unknown };
  if (typeof candidate.code !== "string" || !Array.isArray(candidate.usage)) {
    return null;
  }
  return {
    code: candidate.code,
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : null,
    usage: structuredClone(candidate.usage as ModelUsage[]),
  };
}

function usageForSnapshot(snapshot: JobSnapshot): ModelUsage[] {
  const staged = snapshot.usageByStage ?? snapshot.result.metrics?.usageByStage;
  if (staged !== undefined) {
    return Object.values(staged).flatMap((stage) => structuredClone(stage.usage));
  }
  if (snapshot.result.metrics !== null) {
    return structuredClone(snapshot.result.metrics.usage);
  }
  return [
    ...structuredClone(snapshot.plannerSession?.usage ?? []),
    ...snapshot.result.leaves.flatMap((leaf) => structuredClone(leaf.usage)),
  ];
}

function reconcileCheckpointedRemoteUsage(
  snapshot: JobSnapshot,
  appendCheckpointedUsage: boolean,
): void {
  if (snapshot.usageByStage === undefined && snapshot.result.metrics?.usageByStage === undefined) {
    return;
  }
  const stages = mutableUsageForSnapshot(snapshot);
  const accounted = new Set(snapshot.accountedUsageTurnKeys ?? []);
  const assignments = nonLeafRemoteAssignments(snapshot);
  for (const stage of usageStageNames()) {
    if (stage === "leaves") {
      continue;
    }
    const stageAssignments = assignments.filter((assignment) => assignment.stage === stage);
    const unclaimed = stages[stage].map(usageSignature);
    const hasOpaqueAccountedTurn = stageAssignments.some(
      ({ ref }) =>
        accounted.has(remoteUsageTurnKey(ref)) &&
        ref.state === "terminal" &&
        (ref.usage === undefined || ref.usage.length === 0),
    );

    for (const { ref } of stageAssignments) {
      if (
        ref.state !== "terminal" ||
        !accounted.has(remoteUsageTurnKey(ref)) ||
        ref.usage === undefined
      ) {
        continue;
      }
      consumeUsageSequence(unclaimed, ref.usage.map(usageSignature));
    }

    for (const { ref } of stageAssignments) {
      const key = remoteUsageTurnKey(ref);
      if (
        ref.state !== "terminal" ||
        accounted.has(key) ||
        ref.usage === undefined ||
        ref.usage.length === 0
      ) {
        continue;
      }
      const signatures = ref.usage.map(usageSignature);
      if (!hasOpaqueAccountedTurn && consumeUsageSequence(unclaimed, signatures)) {
        accounted.add(key);
        continue;
      }
      if (appendCheckpointedUsage) {
        stages[stage].push(...structuredClone(ref.usage));
        accounted.add(key);
      }
    }

    const usageMissing = stageAssignments.filter(
      ({ ref }) =>
        !accounted.has(remoteUsageTurnKey(ref)) &&
        ref.state === "terminal" &&
        (ref.usage === undefined || ref.usage.length === 0),
    );
    if (!hasOpaqueAccountedTurn && usageMissing.length === 1 && unclaimed.length > 0) {
      accounted.add(remoteUsageTurnKey(usageMissing[0]!.ref));
    }
  }
  snapshot.usageByStage = materializeUsageByStage(stages);
  snapshot.accountedUsageTurnKeys = [...accounted].sort();
}

function unaccountedNonLeafTurns(snapshot: JobSnapshot): string[] {
  const accounted = new Set(snapshot.accountedUsageTurnKeys ?? []);
  return nonLeafRemoteAssignments(snapshot)
    .filter(({ ref }) => !accounted.has(remoteUsageTurnKey(ref)))
    .map(({ ref }) => `${ref.role}:${ref.turnId ?? "<pending>"}`);
}

function usageStageNames(): UsageStage[] {
  return ["admission", "direct", "planning", "replan", "leaves", "integration", "finalReview"];
}

function usageSignature(usage: ModelUsage): string {
  return JSON.stringify([
    usage.model,
    usage.tier,
    usage.effort,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens ?? 0,
    usage.uncachedInputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.estimatedCostUsd,
  ]);
}

function consumeUsageSequence(pool: string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > pool.length) {
    return false;
  }
  const lastStart = pool.length - sequence.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (sequence.every((signature, offset) => pool[start + offset] === signature)) {
      pool.splice(start, sequence.length);
      return true;
    }
  }
  return false;
}

function remoteUsageTurnKey(ref: RemoteTurnRef): string {
  return JSON.stringify([
    ref.role,
    ref.taskId ?? null,
    ref.attempt ?? null,
    ref.threadId,
    ref.turnId,
  ]);
}

function nonLeafRemoteAssignments(
  snapshot: JobSnapshot,
): Array<{ ref: RemoteTurnRef; stage: Exclude<UsageStage, "leaves"> }> {
  const refs = mergeRemoteTurns([], snapshot.remoteTurns)
    .filter((ref) => ref.role !== "leaf" && ref.turnId !== null)
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  let plannerTurn = 0;
  return refs.map((ref) => {
    let stage: Exclude<UsageStage, "leaves">;
    switch (ref.role) {
      case "leaf":
        throw new AgentTrioServiceError(
          "invalid_recovery_state",
          "leaf turn reached non-leaf usage assignment",
        );
      case "admission":
        stage = "admission";
        break;
      case "direct":
        stage = "direct";
        break;
      case "planner":
        stage = plannerTurn === 0 ? "planning" : "replan";
        plannerTurn += 1;
        break;
      case "integrator":
        stage = "integration";
        break;
      case "finalReview":
        stage = "finalReview";
        break;
    }
    return { ref, stage };
  });
}

function isBudgetFailure(error: unknown): boolean {
  return (
    error instanceof AgentTrioServiceError &&
    (error.code === "deadline_exceeded" ||
      error.code === "cost_budget_exceeded" ||
      error.code === "cost_accounting_unavailable")
  );
}

function summarizeIncomplete(leaves: readonly LeafResult[]): string {
  return leaves.map((leaf) => `${leaf.taskId}: ${leaf.error ?? leaf.summary}`).join("; ");
}

function summarizeLeaves(leaves: readonly LeafResult[]): string {
  return leaves.map((leaf) => `${leaf.taskId}: ${leaf.summary}`).join("\n");
}

function hasIndeterminateWriterSchedule(scheduled: ScheduleResult): boolean {
  const tasks = new Map(scheduled.plan.tasks.map((task) => [task.id, task]));
  return scheduled.leaves.some(
    (leaf) =>
      leaf.status === "indeterminate" && tasks.get(leaf.taskId)?.access === "workspaceWrite",
  );
}

function hasWorkspaceWriters(plan: ExecutionPlan): boolean {
  return plan.tasks.some((task) => task.access === "workspaceWrite");
}

function allPlanTasksCompleted(plan: ExecutionPlan, leaves: readonly LeafResult[]): boolean {
  const statuses = new Map(leaves.map((leaf) => [leaf.taskId, leaf.status]));
  return plan.tasks.every((task) => statuses.get(task.id) === "completed");
}

function hasIndeterminateWriterSnapshot(snapshot: JobSnapshot): boolean {
  const tasks = new Map((snapshot.result.plan?.tasks ?? []).map((task) => [task.id, task]));
  return snapshot.result.leaves.some(
    (leaf) =>
      leaf.status === "indeterminate" && tasks.get(leaf.taskId)?.access === "workspaceWrite",
  );
}

function sumCost(usage: readonly ModelUsage[]): number | null {
  if (usage.some((item) => item.estimatedCostUsd === null)) {
    return null;
  }
  return usage.reduce((total, item) => total + (item.estimatedCostUsd ?? 0), 0);
}

function emptyUsageByStage(): MutableUsageByStage {
  return {
    admission: [],
    direct: [],
    planning: [],
    replan: [],
    leaves: [],
    integration: [],
    finalReview: [],
  };
}

function recordUsage(
  state: MutableRunState,
  stage: UsageStage,
  usage: readonly ModelUsage[],
): void {
  state.extraUsage.push(...usage);
  state.usageByStage[stage].push(...usage);
}

function replaceStageUsage(
  state: MutableRunState,
  stage: UsageStage,
  usage: readonly ModelUsage[],
): void {
  state.usageByStage[stage] = structuredClone([...usage]);
  state.extraUsage = Object.values(state.usageByStage).flatMap((stageUsage) => stageUsage);
}

function materializeUsageByStage(source: MutableUsageByStage): BatchUsageBreakdown {
  const stage = (usage: readonly ModelUsage[]) => {
    const copy: ModelUsage[] = structuredClone([...usage]);
    return { usage: copy, estimatedCostUsd: sumCost(copy) };
  };
  return {
    admission: stage(source.admission),
    direct: stage(source.direct),
    planning: stage(source.planning),
    replan: stage(source.replan),
    leaves: stage(source.leaves),
    integration: stage(source.integration),
    finalReview: stage(source.finalReview),
  };
}

function elapsedMs(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isSettled(status: JobStatus): boolean {
  return isTerminal(status) || status === "waiting_input" || status === "indeterminate";
}

function errorMessage(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    return "run cancelled";
  }
  return error instanceof Error ? error.message : String(error);
}

function cloneResult(result: BatchResult): BatchResult {
  return structuredClone(result);
}

function cloneSnapshot(snapshot: JobSnapshot): JobSnapshot {
  return structuredClone(snapshot);
}

function mergeRemoteTurns(
  local: JobSnapshot["remoteTurns"],
  persisted: JobSnapshot["remoteTurns"],
): JobSnapshot["remoteTurns"] {
  const turns = new Map<string, JobSnapshot["remoteTurns"][number]>();
  for (const turn of [...local, ...persisted]) {
    const key = remoteTurnIdentity(turn);
    const existing = turns.get(key);
    const terminalAdvance = existing?.state !== "terminal" && turn.state === "terminal";
    const terminalRegression = existing?.state === "terminal" && turn.state !== "terminal";
    if (
      existing === undefined ||
      terminalAdvance ||
      (!terminalRegression && Date.parse(turn.updatedAt) >= Date.parse(existing.updatedAt))
    ) {
      turns.set(key, structuredClone(turn));
    }
  }
  const merged = [...turns.values()];
  return merged.filter((turn) => {
    if (turn.turnId !== null) {
      return true;
    }
    return !merged.some(
      (candidate) =>
        candidate.turnId !== null &&
        remoteTurnBaseIdentity(candidate) === remoteTurnBaseIdentity(turn) &&
        Date.parse(candidate.updatedAt) >= Date.parse(turn.updatedAt),
    );
  });
}

function latestNonterminalRemoteTurns(turns: readonly RemoteTurnRef[]): RemoteTurnRef[] {
  return mergeRemoteTurns([], [...turns]).filter((turn) => turn.state !== "terminal");
}

function remoteTurnIdentity(turn: RemoteTurnRef): string {
  return `${remoteTurnBaseIdentity(turn)}:${turn.turnId ?? "<pending>"}`;
}

function remoteTurnBaseIdentity(turn: RemoteTurnRef): string {
  return `${turn.role}:${turn.taskId ?? ""}:${String(turn.attempt ?? 0)}:${turn.threadId}`;
}

const CANCELLATION_REQUEST_FILE = "cancel-request.json";

function requestCancellation(store: JobStore, runId: string, now: Date): void {
  const directory = store.jobDirectory(runId);
  const target = join(directory, CANCELLATION_REQUEST_FILE);
  const temporary = join(directory, `.cancel.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ runId, requestedAt: now.toISOString() })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
    syncControlDirectory(directory);
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
}

function cancellationRequested(store: JobStore, runId: string): boolean {
  return existsSync(join(store.jobDirectory(runId), CANCELLATION_REQUEST_FILE));
}

function clearCancellationRequest(store: JobStore, runId: string): void {
  const directory = store.jobDirectory(runId);
  const target = join(directory, CANCELLATION_REQUEST_FILE);
  const existed = existsSync(target);
  rmSync(target, { force: true });
  if (existed) {
    syncControlDirectory(directory);
  }
}

function syncControlDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isActiveLockError(error: unknown, runId: string): boolean {
  return error instanceof Error && error.message === `job ${runId} is already active`;
}

function plainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateRecoveredResult(snapshot: JobSnapshot, result: BatchResult): void {
  if (result.protocolVersion !== AGENT_TRIO_PROTOCOL_VERSION) {
    throw new AgentTrioServiceError(
      "recovery_protocol_mismatch",
      `recovery returned protocol ${result.protocolVersion}`,
    );
  }
  if (result.runId !== snapshot.result.runId) {
    throw new AgentTrioServiceError(
      "recovery_run_mismatch",
      `recovery returned runId ${result.runId}, expected ${snapshot.result.runId}`,
    );
  }
  if (result.status === "completed" && result.finalResponse === null) {
    throw new AgentTrioServiceError(
      "recovery_contract_incomplete",
      "recovery returned a completed run without a final response",
    );
  }
}

function assertRecoveredWorkspaceCommitted(snapshot: JobSnapshot, result: BatchResult): void {
  if (
    result.status === "completed" &&
    result.plan !== null &&
    hasWorkspaceWriters(result.plan) &&
    snapshot.workspaceCommitState !== "applied"
  ) {
    throw new AgentTrioServiceError(
      "workspace_commit_indeterminate",
      "recovery observed a completed result, but isolated writer patches were not durably marked as applied",
    );
  }
}

function finishSnapshotMetrics(
  snapshot: JobSnapshot,
  result: BatchResult,
  completedAt: Date,
): BatchMetrics {
  const existing = result.metrics ?? snapshot.result.metrics;
  const usageByStage = mutableUsageForSnapshot(snapshot);
  const stagedSource = snapshot.usageByStage ?? existing?.usageByStage;
  const recoveredLeafUsage = result.leaves.flatMap((leaf) => leaf.usage);
  if (stagedSource === undefined) {
    const legacyUsage = existing?.usage ?? [];
    usageByStage.leaves.push(
      ...structuredClone(legacyUsage.length > 0 ? legacyUsage : recoveredLeafUsage),
    );
  } else if (usageByStage.leaves.length === 0 && recoveredLeafUsage.length > 0) {
    usageByStage.leaves.push(...structuredClone(recoveredLeafUsage));
  }
  const usage = Object.values(usageByStage).flatMap((stageUsage) => stageUsage);
  const startedAt = snapshotStartedAt(snapshot, completedAt);
  return {
    profile: snapshot.request.profile ?? existing?.profile ?? "balanced",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    elapsedMs: elapsedMs(startedAt, completedAt),
    planningMs: nonNegativeDuration(snapshot.planningMs ?? existing?.planningMs),
    integrationMs: nonNegativeDuration(snapshot.integrationMs ?? existing?.integrationMs),
    launchSkewMs: existing?.launchSkewMs ?? null,
    peakConcurrency: existing?.peakConcurrency ?? 0,
    replanCount: existing?.replanCount ?? (result.patch === null ? 0 : 1),
    userInterventionCount: Math.max(
      existing?.userInterventionCount ?? 0,
      result.status === "waiting_input" ? 1 : 0,
    ),
    usage: structuredClone(usage),
    estimatedCostUsd: sumCost(usage),
    ...(existing?.routeReason === undefined ? {} : { routeReason: existing.routeReason }),
    ...(existing?.selectedLeafCount !== undefined
      ? { selectedLeafCount: existing.selectedLeafCount }
      : result.plan === null
        ? {}
        : { selectedLeafCount: result.plan.tasks.length }),
    ...(existing?.plannerSkipped === undefined ? {} : { plannerSkipped: existing.plannerSkipped }),
    ...(existing?.integrationSkipped === undefined
      ? {}
      : { integrationSkipped: existing.integrationSkipped }),
    ...(existing?.estimatedDirectCostUsd === undefined
      ? {}
      : { estimatedDirectCostUsd: existing.estimatedDirectCostUsd }),
    ...(existing?.estimatedFanoutCostUsd === undefined
      ? {}
      : { estimatedFanoutCostUsd: existing.estimatedFanoutCostUsd }),
    ...(existing?.routeSource === undefined ? {} : { routeSource: existing.routeSource }),
    ...(existing?.selectedDomain === undefined ? {} : { selectedDomain: existing.selectedDomain }),
    ...(existing?.selectedWaveCount === undefined
      ? {}
      : { selectedWaveCount: existing.selectedWaveCount }),
    ...(existing?.selectedTierCounts === undefined
      ? {}
      : { selectedTierCounts: structuredClone(existing.selectedTierCounts) }),
    ...(existing?.estimatedSerialSeconds !== undefined
      ? { estimatedSerialSeconds: existing.estimatedSerialSeconds }
      : result.plan === null
        ? {}
        : { estimatedSerialSeconds: planSerialSeconds(result.plan) }),
    ...(existing?.estimatedCriticalPathSeconds !== undefined
      ? { estimatedCriticalPathSeconds: existing.estimatedCriticalPathSeconds }
      : result.plan === null
        ? {}
        : { estimatedCriticalPathSeconds: planCriticalPathSeconds(result.plan) }),
    ...(existing?.estimatedDirectSeconds === undefined
      ? {}
      : { estimatedDirectSeconds: existing.estimatedDirectSeconds }),
    ...(existing?.estimatedFanoutSeconds === undefined
      ? {}
      : { estimatedFanoutSeconds: existing.estimatedFanoutSeconds }),
    ...(existing?.estimatedCostRatio === undefined
      ? {}
      : { estimatedCostRatio: existing.estimatedCostRatio }),
    ...(existing?.estimatedLatencyRatio === undefined
      ? {}
      : { estimatedLatencyRatio: existing.estimatedLatencyRatio }),
    ...(existing?.predictionCostErrorRatio === undefined
      ? {}
      : { predictionCostErrorRatio: existing.predictionCostErrorRatio }),
    ...(existing?.predictionLatencyErrorRatio === undefined
      ? {}
      : { predictionLatencyErrorRatio: existing.predictionLatencyErrorRatio }),
    usageByStage: materializeUsageByStage(usageByStage),
  };
}

function planWaveCount(plan: ExecutionPlan): number {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (taskId: string): number => {
    const cached = depths.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(taskId)) {
      return 0;
    }
    visiting.add(taskId);
    const task = tasks.get(taskId);
    const value =
      task === undefined || task.dependsOn.length === 0
        ? 1
        : 1 + Math.max(...task.dependsOn.map(depth));
    visiting.delete(taskId);
    depths.set(taskId, value);
    return value;
  };
  return plan.tasks.length === 0 ? 0 : Math.max(...plan.tasks.map((task) => depth(task.id)));
}

function planTierCounts(plan: ExecutionPlan): NonNullable<BatchMetrics["selectedTierCounts"]> {
  const counts: NonNullable<BatchMetrics["selectedTierCounts"]> = {};
  for (const task of plan.tasks) {
    counts[task.tier] = (counts[task.tier] ?? 0) + 1;
  }
  return counts;
}

function planSerialSeconds(plan: ExecutionPlan): number {
  return plan.tasks.reduce((total, task) => total + task.expectedSeconds, 0);
}

function planCriticalPathSeconds(plan: ExecutionPlan): number | null {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const durations = new Map<string, number>();
  const visiting = new Set<string>();
  const duration = (taskId: string): number | null => {
    const cached = durations.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(taskId)) {
      return null;
    }
    const task = tasks.get(taskId);
    if (task === undefined) {
      return null;
    }
    visiting.add(taskId);
    let dependencySeconds = 0;
    for (const dependency of task.dependsOn) {
      const dependencyDuration = duration(dependency);
      if (dependencyDuration === null) {
        visiting.delete(taskId);
        return null;
      }
      dependencySeconds = Math.max(dependencySeconds, dependencyDuration);
    }
    visiting.delete(taskId);
    const value = dependencySeconds + task.expectedSeconds;
    durations.set(taskId, value);
    return value;
  };
  let criticalPath = 0;
  for (const task of plan.tasks) {
    const taskDuration = duration(task.id);
    if (taskDuration === null) {
      return null;
    }
    criticalPath = Math.max(criticalPath, taskDuration);
  }
  return criticalPath;
}

function optionalRatio(
  key:
    | "estimatedCostRatio"
    | "estimatedLatencyRatio"
    | "predictionCostErrorRatio"
    | "predictionLatencyErrorRatio",
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): Partial<BatchMetrics> {
  if (
    numerator === undefined ||
    numerator === null ||
    denominator === undefined ||
    denominator === null ||
    denominator <= 0
  ) {
    return {};
  }
  return { [key]: numerator / denominator };
}

function checkpointFinishedMetrics(snapshot: JobSnapshot, metrics: BatchMetrics): void {
  snapshot.startedAt = metrics.startedAt;
  snapshot.planningMs = metrics.planningMs;
  snapshot.integrationMs = metrics.integrationMs;
  snapshot.usageByStage = structuredClone(
    metrics.usageByStage ?? materializeUsageByStage(emptyUsageByStage()),
  );
}
