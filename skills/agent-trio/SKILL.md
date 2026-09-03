---
name: agent-trio
description: Explicitly use Agent Trio balanced routing for one turn. The root Sol may complete a tiny indivisible task itself; otherwise it delegates one worker or a compact parallel DAG. Never continue implicitly on later turns.
---

# Agent Trio Balanced

Use the balanced policy once for the complete user request, delegating through the `agent_trio` MCP runtime unless the strict root fast path applies.

## Route Once

The current Sol makes one lightweight semantic decision, using at most one shallow file listing or
build-manifest read:

- Complete in the root and do not call MCP when there is one clear bounded deliverable, no
  independent workflows, and the root can finish it in one focused edit/analysis/verification
  sequence, or when Sol-level reasoning is necessary but cannot usefully split. Detailed output
  requirements do not by themselves justify another worker. No Monitor is expected on this path.
- Delegate one worker with `profile=balanced`, `strategy=direct`: Luna for bounded mechanical work,
  extraction, data processing, exact calculation, or a clear local implementation; Terra for
  state recovery, resume/idempotency logic, coupled multi-file work, ordinary debugging,
  review/synthesis, or one office artifact. This route must not request an internal plan.
- Use `profile=balanced`, `strategy=fanout` only for at least two independent packages, each over
  30 seconds and at least 90 seconds total serial work. Default to two Luna leaves. Use three only
  for three substantial independent streams when three lowers the predicted critical path by at
  least 20% versus the best two-leaf grouping; group homogeneous inputs. Foreground plans may not
  exceed three leaves. Set a Terra floor for recovery, coupled debugging, review/synthesis, and
  office artifact work; allow at most one Sol leaf.
- Use `profile=balanced`, `strategy=auto` only when this root is not Sol or reliable boundaries are
  unavailable.

Pass the `agent_trio` tool arguments as flat top-level fields. Never wrap the whole argument object
in `request`, `input`, or `arguments`.

For a foreground MCP run, generate a unique UUID-style `runId` and call `action=submit` with
`monitorFirst=true`. Only if submit succeeds and returns that same `runId`, make exactly one `action=status`
call with the same ID and `wait=true`. If submit returns an MCP/tool error, stop
immediately and do not call status. The MCP Apps monitor mounts from the submit response. Do not
poll or open another monitor page.

Pass the complete objective without the skill marker, absolute `cwd`, inferred `domain`, and the
current `hostAccess` and `hostApproval` exactly. Preserve constraints. Add only exact capabilities
the user selected. `risk` and `merge` are valid only inside `semanticPlan` for `strategy=fanout`;
never send either as a top-level tool argument. Inside that plan, writer `paths` must be pairwise
disjoint, `after` uses task indexes, `merge` is `deterministic` or `terra`, and `risk` is `low`,
`medium`, or `high`. With `strategy=direct`, omit `semanticPlan` and all plan-only fields.

For an explicitly durable job, submit without `monitorFirst`, show its Monitor link, and stop.
Treat a successful blocking status `finalResponse` as the complete delivery. If MCP fails, report
the exact error and stop unless the user explicitly requests a fallback.
