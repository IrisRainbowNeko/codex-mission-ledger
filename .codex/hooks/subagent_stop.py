"""Require a compact durable TASK_RESULT handoff before a native subagent stops."""

from __future__ import annotations

import re
import sys

from hook_utils import read_payload, write_payload


TASK_ID_PATTERN = re.compile(r"(?m)^task_id:\s*tsk_[A-Za-z0-9]+\s*$")
STATUS_PATTERN = re.compile(
    r"(?m)^status:\s*"
    r"(candidate_submitted|check_approved|check_rejected|blocked|failed)\s*$"
)
ARTIFACT_REFS_PATTERN = re.compile(r"(?m)^artifact_refs:\s*\S")
UNRESOLVED_PATTERN = re.compile(r"(?m)^unresolved:\s*\S")
# Four short fields plus the header; anything larger is a report leaking into wait_agent.
MAX_HANDOFF_CHARS = 800
ALLOWED_FIELD_NAMES = {"task_id", "status", "artifact_refs", "unresolved"}


def compact_handoff(message: str) -> bool:
    stripped = message.strip()
    if len(stripped) > MAX_HANDOFF_CHARS:
        return False
    if not stripped.startswith("TASK_RESULT"):
        return False
    lines = [line.rstrip() for line in stripped.splitlines()]
    if lines[0].strip() != "TASK_RESULT":
        return False
    body = [line for line in lines[1:] if line.strip()]
    if len(body) != 4:
        return False
    names: list[str] = []
    for line in body:
        if ":" not in line:
            return False
        name = line.split(":", 1)[0].strip()
        names.append(name)
    if set(names) != ALLOWED_FIELD_NAMES:
        return False
    return (
        TASK_ID_PATTERN.search(stripped) is not None
        and STATUS_PATTERN.search(stripped) is not None
        and ARTIFACT_REFS_PATTERN.search(stripped) is not None
        and UNRESOLVED_PATTERN.search(stripped) is not None
    )


def main() -> None:
    payload = read_payload()
    message = payload.get("last_assistant_message")
    already_continued = payload.get("stop_hook_active") is True

    valid = isinstance(message, str) and compact_handoff(message)
    if valid or already_continued:
        write_payload({})
        return

    write_payload(
        {
            "decision": "block",
            "reason": (
                "Before stopping, synchronize durable MCP state, then end with "
                "ONLY the TASK_RESULT block (task_id, status, artifact_refs, "
                "unresolved). Do not paste reports, file contents, or tool dumps; "
                "parents re-bill that on every later turn. Keep the whole message "
                f"under {MAX_HANDOFF_CHARS} characters."
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
