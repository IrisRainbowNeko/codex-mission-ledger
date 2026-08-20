import type { JsonObject } from "./types.js";

export const ERROR_CODES = [
  "not_found",
  "conflict",
  "invalid_state",
  "policy_violation",
  "budget_exceeded",
  "lease_conflict",
  "forbidden",
  "validation_error",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ControlPlaneError extends Error {
  readonly code: ErrorCode;
  readonly details: JsonObject;

  constructor(code: ErrorCode, message: string, details: JsonObject = {}) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}

export function isControlPlaneError(error: unknown): error is ControlPlaneError {
  return error instanceof ControlPlaneError;
}

export function assertCondition(
  condition: unknown,
  code: ErrorCode,
  message: string,
  details: JsonObject = {},
): asserts condition {
  if (!condition) {
    throw new ControlPlaneError(code, message, details);
  }
}
