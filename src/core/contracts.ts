export const AGENT_TRIO_PROTOCOL_VERSION = 1 as const;
export const CODEX_APP_SERVER_VERSION = "0.151.0" as const;

export type ModelTier = "luna" | "terra" | "sol";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ExecutionStrategy = "auto" | "direct" | "fanout";
export type AggregationMode = "auto" | "deterministic" | "terra";
export type ValidatorStrength = "none" | "weak" | "strong";
export type TaskAccess = "readOnly" | "workspaceWrite";
export type HostAccess = "readOnly" | "workspaceWrite" | "fullAccess";
export type HostApproval = "never" | "approveForMe";
export type TaskDomain =
  "coding" | "algorithm" | "research" | "paper" | "office" | "autoResearch" | "general";
export type JobMode = "foreground" | "durable";
export type JobStatus =
  | "pending"
  | "planning"
  | "running"
  | "integrating"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";
export type LeafStatus =
  "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled" | "indeterminate";
export type AgentMessageType = "question" | "answer" | "contract_change" | "blocker" | "result";

export interface CapabilityRef {
  kind: "skill" | "plugin";
  name: string;
  path?: string;
}

export interface ValidationSpec {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface IntegrationContract {
  objective: string;
  requiredOutputs: string[];
  validation: ValidationSpec[];
  finalReview: "never" | "riskTriggered" | "always";
  aggregation?: AggregationMode;
}

export interface LeafTask {
  id: string;
  objective: string;
  domain: TaskDomain;
  tier: ModelTier;
  /** Minimum semantic tier requested by the planner; runtime may choose a cheaper effective tier. */
  minTier?: ModelTier;
  effort: ReasoningEffort;
  access: TaskAccess;
  ownedPaths: string[];
  dependsOn: string[];
  capabilities: CapabilityRef[];
  validation: ValidationSpec[];
  communicationWith: string[];
  expectedSeconds: number;
  expectedCostUsd?: number;
  difficulty: number;
  ambiguity: number;
  confidence: number;
  critical: boolean;
  validatorStrength?: ValidatorStrength;
}

export interface ExecutionPlan {
  protocolVersion: typeof AGENT_TRIO_PROTOCOL_VERSION;
  planId: string;
  objective: string;
  domain: TaskDomain;
  assumptions: string[];
  tasks: LeafTask[];
  integration: IntegrationContract;
  risk: "low" | "medium" | "high";
  origin?: "template" | "sol";
}

/** Compact semantic choices a host Sol can submit without starting another Sol child thread. */
export interface SemanticTask {
  id: string;
  objective: string;
  paths: string[];
  after: string[];
  floor: ModelTier | null;
  /** Planner estimate of real leaf execution time, excluding planning and integration. */
  expectedSeconds: number;
  difficulty: number;
  ambiguity: number;
  checks: string[];
  capabilities: string[];
}

export interface SemanticPlan {
  id: string;
  tasks: SemanticTask[];
  merge: "deterministic" | "terra";
  risk: "low" | "medium" | "high";
}

/**
 * Semantic choices emitted by the already-running host Sol. Mechanical validation and
 * capability selection stay inside the runtime so the tool call is short and cannot invent
 * unavailable capability keys or prose-shaped shell commands.
 */
export interface HostSemanticTask {
  /** Null means apply the complete user objective to this task's owned paths. */
  goal: string | null;
  paths: string[];
  /** Zero-based indexes of prerequisite tasks in the same host plan. */
  after: number[];
  floor: ModelTier | null;
  /** Host Sol estimate of real leaf execution time, excluding planning and integration. */
  expectedSeconds: number;
}

export interface HostSemanticPlan {
  /** All leaves share one access mode; mixed read/write plans require the full planner. */
  access: "readOnly" | "workspaceWrite";
  /** Host adoption supports only a local, deterministic result merge. */
  merge: "deterministic" | "terra";
  /** The host must declare risk explicitly instead of relying on a runtime default. */
  risk: "low" | "medium" | "high";
  tasks: HostSemanticTask[];
}

export type PlanPatchOperation =
  | { op: "add"; task: LeafTask }
  | { op: "replace"; taskId: string; task: LeafTask }
  | { op: "cancel"; taskId: string; reason: string };

export interface PlanPatch {
  protocolVersion: typeof AGENT_TRIO_PROTOCOL_VERSION;
  planId: string;
  reason: string;
  operations: PlanPatchOperation[];
  integration?: IntegrationContract;
}

export type ReplanTriggerType =
  | "contract_incomplete"
  | "critical_blocker"
  | "result_conflict"
  | "validator_failure"
  | "low_confidence"
  | "budget_deviation"
  | "scope_change"
  | "unvalidated_high_risk";

export interface ReplanTrigger {
  type: ReplanTriggerType;
  taskIds: string[];
  summary: string;
  observedAt: string;
}

export interface AgentMessage {
  id: string;
  type: AgentMessageType;
  fromTaskId: string;
  toTaskId: string | "planner" | "integrator";
  body: string;
  blocking: boolean;
  createdAt: string;
}

export interface ValidationResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
}

export interface Finding {
  text: string;
  path?: string;
  line?: number;
}

export interface Citation {
  title: string;
  url: string;
  claim?: string;
}

export interface ArtifactRef {
  path: string;
  mediaType?: string;
}

export interface LeafIdentity {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  completedAt: string;
}

export interface TokenUsage {
  cachedInputTokens: number;
  /** Tokens written to the provider prompt cache (absent in pre-cache-write snapshots). */
  cacheWriteInputTokens?: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  tier: ModelTier | "other";
  effort: string | null;
  estimatedCostUsd: number | null;
  /** Origin of estimatedCostUsd when the provider/runtime can distinguish it. */
  costSource?: "app_server" | "price_table";
}

export interface StageUsage {
  usage: ModelUsage[];
  estimatedCostUsd: number | null;
}

export interface BatchUsageBreakdown {
  admission: StageUsage;
  direct: StageUsage;
  planning: StageUsage;
  replan: StageUsage;
  leaves: StageUsage;
  integration: StageUsage;
  finalReview: StageUsage;
}

export interface LeafResult {
  taskId: string;
  status: Exclude<LeafStatus, "pending" | "running">;
  summary: string;
  confidence: number;
  findings: Finding[];
  changedFiles: string[];
  validation: ValidationResult[];
  citations: Citation[];
  artifacts: ArtifactRef[];
  messages: AgentMessage[];
  threadId: string | null;
  turnId: string | null;
  usage: ModelUsage[];
  startedAt: string | null;
  completedAt: string;
  error?: string;
  failureKind?: "reasoning" | "transient" | "validation" | "permission" | "contract" | "unknown";
}

export interface ExecutionLimits {
  maxConcurrent: number;
  maxLeaves: number;
  maxWaves: number;
  maxSolLeaves: number;
  maxReplans: number;
  deadlineMs?: number;
  maxCostUsd?: number;
}

export interface RunRequest {
  objective: string;
  cwd: string;
  /** Permission mode of the calling Codex task. Children may inherit it but never exceed it. */
  hostAccess?: HostAccess;
  /** Approval mode of the calling Codex task. Children may inherit it but never strengthen it. */
  hostApproval?: HostApproval;
  strategy?: ExecutionStrategy;
  /** Calling-Sol tier choice for a delegated direct run; valid only with strategy=direct. */
  directTier?: Exclude<ModelTier, "sol">;
  mode?: JobMode;
  domain?: TaskDomain;
  constraints?: string[];
  /** Optional direct-path capabilities; fanout plans still declare capabilities per leaf. */
  capabilities?: CapabilityRef[];
  /** Optional compact plan produced by the calling Sol; skips a second Sol planning turn. */
  semanticPlan?: HostSemanticPlan;
  limits?: Partial<ExecutionLimits>;
  integrate?: boolean;
}

export type AgentTrioRequest =
  | ({ action: "run" } & RunRequest & { runId?: string })
  | ({ action: "submit" } & RunRequest & { runId?: string; monitorFirst?: boolean })
  | { action: "status"; runId: string; wait?: boolean }
  | { action: "cancel"; runId: string }
  | { action: "resume"; runId: string; input?: string };

export interface BatchMetrics {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  planningMs: number;
  integrationMs: number;
  launchSkewMs: number | null;
  peakConcurrency: number;
  replanCount: number;
  userInterventionCount: number;
  usage: ModelUsage[];
  estimatedCostUsd: number | null;
  routeReason?: string;
  selectedLeafCount?: number;
  plannerSkipped?: boolean;
  integrationSkipped?: boolean;
  estimatedDirectCostUsd?: number | null;
  estimatedFanoutCostUsd?: number | null;
  /** Present on V3 results; optional so snapshots produced before stage accounting remain readable. */
  usageByStage?: BatchUsageBreakdown;
}

export interface BatchResult {
  protocolVersion: typeof AGENT_TRIO_PROTOCOL_VERSION;
  runId: string;
  status: JobStatus;
  plan: ExecutionPlan | null;
  patch: PlanPatch | null;
  leaves: LeafResult[];
  finalResponse: string | null;
  metrics: BatchMetrics | null;
  /** Local read-only dashboard for this run. It is absent when monitoring is disabled. */
  monitorUrl?: string;
  needsAction?: string;
  error?: string;
}

/** Durable planner state needed to continue an existing Sol thread after a process restart. */
export interface PlannerSessionState {
  /** Absent in snapshots written before run-scoped planner checkpointing. */
  runId?: string;
  threadId: string;
  request: RunRequest;
  limits: ExecutionLimits;
  initialPlan: ExecutionPlan;
  plan: ExecutionPlan;
  patch: PlanPatch | null;
  replanCount: 0 | 1;
  usage: ModelUsage[];
}

export interface RemoteTurnRef {
  role: "admission" | "direct" | "planner" | "leaf" | "integrator" | "finalReview";
  taskId?: string;
  /** Logical leaf attempt; absent in snapshots written before attempt checkpointing. */
  attempt?: number;
  threadId: string;
  turnId: string | null;
  access: TaskAccess;
  state: "thread_started" | "running" | "terminal";
  /** Per-turn accounting persisted with the terminal checkpoint when capture succeeded. */
  usage?: ModelUsage[];
  updatedAt: string;
}

/**
 * Durable evidence that Terra integration and deterministic aggregate validation completed.
 * It exists only while a required Sol final review has not yet been committed.
 */
export interface IntegrationCheckpoint {
  planId: string;
  leafIdentities: LeafIdentity[];
  response: string;
  validation: ValidationResult[];
  integratorThreadId: string | null;
  launchSkewMs: number | null;
  peakConcurrency: number;
  replanCount: number;
  updatedAt: string;
}

export interface WaitingTurnCheckpoint {
  threadId: string;
  previousTurnId: string;
  cwd: string;
  needsAction: string;
  capabilities: CapabilityRef[];
  updatedAt: string;
}

export interface WaitingLeafResumePoint {
  taskId: string;
  threadId: string;
  previousTurnId: string;
  attempt: number;
  needsAction: string;
}

/** Durable evidence needed to start exactly one continuation turn after external input arrives. */
export type WaitingInputCheckpoint =
  | { kind: "admission"; turn: WaitingTurnCheckpoint }
  | { kind: "direct"; turn: WaitingTurnCheckpoint }
  | {
      kind: "leaves";
      planId: string;
      leaves: WaitingLeafResumePoint[];
      updatedAt: string;
    }
  | {
      kind: "integration";
      planId: string;
      turn: WaitingTurnCheckpoint;
      leafIdentities: LeafIdentity[];
    };

export interface JobSnapshot {
  protocolVersion: typeof AGENT_TRIO_PROTOCOL_VERSION;
  requestHash: string;
  request: RunRequest;
  result: BatchResult;
  remoteTurns: RemoteTurnRef[];
  coordinatorThreadId: string | null;
  plannerThreadId: string | null;
  integratorThreadId: string | null;
  /**
   * Durable commit marker for isolated writer patches. Missing values are legacy snapshots and
   * must never be treated as proof that writer changes reached the user's workspace.
   */
  workspaceCommitState?: "not_applicable" | "pending" | "applied";
  /** Optional for compatibility with snapshots written before crash continuation support. */
  plannerSession?: PlannerSessionState | null;
  startedAt?: string;
  planningMs?: number;
  integrationMs?: number;
  usageByStage?: BatchUsageBreakdown;
  /** Stable remote turn identities whose non-leaf usage is already present in usageByStage. */
  accountedUsageTurnKeys?: string[];
  /** Present only across the crash window between integration and required final review. */
  integrationCheckpoint?: IntegrationCheckpoint;
  /** Present only while a terminal turn is waiting for external input or permission. */
  waitingInputCheckpoint?: WaitingInputCheckpoint;
  updatedAt: string;
}
