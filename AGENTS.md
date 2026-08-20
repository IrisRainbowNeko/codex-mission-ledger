# hierarchical-codex

This repository is a Sol → Terra → Luna control plane for native Codex
subagents. MCP tools named `hierarchical_codex` are authoritative. The
Subagents UI is observational.

When work is decomposable, parallel, or needs independent verification, follow
the `$prism` skill:

- `.codex/skills/prism/SKILL.md` (Codex App / older project scan)
- `.agents/skills/prism/SKILL.md` (current CLI / IDE scan)

Hard rules even if the skill picker is unavailable:

1. Sol spawns only `terra-coordinator`. Terra spawns only Luna profiles. Luna never spawns.
2. Call `task_allocate` before `spawn_agent`. Put the returned `task_id` in the child prompt.
3. Set `agent_type` to the profile name. Use `fork_turns="none"` (V2) or `fork_context=false` (V1).
4. Children `task_claim` then `task_start` before work, then `result_submit_candidate`.
5. A producer cannot check, verify, or commit its own result.

Do not invent an external orchestrator. Use native spawn so threads stay in the Codex UI.
