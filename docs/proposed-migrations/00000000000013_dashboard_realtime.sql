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
-- publication, and no REPLICA IDENTITY has ever been set. Without this
-- migration, the client-side subscription code shipped in this branch
-- compiles and typechecks correctly, but will never actually receive any
-- postgres_changes events -- Realtime only broadcasts changes for tables
-- explicitly added to the publication.
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
-- Empirically verified locally (native PostgreSQL 16 + pgvector, matching
-- the pgvector/pgvector:pg16 image CI uses), not just reasoned about:
--   - Applied cleanly on top of migrations 1-12 in a fresh scratch database.
--   - supabase/tests/rls_tenant_isolation.sql and rls_handover.sql both
--     still pass unmodified afterward -- this migration does not change
--     cross-tenant isolation or any RLS behavior.
--   - Publication ends up with exactly these 4 tables, no more, no less.
--   - REPLICA IDENTITY is FULL on all 4 tables; RLS (relrowsecurity) remains
--     enabled and unchanged on all 4.
--   - Re-running the ADD TABLE guard below a second time, and running it
--     against a database where a table was already manually added to the
--     publication beforehand (simulating a teammate toggling Realtime on
--     via the Supabase dashboard UI before this migration ships), both
--     complete with zero errors and zero duplicate publication rows.
--     (An earlier draft of this file used bare `alter publication
--     supabase_realtime add table ...` statements, which are NOT
--     idempotent -- PostgreSQL raises `ERROR: relation "..." is already
--     member of publication "supabase_realtime"` and aborts the whole
--     migration if a table is already a member. Reproduced locally, then
--     fixed below with an existence-checked guard.)
-- ============================================================================

-- REPLICA IDENTITY FULL -- required per table, not just for app convenience:
--
-- Every one of these tables' SELECT RLS policies
-- (conversations_select_member, messages_select_member,
-- conversation_assignments' select policy, handover_events_select_member)
-- checks the row's `company_id`. Supabase Realtime enforces these same
-- policies per subscriber before forwarding a postgres_changes event, and
-- for UPDATE/DELETE it evaluates the policy against `old_record` (the
-- previous row image from the WAL). With the default REPLICA IDENTITY,
-- `old_record` only ever contains the primary key (`id`) -- `company_id`
-- would be missing, so the RLS check backing an UPDATE or DELETE broadcast
-- could never be satisfied correctly. FULL is what makes `company_id` (and
-- every other column the RLS policy or the client's own merge logic needs)
-- available on every UPDATE/DELETE event, which is what keeps tenant
-- scoping correct for those events, not just complete.
--
-- Per table:
--   conversations: state/ai_mode/assigned_member_id/handover_last_read_at
--     change on almost every UPDATE the dashboard needs to react to
--     (Pause/Resume AI, assign, start/end human assistance, handover
--     state transitions) -- FULL required for correct RLS-scoped
--     UPDATE broadcasts.
--   messages: outbound_status transitions (reserved -> sending -> sent/
--     send_failed/delivery_unknown) fire on every AI/human reply --
--     the highest-volume table here -- FULL required for the same reason.
--   conversation_assignments: assigned_to/unassigned_at UPDATEs on every
--     assign/reassign/end-human-assistance action -- FULL required.
--   handover_events: this table is INSERT-only in the application today
--     (trigger_handover's `insert ... on conflict (handover_event_key) do
--     nothing`; no UPDATE or DELETE code path exists anywhere in this
--     repo for it, confirmed by a repo-wide search). DEFAULT would
--     therefore be *sufficient* for this table's actual write pattern --
--     it is set to FULL here anyway only for consistency with the other
--     three and as a safety net (e.g. a future manual cleanup of a
--     mis-fired event, or an ON DELETE CASCADE from a company being
--     off-boarded) rather than because a live gap demands it. If the
--     reviewer prefers minimizing WAL overhead, `handover_events` is the
--     one table in this set that can safely be switched to DEFAULT.
alter table conversations replica identity full;
alter table messages replica identity full;
alter table conversation_assignments replica identity full;
alter table handover_events replica identity full;

-- WAL/performance impact: REPLICA IDENTITY FULL logs the entire previous
-- row (not just the primary key) into the WAL for every UPDATE/DELETE on
-- that table, increasing WAL volume and logical-decoding cost roughly in
-- proportion to row width and update frequency. `messages` is the table
-- most worth watching in production: it has the widest rows here (`body`
-- text, `ai_structured_response` jsonb) and the highest UPDATE frequency
-- (an outbound_status transition on every reply). `conversations` sees
-- moderate UPDATE volume (state/ai_mode changes, not per-message).
-- `conversation_assignments` and `handover_events` are comparatively
-- low-volume (assignment/handover events happen far less often than
-- messages) and negligible either way. None of this affects INSERT-only
-- workloads or SELECT reads at all -- REPLICA IDENTITY only changes what's
-- logged for UPDATE/DELETE. This is a bounded, acceptable cost at this
-- application's scale; if `messages` WAL volume ever becomes a measured
-- problem, a future optimization would be `REPLICA IDENTITY USING INDEX`
-- against a covering (id, company_id) index instead of FULL -- not
-- implemented here since no such index exists today and RLS-on-DELETE
-- correctness (above) still needs `company_id` present either way.

-- Idempotent add-to-publication: `alter publication ... add table` is NOT
-- safe to run twice (see the empirical note above) -- this guards each
-- one with an existence check against pg_publication_tables so applying
-- this migration is a no-op for any table that's already a member,
-- whether from a prior run of this same migration or a table someone
-- already enabled by hand via the Supabase dashboard's per-table Realtime
-- toggle. Never creates, drops, or alters the `supabase_realtime`
-- publication itself (Supabase provisions it automatically); never touches
-- any row, column, constraint, RLS policy, or GRANT on these tables --
-- publication membership only controls what Realtime *can* broadcast, not
-- who is authorized to read it. Authorization is unchanged: every existing
-- SELECT RLS policy on these four tables remains the sole boundary, now
-- additionally enforced by Realtime itself against the connecting client's
-- own JWT (set client-side via supabase.realtime.setAuth(accessToken)
-- before subscribing -- see apps/web/lib/realtime/useTenantRealtimeChannel.ts)
-- -- a client only ever receives postgres_changes events, including DELETE
-- events, for rows its own membership/permissions already allow it to see.
-- No DELETE code path exists against any of these four tables anywhere in
-- this repo today (verified by search); if one is ever added (or a company
-- off-boarding cascades a delete), the FULL old row -- company_id included
-- -- is exactly what keeps that DELETE broadcast correctly tenant-scoped
-- instead of silently malformed.
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
      execute format('alter publication supabase_realtime add table %I', target_table);
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
-- Rollback (additive only -- reverses cleanly, touches no data):
-- ----------------------------------------------------------------------------
-- alter publication supabase_realtime drop table conversations;
-- alter publication supabase_realtime drop table messages;
-- alter publication supabase_realtime drop table conversation_assignments;
-- alter publication supabase_realtime drop table handover_events;
-- alter table conversations replica identity default;
-- alter table messages replica identity default;
-- alter table conversation_assignments replica identity default;
-- alter table handover_events replica identity default;

-- ----------------------------------------------------------------------------
-- Suggested test assertions for supabase/tests/ once this migration is
-- approved and moved into supabase/migrations/ (not added as a live test
-- file yet, per "update only the proposed migration document" -- kept here
-- for review, to be split into its own supabase/tests/rls_realtime.sql
-- alongside the actual migration move):
--
-- 1. Publication membership is exactly the 4 intended tables, no more:
--   select array_agg(tablename order by tablename) from pg_publication_tables
--     where pubname = 'supabase_realtime' and schemaname = 'public';
--   -- expect: {conversation_assignments,conversations,handover_events,messages}
--
-- 2. Replica identity is FULL on all 4:
--   select relname, relreplident from pg_class
--     where relname in ('conversations','messages','conversation_assignments','handover_events');
--   -- expect: relreplident = 'f' for all 4 rows
--
-- 3. RLS remains enabled (this migration must never touch relrowsecurity):
--   select relname, relrowsecurity from pg_class
--     where relname in ('conversations','messages','conversation_assignments','handover_events');
--   -- expect: relrowsecurity = true for all 4 rows (already asserted
--   -- implicitly today by rls_tenant_isolation.sql/rls_handover.sql
--   -- continuing to pass unmodified after this migration).
--
-- 4. Company A cannot receive Company B's rows: this is a property of the
--   underlying SELECT RLS policies (conversations_select_member,
--   messages_select_member, etc.), already covered end-to-end by the
--   existing rls_tenant_isolation.sql/rls_handover.sql suites (both
--   re-verified passing after this migration, see the empirical note
--   above) -- publication membership does not change what those policies
--   allow, only whether a change event is broadcast at all. A dedicated
--   Realtime-specific test would need a running Realtime server (outside
--   what supabase/tests/run.sh's plain-Postgres harness can exercise) to
--   assert the websocket-level behavior directly; the RLS layer it depends
--   on is what's covered locally today.
-- ----------------------------------------------------------------------------
