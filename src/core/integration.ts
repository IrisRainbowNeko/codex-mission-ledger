import type {
  BatchResult,
  CapabilityRef,
  ExecutionPlan,
  JobSnapshot,
  LeafResult,
  ModelUsage,
  RemoteTurnRef,
  RunRequest,
  ValidationResult,
  ValidationSpec,
} from "./contracts.js";

export type MaybePromise<T> = T | Promise<T>;

export type PlannedExecutionRoute = "fanout" | "planned_single";

export interface WaitingTurnContext {
  threadId: string;
  previousTurnId: string;
  cwd: string;
  capabilities: CapabilityRef[];
}

export type AdmissionDecision =
  | {
      route: "direct";
      reason: string;
      outcome?: AgentOutcome;
      usage?: ModelUsage[];
      threadId?: string | null;
      estimatedDirectCostUsd?: number | null;
      estimatedFanoutCostUsd?: number | null;
      estimatedDirectSeconds?: number | null;
      estimatedFanoutSeconds?: number | null;
      suggestedMaxLeaves?: number;
    }
  | {
      route: PlannedExecutionRoute;
      reason: string;
      usage?: ModelUsage[];
      threadId?: string | null;
      estimatedDirectCostUsd?: number | null;
      estimatedFanoutCostUsd?: number | null;
      estimatedDirectSeconds?: number | null;
      estimatedFanoutSeconds?: number | null;
      suggestedMaxLeaves?: number;
    }
  | {
      route: "waiting_input";
      reason: string;
      needsAction: string;
      usage?: ModelUsage[];
      threadId?: string | null;
      waitingTurn?: WaitingTurnContext;
      estimatedDirectCostUsd?: number | null;
      estimatedFanoutCostUsd?: number | null;
      estimatedDirectSeconds?: number | null;
      estimatedFanoutSeconds?: number | null;
      suggestedMaxLeaves?: number;
    };

export interface AdmissionController {
  decide(input: {
    runId: string;
    request: RunRequest;
    signal: AbortSignal;
  }): MaybePromise<AdmissionDecision>;
  resumeAdmission?(input: {
    runId: string;
    request: RunRequest;
    continuation: WaitingTurnContext;
    userInput?: string;
    signal: AbortSignal;
  }): MaybePromise<AdmissionDecision>;
}

export type ExecutionOutcomeStatus = "completed" | "waiting_input" | "failed" | "indeterminate";

export interface AgentOutcome {
  status: ExecutionOutcomeStatus;
  response: string | null;
  threadId: string | null;
  usage: ModelUsage[];
  validation?: ValidationResult[];
  needsAction?: string;
  error?: string;
  planIssues?: IntegrationPlanIssue[];
  waitingTurn?: WaitingTurnContext;
}

export interface IntegrationPlanIssue {
  type: "contract_incomplete" | "result_conflict" | "scope_change";
  taskIds: string[];
  summary: string;
}

export interface DeterministicValidator {
  validate(input: {
    specs: readonly ValidationSpec[];
    baseCwd: string;
    access: "readOnly" | "workspaceWrite";
    signal: AbortSignal;
  }): Promise<ValidationResult[]>;
}

export interface DirectExecutor {
  execute(input: {
    runId: string;
    request: RunRequest;
    signal: AbortSignal;
  }): Promise<AgentOutcome>;
  resumeDirect?(input: {
    runId: string;
    request: RunRequest;
    continuation: WaitingTurnContext;
    userInput?: string;
    signal: AbortSignal;
  }): Promise<AgentOutcome>;
}

export interface IntegrationInput {
  runId: string;
  request: RunRequest;
  plan: ExecutionPlan;
  leaves: readonly LeafResult[];
  coordinatorThreadId?: string | null;
  plannerThreadId: string;
  signal: AbortSignal;
}

export interface ResultIntegrator {
  integrate(input: IntegrationInput): Promise<AgentOutcome>;
  resumeIntegration?(
    input: IntegrationInput & {
      continuation: WaitingTurnContext;
      userInput?: string;
    },
  ): Promise<AgentOutcome>;
}

export interface FinalReviewInput extends IntegrationInput {
  integratedResponse: string;
  integrationValidation: readonly ValidationResult[];
  integratorThreadId: string | null;
}

export interface FinalReviewResult {
  approved: boolean;
  issues: string[];
  /** Present only when Sol must replace a materially incorrect Terra response. */
  replacementResponse?: string | null;
  threadId: string;
  usage: ModelUsage[];
}

export interface FinalReviewer {
  review(input: FinalReviewInput): Promise<FinalReviewResult>;
}

export interface WorkspaceController {
  prepare(input: { runId: string; request: RunRequest; plan: ExecutionPlan }): Promise<void>;
  /** Reattach durable writer workspaces that may contain changes from before a crash. */
  resume?(input: {
    runId: string;
    request: RunRequest;
    plan: ExecutionPlan;
    results: readonly LeafResult[];
  }): Promise<void>;
  updatePlan?(runId: string, plan: ExecutionPlan): Promise<void>;
  prepareTask?(
    runId: string,
    task: ExecutionPlan["tasks"][number],
    dependencies: readonly LeafResult[],
  ): Promise<string>;
  /**
   * Materialize all completed writer patches in an isolated read-only snapshot for aggregate
   * validation before the patches are applied to the user's workspace.
   */
  prepareValidation?(runId: string, results: readonly LeafResult[]): Promise<string>;
  integrate(runId: string, results: readonly LeafResult[]): Promise<void>;
  cleanup(runId: string): Promise<void>;
}

export interface ReattachResult {
  result: BatchResult;
  coordinatorThreadId?: string | null;
  plannerThreadId?: string | null;
  integratorThreadId?: string | null;
  continuation?: {
    initialLeaves: LeafResult[];
    workspaceWritersMayHaveRun: boolean;
    /** Resume exactly the missing review stage without replaying leaves or Terra integration. */
    finalReview?: {
      integratedResponse: string;
      integrationValidation: ValidationResult[];
      integratorThreadId: string | null;
      launchSkewMs: number | null;
      peakConcurrency: number;
      replanCount: number;
    };
    waitingInput?: JobSnapshot["waitingInputCheckpoint"];
  };
}

export interface RemoteCancellationResult {
  /** Latest state for every nonterminal ref supplied to the adapter. */
  remoteTurns: RemoteTurnRef[];
  /** True only when every supplied remote turn was observed in a terminal state. */
  allTerminal: boolean;
  reasons: string[];
}

/**
 * Recovery is deliberately an adapter boundary: only the App Server layer can
 * safely reattach persisted thread/turn ids without repeating side effects.
 */
export interface RecoveryAdapter {
  reattach(input: { snapshot: JobSnapshot; signal: AbortSignal }): Promise<ReattachResult>;
  cancel?(input: { snapshot: JobSnapshot }): Promise<RemoteCancellationResult>;
}

export class WaitingInputError extends Error {
  readonly needsAction: string;

  constructor(needsAction: string, message = "external input is required") {
    super(message);
    this.name = "WaitingInputError";
    this.needsAction = needsAction;
  }
}
