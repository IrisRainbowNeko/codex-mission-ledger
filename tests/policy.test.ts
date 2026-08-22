import { describe, expect, it } from "vitest";
import type { ControlPlaneError } from "../src/domain/errors.js";
import {
  assertAssignmentPolicy,
  assertFanoutCoordinatorObjective,
  assertParentChildPolicy,
  assertRootRoleForStrategy,
  assertTransition,
  FANOUT_TERRA_OBJECTIVE_MAX_CHARS,
  normalizeDirectorPlan,
  normalizeStrategy,
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
    expect(() => assertRootRoleForStrategy("direct", "operator")).not.toThrow();
    expect(() => assertRootRoleForStrategy("direct", "coordinator")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "policy_violation" }),
    );
    expect(() => assertRootRoleForStrategy("fanout", "operator")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "policy_violation" }),
    );
    expect(() => assertRootRoleForStrategy("pipeline", "coordinator")).not.toThrow();
  });

  it("locks directorPlan and fanout Terra objective length", () => {
    expect(normalizeStrategy(undefined)).toBe("fanout");
    expect(() => normalizeDirectorPlan("fanout", "hidden plan")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "validation_error" }),
    );
    expect(normalizeDirectorPlan("fanout", "")).toBeNull();
    expect(() => normalizeDirectorPlan("director_plan", "too short")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "validation_error" }),
    );
    expect(() => normalizeDirectorPlan("director_plan", "../secret.md")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "validation_error" }),
    );
    expect(() => normalizeDirectorPlan("director_plan", "/tmp/plan.md")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "validation_error" }),
    );
    expect(normalizeDirectorPlan("director_plan", "director-plan.md")).toBe("director-plan.md");
    expect(normalizeDirectorPlan("director_plan", "docs/mission-plan.md")).toBe(
      "docs/mission-plan.md",
    );
    expect(() =>
      assertFanoutCoordinatorObjective("fanout", "x".repeat(FANOUT_TERRA_OBJECTIVE_MAX_CHARS + 1)),
    ).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "policy_violation" }),
    );
    expect(() =>
      assertFanoutCoordinatorObjective(
        "director_plan",
        "x".repeat(FANOUT_TERRA_OBJECTIVE_MAX_CHARS + 1),
      ),
    ).not.toThrow();
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
