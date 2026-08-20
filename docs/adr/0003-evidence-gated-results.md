# ADR 0003: Separate production, checking, verification, and commit

- Status: Accepted
- Date: 2026-08-20

## Context

Language models can be confident while wrong. Self-reflection without external
feedback does not provide a reliable correctness boundary, and multi-agent
agreement can amplify correlated errors.

The architecture covers domains with different validators: tests and compilers,
paper source spans, numerical invariants, document rendering, or subjective
rubrics.

## Decision

Use explicit evidence gates:

```text
producer -> candidate
independent actor -> checked
direct parent -> verified
direct parent -> committed
```

The control plane enforces:

- producer cannot check/verify its own result;
- transitions cannot skip gates;
- reviews record evidence and notes;
- parent cannot commit with active direct children;
- dependency release occurs only after commit.

Deterministic validators and primary sources are preferred. Where no objective
validator exists, use independent proposals, explicit rubrics, limited
comparison, and unresolved/disputed outcomes.

## Consequences

Positive:

- Clear accountability.
- Auditable acceptance decisions.
- Reduced reliance on model confidence.
- Domain-specific validators fit one common lifecycle.

Negative:

- More tool calls and coordination.
- Not every task needs all gates; the current MVP applies them uniformly to
  managed producer tasks.
- Distinct actor IDs do not guarantee statistical independence.
- Human review remains necessary for critical irreversible outcomes.

## Future refinement

Introduce risk-based gate profiles only after benchmark evidence shows which
gates can be safely collapsed for low-risk, strongly deterministic tasks.
