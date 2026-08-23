export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const MODEL_TIERS = ["sol", "terra", "luna"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const REASONING_EFFORTS = ["high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const AGENT_ROLES = ["director", "coordinator", "operator", "verifier", "advisor"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const MISSION_STATUSES = ["active", "completed", "cancelled"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_STRATEGIES = ["direct", "fanout", "director_plan", "pipeline"] as const;
export type MissionStrategy = (typeof MISSION_STRATEGIES)[number];

export const PORTRAIT_LEVELS = ["low", "medium", "high"] as const;
export type PortraitLevel = (typeof PORTRAIT_LEVELS)[number];

export const VALIDATOR_STRENGTHS = ["strong", "weak", "none"] as const;
export type ValidatorStrength = (typeof VALIDATOR_STRENGTHS)[number];

export interface MissionPortrait extends JsonObject {
  ambiguity: PortraitLevel;
  coupling: PortraitLevel;
  parallelism: PortraitLevel;
  validator: ValidatorStrength;
}

export const TASK_STATUSES = [
  "proposed",
  "ready",
  "leased",
  "running",
  "blocked",
  "candidate",
  "checked",
  "verified",
  "committed",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CLAIM_STATUSES = [
  "candidate",
  "checked",
  "verified",
  "disputed",
  "rejected",
  "superseded",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const REVIEW_STAGES = ["check", "verify"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export interface BudgetLimits extends JsonObject {
  tokens?: number;
  costUsd?: number;
  wallClockSeconds?: number;
  toolCalls?: number;
  maxChildren?: number;
}

export interface Usage extends JsonObject {
  tokens: number;
  costUsd: number;
  wallClockSeconds: number;
  toolCalls: number;
}

export interface Mission {
  id: string;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  risk: RiskLevel;
  status: MissionStatus;
  strategy: MissionStrategy;
  portrait: MissionPortrait | null;
  /** Workspace-relative `.md` path when strategy is `director_plan`. */
  directorPlan: string | null;
  budget: BudgetLimits;
  usage: Usage;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  missionId: string;
  parentTaskId: string | null;
  objective: string;
  role: AgentRole;
  model: ModelTier;
  reasoningEffort: ReasoningEffort;
  maxEffort: ReasoningEffort;
  capabilityPack: string;
  status: TaskStatus;
  dependencies: string[];
  inputArtifactRefs: string[];
  allowedTools: string[];
  doneCriteria: string[];
  outputSchema: JsonObject | null;
  risk: RiskLevel;
  budget: BudgetLimits;
  usage: Usage;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  producerId: string | null;
  summary: string | null;
  unresolved: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  missionId: string;
  taskId: string;
  kind: string;
  mimeType: string;
  sha256: string;
  byteLength: number;
  storageUri: string;
  metadata: JsonObject;
  createdBy: string;
  createdAt: string;
}

export interface Claim {
  id: string;
  missionId: string;
  taskId: string;
  statement: string;
  status: ClaimStatus;
  confidence: number | null;
  evidenceRefs: string[];
  artifactId: string | null;
  producerId: string;
  verifierId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Review {
  id: string;
  missionId: string;
  taskId: string;
  stage: ReviewStage;
  reviewerId: string;
  approved: boolean;
  evidenceRefs: string[];
  notes: string;
  createdAt: string;
}

export interface AuditEvent {
  sequence: number;
  missionId: string;
  taskId: string | null;
  type: string;
  actorId: string;
  payload: JsonObject;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface RecoverySnapshot {
  mission: Mission;
  tasks: Task[];
  artifacts: Artifact[];
  claims: Claim[];
  reviews: Review[];
  events: AuditEvent[];
}

export interface ChildStatus {
  id: string;
  status: TaskStatus;
  version: number;
  risk: RiskLevel;
  summary: string | null;
  unresolved: string[];
  artifactRefs: string[];
  producerId: string | null;
  updatedAt: string;
  leaseExpired: boolean;
}

export interface ChildrenStatus {
  parentTaskId: string;
  children: ChildStatus[];
  allTerminal: boolean;
}

export const ZERO_USAGE: Usage = {
  tokens: 0,
  costUsd: 0,
  wallClockSeconds: 0,
  toolCalls: 0,
};
