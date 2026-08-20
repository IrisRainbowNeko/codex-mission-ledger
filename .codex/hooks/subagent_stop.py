"""Require a durable task handoff before a native subagent stops."""

from __future__ import annotations

import re
import sys

from hook_utils import read_payload, write_payload


TASK_ID_PATTERN = re.compile(r"(?m)^task_id:\s*tsk_[A-Za-z0-9]+\s*$")
STATUS_PATTERN = re.compile(
    r"(?m)^status:\s*"
    r"(candidate_submitted|check_approved|check_rejected|blocked|failed)\s*$"
)


def main() -> None:
    payload = read_payload()
    message = payload.get("last_assistant_message")
    already_continued = payload.get("stop_hook_active") is True

    valid = (
        isinstance(message, str)
        and "TASK_RESULT" in message
        and TASK_ID_PATTERN.search(message) is not None
        and STATUS_PATTERN.search(message) is not None
    )
    if valid or already_continued:
        write_payload({})
        return

    write_payload(
        {
            "decision": "block",
            "reason": (
                "Before stopping, synchronize the durable MCP task state. Submit "
                "or block/release the task as appropriate, then end with the "
                "required TASK_RESULT block containing task_id, status, "
                "artifact_refs, and unresolved."
            ),
        }
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"Hierarchical stop hook failed closed: {exc}\n")
        raise SystemExit(2) from exc
