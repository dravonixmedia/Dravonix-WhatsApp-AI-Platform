-- ============================================================================
-- Migration 13: enables tenant-scoped Supabase Realtime for the dashboard
-- (Live Conversations, Human Handover Inbox, ai_mode changes).
--
-- Promoted from docs/proposed-migrations/00000000000013_dashboard_realtime.sql
-- (kept in place for audit history/review trail, not deleted) after security
-- review. See that file's full revision history for the reasoning that led
-- here, summarized below.
--
-- Confirmed schema gap: a repo-wide search found zero existing Realtime
-- infrastructure -- no table was in the `supabase_realtime` publication.
-- Without this migration, the client-side subscription code in apps/web/
-- lib/realtime/* compiles and typechecks correctly, but never actually
-- receives any postgres_changes events -- Realtime only broadcasts changes
-- for tables explicitly added to the publication.
--
-- Security correction already applied before this migration was approved:
-- an earlier draft set REPLICA IDENTITY FULL on all four tables, justified
-- partly as "gives RLS the company_id it needs to correctly scope DELETE
-- broadcasts". That was wrong -- per Supabase's documented Postgres Changes
-- behavior, RLS is evaluated for INSERT/UPDATE but is NOT applied to DELETE
-- events at all, and `old_record` is documented to stay primary-key-only
-- for RLS-enabled tables regardless of REPLICA IDENTITY. Combined with
-- confirming no client subscription anywhere reads `payload.old` (apps/web/
-- test/watchConfigs.test.ts audits every subscription; every one of them
-- is INSERT/UPDATE only -- DELETE and "*" are not even representable in
-- apps/web/lib/realtime/tenantChannel.ts's RealtimeWatch type), this
-- migration:
--   - never sets REPLICA IDENTITY on any table (all four stay at
--     Postgres's DEFAULT -- no ALTER TABLE ... REPLICA IDENTITY statement
--     appears anywhere below);
--   - never creates, drops, or recreates the `supabase_realtime`
--     publication itself (verifies it already exists, and aborts with a
--     controlled error otherwise -- see below);
--   - never touches any row, column, constraint, RLS policy, or GRANT on
--     any table;
--   - adds exactly four tables to the publication, guarded so it is safe
--     to apply more than once and safe if a table is already a member
--     (e.g. from a manual Supabase dashboard Realtime toggle).
-- ============================================================================

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
-- safe to run twice -- running it against a table already in the
-- publication raises `ERROR: relation "..." is already member of
-- publication "supabase_realtime"` and aborts the whole migration. This
-- guards each one with an existence check against pg_publication_tables so
-- applying this migration is a no-op for any table that's already a
-- member, whether from a prior run of this same migration or a table
-- someone already enabled by hand via the Supabase dashboard's per-table
-- Realtime toggle. Never creates, drops, or alters the `supabase_realtime`
-- publication itself; never touches any row, column, constraint, RLS
-- policy, or GRANT on these tables -- publication membership only controls
-- what Realtime *can* broadcast for INSERT/UPDATE, not who is authorized
-- to read it. Authorization for INSERT/UPDATE is unchanged: every existing
-- SELECT RLS policy on these four tables remains the sole boundary,
-- additionally enforced by Realtime itself against the connecting
-- client's own JWT (set client-side via supabase.realtime.setAuth
-- (accessToken) before subscribing -- see apps/web/lib/realtime/
-- useTenantRealtimeChannel.ts). This migration adds exactly these four
-- tables and no others:
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

-- `leads` is deliberately NOT added here -- the realtime requirement
-- enumerated conversations/messages/assignments/handovers/ai_mode only
-- (ai_mode is a column on `conversations`, already covered above). Leads
-- list/detail pages refresh on demand (revalidatePath after each mutation)
-- rather than via a live subscription; adding `leads` to this publication
-- would be a small, low-risk follow-up if live lead updates are wanted
-- later, out of scope for this migration.

-- ----------------------------------------------------------------------------
-- Rollback (additive only -- reverses cleanly, touches no data, no RLS/
-- grant changes to undo since none were made):
-- ----------------------------------------------------------------------------
-- alter publication supabase_realtime drop table public.conversations;
-- alter publication supabase_realtime drop table public.messages;
-- alter publication supabase_realtime drop table public.conversation_assignments;
-- alter publication supabase_realtime drop table public.handover_events;
