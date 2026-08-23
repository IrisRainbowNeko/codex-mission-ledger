"""Reject native subagent spawns that violate the Sol→Terra→Luna policy."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

from hook_utils import deny_pre_tool, read_payload, write_payload


PROFILE_POLICY = {
    "terra-coordinator": {
        "model": "gpt-5.6-terra",
        "efforts": {"high", "xhigh", "max"},
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
DB_NAME = "control-plane.sqlite"
DIRECT_LUNA_PROFILES = {"luna-producer", "luna-verifier"}


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


def ledger_db_paths() -> list[Path]:
    paths: list[Path] = []
    env_db = os.environ.get("CODEX_MISSION_LEDGER_DB") or os.environ.get("HIERARCHICAL_CODEX_DB")
    if env_db:
        paths.append(Path(env_db).expanduser())
    env_home = os.environ.get("CODEX_MISSION_LEDGER_HOME") or os.environ.get("HIERARCHICAL_CODEX_HOME")
    if env_home:
        paths.append(Path(env_home).expanduser() / DB_NAME)
    paths.append(Path.cwd() / ".codex-mission-ledger" / DB_NAME)
    paths.append(Path.home() / ".local" / "share" / "codex-mission-ledger" / DB_NAME)
    # Keep reading pre-rename ledgers so an upgrade never silently forks state.
    paths.append(Path.cwd() / ".hierarchical-codex" / DB_NAME)
    paths.append(Path.home() / ".local" / "share" / "hierarchical-codex" / DB_NAME)
    unique: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        resolved = str(path)
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(path)
    return unique


def lookup_direct_root_operator(task_id: str) -> bool | None:
    """Return True if the task is a direct-mission root operator, False if found
    but not qualifying, None if the task is missing from every ledger."""
    found = False
    for path in ledger_db_paths():
        if not path.is_file():
            continue
        try:
            connection = sqlite3.connect(str(path))
        except sqlite3.Error:
            continue
        try:
            try:
                row = connection.execute(
                    """
                    SELECT t.role, t.parent_task_id, m.strategy
                    FROM tasks t
                    JOIN missions m ON m.id = t.mission_id
                    WHERE t.id = ?
                    """,
                    (task_id,),
                ).fetchone()
            except sqlite3.Error:
                continue
            if row is None:
                continue
            found = True
            role, parent_task_id, strategy = row
            if role == "operator" and parent_task_id is None and strategy == "direct":
                return True
            return False
        finally:
            connection.close()
    return False if found else None


def allow_sol_direct_luna(parent_tier: str, profile: str, serialized_input: str) -> bool:
    if parent_tier != "sol" or profile not in DIRECT_LUNA_PROFILES:
        return False
    task_ids = TASK_ID_PATTERN.findall(serialized_input)
    if not task_ids:
        return False
    if profile == "luna-verifier":
        match = re.search(r"review_target_task_id[:\s]+(tsk_[A-Za-z0-9]+)", serialized_input)
        if match is not None:
            task_ids = [match.group(1)]
    for task_id in task_ids:
        result = lookup_direct_root_operator(task_id)
        if result is True:
            return True
        if result is False:
            return False
    return False


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
            "Only Mission Ledger for Codex profiles may be spawned: "
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

    serialized_input = json.dumps(tool_input, ensure_ascii=False)
    if parent_tier not in policy["parent_tiers"] and not allow_sol_direct_luna(
        parent_tier, profile, serialized_input
    ):
        deny_pre_tool(f"Parent tier '{parent_tier}' cannot spawn profile '{profile}'.")
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
