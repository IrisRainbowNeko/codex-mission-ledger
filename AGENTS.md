# Mission Ledger for Codex

This repository is a Sol → Terra → Luna control plane for native Codex
subagents. MCP tools named `hierarchical_codex` are authoritative. The
Subagents UI is observational.

Sol's first action is a no-tool `MISSION_ROUTE`. `mission_create` locks one
strategy: `direct`, `fanout` (default), `director_plan`, or `pipeline`.
Coordinator polling stays illegal on every path. Token mass target Luna 82 ·
Terra 13 · Sol 5 applies to **`fanout`**.

When work is decomposable, parallel, sequential-staged, or needs a bounded
director plan, follow the `$agent-trio` skill:

- `.codex/skills/agent-trio/SKILL.md` (Codex App / older project scan)
- `.agents/skills/agent-trio/SKILL.md` (current CLI / IDE scan)

Hard rules even if the skill picker is unavailable:

1. After `MISSION_ROUTE`, follow only the locked strategy. Sol spawns Terra
   except `direct`, where Sol may allocate one root Luna operator.
2. Call `task_allocate` before `spawn_agent`. Put the returned `task_id` in the child prompt.
3. Set `agent_type` to the profile name. Use `fork_turns="none"` (V2) or `fork_context=false` (V1).
4. Children `task_claim` then `task_start` before work, then `result_submit_candidate`.
5. A producer cannot check, verify, or commit its own result.
6. Sol and Terra must not `artifact_get` full reports or write the user-facing deliverable. Luna writes that file. Exception: on `director_plan`, Sol writes one markdown plan (default `director-plan.md`) in the project folder and stores that relative path in `directorPlan`.
7. The entire final child message is a `TASK_RESULT` block. Do not paste reports into `wait_agent`.
8. Sol never polls with `list_agents`, `wait`, `send_message`, or `sleep`. One `wait_agent` at 1h. Terra never babysits children; one long `wait_agent` then `children_status`. On fanout, Sol closes from the Terra summary — `mission_close` auto-finalizes a low/medium root Terra candidate. Sol's last user-visible reply includes the path Luna wrote.

Do not invent an external orchestrator. Use native spawn so threads stay in the Codex UI.
