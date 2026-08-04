-- ============================================================================
-- PROPOSED MIGRATION -- NOT APPLIED, NOT YET IN supabase/migrations/.
--
-- Per this task's instructions ("do not apply a new migration unless a
-- confirmed schema gap requires one... prepare a proposed migration and
-- stop for approval before applying it"), this file is deliberately kept
-- outside supabase/migrations/ so it is never picked up by
-- supabase/migrations/validate-sequence.sh or supabase/tests/run.sh
-- (pnpm test:db), and is not part of any migration numbering yet.
--
-- Confirmed schema gap: this branch adds tenant-scoped Supabase Realtime
-- (dashboard live updates for conversations, messages, assignments,
-- handovers, and ai_mode changes). A repo-wide search confirmed zero
-- existing Realtime infrastructure: no table is in the `supabase_realtime`
-- publication. Without this migration, the client-side subscription code
-- shipped in this branch compiles and typechecks correctly, but will never
-- actually receive any postgres_changes events -- Realtime only broadcasts
-- changes for tables explicitly added to the publication.
--
-- Number: 00000000000013, the correct next contiguous number after
-- 00000000000012_human_handover.sql (verified via
-- supabase/migrations/validate-sequence.sh, which still reports migrations
-- 1..12 as a contiguous, gap-free sequence -- this file is not yet counted
-- since it isn't in that directory).
--
-- If approved, move this file to
-- supabase/migrations/00000000000013_dashboard_realtime.sql and apply it
-- exactly like every prior migration: local/CI scratch-database validation
-- via `pnpm test:db` first, then a separate, explicit go-ahead before it is
-- ever applied to the hosted staging Supabase project.
--
-- ----------------------------------------------------------------------------
-- REVISION 2 -- corrects a security misstatement in the previous revision.
-- ----------------------------------------------------------------------------
-- The previous revision of this file set REPLICA IDENTITY FULL on all four
-- tables and justified it partly as "gives RLS the company_id it needs to
-- correctly scope DELETE broadcasts". That justification was wrong. Per
-- Supabase's documented Postgres Changes behavior:
--   - Row Level Security is evaluated for INSERT and UPDATE events (Realtime
--     re-checks the row's visibility per subscriber).
--   - RLS is NOT applied to DELETE events at all. A DELETE is broadcast to
--     every subscriber on that table, regardless of their own RLS
--     visibility -- REPLICA IDENTITY FULL does not change this; it only
--     changes how much of the deleted row's data is included in that
--     unfiltered broadcast, which would make the exposure worse, not safer.
--   - Even for UPDATE, when RLS is enabled on a table, `old_record` on a
--     realtime payload is documented to only ever contain primary-key
--     columns -- not the rest of the row -- regardless of REPLICA IDENTITY.
--     Setting FULL does not actually deliver old.company_id (or any other
--     old column) to a Postgres Changes subscriber for these RLS-enabled
--     tables; it only affects what Postgres itself logs to the WAL.
--
-- Given that, the correct, minimal fix has two parts, both applied in this
-- revision:
--   1. No subscription in this branch (apps/web/lib/realtime/*) is
--      registered for DELETE, or for "*" (which silently includes DELETE),
--      for any of these four tables -- see
--      apps/web/lib/realtime/tenantChannel.ts (RealtimeWatch's `event` type
--      no longer accepts "DELETE"/"*" at all -- a compile error, not just a
--      convention) and apps/web/lib/realtime/watchConfigs.ts (every actual
--      subscription, audited in apps/web/test/watchConfigs.test.ts).
--      There are no DELETE code paths against any of these four tables
--      anywhere in this repo today, so there is nothing to subscribe to,
--      and no "just in case" DELETE subscription has been added.
--   2. REPLICA IDENTITY is left at its default on all four tables (no
--      `alter table ... replica identity full` statements below at all).
--      Every subscription in this branch reads only `payload.new` --
--      confirmed by inspection of apps/web/app/dashboard/handover/
--      [conversationId]/ConversationThread.tsx (the only handler that reads
--      payload data at all; RealtimeRefreshBoundary's handler ignores the
--      payload entirely and just triggers a refetch through the existing,
--      already-correct, already-RLS-scoped server data loader). Since
--      nothing consumes `payload.old`, and old_record wouldn't reliably
--      contain more than the primary key for these RLS-enabled tables
--      regardless, REPLICA IDENTITY FULL would add WAL overhead (the full
--      previous row logged on every UPDATE, heaviest on `messages` --
--      widest rows, highest update frequency via outbound_status
--      transitions) for zero actual benefit to this application. DEFAULT
--      (primary-key-only old-row tracking) is correct for all four tables.
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'supabase_realtime publication does not exist. This migration assumes a '
      'real Supabase project, which provisions this publication automatically '
      '-- it deliberately never creates or drops it itself. Aborting rather '
      'than silently creating one, since that would indicate this is being '
      'run against an unexpected environment.';
  end if;
end $$;

-- Idempotent add-to-publication: `alter publication ... add table` is NOT
-- safe to run twice -- empirically reproduced locally (PostgreSQL 16):
-- running it against a table already in the publication raises
-- `ERROR: relation "..." is already member of publication "supabase_realtime"`
-- and aborts the whole migration. This guards each one with an existence
-- check against pg_publication_tables so applying this migration is a
-- no-op for any table that's already a member, whether from a prior run of
-- this same migration or a table someone already enabled by hand via the
-- Supabase dashboard's per-table Realtime toggle. Never creates, drops, or
-- alters the `supabase_realtime` publication itself; never touches any
-- row, column, constraint, RLS policy, or GRANT on these tables --
-- publication membership only controls what Realtime *can* broadcast for
-- INSERT/UPDATE, not who is authorized to read it. Authorization for
-- INSERT/UPDATE is unchanged: every existing SELECT RLS policy on these
-- four tables remains the sole boundary, additionally enforced by Realtime
-- itself against the connecting client's own JWT (set client-side via
-- supabase.realtime.setAuth(accessToken) before subscribing -- see
-- apps/web/lib/realtime/useTenantRealtimeChannel.ts). This migration adds
-- exactly these four tables and no others:
--   public.conversations
--   public.messages
--   public.conversation_assignments
--   public.handover_events
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'conversations',
    'messages',
    'conversation_assignments',
    'handover_events'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = target_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end $$;

-- `leads` is deliberately NOT added here -- the realtime requirement for
-- this task enumerated conversations/messages/assignments/handovers/
-- ai_mode only (ai_mode is a column on `conversations`, already covered
-- above). Leads list/detail pages in this branch refresh on demand
-- (revalidatePath after each mutation) rather than via a live subscription;
-- adding `leads` to this publication would be a small, low-risk follow-up
-- if live lead updates are wanted later, out of scope for this proposal.

-- ----------------------------------------------------------------------------
-- Rollback (additive only -- reverses cleanly, touches no data, no RLS/
-- grant changes to undo since none were made):
-- ----------------------------------------------------------------------------
-- alter publication supabase_realtime drop table public.conversations;
-- alter publication supabase_realtime drop table public.messages;
-- alter publication supabase_realtime drop table public.conversation_assignments;
-- alter publication supabase_realtime drop table public.handover_events;

-- ----------------------------------------------------------------------------
-- Empirically verified locally (native PostgreSQL 16 + pgvector, matching
-- the pgvector/pgvector:pg16 image CI uses), not just reasoned about:
--   - Applied cleanly on top of migrations 1-12 in a fresh scratch database
--     that already has a `supabase_realtime` publication (mirroring what a
--     real Supabase project provisions automatically).
--   - Running it a second time (idempotency), and running it against a
--     database where a table was already manually added to the publication
--     beforehand (simulating a teammate toggling Realtime on via the
--     Supabase dashboard UI before this migration ships), both complete
--     with zero errors and zero duplicate publication rows.
--   - Dropping the `supabase_realtime` publication first and re-applying:
--     aborts with the controlled RAISE EXCEPTION message above, not a
--     generic Postgres error.
--   - Publication ends up with exactly these 4 tables, no more, no less.
--   - supabase/tests/rls_tenant_isolation.sql and rls_handover.sql both
--     still pass unmodified afterward -- this migration does not change
--     cross-tenant isolation, RLS, or any grant.
--   - REPLICA IDENTITY is left at its default (no ALTER TABLE statements
--     in this file at all) -- there is nothing to verify changed there.
--
-- Suggested test assertions for supabase/tests/ once this migration is
-- approved and moved into supabase/migrations/ (not added as a live test
-- file yet, per "update only ... where required" -- to be split into
-- supabase/tests/rls_realtime.sql alongside the actual migration move):
--
-- 1. Publication membership is exactly the 4 intended tables, no more:
--   select array_agg(tablename order by tablename) from pg_publication_tables
--     where pubname = 'supabase_realtime' and schemaname = 'public';
--   -- expect: {conversation_assignments,conversations,handover_events,messages}
--
-- 2. Replica identity remains DEFAULT on all 4 (this migration must never
--   set it to FULL or anything else):
--   select relname, relreplident from pg_class
--     where relname in ('conversations','messages','conversation_assignments','handover_events');
--   -- expect: relreplident = 'd' (default) for all 4 rows
--
-- 3. RLS remains enabled (this migration must never touch relrowsecurity):
--   select relname, relrowsecurity from pg_class
--     where relname in ('conversations','messages','conversation_assignments','handover_events');
--   -- expect: relrowsecurity = true for all 4 rows (already asserted
--   -- implicitly today by rls_tenant_isolation.sql/rls_handover.sql
--   -- continuing to pass unmodified after this migration).
--
-- 4. Company A cannot receive Company B's INSERT/UPDATE rows: this is a
--   property of the underlying SELECT RLS policies (conversations_select_
--   member, messages_select_member, etc.), already covered end-to-end by
--   the existing rls_tenant_isolation.sql/rls_handover.sql suites (both
--   re-verified passing after this migration). Whether a client's
--   *application code* ever asks for another tenant's rows in the first
--   place is covered client-side by apps/web/test/tenantChannel.test.ts
--   and apps/web/test/watchConfigs.test.ts (every watch list audited to
--   confirm INSERT/UPDATE only, filters always embed the caller's own
--   scopeId, never a second tenant's id). A dedicated Realtime-specific
--   integration test would need a running Realtime server (outside what
--   supabase/tests/run.sh's plain-Postgres harness can exercise) to assert
--   the websocket-level broadcast behavior directly; the RLS layer and the
--   client subscription construction it depends on are both covered
--   locally today.
-- ----------------------------------------------------------------------------
