"""Shared JSON I/O helpers for Codex lifecycle hooks."""

from __future__ import annotations

import json
import sys
from typing import Any


def read_payload() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as exc:
        sys.stderr.write(f"Hierarchical policy denied malformed hook input: {exc}\n")
        raise SystemExit(2) from exc
    if not isinstance(value, dict):
        sys.stderr.write("Hierarchical policy denied non-object hook input.\n")
        raise SystemExit(2)
    return value


def write_payload(value: dict[str, Any]) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def deny_pre_tool(reason: str) -> None:
    write_payload(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }
    )

