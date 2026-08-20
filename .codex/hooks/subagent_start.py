"""Inject concise durable-control instructions when a native subagent starts."""

from __future__ import annotations

import sys

from hook_utils import read_payload, write_payload


CONTEXT_BY_PROFILE = {
    "terra-coordinator": (
        "You are a direct Terra child. Extract task_id from the parent envelope, "
        "then call task_get, task_claim, and task_start before work. Allocate "
        "operator tasks only for luna-producer children. Spawn luna-verifier "
        "with review_target_task_id; do not allocate a verifier task."
    ),
    "luna-producer": (
        "You are a Luna leaf. Extract task_id, claim and start it before work, "
        "heartbeat long operations, artifact_put on this task, submit candidate "
        "evidence with usage, and never spawn."
    ),
    "luna-verifier": (
        "You are an independent Luna leaf. Review review_target_task_id. Never "
        "claim or start any task. Record one result_check and never verify, "
        "submit_candidate, or commit."
    ),
    "sol-advisor": (
        "You are a sparse read-only advisor. Use compressed evidence, do not "
        "spawn, and do not take over another agent's task lifecycle."
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
