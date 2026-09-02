import type { Readable, Writable } from "node:stream";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RequestId = string | number;

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface AppServerConnection {
  /** Bytes received from app-server. */
  readonly readable: Readable;
  /** Bytes sent to app-server. */
  readonly writable: Writable;
  /** Rejects when the underlying process or proxy fails unexpectedly. */
  readonly closed?: Promise<void>;
  close(): Promise<void>;
}

export type AppServerConnectionFactory = () => AppServerConnection | Promise<AppServerConnection>;

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: string[] | null;
  extensions?: JsonObject | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface AppServerNotification<TParams = JsonValue | undefined> {
  method: string;
  params: TParams;
  emittedAtMs?: number;
}

export interface AppServerServerRequest<TParams = JsonValue | undefined> {
  id: RequestId;
  method: string;
  params: TParams;
}

export type ServerRequestHandler<
  TParams = JsonValue | undefined,
  TResult extends JsonValue = JsonValue,
> = (request: AppServerServerRequest<TParams>, signal: AbortSignal) => TResult | Promise<TResult>;

export type NotificationHandler = (notification: AppServerNotification) => void | Promise<void>;
export type ConnectionErrorHandler = (error: Error) => void;

export interface NotificationWaitOptions {
  predicate?: (notification: AppServerNotification) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | { type: "inputAudio"; audioUrl: string };

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

export type DynamicToolCallHandler = ServerRequestHandler<
  DynamicToolCallParams,
  DynamicToolCallResponse & JsonObject
>;

export const APPROVAL_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

export type ApprovalRequestMethod = (typeof APPROVAL_REQUEST_METHODS)[number];
export type ApprovalRequestHandler = ServerRequestHandler<JsonObject, JsonObject>;

export interface DynamicToolFunctionSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
}

export interface DynamicToolNamespaceTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
}

export interface DynamicToolNamespaceSpec {
  type: "namespace";
  name: string;
  description: string;
  tools: DynamicToolNamespaceTool[];
}

export type DynamicToolSpec = DynamicToolFunctionSpec | DynamicToolNamespaceSpec;

export type ApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type NetworkAccess = "restricted" | "enabled";

/** Exact command sandbox policy shape exposed by codex-cli 0.151.0. */
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: NetworkAccess }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export interface CommandExecTerminalSize {
  cols: number;
  rows: number;
}

/** Standalone argv execution request exposed by codex-cli 0.151.0. */
export interface CommandExecParams {
  command: string[];
  processId?: string | null;
  tty?: boolean;
  streamStdin?: boolean;
  streamStdoutStderr?: boolean;
  outputBytesCap?: number | null;
  disableOutputCap?: boolean;
  disableTimeout?: boolean;
  timeoutMs?: number | null;
  cwd?: string | null;
  env?: Record<string, string | null> | null;
  size?: CommandExecTerminalSize | null;
  sandboxPolicy?: SandboxPolicy | null;
  permissionProfile?: string | null;
}

export interface CommandExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  allowProviderModelFallback?: boolean;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  ephemeral?: boolean | null;
  historyMode?: "legacy" | "paginated" | null;
  sessionStartSource?: "startup" | "clear" | null;
  threadSource?: string | null;
  projectId?: string | null;
  environments?: JsonValue[] | null;
  dynamicTools?: DynamicToolSpec[] | null;
  selectedCapabilityRoots?: JsonValue[] | null;
  experimentalRawEvents?: boolean;
}

export interface ThreadResumeParams {
  threadId: string;
  history?: JsonValue[] | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  excludeTurns?: boolean;
  initialTurnsPage?: JsonObject | null;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

/** Exact experimental thread/fork request exposed by codex-cli 0.151.0. */
export interface ThreadForkParams {
  threadId: string;
  lastTurnId?: string | null;
  beforeTurnId?: string | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean;
  threadSource?: string | null;
  excludeTurns?: boolean;
  deferGoalContinuation?: boolean;
}

/** Raw Responses API items appended to a thread without running a model turn. */
export interface ThreadInjectItemsParams {
  threadId: string;
  items: JsonValue[];
}

/** Replace a paginated thread's durable history with the prefix before one turn. */
export interface ThreadRevertParams {
  threadId: string;
  beforeTurnId: string;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: JsonValue[] }
  | { type: "image"; detail?: "auto" | "low" | "high" | "original"; url: string }
  | { type: "localImage"; detail?: "auto" | "low" | "high" | "original"; path: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  responsesapiClientMetadata?: Record<string, string> | null;
  additionalContext?: JsonObject | null;
  environments?: JsonValue[] | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandboxPolicy?: JsonValue | null;
  permissions?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: "auto" | "concise" | "detailed" | "none" | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  outputSchema?: JsonValue | null;
  collaborationMode?: JsonValue | null;
}

export interface TurnSteerParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  responsesapiClientMetadata?: Record<string, string> | null;
  additionalContext?: JsonObject | null;
  expectedTurnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type AppServerThread = JsonObject & { id: string };
export type AppServerTurn = JsonObject & { id: string };

export type ThreadStartResponse = JsonObject & {
  thread: AppServerThread;
  model: string;
  modelProvider: string;
  cwd: string;
  serviceTier?: string | null;
  runtimeWorkspaceRoots?: string[];
  instructionSources: string[];
  reasoningEffort?: string | null;
  multiAgentMode?: string;
};

export type ThreadResumeResponse = ThreadStartResponse & {
  initialTurnsPage?: JsonValue;
  turnsBackwardsCursor?: string | null;
  itemsBackwardsCursor?: string | null;
};

export type ThreadForkResponse = ThreadStartResponse;
export type ThreadInjectItemsResponse = JsonObject;
export type ThreadRevertResponse = JsonObject & {
  thread: AppServerThread;
  turnsBackwardsCursor: string | null;
  itemsBackwardsCursor: string | null;
};
export type ThreadReadResponse = JsonObject & { thread: AppServerThread };
export type TurnStartResponse = JsonObject & { turn: AppServerTurn };
export type TurnSteerResponse = JsonObject & { turnId: string };
export type TurnInterruptResponse = JsonObject;

export interface ThreadUsageBreakdownGroup {
  model: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  estimatedUsageCreditsMicros: number;
  netNewInputTokens: number | null;
  cachedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ThreadUsage {
  threadId: string;
  estimatedUsageCreditsMicros: number;
  estimatedUsageUsdMicros: number | null;
  groups: ThreadUsageBreakdownGroup[];
}

export interface AccountTokenUsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface AccountTokenUsageDailyBucket {
  startDate: string;
  tokens: number;
}

export type ThreadUsageResponse = JsonObject & {
  summary: AccountTokenUsageSummary & JsonObject;
  dailyUsageBuckets: (AccountTokenUsageDailyBucket & JsonObject)[] | null;
  threadUsage?: (ThreadUsage & JsonObject) | null;
};

export type AppServerModel = JsonObject & {
  id: string;
  model: string;
  upgrade: string | null;
  upgradeInfo: JsonObject | null;
  availabilityNux: JsonObject | null;
  displayName: string;
  description: string;
  modelSpecialty: string | null;
  hidden: boolean;
  supportedReasoningEfforts: (JsonObject & {
    reasoningEffort: string;
    description: string;
  })[];
  defaultReasoningEffort: string;
  inputModalities: ("text" | "image" | "audio")[];
  supportsPersonality: boolean;
  multiAgentVersion: "disabled" | "v1" | "v2" | null;
  additionalSpeedTiers: string[];
  serviceTiers: (JsonObject & { id: string; name: string; description: string })[];
  defaultServiceTier: string | null;
  isDefault: boolean;
};

export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}

export type ModelListResponse = JsonObject & {
  data: AppServerModel[];
  nextCursor: string | null;
};

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Defaults to zero in the App Server schema and may be absent in legacy payloads. */
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface ThreadTokenUsageUpdated {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
}

export type AppServerState = "disconnected" | "connecting" | "ready" | "closing";

/** Narrow surface used by the orchestrator and straightforward to replace with a fake. */
export interface AppServer {
  readonly state: AppServerState;
  readonly initializeResult: InitializeResponse | null;
  connect(): Promise<InitializeResponse>;
  reconnect(): Promise<InitializeResponse>;
  close(): Promise<void>;
  request<TResult = JsonValue>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(handler: NotificationHandler): () => void;
  onNotification(method: string, handler: NotificationHandler): () => void;
  /** Optional transport lifecycle hook used to fail active turn joins immediately. */
  onConnectionError?(handler: ConnectionErrorHandler): () => void;
  waitForNotification(
    method?: string,
    options?: NotificationWaitOptions,
  ): Promise<AppServerNotification>;
  setServerRequestHandler(method: string, handler: ServerRequestHandler | null): void;
  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse>;
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  threadFork?(params: ThreadForkParams): Promise<ThreadForkResponse>;
  threadInjectItems?(params: ThreadInjectItemsParams): Promise<ThreadInjectItemsResponse>;
  threadRevert?(params: ThreadRevertParams): Promise<ThreadRevertResponse>;
  threadRead(params: ThreadReadParams): Promise<ThreadReadResponse>;
  turnStart(params: TurnStartParams): Promise<TurnStartResponse>;
  turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse>;
  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse>;
  commandExec?(params: CommandExecParams, options?: RequestOptions): Promise<CommandExecResponse>;
  threadUsage(threadId: string): Promise<ThreadUsageResponse>;
  modelList(params?: ModelListParams): Promise<ModelListResponse>;
  latestThreadTokenUsage(threadId: string): ThreadTokenUsageUpdated | null;
}

export interface AppServerClientOptions {
  connectionFactory: AppServerConnectionFactory;
  initialize?: {
    clientInfo?: Partial<ClientInfo>;
    capabilities?: Partial<InitializeCapabilities> | null;
  };
  notificationBufferSize?: number;
  /** Keep high-volume delta notifications for later waiters; production orchestration disables it. */
  bufferNotificationDeltas?: boolean;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  onError?: (error: Error) => void;
  serverRequestHandlers?: Readonly<Record<string, ServerRequestHandler>>;
  onDynamicToolCall?: DynamicToolCallHandler;
  onApprovalRequest?: ApprovalRequestHandler;
}
