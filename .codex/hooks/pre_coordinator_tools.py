"""Reject Terra coordinator babysitting tools that inflate wait loops."""

from __future__ import annotations

import json
import sys
from typing import Any

from hook_utils import deny_pre_tool, read_payload, write_payload

# Native wait_agent must not match this set. Matcher in hooks.json uses $.
BABYSIT_TOOLS = {"wait", "Wait", "list_agents", "send_message", "followup_task"}
MIN_WAIT_AGENT_TIMEOUT_MS = 1_800_000


def classify_model(model: str) -> str | None:
    lowered = model.lower()
    if "luna" in lowered:
        return "luna"
    if "terra" in lowered:
        return "terra"
    if "sol" in lowered or lowered in {"gpt-5.6", "gpt-5.6-codex"}:
        return "sol"
    return None


def parse_tool_input(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("tool_input")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


def is_cell_yield(tool_input: dict[str, Any]) -> bool:
    cell_id = tool_input.get("cell_id")
    max_tokens = tool_input.get("max_tokens")
    has_cell = (isinstance(cell_id, str) and cell_id.strip() != "") or (
        isinstance(cell_id, int) and not isinstance(cell_id, bool)
    )
    if isinstance(max_tokens, bool):
        return False
    if isinstance(max_tokens, int):
        return has_cell and max_tokens > 0
    if isinstance(max_tokens, float):
        return has_cell and max_tokens.is_integer() and max_tokens > 0
    return False


def timeout_ms(tool_input: dict[str, Any]) -> int | None:
    for key in ("timeout_ms", "timeoutMs", "timeout"):
        value = tool_input.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.isdigit():
                return int(stripped)
    return None


def main() -> None:
    payload = read_payload()
    model = payload.get("model")
    if not isinstance(model, str) or not model.strip():
        # Fail open: Sol is the root chat; missing model must not wedge wait/list_agents.
        write_payload({})
        return
    if classify_model(model) != "terra":
        write_payload({})
        return

    tool_name = payload.get("tool_name") or payload.get("tool") or ""
    if not isinstance(tool_name, str):
        write_payload({})
        return

    if tool_name in BABYSIT_TOOLS:
        if tool_name in {"wait", "Wait"} and is_cell_yield(parse_tool_input(payload)):
            write_payload({})
            return
        deny_pre_tool(
            "Terra coordinators must not poll or babysit. Do not call wait, "
            "list_agents, send_message, or followup_task. Spawn the batch, then "
            "one wait_agent with timeout_ms >= 1800000. After a timeout, "
            "children_status once; retry wait_agent only if a child is still "
            "live. Recover by spawning a replacement Luna, not by pinging the "
            "child. VS Code cell yield (cell_id + max_tokens) is allowed."
        )
        return

    if tool_name == "wait_agent":
        parsed_timeout = timeout_ms(parse_tool_input(payload))
        if parsed_timeout is None or parsed_timeout < MIN_WAIT_AGENT_TIMEOUT_MS:
            deny_pre_tool(
                "Terra must use one long wait_agent (timeout_ms >= 1800000) and "
                "must not poll with 60s waits. After a timeout, children_status "
                "once; retry wait_agent only if a child is still live."
            )
            return

    write_payload({})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Fail open so a payload-shape change cannot block wait/list_agents globally.
        write_payload({})
        raise SystemExit(0) from None
