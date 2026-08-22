import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane.js";
import { ArtifactStore } from "../src/infra/artifact-store.js";
import { ControlPlaneDatabase } from "../src/infra/database.js";
import { Repository } from "../src/infra/repository.js";
import { baseMissionInput, lunaRootTaskInput, samplePortrait, terraTaskInput } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const hookDirectory = join(projectRoot, ".codex", "hooks");
const isolatedHookHome = join(tmpdir(), "hierarchical-codex-hook-empty");

function invokeHook(
  script: string,
  payload: string | Record<string, unknown>,
  args: string[] = [],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIERARCHICAL_CODEX_HOME: isolatedHookHome,
    ...options.env,
  };
  if (options.env === undefined || !("HIERARCHICAL_CODEX_DB" in options.env)) {
    delete env["HIERARCHICAL_CODEX_DB"];
  }
  return spawnSync("python3", [join(hookDirectory, script), ...args], {
    cwd: options.cwd ?? projectRoot,
    env,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
}

function runHook(
  script: string,
  payload: Record<string, unknown>,
  args: string[] = [],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  const result = invokeHook(script, payload, args, options);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function spawnPrompt(profile: string): string {
  if (profile === "luna-verifier") {
    return "review_target_task_id: tsk_abc123 expected_version: 4";
  }
  return "TaskEnvelope task_id: tsk_abc123";
}

describe("Codex lifecycle hooks", () => {
  it.each([
    ["terra-coordinator", "gpt-5.6-sol", "gpt-5.6-terra", "high", "v2"],
    ["terra-coordinator", "gpt-5.6-sol", "gpt-5.6-terra", "xhigh", "v2"],
    ["terra-coordinator", "gpt-5.6-sol", "gpt-5.6-terra", "max", "v2"],
    ["sol-advisor", "gpt-5.6-sol", "gpt-5.6-sol", "high", "v2"],
    ["sol-advisor", "gpt-5.6-sol", "gpt-5.6-sol", "xhigh", "v2"],
    ["sol-advisor", "gpt-5.6-sol", "gpt-5.6-sol", "max", "v2"],
    ["luna-producer", "gpt-5.6-terra", "gpt-5.6-luna", "high", "v2"],
    ["luna-producer", "gpt-5.6-terra", "gpt-5.6-luna", "xhigh", "v2"],
    ["luna-producer", "gpt-5.6-terra", "gpt-5.6-luna", "max", "v2"],
    ["luna-verifier", "gpt-5.6-terra", "gpt-5.6-luna", "high", "v1"],
    ["luna-verifier", "gpt-5.6-terra", "gpt-5.6-luna", "xhigh", "v1"],
    ["luna-verifier", "gpt-5.6-terra", "gpt-5.6-luna", "max", "v1"],
  ])(
    "allows %s from %s to %s at %s using %s fork fields",
    (profile, parentModel, childModel, reasoningEffort, schema) => {
      const forkFields = schema === "v1" ? { fork_context: false } : { fork_turns: "none" };
      const output = runHook("pre_spawn_policy.py", {
        hook_event_name: "PreToolUse",
        model: parentModel,
        tool_name: "Agent",
        tool_input: {
          agent_type: profile,
          model: childModel,
          reasoning_effort: reasoningEffort,
          ...forkFields,
          prompt: spawnPrompt(profile),
        },
      });
      expect(output).toEqual({});
    },
  );

  it("allows a policy-compliant Sol to Terra native spawn", () => {
    const output = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-sol",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "terra-coordinator",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        fork_turns: "none",
        prompt: "TaskEnvelope task_id: tsk_abc123",
      },
    });
    expect(output).toEqual({});
  });

  it("rejects Luna spawning and unsupported Terra effort", () => {
    const lunaOutput = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-luna",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "luna-producer",
        model: "gpt-5.6-luna",
        reasoning_effort: "high",
        fork_turns: "none",
        prompt: "task_id: tsk_abc123",
      },
    });
    expect(lunaOutput).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });

    const effortOutput = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-sol",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "terra-coordinator",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        fork_turns: "none",
        prompt: "task_id: tsk_abc123",
      },
    });
    expect(effortOutput).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("requires luna-verifier spawn input to name review_target_task_id", () => {
    const allowed = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "luna-verifier",
        model: "gpt-5.6-luna",
        reasoning_effort: "xhigh",
        fork_turns: "none",
        prompt: "review_target_task_id: tsk_producer1 expected_version: 6",
      },
    });
    expect(allowed).toEqual({});

    const missingTarget = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "luna-verifier",
        model: "gpt-5.6-luna",
        reasoning_effort: "xhigh",
        fork_turns: "none",
        prompt: "task_id: tsk_abc123",
      },
    });
    expect(missingTarget).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("requires fork_turns none and a durable task ID", () => {
    const output = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "Agent",
      tool_input: {
        agent_type: "luna-producer",
        model: "gpt-5.6-luna",
        reasoning_effort: "xhigh",
        fork_turns: "all",
        prompt: "No task envelope",
      },
    });
    expect(output).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("rejects mixed V1/V2 fork fields", () => {
    const output = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "Agent",
      tool_input: {
        agent_type: "luna-producer",
        model: "gpt-5.6-luna",
        reasoning_effort: "high",
        fork_turns: "none",
        fork_context: false,
        prompt: "task_id: tsk_abc123",
      },
    });
    expect(output).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("fails closed with exit code 2 on malformed hook JSON", () => {
    const result = invokeHook("pre_spawn_policy.py", "{not-json");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("denied malformed hook input");
  });

  it("lets ordinary subagent spawns through in --opt-in user mode", () => {
    const allowed = runHook(
      "pre_spawn_policy.py",
      {
        hook_event_name: "PreToolUse",
        model: "gpt-5.6-luna",
        tool_name: "Agent",
        tool_input: {
          agent_type: "explorer",
          prompt: "Look around the repo",
        },
      },
      ["--opt-in"],
    );
    expect(allowed).toEqual({});

    const denied = runHook(
      "pre_spawn_policy.py",
      {
        hook_event_name: "PreToolUse",
        model: "gpt-5.6-sol",
        tool_name: "Agent",
        tool_input: {
          agent_type: "luna-producer",
          model: "gpt-5.6-luna",
          reasoning_effort: "high",
          fork_turns: "none",
          prompt: "task_id: tsk_abc123",
        },
      },
      ["--opt-in"],
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("injects start context and continues an incomplete stop only once", () => {
    const start = runHook("subagent_start.py", {
      hook_event_name: "SubagentStart",
      agent_type: "luna-producer",
    });
    expect(start).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
      },
    });

    const incomplete = runHook("subagent_stop.py", {
      hook_event_name: "SubagentStop",
      agent_type: "luna-producer",
      stop_hook_active: false,
      last_assistant_message: "I think I am done.",
    });
    expect(incomplete).toMatchObject({ decision: "block" });

    const secondAttempt = runHook("subagent_stop.py", {
      hook_event_name: "SubagentStop",
      agent_type: "luna-producer",
      stop_hook_active: true,
      last_assistant_message: "Still incomplete.",
    });
    expect(secondAttempt).toEqual({});
  });

  it("accepts a machine-readable durable handoff", () => {
    const output = runHook("subagent_stop.py", {
      hook_event_name: "SubagentStop",
      agent_type: "luna-producer",
      stop_hook_active: false,
      last_assistant_message: [
        "TASK_RESULT",
        "task_id: tsk_abc123",
        "status: candidate_submitted",
        "artifact_refs: art_123",
        "unresolved: none",
      ].join("\n"),
    });
    expect(output).toEqual({});
  });

  it("rejects a TASK_RESULT buried in a report", () => {
    const output = runHook("subagent_stop.py", {
      hook_event_name: "SubagentStop",
      agent_type: "luna-producer",
      stop_hook_active: false,
      last_assistant_message: [
        "Here is the full analysis of the repository...",
        "TASK_RESULT",
        "task_id: tsk_abc123",
        "status: candidate_submitted",
        "artifact_refs: art_123",
        "unresolved: none",
      ].join("\n"),
    });
    expect(output).toMatchObject({ decision: "block" });
  });

  it("denies Terra babysitting tools and short wait_agent, and fails open otherwise", () => {
    const deniedWait = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "wait",
      tool_input: { yield_time_ms: 30000 },
    });
    expect(deniedWait).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const allowedCellYield = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "wait",
      tool_input: { cell_id: "7", yield_time_ms: 10000, max_tokens: 10000 },
    });
    expect(allowedCellYield).toEqual({});

    const deniedList = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "list_agents",
      tool_input: {},
    });
    expect(deniedList).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const deniedSend = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "send_message",
      tool_input: { target: "engineering_quality", message: "ping" },
    });
    expect(deniedSend).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const deniedFollowup = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "followup_task",
      tool_input: { target: "code_architecture", message: "ping" },
    });
    expect(deniedFollowup).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const deniedShortWait = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "wait_agent",
      tool_input: { timeout_ms: 60_000 },
    });
    expect(deniedShortWait).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const allowedLongWait = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-terra",
      tool_name: "wait_agent",
      tool_input: { timeout_ms: 3_600_000 },
    });
    expect(allowedLongWait).toEqual({});

    const solList = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-sol",
      tool_name: "list_agents",
      tool_input: {},
    });
    expect(solList).toEqual({});

    const missingModel = runHook("pre_coordinator_tools.py", {
      hook_event_name: "PreToolUse",
      tool_name: "wait",
      tool_input: { yield_time_ms: 30000 },
    });
    expect(missingModel).toEqual({});
  });

  it("denies Sol→Luna without a direct-mission ledger row and allows it when present", () => {
    const denied = runHook("pre_spawn_policy.py", {
      hook_event_name: "PreToolUse",
      model: "gpt-5.6-sol",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "luna-producer",
        model: "gpt-5.6-luna",
        reasoning_effort: "high",
        fork_turns: "none",
        prompt: "TaskEnvelope task_id: tsk_missingdirect",
      },
    });
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const directory = mkdtempSync(join(tmpdir(), "hierarchical-codex-hook-ledger-"));
    const database = new ControlPlaneDatabase(join(directory, "control-plane.sqlite"));
    const repository = new Repository(database);
    const artifacts = new ArtifactStore(join(directory, "artifacts"), 1024);
    const controlPlane = new ControlPlane(repository, artifacts, {
      defaultLeaseSeconds: 60,
      maxLeaseSeconds: 300,
      eventPageSize: 50,
    });
    try {
      const direct = controlPlane.createMission({
        ...baseMissionInput("mission:hook-direct:1"),
        strategy: "direct",
        portrait: samplePortrait({ parallelism: "low" }),
      });
      const luna = controlPlane.allocateTask(lunaRootTaskInput(direct.id, "task:hook-direct:1"));
      const fanout = controlPlane.createMission(baseMissionInput("mission:hook-fanout:1"));
      const terra = controlPlane.allocateTask(terraTaskInput(fanout.id, "task:hook-fanout:1"));
      database.close();
      const allowed = runHook(
        "pre_spawn_policy.py",
        {
          hook_event_name: "PreToolUse",
          model: "gpt-5.6-sol",
          tool_name: "spawn_agent",
          tool_input: {
            agent_type: "luna-producer",
            model: "gpt-5.6-luna",
            reasoning_effort: "high",
            fork_turns: "none",
            prompt: `TaskEnvelope task_id: ${luna.id}`,
          },
        },
        [],
        { env: { HIERARCHICAL_CODEX_HOME: directory } },
      );
      expect(allowed).toEqual({});

      const deniedFanout = runHook(
        "pre_spawn_policy.py",
        {
          hook_event_name: "PreToolUse",
          model: "gpt-5.6-sol",
          tool_name: "spawn_agent",
          tool_input: {
            agent_type: "luna-producer",
            model: "gpt-5.6-luna",
            reasoning_effort: "high",
            fork_turns: "none",
            prompt: `TaskEnvelope task_id: ${terra.id}`,
          },
        },
        [],
        { env: { HIERARCHICAL_CODEX_HOME: directory } },
      );
      expect(deniedFanout).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      try {
        database.close();
      } catch {
        // Closed before the hook runs so Python can open the file.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
