import { describe, expect, it } from "vitest";
import type { ControlPlaneError } from "../src/domain/errors.js";
import {
  assertAssignmentPolicy,
  assertParentChildPolicy,
  assertTransition,
} from "../src/domain/policy.js";

describe("hierarchy policy", () => {
  it.each([
    ["director", "sol", "high", "max"],
    ["coordinator", "terra", "high", "max"],
    ["coordinator", "terra", "xhigh", "max"],
    ["operator", "luna", "high", "xhigh"],
    ["verifier", "luna", "max", "max"],
    ["advisor", "sol", "xhigh", "max"],
  ] as const)("accepts role %s on %s with effort %s", (role, model, effort, maxEffort) => {
    expect(() => assertAssignmentPolicy(role, model, effort, maxEffort)).not.toThrow();
  });

  it.each([
    ["operator", "terra", "xhigh", "max"],
    ["coordinator", "luna", "high", "max"],
    ["advisor", "sol", "max", "xhigh"],
  ] as const)("rejects invalid assignment %s/%s/%s", (role, model, effort, maxEffort) => {
    expect(() => assertAssignmentPolicy(role, model, effort, maxEffort)).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "policy_violation" }),
    );
  });

  it("enforces direct authority edges", () => {
    expect(() => assertParentChildPolicy(null, "coordinator")).not.toThrow();
    expect(() => assertParentChildPolicy("coordinator", "operator")).not.toThrow();
    expect(() => assertParentChildPolicy("coordinator", "verifier")).not.toThrow();
    expect(() => assertParentChildPolicy("operator", "operator")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "policy_violation" }),
    );
    expect(() => assertParentChildPolicy(null, "operator")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "policy_violation" }),
    );
  });

  it("enforces evidence-gate transitions", () => {
    expect(() => assertTransition("running", "candidate")).not.toThrow();
    expect(() => assertTransition("candidate", "checked")).not.toThrow();
    expect(() => assertTransition("checked", "verified")).not.toThrow();
    expect(() => assertTransition("verified", "committed")).not.toThrow();
    expect(() => assertTransition("candidate", "committed")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_state" }),
    );
  });
});
