import type {
  BatchResult,
  JobSnapshot,
  LeafResult,
  LeafTask,
  RemoteTurnRef,
} from "../core/contracts.js";
import type {
  ReattachResult,
  RecoveryAdapter,
  RemoteCancellationResult,
} from "../core/integration.js";
import { AppServerLeafExecutor, type AppServerLeafExecutorOptions } from "./adapters.js";
import {
  parseAgentOutcomeBody,
  parseFinalReviewBody,
  parseIntegratorOutcomeBody,
} from "./adapters/schemas.js";
import {
  AppServerAdapterError,
  ensureConnected,
  runtimeFor,
  strictFinalJson,
} from "./adapters/runtime.js";
import type { AppServer } from "./types.js";

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_REATTACH_POLL_MS = 500;

export interface AwaitRunningTurnInput {
  appServer: AppServer;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export type AppServerRunningTurnAwaiter = (input: AwaitRunningTurnInput) => Promise<void>;

interface CompletedLeafReader {
  readCompletedLeaf(input: {
    task: LeafTask;
    threadId: string;
    turnId: string;
    appServer?: AppServer;
  }): Promise<LeafResult | null>;
}

export interface AppServerRecoveryAdapterOptions extends AppServerLeafExecutorOptions {
  /**
   * An explicit capability for transports that remain subscribed to an already-running turn.
   * Recovery never assumes a newly-created App Server process can observe an old turn.
   */
  awaitRunningTurn?: AppServerRunningTurnAwaiter;
  leafExecutor?: CompletedLeafReader;
  now?: () => Date;
}

type ObservedTurn =
  { state: "terminal" } | { state: "running" } | { state: "unknown"; reason: string };

interface RecoveredAgentOutcome {
  role: "direct" | "integrator";
  updatedAt: string;
  outcome: ReturnType<typeof parseAgentOutcomeBody>;
}

interface RecoveredFinalReview {
  role: "finalReview";
  updatedAt: string;
  review: ReturnType<typeof parseFinalReviewBody>;
}

type RecoveredOutcome = RecoveredAgentOutcome | RecoveredFinalReview;

type RecoveryContinuation = NonNullable<ReattachResult["continuation"]>;

/** Await a turn through the notification runtime owned by a still-live App Server transport. */
export async function awaitLiveAppServerTurn(input: AwaitRunningTurnInput): Promise<void> {
  await runtimeFor(input.appServer).waitForTurn(input.threadId, input.turnId, {
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
}

/** Reattach to a durable read-only turn by observing it; never starts or resumes model work. */
export async function awaitPersistedAppServerTurn(input: AwaitRunningTurnInput): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    throwIfAborted(input.signal);
    const observed = await observeTurn(
      input.appServer,
      {
        role: "leaf",
        threadId: input.threadId,
        turnId: input.turnId,
        access: "readOnly",
        state: "running",
        updatedAt: new Date().toISOString(),
      },
      input.turnId,
    );
    if (observed.state === "terminal") {
      return;
    }
    if (observed.state === "unknown" && !observed.reason.includes("was not found")) {
      throw new AppServerAdapterError(
        "reattach_observation_failed",
        `cannot observe turn '${input.turnId}': ${observed.reason}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AppServerAdapterError(
        "reattach_timeout",
        `turn '${input.turnId}' did not complete within ${String(input.timeoutMs)}ms`,
      );
    }
    await waitForPoll(Math.min(DEFAULT_REATTACH_POLL_MS, remaining), input.signal);
  }
}

/**
 * Reconstructs only results that can be observed from persisted App Server ids.
 * It never starts, continues, steers, or otherwise replays a model turn.
 */
export class AppServerRecoveryAdapter implements RecoveryAdapter {
  readonly #appServer: AppServer;
  readonly #leafExecutor: CompletedLeafReader;
  readonly #awaitRunningTurn: AppServerRunningTurnAwaiter | undefined;
  readonly #turnTimeoutMs: number;
  readonly #now: () => Date;

  constructor(options: AppServerRecoveryAdapterOptions) {
    this.#appServer = options.appServer;
    this.#leafExecutor = options.leafExecutor ?? new AppServerLeafExecutor(options);
    this.#awaitRunningTurn = options.awaitRunningTurn;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.#turnTimeoutMs) || this.#turnTimeoutMs <= 0) {
      throw new RangeError("turnTimeoutMs must be a positive finite number");
    }
    if (this.#awaitRunningTurn !== undefined) {
      // Subscribe before thread/read so a completion racing the first observation is buffered.
      runtimeFor(this.#appServer);
    }
  }

  async reattach(input: { snapshot: JobSnapshot; signal: AbortSignal }): Promise<ReattachResult> {
    throwIfAborted(input.signal);
    await ensureConnected(this.#appServer);
    throwIfAborted(input.signal);

    const snapshot = structuredClone(input.snapshot);
    const refs = latestRecoveryRefs(snapshot.remoteTurns);
    const leaves = new Map(snapshot.result.leaves.map((leaf) => [leaf.taskId, leaf]));
    const reasons: string[] = [];
    const outcomes: RecoveredOutcome[] = [];

    for (const ref of refs) {
      throwIfAborted(input.signal);
      if (ref.role === "leaf") {
        await this.#recoverLeaf(snapshot, ref, leaves, reasons, input.signal);
      } else {
        await this.#recoverNonLeaf(snapshot, ref, outcomes, reasons, input.signal);
      }
    }

    const continuation = recoveryContinuation(snapshot, leaves, outcomes, reasons, refs);
    const result =
      continuation === null
        ? this.#finishResult(snapshot, leaves, outcomes, reasons, refs)
        : continuingResult(snapshot.result, continuation.initialLeaves);
    return {
      result,
      coordinatorThreadId: latestThreadFor(refs, ["admission"]) ?? snapshot.coordinatorThreadId,
      plannerThreadId:
        latestThreadFor(refs, ["planner", "finalReview"]) ?? snapshot.plannerThreadId,
      integratorThreadId:
        latestThreadFor(refs, ["direct", "integrator"]) ?? snapshot.integratorThreadId,
      ...(continuation === null ? {} : { continuation }),
    };
  }

  async cancel(input: { snapshot: JobSnapshot }): Promise<RemoteCancellationResult> {
    await ensureConnected(this.#appServer);
    const refs = latestRemoteRefsByThread(input.snapshot.remoteTurns).filter(
      (ref) => ref.state !== "terminal",
    );
    const observations = new Map<string, Promise<ObservedTurn>>();
    const remoteTurns = await Promise.all(
      refs.map(async (ref): Promise<RemoteTurnRef> => {
        if (ref.turnId === null) {
          return ref;
        }
        const key = turnKey(ref.threadId, ref.turnId);
        let observation = observations.get(key);
        if (observation === undefined) {
          observation = this.#interruptAndObserve(ref.threadId, ref.turnId);
          observations.set(key, observation);
        }
        return (await observation).state === "terminal"
          ? { ...ref, state: "terminal", updatedAt: this.#now().toISOString() }
          : ref;
      }),
    );
    const reasons = await Promise.all(
      refs.map(async (ref, index): Promise<string | null> => {
        if (remoteTurns[index]?.state === "terminal") {
          return null;
        }
        if (ref.turnId === null) {
          return `${remoteLabel(ref)} has no persisted turn id, so cancellation cannot be confirmed`;
        }
        const observed = await observations.get(turnKey(ref.threadId, ref.turnId))!;
        return observed.state === "unknown"
          ? `${remoteLabel(ref)} cancellation is unconfirmed: ${observed.reason}`
          : `${remoteLabel(ref)} remained running after its interrupt request`;
      }),
    );
    const failures = reasons.filter((reason): reason is string => reason !== null);
    return {
      remoteTurns,
      allTerminal: failures.length === 0,
      reasons: failures,
    };
  }

  async #interruptAndObserve(threadId: string, turnId: string): Promise<ObservedTurn> {
    let observed = await observeTurn(
      this.#appServer,
      cancellationRef(threadId, turnId, this.#now()),
      turnId,
    );
    if (observed.state === "terminal") {
      return observed;
    }
    try {
      await this.#appServer.turnInterrupt({ threadId, turnId });
    } catch (error) {
      const raced = await observeTurn(
        this.#appServer,
        cancellationRef(threadId, turnId, this.#now()),
        turnId,
      );
      if (raced.state === "terminal") {
        return raced;
      }
      return {
        state: "unknown",
        reason: `turn/interrupt failed: ${errorMessage(error)}`,
      };
    }

    observed = await observeTurn(
      this.#appServer,
      cancellationRef(threadId, turnId, this.#now()),
      turnId,
    );
    if (observed.state === "terminal") {
      return observed;
    }
    if (this.#awaitRunningTurn === undefined) {
      return observed.state === "unknown"
        ? observed
        : { state: "unknown", reason: "terminal turn confirmation is unavailable" };
    }

    const signal = new AbortController().signal;
    try {
      await this.#awaitRunningTurn({
        appServer: this.#appServer,
        threadId,
        turnId,
        signal,
        timeoutMs: this.#turnTimeoutMs,
      });
    } catch (error) {
      const finalObservation = await observeTurn(
        this.#appServer,
        cancellationRef(threadId, turnId, this.#now()),
        turnId,
      );
      return finalObservation.state === "terminal"
        ? finalObservation
        : {
            state: "unknown",
            reason: `terminal confirmation failed: ${errorMessage(error)}`,
          };
    }
    return observeTurn(this.#appServer, cancellationRef(threadId, turnId, this.#now()), turnId);
  }

  async #recoverLeaf(
    snapshot: JobSnapshot,
    ref: RemoteTurnRef,
    leaves: Map<string, LeafResult>,
    reasons: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const taskId = ref.taskId;
    if (taskId === undefined) {
      reasons.push(`leaf thread '${ref.threadId}' has no persisted task id`);
      return;
    }
    const task = snapshot.result.plan?.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      reasons.push(`leaf '${taskId}' is absent from the persisted execution plan`);
      leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reasons.at(-1)!));
      return;
    }
    if (task.access !== ref.access) {
      const reason = `leaf '${taskId}' access does not match its persisted remote turn`;
      reasons.push(reason);
      leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reason));
      return;
    }
    const persisted = leaves.get(taskId);
    if (
      ref.turnId !== null &&
      persisted?.threadId === ref.threadId &&
      persisted.turnId === ref.turnId
    ) {
      // The service only persists a LeafResult after transport parsing and
      // deterministic validation. Prefer that evidence over the model turn.
      return;
    }
    if (ref.turnId === null) {
      const reason = unknownTurnReason(ref, "no turn id was checkpointed");
      reasons.push(reason);
      leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reason));
      return;
    }

    const turnId = ref.turnId;
    let observed = await observeTurn(this.#appServer, ref, turnId);
    if (observed.state === "running" && ref.access === "readOnly") {
      observed = await this.#awaitReadOnly(ref, turnId, observed, signal);
    }
    if (observed.state !== "terminal") {
      const reason =
        observed.state === "unknown"
          ? unknownTurnReason(ref, observed.reason)
          : runningTurnReason(ref, this.#awaitRunningTurn !== undefined);
      reasons.push(reason);
      leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reason));
      return;
    }

    try {
      const recovered = await this.#leafExecutor.readCompletedLeaf({
        task,
        threadId: ref.threadId,
        turnId,
        appServer: this.#appServer,
      });
      if (recovered === null) {
        const reason = unknownTurnReason(ref, "thread/read no longer reports a terminal turn");
        reasons.push(reason);
        leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reason));
        return;
      }
      if (recovered.status === "completed" && task.validation.length > 0) {
        const reason = unknownTurnReason(
          ref,
          "the deterministic leaf validation result was not persisted; recovery will not replay validators",
        );
        reasons.push(reason);
        leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reason));
        return;
      }
      leaves.set(taskId, recovered);
    } catch (error) {
      const reason = unknownTurnReason(
        ref,
        `terminal result is not trustworthy: ${errorMessage(error)}`,
      );
      reasons.push(reason);
      leaves.set(taskId, indeterminateLeaf(ref, taskId, this.#now(), reason));
    }
  }

  async #recoverNonLeaf(
    snapshot: JobSnapshot,
    ref: RemoteTurnRef,
    outcomes: RecoveredOutcome[],
    reasons: string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (ref.turnId === null) {
      reasons.push(unknownTurnReason(ref, "no turn id was checkpointed"));
      return;
    }
    const turnId = ref.turnId;
    let observed = await observeTurn(this.#appServer, ref, turnId);
    if (observed.state === "running" && ref.access === "readOnly") {
      observed = await this.#awaitReadOnly(ref, turnId, observed, signal);
    }
    if (observed.state !== "terminal") {
      reasons.push(
        observed.state === "unknown"
          ? unknownTurnReason(ref, observed.reason)
          : runningTurnReason(ref, this.#awaitRunningTurn !== undefined),
      );
      return;
    }

    if (ref.role === "admission") {
      if (isWaitingCheckpointRef(snapshot, ref)) {
        return;
      }
      if (snapshot.result.status === "pending") {
        reasons.push("terminal admission work was not committed; recovery will not replay it");
      }
      return;
    }
    if (ref.role === "planner") {
      if (snapshot.result.plan === null) {
        reasons.push("terminal planner work was not committed; recovery will not replay it");
      }
      return;
    }
    if (ref.role !== "direct" && ref.role !== "integrator" && ref.role !== "finalReview") {
      return;
    }
    if (isWaitingCheckpointRef(snapshot, ref)) {
      return;
    }
    if (ref.role === "integrator" && snapshot.integrationCheckpoint !== undefined) {
      const checkpointError = validateIntegrationCheckpoint(snapshot, ref);
      if (checkpointError !== null) {
        reasons.push(unknownTurnReason(ref, checkpointError));
        return;
      }
      outcomes.push({
        role: "integrator",
        updatedAt: snapshot.integrationCheckpoint.updatedAt,
        outcome: {
          status: "completed",
          response: snapshot.integrationCheckpoint.response,
          validation: structuredClone(snapshot.integrationCheckpoint.validation),
        },
      });
      return;
    }
    if (
      (ref.role === "integrator" || ref.role === "finalReview") &&
      (snapshot.result.plan?.integration.validation.length ?? 0) > 0
    ) {
      reasons.push(
        unknownTurnReason(
          ref,
          "the deterministic integration validation result was not persisted; recovery will not replay validators",
        ),
      );
      return;
    }

    try {
      const turn = await runtimeFor(this.#appServer).readCompletedTurn(ref.threadId, turnId);
      if (turn === null) {
        reasons.push(unknownTurnReason(ref, "thread/read no longer reports a terminal turn"));
        return;
      }
      const body = strictFinalJson(turn);
      if (ref.role === "finalReview") {
        outcomes.push({
          role: ref.role,
          updatedAt: ref.updatedAt,
          review: parseFinalReviewBody(body),
        });
        return;
      }
      const outcome =
        ref.role === "integrator" ? parseIntegratorOutcomeBody(body) : parseAgentOutcomeBody(body);
      if (ref.role === "integrator" && (outcome.planIssues?.length ?? 0) > 0) {
        reasons.push(
          unknownTurnReason(
            ref,
            `Terra integration reported unresolved plan issues: ${outcome
              .planIssues!.map((issue) => issue.summary)
              .join("; ")}`,
          ),
        );
        return;
      }
      outcomes.push({
        role: ref.role,
        updatedAt: ref.updatedAt,
        outcome,
      });
    } catch (error) {
      reasons.push(
        unknownTurnReason(ref, `terminal result is not trustworthy: ${errorMessage(error)}`),
      );
    }
  }

  async #awaitReadOnly(
    ref: RemoteTurnRef,
    turnId: string,
    observed: ObservedTurn,
    signal: AbortSignal,
  ): Promise<ObservedTurn> {
    if (observed.state !== "running" || this.#awaitRunningTurn === undefined) {
      return observed;
    }
    try {
      await this.#awaitRunningTurn({
        appServer: this.#appServer,
        threadId: ref.threadId,
        turnId,
        signal,
        timeoutMs: this.#turnTimeoutMs,
      });
      throwIfAborted(signal);
      return observeTurn(this.#appServer, ref, turnId);
    } catch (error) {
      throwIfAborted(signal);
      return {
        state: "unknown",
        reason: `the transport could not await the running turn: ${errorMessage(error)}`,
      };
    }
  }

  #finishResult(
    snapshot: JobSnapshot,
    leaves: Map<string, LeafResult>,
    outcomes: RecoveredOutcome[],
    reasons: string[],
    refs: readonly RemoteTurnRef[],
  ): BatchResult {
    const result: BatchResult = {
      ...structuredClone(snapshot.result),
      leaves: orderedLeaves(snapshot, leaves),
    };
    const uniqueReasons = [...new Set(reasons)];
    if (uniqueReasons.length > 0) {
      return indeterminateResult(result, uniqueReasons.join("; "));
    }

    const finalOutcome = selectFinalOutcome(snapshot, outcomes, refs);
    if (finalOutcome !== null) {
      result.status = finalOutcome.status;
      result.finalResponse = finalOutcome.response;
      assignOptional(result, "needsAction", finalOutcome.needsAction);
      assignOptional(result, "error", finalOutcome.error);
      if (
        result.status === "completed" &&
        hasWorkspaceWriters(snapshot) &&
        snapshot.workspaceCommitState !== "applied"
      ) {
        return indeterminateResult(
          result,
          "the final outcome completed, but isolated writer patches were not durably marked as applied",
        );
      }
      return result;
    }

    if (result.status === "waiting_input") {
      return result;
    }
    const plan = result.plan;
    if (plan !== null) {
      const plannedLeaves = plan.tasks.map((task) => leaves.get(task.id));
      if (plannedLeaves.every((leaf): leaf is LeafResult => leaf !== undefined)) {
        const incomplete = plannedLeaves.filter((leaf) => leaf.status !== "completed");
        if (incomplete.length > 0) {
          const permission = incomplete.find(
            (leaf) => leaf.failureKind === "permission" && leaf.error !== undefined,
          );
          if (permission !== undefined) {
            result.status = "waiting_input";
            result.finalResponse = null;
            result.needsAction = permission.error ?? permission.summary;
            result.error = "leaf requires external permission or input";
            return result;
          }
          const error = incomplete
            .map((leaf) => `${leaf.taskId}: ${leaf.error ?? leaf.summary}`)
            .join("; ");
          if (incomplete.some((leaf) => leaf.status === "indeterminate")) {
            return indeterminateResult(result, error);
          }
          result.status = incomplete.some((leaf) => leaf.status === "cancelled")
            ? "cancelled"
            : "failed";
          result.finalResponse = null;
          result.error = error;
          delete result.needsAction;
          return result;
        }
        if (snapshot.request.integrate === false) {
          result.status = "completed";
          result.finalResponse = plannedLeaves
            .map((leaf) => `${leaf.taskId}: ${leaf.summary}`)
            .join("\n");
          delete result.needsAction;
          delete result.error;
          return result;
        }
      }
    }

    return indeterminateResult(
      result,
      refs.length === 0
        ? "no persisted App Server turn is available for safe recovery"
        : "persisted turns ended before the run produced a final response; recovery will not replay work",
    );
  }
}

function hasWorkspaceWriters(snapshot: JobSnapshot): boolean {
  return snapshot.result.plan?.tasks.some((task) => task.access === "workspaceWrite") ?? false;
}

function recoveryContinuation(
  snapshot: JobSnapshot,
  leaves: ReadonlyMap<string, LeafResult>,
  outcomes: readonly RecoveredOutcome[],
  reasons: string[],
  refs: readonly RemoteTurnRef[],
): RecoveryContinuation | null {
  const plan = snapshot.result.plan;
  if (reasons.length > 0) {
    return null;
  }
  if (snapshot.result.status === "waiting_input") {
    return waitingRecoveryContinuation(snapshot, leaves, refs, reasons);
  }
  if (plan === null) {
    return null;
  }
  const initialLeaves = orderedLeaves(snapshot, leaves);
  if (initialLeaves.some((leaf) => leaf.status !== "completed")) {
    return null;
  }
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const staleLeaves = initialLeaves.filter((leaf) => !tasks.has(leaf.taskId));
  if (staleLeaves.length > 0) {
    reasons.push(
      `persisted leaves are absent from the active execution plan: ${staleLeaves
        .map((leaf) => leaf.taskId)
        .join(", ")}`,
    );
    return null;
  }
  const workspaceWritersMayHaveRun = writersMayHaveRun(snapshot, initialLeaves, refs);
  const integrator = outcomes
    .filter((candidate): candidate is RecoveredAgentOutcome => candidate.role === "integrator")
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0];
  if (
    integrator?.outcome.status === "completed" &&
    integrator.outcome.response !== null &&
    snapshot.integrationCheckpoint !== undefined &&
    !refs.some((ref) => ref.role === "finalReview") &&
    requiresFinalReview(snapshot, integrator.outcome.validation ?? [])
  ) {
    return {
      initialLeaves: structuredClone(initialLeaves),
      workspaceWritersMayHaveRun,
      finalReview: {
        integratedResponse: snapshot.integrationCheckpoint.response,
        integrationValidation: structuredClone(snapshot.integrationCheckpoint.validation),
        integratorThreadId: snapshot.integrationCheckpoint.integratorThreadId,
        launchSkewMs: snapshot.integrationCheckpoint.launchSkewMs,
        peakConcurrency: snapshot.integrationCheckpoint.peakConcurrency,
        replanCount: snapshot.integrationCheckpoint.replanCount,
      },
    };
  }
  if (
    outcomes.length > 0 ||
    refs.some(
      (ref) => ref.role === "direct" || ref.role === "integrator" || ref.role === "finalReview",
    )
  ) {
    return null;
  }
  return {
    initialLeaves: structuredClone(initialLeaves),
    workspaceWritersMayHaveRun,
  };
}

function waitingRecoveryContinuation(
  snapshot: JobSnapshot,
  leaves: ReadonlyMap<string, LeafResult>,
  refs: readonly RemoteTurnRef[],
  reasons: string[],
): RecoveryContinuation | null {
  const checkpoint = snapshot.waitingInputCheckpoint;
  if (checkpoint === undefined) {
    return null;
  }
  const fail = (reason: string): null => {
    reasons.push(`waiting_input checkpoint is invalid: ${reason}`);
    return null;
  };
  if (snapshot.result.needsAction === undefined) {
    return fail("the persisted result has no needsAction");
  }
  const plan = snapshot.result.plan;
  if (checkpoint.kind === "admission" || checkpoint.kind === "direct") {
    if (plan !== null) {
      return fail(`${checkpoint.kind} continuation cannot have an execution plan`);
    }
    if (checkpoint.turn.needsAction !== snapshot.result.needsAction) {
      return fail("needsAction does not match the persisted result");
    }
    const ref = refs.find(
      (candidate) =>
        candidate.role === checkpoint.kind &&
        candidate.threadId === checkpoint.turn.threadId &&
        candidate.turnId === checkpoint.turn.previousTurnId,
    );
    if (ref === undefined || ref.state !== "terminal") {
      return fail(`the ${checkpoint.kind} terminal turn is missing`);
    }
    return {
      initialLeaves: [],
      workspaceWritersMayHaveRun: false,
      waitingInput: structuredClone(checkpoint),
    };
  }
  if (plan === null || checkpoint.planId !== plan.planId) {
    return fail("planId does not match the active execution plan");
  }
  if (checkpoint.kind === "integration") {
    const ordered = orderedLeaves(snapshot, leaves);
    if (
      ordered.length !== plan.tasks.length ||
      ordered.some((leaf) => leaf.status !== "completed") ||
      checkpoint.leafIdentities.length !== ordered.length ||
      checkpoint.leafIdentities.some((identity, index) => {
        const expected = ordered[index];
        return (
          expected === undefined ||
          identity.taskId !== expected.taskId ||
          identity.threadId !== expected.threadId ||
          identity.turnId !== expected.turnId ||
          identity.completedAt !== expected.completedAt
        );
      })
    ) {
      return fail("integration continuation does not match the completed leaves");
    }
    if (
      checkpoint.turn.needsAction !== snapshot.result.needsAction ||
      !refs.some(
        (ref) =>
          ref.role === "integrator" &&
          ref.threadId === checkpoint.turn.threadId &&
          ref.turnId === checkpoint.turn.previousTurnId &&
          ref.state === "terminal",
      )
    ) {
      return fail("the integration terminal turn is missing or mismatched");
    }
    return {
      initialLeaves: structuredClone(ordered),
      workspaceWritersMayHaveRun: writersMayHaveRun(snapshot, ordered, refs),
      waitingInput: structuredClone(checkpoint),
    };
  }

  const points = new Map(checkpoint.leaves.map((point) => [point.taskId, point]));
  if (points.size !== checkpoint.leaves.length || points.size === 0) {
    return fail("leaf continuation points are empty or duplicated");
  }
  const resumable: LeafResult[] = [];
  for (const task of plan.tasks) {
    const leaf = leaves.get(task.id);
    const point = points.get(task.id);
    if (point !== undefined) {
      if (
        leaf === undefined ||
        (leaf.status !== "blocked" && leaf.status !== "failed") ||
        leaf.failureKind !== "permission" ||
        leaf.threadId !== point.threadId ||
        leaf.turnId !== point.previousTurnId ||
        point.needsAction !== (leaf.error ?? leaf.summary) ||
        !refs.some(
          (ref) =>
            ref.role === "leaf" &&
            ref.taskId === task.id &&
            ref.threadId === point.threadId &&
            ref.turnId === point.previousTurnId &&
            (ref.attempt ?? 1) === point.attempt &&
            ref.state === "terminal",
        )
      ) {
        return fail(`leaf continuation for ${task.id} is missing or mismatched`);
      }
      resumable.push(structuredClone(leaf));
      points.delete(task.id);
      continue;
    }
    if (leaf?.status === "completed") {
      resumable.push(structuredClone(leaf));
      continue;
    }
    if (
      leaf !== undefined &&
      leaf.status === "blocked" &&
      task.dependsOn.some((dependency) =>
        checkpoint.leaves.some((item) => item.taskId === dependency),
      )
    ) {
      continue;
    }
    return fail(`leaf ${task.id} is neither completed nor safely resumable`);
  }
  if (points.size > 0) {
    return fail(`leaf continuation references unknown tasks: ${[...points.keys()].join(", ")}`);
  }
  return {
    initialLeaves: resumable,
    workspaceWritersMayHaveRun: writersMayHaveRun(snapshot, resumable, refs),
    waitingInput: structuredClone(checkpoint),
  };
}

function writersMayHaveRun(
  snapshot: JobSnapshot,
  leaves: readonly LeafResult[],
  refs: readonly RemoteTurnRef[],
): boolean {
  const tasks = new Map(snapshot.result.plan?.tasks.map((task) => [task.id, task]) ?? []);
  return (
    leaves.some(
      (leaf) =>
        tasks.get(leaf.taskId)?.access === "workspaceWrite" &&
        (leaf.threadId !== null || leaf.changedFiles.length > 0),
    ) ||
    refs.some(
      (ref) => ref.role === "leaf" && ref.access === "workspaceWrite" && ref.turnId !== null,
    )
  );
}

function isWaitingCheckpointRef(snapshot: JobSnapshot, ref: RemoteTurnRef): boolean {
  if (snapshot.result.status !== "waiting_input") {
    return false;
  }
  const checkpoint = snapshot.waitingInputCheckpoint;
  if (checkpoint === undefined) {
    return false;
  }
  if (checkpoint.kind === "admission" || checkpoint.kind === "direct") {
    return (
      ref.role === checkpoint.kind &&
      ref.threadId === checkpoint.turn.threadId &&
      ref.turnId === checkpoint.turn.previousTurnId
    );
  }
  if (checkpoint.kind === "integration") {
    return (
      ref.role === "integrator" &&
      ref.threadId === checkpoint.turn.threadId &&
      ref.turnId === checkpoint.turn.previousTurnId
    );
  }
  return checkpoint.leaves.some(
    (point) =>
      ref.role === "leaf" &&
      ref.taskId === point.taskId &&
      ref.threadId === point.threadId &&
      ref.turnId === point.previousTurnId,
  );
}

function continuingResult(result: BatchResult, leaves: readonly LeafResult[]): BatchResult {
  const continuing: BatchResult = {
    ...structuredClone(result),
    status: "running",
    leaves: structuredClone([...leaves]),
    finalResponse: null,
  };
  delete continuing.needsAction;
  delete continuing.error;
  return continuing;
}

async function observeTurn(
  server: AppServer,
  ref: RemoteTurnRef,
  turnId: string,
): Promise<ObservedTurn> {
  try {
    const response = await server.threadRead({ threadId: ref.threadId, includeTurns: true });
    const turns = (response.thread as Record<string, unknown>)["turns"];
    if (!Array.isArray(turns)) {
      return { state: "unknown", reason: "thread/read omitted turns" };
    }
    const turn = turns.find((candidate) => isRecord(candidate) && candidate["id"] === turnId);
    if (!isRecord(turn)) {
      return { state: "unknown", reason: "the persisted turn was not found" };
    }
    if (turn["status"] === "inProgress") {
      return { state: "running" };
    }
    if (
      turn["status"] === "completed" ||
      turn["status"] === "failed" ||
      turn["status"] === "interrupted"
    ) {
      return { state: "terminal" };
    }
    return { state: "unknown", reason: "the persisted turn has an unknown status" };
  } catch (error) {
    return { state: "unknown", reason: `thread/read failed: ${errorMessage(error)}` };
  }
}

function latestRemoteRefsByThread(refs: readonly RemoteTurnRef[]): RemoteTurnRef[] {
  const latest = new Map<string, RemoteTurnRef>();
  for (const ref of refs) {
    const key = `${ref.role}:${ref.taskId ?? ""}:${ref.threadId}`;
    const current = latest.get(key);
    if (current === undefined || timestamp(ref.updatedAt) >= timestamp(current.updatedAt)) {
      latest.set(key, structuredClone(ref));
    }
  }
  return [...latest.values()].sort(
    (left, right) => timestamp(left.updatedAt) - timestamp(right.updatedAt),
  );
}

function latestRecoveryRefs(refs: readonly RemoteTurnRef[]): RemoteTurnRef[] {
  const latest = new Map<string, RemoteTurnRef>();
  for (const ref of latestRemoteRefsByThread(refs)) {
    const key =
      ref.role === "leaf" && ref.taskId === undefined
        ? `${ref.role}::${ref.threadId}`
        : `${ref.role}:${ref.taskId ?? ""}`;
    const current = latest.get(key);
    const newerAttempt = (ref.attempt ?? 0) > (current?.attempt ?? 0);
    const sameAttempt = (ref.attempt ?? 0) === (current?.attempt ?? 0);
    if (
      current === undefined ||
      newerAttempt ||
      (sameAttempt && timestamp(ref.updatedAt) >= timestamp(current.updatedAt))
    ) {
      latest.set(key, structuredClone(ref));
    }
  }
  return [...latest.values()].sort(
    (left, right) => timestamp(left.updatedAt) - timestamp(right.updatedAt),
  );
}

function latestThreadFor(
  refs: readonly RemoteTurnRef[],
  roles: readonly RemoteTurnRef["role"][],
): string | null {
  return (
    refs
      .filter((ref) => roles.includes(ref.role))
      .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0]?.threadId ??
    null
  );
}

function selectFinalOutcome(
  snapshot: JobSnapshot,
  outcomes: readonly RecoveredOutcome[],
  refs: readonly RemoteTurnRef[],
): ReturnType<typeof parseAgentOutcomeBody> | null {
  const finalReview = outcomes
    .filter((candidate): candidate is RecoveredFinalReview => candidate.role === "finalReview")
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0];
  const integrator = outcomes
    .filter((candidate): candidate is RecoveredAgentOutcome => candidate.role === "integrator")
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0];

  if (finalReview !== undefined) {
    if (finalReview.review.approved) {
      if (integrator?.outcome.status !== "completed" || integrator.outcome.response === null) {
        return {
          status: "indeterminate",
          response: null,
          validation: integrator?.outcome.validation ?? [],
          error:
            "Sol final review approved the result, but no recoverable Terra response was persisted",
        };
      }
      return integrator.outcome;
    }
    if (finalReview.review.replacementResponse !== undefined) {
      return {
        status: "completed",
        response: finalReview.review.replacementResponse,
        validation: integrator?.outcome.validation ?? [],
      };
    }
    return {
      status: "failed",
      response: null,
      validation: integrator?.outcome.validation ?? [],
      error: `Sol final review rejected the result: ${finalReview.review.issues.join("; ")}`,
    };
  }

  const ordered = outcomes
    .filter((candidate): candidate is RecoveredAgentOutcome => candidate.role !== "finalReview")
    .sort((left, right) => {
      const rank = outcomeRank(right.role) - outcomeRank(left.role);
      return rank === 0 ? timestamp(right.updatedAt) - timestamp(left.updatedAt) : rank;
    });
  for (const candidate of ordered) {
    if (
      candidate.role === "integrator" &&
      candidate.outcome.status === "completed" &&
      candidate.outcome.response !== null &&
      requiresFinalReview(snapshot, candidate.outcome.validation ?? [])
    ) {
      const reviewWasStarted = refs.some((ref) => ref.role === "finalReview");
      if (!reviewWasStarted) {
        continue;
      }
    }
    return candidate.outcome;
  }
  return null;
}

function validateIntegrationCheckpoint(snapshot: JobSnapshot, ref: RemoteTurnRef): string | null {
  const checkpoint = snapshot.integrationCheckpoint;
  const plan = snapshot.result.plan;
  if (checkpoint === undefined || plan === null) {
    return "the integration checkpoint or active plan is missing";
  }
  if (checkpoint.planId !== plan.planId) {
    return "the integration checkpoint does not match the active plan";
  }
  if (checkpoint.integratorThreadId !== ref.threadId) {
    return "the integration checkpoint does not match the persisted Terra thread";
  }
  if (!Number.isFinite(Date.parse(checkpoint.updatedAt))) {
    return "the integration checkpoint timestamp is invalid";
  }
  if (
    !Number.isInteger(checkpoint.peakConcurrency) ||
    checkpoint.peakConcurrency < 0 ||
    !Number.isInteger(checkpoint.replanCount) ||
    checkpoint.replanCount < 0 ||
    checkpoint.replanCount > 1 ||
    (checkpoint.launchSkewMs !== null &&
      (!Number.isFinite(checkpoint.launchSkewMs) || checkpoint.launchSkewMs < 0))
  ) {
    return "the integration checkpoint contains invalid scheduler metrics";
  }
  const expectedLeaves = snapshot.result.leaves.map(leafIdentity);
  if (
    checkpoint.leafIdentities.length !== expectedLeaves.length ||
    checkpoint.leafIdentities.some((identity, index) => {
      const expected = expectedLeaves[index];
      return (
        expected === undefined ||
        identity.taskId !== expected.taskId ||
        identity.threadId !== expected.threadId ||
        identity.turnId !== expected.turnId ||
        identity.completedAt !== expected.completedAt
      );
    })
  ) {
    return "the integration checkpoint does not match the persisted leaf results";
  }
  const specs = plan.integration.validation;
  if (
    checkpoint.validation.length !== specs.length ||
    checkpoint.validation.some((result, index) => result.command !== specs[index]?.command)
  ) {
    return "the integration checkpoint does not match the deterministic validation contract";
  }
  return null;
}

function leafIdentity(leaf: LeafResult): {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  completedAt: string;
} {
  return {
    taskId: leaf.taskId,
    threadId: leaf.threadId,
    turnId: leaf.turnId,
    completedAt: leaf.completedAt,
  };
}

function requiresFinalReview(
  snapshot: JobSnapshot,
  integrationValidation: readonly { status: "passed" | "failed" | "skipped" }[],
): boolean {
  const plan = snapshot.result.plan;
  if (plan === null || plan.integration.finalReview === "never") {
    return false;
  }
  if (plan.integration.finalReview === "always" || plan.risk === "high") {
    return true;
  }
  if (snapshot.result.patch !== null) {
    return true;
  }
  if (integrationValidation.some((validation) => validation.status !== "passed")) {
    return true;
  }
  return snapshot.result.leaves.some((leaf) => {
    const task = plan.tasks.find((candidate) => candidate.id === leaf.taskId);
    return (
      (task?.critical === true && leaf.confidence < 0.7) ||
      leaf.validation.some((validation) => validation.status === "failed")
    );
  });
}

function outcomeRank(role: RecoveredAgentOutcome["role"]): number {
  return role === "integrator" ? 2 : 1;
}

function orderedLeaves(
  snapshot: JobSnapshot,
  leaves: ReadonlyMap<string, LeafResult>,
): LeafResult[] {
  const ordered: LeafResult[] = [];
  const seen = new Set<string>();
  for (const task of snapshot.result.plan?.tasks ?? []) {
    const leaf = leaves.get(task.id);
    if (leaf !== undefined) {
      ordered.push(structuredClone(leaf));
      seen.add(task.id);
    }
  }
  for (const leaf of leaves.values()) {
    if (!seen.has(leaf.taskId)) {
      ordered.push(structuredClone(leaf));
    }
  }
  return ordered;
}

function indeterminateLeaf(
  ref: RemoteTurnRef,
  taskId: string,
  now: Date,
  reason: string,
): LeafResult {
  return {
    taskId,
    status: "indeterminate",
    summary:
      ref.access === "workspaceWrite"
        ? "leaf result is indeterminate; workspace changes may have occurred"
        : "leaf result is indeterminate; its read-only turn could not be reattached",
    confidence: 0,
    findings: [],
    changedFiles: [],
    validation: [],
    citations: [],
    artifacts: [],
    messages: [],
    threadId: ref.threadId,
    turnId: ref.turnId,
    usage: [],
    startedAt: null,
    completedAt: now.toISOString(),
    error: reason,
    failureKind: "unknown",
  };
}

function indeterminateResult(result: BatchResult, reason: string): BatchResult {
  result.status = "indeterminate";
  result.finalResponse = null;
  result.error = reason;
  delete result.needsAction;
  return result;
}

function runningTurnReason(ref: RemoteTurnRef, hasAwaiter: boolean): string {
  if (ref.access === "workspaceWrite") {
    return `workspace writer '${remoteLabel(ref)}' is still running; workspace changes may have occurred`;
  }
  return hasAwaiter
    ? `read-only turn '${remoteLabel(ref)}' remained running after reattachment`
    : `read-only turn '${remoteLabel(ref)}' is still running and this transport cannot await it`;
}

function unknownTurnReason(ref: RemoteTurnRef, detail: string): string {
  const consequence =
    ref.access === "workspaceWrite" ? "; workspace changes may have occurred" : "";
  return `${remoteLabel(ref)} is indeterminate: ${detail}${consequence}`;
}

function remoteLabel(ref: RemoteTurnRef): string {
  return ref.taskId === undefined ? ref.role : `${ref.role}:${ref.taskId}`;
}

function cancellationRef(threadId: string, turnId: string, now: Date): RemoteTurnRef {
  return {
    role: "leaf",
    threadId,
    turnId,
    access: "readOnly",
    state: "running",
    updatedAt: now.toISOString(),
  };
}

function assignOptional<K extends "needsAction" | "error">(
  result: BatchResult,
  key: K,
  value: BatchResult[K],
): void {
  if (value === undefined) {
    delete result[key];
  } else {
    result[key] = value;
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new AppServerAdapterError("aborted", "recovery aborted");
}

function waitForPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new AppServerAdapterError("aborted", "recovery aborted"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
