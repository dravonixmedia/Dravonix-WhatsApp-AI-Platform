# ADR-0007: Storage strategy

## Status

Accepted

## Context

The platform stores temporary inbound/outbound audio, generated voice replies, and
company knowledge documents (PDF/DOCX/TXT/CSV). All of it is tenant-owned and must
never be reachable across a tenant boundary, and audio in particular has retention
requirements (delete after a configurable period).

## Decision

- `packages/storage` defines a `StorageProvider` interface
  (`put`, `get`, `delete`, `getSignedUrl`, `list`) independent of the backing
  service.
- `R2StorageProvider` implements it against Cloudflare R2 (S3-compatible) — the
  default for temporary audio and processed media, colocated with the Workers
  runtime for low latency.
- `SupabaseStorageProvider` implements the same interface against Supabase Storage,
  for company documents where RLS-integrated access alongside the rest of the
  tenant's Postgres data is preferable.
- `MockStorageProvider` (in-memory) implements it for tests and local development
  without cloud credentials.
- Every object key is constructed as `companies/{companyId}/{domain}/{...}`
  (e.g. `companies/{id}/audio/inbound/{messageId}.ogg`,
  `companies/{id}/knowledge/{sourceId}/{filename}`) by a single key-builder
  (`packages/storage/src/keys.ts`) — callers never hand-construct keys, which
  prevents path-traversal or cross-tenant key collisions. The key builder rejects
  any `companyId`/`domain`/identifier containing path-traversal characters.
- Retention is enforced by a scheduled `retention-cleanup` job
  (`apps/workers/notification-consumer` cron partner, or a dedicated cron-triggered
  worker) reading per-company retention settings and deleting expired objects and
  their DB metadata rows together, in a transaction, so a partially-deleted object
  never leaves a dangling DB reference.

## Consequences

- Switching the temporary-audio backend (e.g. to another S3-compatible provider)
  means a new `StorageProvider` implementation, not a rewrite of the voice pipeline.
- Tenant isolation for storage is testable purely by asserting the key builder's
  rejection rules and by asserting `StorageProvider` implementations never accept a
  caller-supplied raw key.
