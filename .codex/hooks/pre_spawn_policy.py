"""Reject native subagent spawns that violate the Sol→Terra→Luna policy."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from hook_utils import deny_pre_tool, read_payload, write_payload


PROFILE_POLICY = {
    "terra-coordinator": {
        "model": "gpt-5.6-terra",
        "efforts": {"xhigh", "max"},
        "parent_tiers": {"sol"},
    },
    "luna-producer": {
        "model": "gpt-5.6-luna",
        "efforts": {"high", "xhigh", "max"},
        "parent_tiers": {"terra"},
    },
    "luna-verifier": {
        "model": "gpt-5.6-luna",
        "efforts": {"high", "xhigh", "max"},
        "parent_tiers": {"terra"},
    },
    "sol-advisor": {
        "model": "gpt-5.6-sol",
        "efforts": {"high", "xhigh", "max"},
        "parent_tiers": {"sol"},
    },
}

TASK_ID_PATTERN = re.compile(r"\btsk_[A-Za-z0-9]+\b")


def string_field(value: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def classify_model(model: str) -> str | None:
    lowered = model.lower()
    if "luna" in lowered:
        return "luna"
    if "terra" in lowered:
        return "terra"
    if "sol" in lowered or lowered in {"gpt-5.6", "gpt-5.6-codex"}:
        return "sol"
    return None


def main(opt_in: bool = False) -> None:
    payload = read_payload()
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        if opt_in:
            write_payload({})
            return
        deny_pre_tool("spawn_agent input must be a JSON object.")
        return

    profile = string_field(tool_input, "agent_type", "agentType", "profile")
    if profile not in PROFILE_POLICY:
        if opt_in:
            # User-global install must not veto ordinary Codex subagents.
            write_payload({})
            return
        deny_pre_tool(
            "Only hierarchical-codex profiles may be spawned: "
            + ", ".join(sorted(PROFILE_POLICY))
        )
        return

    policy = PROFILE_POLICY[profile]
    parent_model = payload.get("model")
    parent_tier = classify_model(parent_model) if isinstance(parent_model, str) else None
    if parent_tier is None:
        deny_pre_tool("Cannot establish the parent model tier; spawn denied.")
        return
    if parent_tier == "luna":
        deny_pre_tool("Luna is a strict leaf and cannot call spawn_agent.")
        return
    if parent_tier not in policy["parent_tiers"]:
        deny_pre_tool(
            f"Parent tier '{parent_tier}' cannot spawn profile '{profile}'."
        )
        return

    requested_model = string_field(tool_input, "model")
    expected_model = policy["model"]
    if requested_model is not None and requested_model != expected_model:
        deny_pre_tool(
            f"Profile '{profile}' must use model '{expected_model}', "
            f"not '{requested_model}'."
        )
        return

    requested_effort = string_field(
        tool_input, "reasoning_effort", "reasoningEffort", "model_reasoning_effort"
    )
    if requested_effort not in policy["efforts"]:
        allowed = ", ".join(sorted(policy["efforts"]))
        deny_pre_tool(
            f"Profile '{profile}' requires an explicit supported reasoning effort: "
            f"{allowed}."
        )
        return

    fork_turns = tool_input.get("fork_turns", tool_input.get("forkTurns"))
    fork_context = tool_input.get("fork_context", tool_input.get("forkContext"))
    valid_v2_fork = fork_turns == "none" and fork_context is None
    valid_v1_fork = fork_context is False and fork_turns is None
    if not valid_v2_fork and not valid_v1_fork:
        deny_pre_tool(
            "Hierarchical spawns must use fork_turns='none' for V2 or "
            "fork_context=false for V1, without mixing schemas."
        )
        return

    serialized_input = json.dumps(tool_input, ensure_ascii=False)
    if TASK_ID_PATTERN.search(serialized_input) is None:
        deny_pre_tool(
            "Spawn input must contain a control-plane task_id (tsk_...) in its "
            "TaskEnvelope."
        )
        return

    if profile == "luna-verifier" and "review_target_task_id" not in serialized_input:
        deny_pre_tool(
            "luna-verifier spawn input must contain review_target_task_id "
            "pointing at the producer candidate task."
        )
        return

    write_payload({})


if __name__ == "__main__":
    try:
        main(opt_in="--opt-in" in sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:  # Fail closed on unexpected policy errors.
        sys.stderr.write(f"Hierarchical spawn policy failed closed: {exc}\n")
        raise SystemExit(2) from exc
