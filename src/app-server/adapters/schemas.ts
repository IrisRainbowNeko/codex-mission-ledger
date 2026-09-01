import type { AgentOutcome, ExecutionOutcomeStatus } from "../../core/integration.js";
import type {
  ArtifactRef,
  Citation,
  Finding,
  LeafResult,
  ValidationResult,
} from "../../core/contracts.js";

const MAX_LEAF_SUMMARY_LENGTH = 16_000;

const findingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", minLength: 1, maxLength: 2_000 },
    path: { type: ["string", "null"], maxLength: 4_096 },
    line: { type: ["integer", "null"], minimum: 1 },
  },
  required: ["text", "path", "line"],
} as const;

const validationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4_000 },
    status: { type: "string", enum: ["passed", "failed", "skipped"] },
    summary: { type: "string", maxLength: 2_000 },
  },
  required: ["command", "status", "summary"],
} as const;

const citationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 1_000 },
    url: { type: "string", minLength: 1, maxLength: 4_096 },
    claim: { type: ["string", "null"], maxLength: 2_000 },
  },
  required: ["title", "url", "claim"],
} as const;

const artifactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    mediaType: { type: ["string", "null"], maxLength: 512 },
  },
  required: ["path", "mediaType"],
} as const;

const integrationPlanIssueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["contract_incomplete", "result_conflict", "scope_change"],
    },
    taskIds: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
    summary: { type: "string", minLength: 1, maxLength: 8_000 },
  },
  required: ["type", "taskIds", "summary"],
} as const;

/** The model supplies content only; transport-owned ids, timestamps and usage are injected later. */
export const LEAF_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: MAX_LEAF_SUMMARY_LENGTH },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    findings: { type: "array", maxItems: 32, items: findingSchema },
    changedFiles: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    citations: { type: "array", maxItems: 32, items: citationSchema },
    artifacts: { type: "array", maxItems: 32, items: artifactSchema },
    error: { type: ["string", "null"], maxLength: 4_000 },
    failureKind: {
      type: ["string", "null"],
      enum: ["reasoning", "transient", "validation", "permission", "contract", "unknown", null],
    },
  },
  required: [
    "status",
    "summary",
    "confidence",
    "findings",
    "changedFiles",
    "citations",
    "artifacts",
    "error",
    "failureKind",
  ],
} as const;

export const AGENT_OUTCOME_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["completed", "waiting_input", "failed", "indeterminate"],
    },
    response: { type: ["string", "null"], maxLength: 200_000 },
    validation: { type: "array", maxItems: 64, items: validationSchema },
    needsAction: { type: ["string", "null"], maxLength: 16_000 },
    error: { type: ["string", "null"], maxLength: 16_000 },
  },
  required: ["status", "response", "validation", "needsAction", "error"],
} as const;

export const INTEGRATOR_OUTCOME_OUTPUT_SCHEMA = {
  ...AGENT_OUTCOME_OUTPUT_SCHEMA,
  properties: {
    status: AGENT_OUTCOME_OUTPUT_SCHEMA.properties.status,
    response: AGENT_OUTCOME_OUTPUT_SCHEMA.properties.response,
    needsAction: AGENT_OUTCOME_OUTPUT_SCHEMA.properties.needsAction,
    error: AGENT_OUTCOME_OUTPUT_SCHEMA.properties.error,
    planIssues: { type: "array", maxItems: 32, items: integrationPlanIssueSchema },
  },
  required: ["status", "response", "needsAction", "error", "planIssues"],
} as const;

/** Sol returns a verdict, not a duplicate of Terra's response. */
export const FINAL_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    approved: { type: "boolean" },
    issues: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    replacementResponse: { type: ["string", "null"], minLength: 1, maxLength: 200_000 },
  },
  required: ["approved", "issues", "replacementResponse"],
} as const;

export const AGENT_MESSAGE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["question", "answer", "contract_change", "blocker", "result"],
    },
    toTaskId: { type: "string", minLength: 1, maxLength: 128 },
    body: { type: "string", minLength: 1, maxLength: 1_024 },
    blocking: { type: "boolean" },
  },
  required: ["type", "toTaskId", "body", "blocking"],
} as const;

type ParsedLeafBody = Pick<
  LeafResult,
  | "status"
  | "summary"
  | "confidence"
  | "findings"
  | "changedFiles"
  | "validation"
  | "citations"
  | "artifacts"
  | "error"
  | "failureKind"
>;

export function parseLeafResultBody(value: unknown): ParsedLeafBody {
  const record = strictRecordWithOptional(
    value,
    Object.keys(LEAF_RESULT_OUTPUT_SCHEMA.properties),
    ["validation"],
    "LeafResult",
  );
  const status = stringEnum(record["status"], ["completed", "blocked", "failed"], "status");
  const summary = boundedString(record["summary"], "summary", 1, MAX_LEAF_SUMMARY_LENGTH);
  const confidence = finiteNumber(record["confidence"], "confidence", 0, 1);
  const findings = objectArray(record["findings"], "findings", 32, parseFinding);
  const changedFiles = stringArray(record["changedFiles"], "changedFiles", 128, 4_096).map((path) =>
    safeRelativePath(path, "changedFiles"),
  );
  const validation =
    record["validation"] === undefined
      ? []
      : objectArray(record["validation"], "validation", 32, parseValidation);
  const citations = objectArray(record["citations"], "citations", 32, parseCitation);
  const artifacts = objectArray(record["artifacts"], "artifacts", 32, parseArtifact);
  const error = nullableString(record["error"], "error", 4_000);
  const failureKind = nullableStringEnum(
    record["failureKind"],
    ["reasoning", "transient", "validation", "permission", "contract", "unknown"],
    "failureKind",
  );
  if (status !== "completed" && error === null) {
    throw new Error(`${status} LeafResult must include an error`);
  }
  return {
    status,
    summary,
    confidence,
    findings,
    changedFiles,
    validation,
    citations,
    artifacts,
    // Structured Outputs requires the nullable failure fields on every branch. Some providers
    // fill those placeholders even after selecting completed; status is the discriminant and the
    // runtime's deterministic validators remain authoritative for completed work.
    ...(status === "completed" || error === null ? {} : { error }),
    ...(status === "completed" || failureKind === null ? {} : { failureKind }),
  };
}

export function parseAgentOutcomeBody(value: unknown): Omit<AgentOutcome, "threadId" | "usage"> {
  const record = strictRecord(
    value,
    Object.keys(AGENT_OUTCOME_OUTPUT_SCHEMA.properties),
    "AgentOutcome",
  );
  const status = stringEnum(
    record["status"],
    ["completed", "waiting_input", "failed", "indeterminate"],
    "status",
  ) as ExecutionOutcomeStatus;
  const response = nullableString(record["response"], "response", 200_000);
  const validation = objectArray(record["validation"], "validation", 64, parseValidation);
  const needsAction = nullableString(record["needsAction"], "needsAction", 16_000);
  const error = nullableString(record["error"], "error", 16_000);
  if (status === "completed" && response === null) {
    throw new Error("completed AgentOutcome must include a response");
  }
  if (status === "waiting_input" && needsAction === null) {
    throw new Error("waiting_input AgentOutcome must include needsAction");
  }
  if ((status === "failed" || status === "indeterminate") && error === null) {
    throw new Error(`${status} AgentOutcome must include an error`);
  }
  return {
    status,
    response,
    validation,
    ...(needsAction === null ? {} : { needsAction }),
    ...(error === null ? {} : { error }),
  };
}

export function parseIntegratorOutcomeBody(
  value: unknown,
): Omit<AgentOutcome, "threadId" | "usage"> {
  const record = strictRecordWithOptional(
    value,
    Object.keys(INTEGRATOR_OUTCOME_OUTPUT_SCHEMA.properties),
    ["validation"],
    "IntegratorOutcome",
  );
  const { planIssues: rawIssues, ...base } = record;
  const outcome = parseAgentOutcomeBody({ validation: [], ...base });
  const planIssues = objectArray(rawIssues, "planIssues", 32, (issue, label) => {
    const parsed = strictRecord(issue, ["type", "taskIds", "summary"], label);
    return {
      type: stringEnum(
        parsed["type"],
        ["contract_incomplete", "result_conflict", "scope_change"],
        `${label}.type`,
      ),
      taskIds: stringArray(parsed["taskIds"], `${label}.taskIds`, 32, 128),
      summary: boundedString(parsed["summary"], `${label}.summary`, 1, 8_000),
    };
  });
  return { ...outcome, planIssues };
}

export function parseFinalReviewBody(value: unknown): {
  approved: boolean;
  issues: string[];
  replacementResponse?: string;
} {
  const record = strictRecord(
    value,
    Object.keys(FINAL_REVIEW_OUTPUT_SCHEMA.properties),
    "FinalReview",
  );
  if (typeof record["approved"] !== "boolean") {
    throw new Error("approved must be a boolean");
  }
  const approved = record["approved"];
  const issues = stringArray(record["issues"], "issues", 16, 2_000);
  const replacementResponse =
    record["replacementResponse"] === null
      ? null
      : boundedString(record["replacementResponse"], "replacementResponse", 1, 200_000);
  if (approved && issues.length > 0) {
    throw new Error("approved FinalReview cannot include issues");
  }
  if (approved && replacementResponse !== null) {
    throw new Error("approved FinalReview cannot include replacementResponse");
  }
  if (!approved && issues.length === 0) {
    throw new Error("rejected FinalReview must include at least one issue");
  }
  return {
    approved,
    issues,
    ...(replacementResponse === null ? {} : { replacementResponse }),
  };
}

function parseFinding(value: unknown, label: string): Finding {
  const record = strictRecord(value, ["text", "path", "line"], label);
  const path = nullableString(record["path"], `${label}.path`, 4_096);
  const line = nullableInteger(record["line"], `${label}.line`, 1);
  return {
    text: boundedString(record["text"], `${label}.text`, 1, 2_000),
    ...(path === null ? {} : { path: safeRelativePath(path, `${label}.path`) }),
    ...(line === null ? {} : { line }),
  };
}

function parseValidation(value: unknown, label: string): ValidationResult {
  const record = strictRecord(value, ["command", "status", "summary"], label);
  return {
    command: boundedString(record["command"], `${label}.command`, 1, 4_000),
    status: stringEnum(record["status"], ["passed", "failed", "skipped"], `${label}.status`),
    summary: boundedString(record["summary"], `${label}.summary`, 0, 2_000),
  };
}

function parseCitation(value: unknown, label: string): Citation {
  const record = strictRecord(value, ["title", "url", "claim"], label);
  const url = boundedString(record["url"], `${label}.url`, 1, 4_096);
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`${label}.url must be an absolute HTTP(S) URL`);
  }
  const claim = nullableString(record["claim"], `${label}.claim`, 2_000);
  return {
    title: boundedString(record["title"], `${label}.title`, 1, 1_000),
    url,
    ...(claim === null ? {} : { claim }),
  };
}

function parseArtifact(value: unknown, label: string): ArtifactRef {
  const record = strictRecord(value, ["path", "mediaType"], label);
  const mediaType = nullableString(record["mediaType"], `${label}.mediaType`, 512);
  return {
    path: safeRelativePath(
      boundedString(record["path"], `${label}.path`, 1, 4_096),
      `${label}.path`,
    ),
    ...(mediaType === null ? {} : { mediaType }),
  };
}

function strictRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw new Error(`${label} contains unknown property '${extra}'`);
  }
  for (const key of allowedKeys) {
    if (!(key in record)) {
      throw new Error(`${label} is missing '${key}'`);
    }
  }
  return record;
}

function strictRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw new Error(`${label} contains unknown property '${extra}'`);
  }
  for (const key of requiredKeys) {
    if (!(key in record)) {
      throw new Error(`${label} is missing '${key}'`);
    }
  }
  return record;
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must be a string of ${minimum}-${maximum} characters`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedString(value, label, 0, maximum);
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string, minimum: number): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be null or an integer >= ${minimum}`);
  }
  return value as number;
}

function stringEnum<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${label} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function nullableStringEnum<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T | null {
  return value === null ? null : stringEnum(value, values, label);
}

function stringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} must be an array with at most ${maximumItems} items`);
  }
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, 1, maximumLength));
}

function objectArray<T>(
  value: unknown,
  label: string,
  maximumItems: number,
  parse: (value: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} must be an array with at most ${maximumItems} items`);
  }
  return value.map((item, index) => parse(item, `${label}[${index}]`));
}

function safeRelativePath(value: string, label: string): string {
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    throw new Error(`${label} must be a workspace-relative path`);
  }
  return value;
}
