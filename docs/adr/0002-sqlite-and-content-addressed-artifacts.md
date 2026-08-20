# ADR 0002: Use SQLite and a content-addressed local artifact store

- Status: Accepted
- Date: 2026-08-20

## Context

The MVP needs transactions, optimistic versions, leases, idempotency, recovery,
and audit on one Codex host. Requiring external infrastructure would make local
App/IDE adoption substantially harder.

Task metadata and large artifact bodies have different access patterns. Storing
all content in chat or SQLite would increase context and database size.

## Decision

Use:

- Node's built-in `node:sqlite`;
- one local SQLite database for workflow records;
- WAL when supported;
- immediate write transactions;
- immutable artifact files addressed by SHA-256;
- SQLite metadata linking tasks, claims, and artifact URIs.

Artifacts are accepted as bounded content. The API does not register arbitrary
host filesystem paths.

## Consequences

Positive:

- Zero database service dependency.
- Atomic task mutations and durable idempotency.
- Easy local backup and recovery.
- Artifact deduplication and integrity checks.
- No native npm database addon.

Negative:

- Single-host writer model.
- Database and artifact directory must be backed up together.
- No multi-tenant authentication.
- Storage retention and garbage collection are not yet implemented.

## Migration trigger

Move to a service database/object store only when requirements include:

- multiple Codex hosts;
- remote workers;
- untrusted tenants;
- high write concurrency;
- independent high availability.

That migration also requires authenticated actor identity, distributed lease
fencing, and an explicit consistency model.
