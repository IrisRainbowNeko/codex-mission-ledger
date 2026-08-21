# hierarchical-codex

This repository is a Sol → Terra → Luna control plane for native Codex
subagents. MCP tools named `hierarchical_codex` are authoritative. The
Subagents UI is observational.

Token mass target (host `token_count`, cache included, worker threads only):
Luna 82 · Terra 13 · Sol 5. Sol aims, Terra fans out, Luna does the work.

When work is decomposable, parallel, or needs independent verification, follow
the `$agent-trio` skill:

- `.codex/skills/agent-trio/SKILL.md` (Codex App / older project scan)
- `.agents/skills/agent-trio/SKILL.md` (current CLI / IDE scan)

Hard rules even if the skill picker is unavailable:

1. Sol spawns only `terra-coordinator` at effort `high`. Terra spawns only Luna profiles. Luna never spawns.
2. Call `task_allocate` before `spawn_agent`. Put the returned `task_id` in the child prompt.
3. Set `agent_type` to the profile name. Use `fork_turns="none"` (V2) or `fork_context=false` (V1).
4. Children `task_claim` then `task_start` before work, then `result_submit_candidate`.
5. A producer cannot check, verify, or commit its own result.
6. Sol and Terra must not `artifact_get` full reports or write the user-facing file. Luna synthesizer writes the deliverable.
7. The entire final child message is a `TASK_RESULT` block. Do not paste reports into `wait_agent`.
8. Sol never polls with `list_agents`, `wait`, `send_message`, or `sleep`. One `wait_agent` at 1h. Terra never babysits children; one long `wait_agent` then `children_status`.

Do not invent an external orchestrator. Use native spawn so threads stay in the Codex UI.
