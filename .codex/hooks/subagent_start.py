"""Inject concise durable-control instructions when a native subagent starts."""

from __future__ import annotations

import sys

from hook_utils import read_payload, write_payload


CONTEXT_BY_PROFILE = {
    "terra-coordinator": (
        "You are a cheap Terra coordinator. Extract task_id, then task_get, "
        "task_claim, and task_start with leaseSeconds=14400. If "
        "mission_get(includeDetails=false) strategy is director_plan, read "
        "the workspace markdown at directorPlan; if pipeline, allocate Luna "
        "with dependencies. Fan-out "
        "otherwise. Never list_agents, wait, send_message, or followup_task. "
        "Stay read-only. A synthesizer writes any user-facing file. "
        "If a child parks (blocked) on training/remote work, task_block "
        "yourself and return TASK_RESULT blocked; do not wait_agent overnight. "
        "results_gate_and_commit for low/medium; skip luna-verifier unless "
        "risk is high/critical or evidence is non-deterministic. End with "
        "TASK_RESULT only; never paste reports."
    ),
    "luna-producer": (
        "You are a Luna leaf. Extract task_id, claim and start it before work, "
        "heartbeat only between short execs, never during a multi-hour SSH. "
        "For training/remote jobs: detach, artifact_put a run handle, "
        "task_block, TASK_RESULT blocked. artifact_put on this task, submit "
        "candidate evidence with usage and a <=500 char summary when the job "
        "is actually done, and never spawn. The entire final message is "
        "TASK_RESULT only."
    ),
    "luna-verifier": (
        "You are an independent Luna leaf. Review review_target_task_id. Never "
        "claim or start any task. Use truncated artifacts and claims. Record "
        "one result_check and never verify, submit_candidate, or commit. "
        "TASK_RESULT only."
    ),
    "sol-advisor": (
        "You are a sparse read-only advisor. Use compressed evidence, do not "
        "spawn, do not artifact_get full reports, and do not take over another "
        "agent's task lifecycle."
    ),
}


def main() -> None:
    payload = read_payload()
    agent_type = payload.get("agent_type")
    context = CONTEXT_BY_PROFILE.get(agent_type)
    if context is None:
        write_payload({})
        return
    write_payload(
        {
            "hookSpecificOutput": {
                "hookEventName": "SubagentStart",
                "additionalContext": context,
            }
        }
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"Hierarchical start hook failed closed: {exc}\n")
        raise SystemExit(2) from exc
