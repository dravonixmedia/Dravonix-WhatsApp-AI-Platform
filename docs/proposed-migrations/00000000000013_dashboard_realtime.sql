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
-- If approved, move this file to
-- supabase/migrations/00000000000013_dashboard_realtime.sql (next in
-- sequence after 00000000000012_human_handover.sql) and apply it exactly
-- like every prior migration: local/CI scratch-database validation via
-- `pnpm test:db` first, then a separate, explicit go-ahead before it is
-- ever applied to the hosted staging Supabase project.
-- ============================================================================

-- REPLICA IDENTITY FULL: without this, Realtime's UPDATE/DELETE payloads
-- only guarantee the row's primary key in `old_record`, not the rest of the
-- previous values. FULL gives the dashboard's realtime handlers the
-- complete previous row on every UPDATE/DELETE, which the client-side merge
-- logic (apps/web/lib/realtime/*, ConversationThread.tsx) relies on for
-- correctly patching in-place rather than guessing at what changed.
alter table conversations replica identity full;
alter table messages replica identity full;
alter table conversation_assignments replica identity full;
alter table handover_events replica identity full;

-- Adds each table to the `supabase_realtime` publication Supabase's Realtime
-- server broadcasts from. This is additive and reversible (see rollback
-- below) and does not alter any row, column, constraint, or RLS policy on
-- these tables -- every existing SELECT RLS policy
-- (conversations_select_member, messages_select_member,
-- conversation_assignments' select policy, handover_events_select_member)
-- continues to be the actual authorization boundary: Supabase Realtime
-- evaluates each table's SELECT RLS using the connecting user's own JWT
-- (set client-side via supabase.realtime.setAuth(accessToken) before
-- subscribing -- see apps/web/lib/realtime/useTenantRealtimeChannel.ts), so
-- a client only ever receives postgres_changes events for rows its own
-- membership/permissions already allow it to see.
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversation_assignments;
alter publication supabase_realtime add table handover_events;

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
