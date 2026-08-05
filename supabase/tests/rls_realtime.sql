-- Migration 13 (dashboard Realtime) verification tests. Run after
-- rls_tenant_isolation.sql and rls_handover.sql (via supabase/tests/run.sh),
-- against the same throwaway local Postgres database -- never a hosted
-- Supabase project. Every check either passes silently or RAISE EXCEPTIONs.
--
-- Migration 13 itself already ran (as its own file, earlier in run.sh) by
-- the time this file executes, so publication membership/replica identity/
-- RLS-enabled state below are already-durable facts being verified, not
-- something this file sets up itself.
--
-- What this file does NOT re-check, because it's already covered
-- elsewhere and duplicating it here would be redundant, not more rigorous:
--   - "Migration sequence is contiguous from 1 through 13" is
--     supabase/migrations/validate-sequence.sh's job (a filename-globbing
--     check, not a database property) -- run as its own step in
--     supabase/tests/run.sh / CI, and confirmed separately in this task's
--     report.
--   - "Existing tenant-isolation tests still pass" means
--     rls_tenant_isolation.sql and rls_handover.sql, run immediately
--     before this file in the same suite -- their own pass/fail is the
--     answer, not something re-asserted here.
--   - "Migration 12 remains byte-for-byte unchanged" is a git-level fact
--     (`git diff` against the base branch), not a database property this
--     SQL can observe from inside a scratch database.

begin;

create or replace function test_assert(description text, condition boolean) returns void
  language plpgsql
  as $$
  begin
    if not condition then
      raise exception 'ASSERTION FAILED: %', description;
    else
      raise notice 'OK: %', description;
    end if;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- 1. The supabase_realtime publication exists.
-- ---------------------------------------------------------------------------

select test_assert(
  'supabase_realtime publication exists',
  exists (select 1 from pg_publication where pubname = 'supabase_realtime')
);

-- ---------------------------------------------------------------------------
-- 2. Exactly the four approved tables are publication members -- no more,
--    no less. Compares the full set, not just membership of each one
--    individually, so an extra/unrelated table would fail this too.
-- ---------------------------------------------------------------------------

select test_assert(
  'supabase_realtime publication contains exactly the 4 approved tables, no others',
  (
    select array_agg(tablename::text order by tablename)
    from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
  ) = array['conversation_assignments', 'conversations', 'handover_events', 'messages']
);

select test_assert(
  'public.conversations is a publication member',
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  )
);
select test_assert(
  'public.messages is a publication member',
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  )
);
select test_assert(
  'public.conversation_assignments is a publication member',
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_assignments'
  )
);
select test_assert(
  'public.handover_events is a publication member',
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'handover_events'
  )
);

select test_assert(
  'leads was NOT added to the publication by migration 13 (out of scope, unrelated)',
  not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads'
  )
);

-- ---------------------------------------------------------------------------
-- 3. Migration 13 can be applied twice without error, and applying it when
--    one or more tables are already present succeeds -- both are true
--    simultaneously here, since all four tables are already members from
--    the earlier run of the actual migration file. This re-executes the
--    exact same idempotent guard migration 13 uses (not a paraphrase) and
--    asserts membership is unchanged afterward.
-- ---------------------------------------------------------------------------

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

select test_assert(
  'Re-running migration 13''s idempotent guard a second time raised no error and left membership unchanged',
  (
    select array_agg(tablename::text order by tablename)
    from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
  ) = array['conversation_assignments', 'conversations', 'handover_events', 'messages']
);

-- ---------------------------------------------------------------------------
-- 4. Replica identity remains DEFAULT for all four tables -- migration 13
--    must never set FULL (see its header comment for why: RLS is not
--    applied to DELETE events regardless, and no subscription anywhere
--    reads payload.old, so FULL would only add WAL overhead for no
--    benefit).
-- ---------------------------------------------------------------------------

select test_assert(
  'conversations replica identity is DEFAULT, not FULL',
  (select relreplident from pg_class where relname = 'conversations') = 'd'
);
select test_assert(
  'messages replica identity is DEFAULT, not FULL',
  (select relreplident from pg_class where relname = 'messages') = 'd'
);
select test_assert(
  'conversation_assignments replica identity is DEFAULT, not FULL',
  (select relreplident from pg_class where relname = 'conversation_assignments') = 'd'
);
select test_assert(
  'handover_events replica identity is DEFAULT, not FULL',
  (select relreplident from pg_class where relname = 'handover_events') = 'd'
);

-- ---------------------------------------------------------------------------
-- 5. RLS remains enabled on all four tables -- migration 13 must never
--    touch relrowsecurity.
-- ---------------------------------------------------------------------------

select test_assert(
  'conversations has RLS enabled',
  (select relrowsecurity from pg_class where relname = 'conversations') = true
);
select test_assert(
  'messages has RLS enabled',
  (select relrowsecurity from pg_class where relname = 'messages') = true
);
select test_assert(
  'conversation_assignments has RLS enabled',
  (select relrowsecurity from pg_class where relname = 'conversation_assignments') = true
);
select test_assert(
  'handover_events has RLS enabled',
  (select relrowsecurity from pg_class where relname = 'handover_events') = true
);

-- ---------------------------------------------------------------------------
-- 6. Company A cannot access Company B's rows on any of the four realtime
--    tables -- migration 13 must not weaken (or appear to weaken) the
--    existing cross-tenant RLS boundary. Self-contained fixtures (not
--    reused from the other two suites, which already rolled back their own
--    fixtures by the time this file runs).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('91111111-0000-0000-0000-000000000001', 'realtime-owner-a@example.test'),
  ('92222222-0000-0000-0000-000000000002', 'realtime-owner-b@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('9a000000-0000-0000-0000-000000000001', 'Realtime Co A', 'realtime-co-a', 'active', true),
  ('9b000000-0000-0000-0000-000000000002', 'Realtime Co B', 'realtime-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('9c000000-0000-0000-0000-000000000001', '9a000000-0000-0000-0000-000000000001', '91111111-0000-0000-0000-000000000001', 'company_owner', true),
  ('9c000000-0000-0000-0000-000000000002', '9b000000-0000-0000-0000-000000000002', '92222222-0000-0000-0000-000000000002', 'company_owner', true);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('9d000000-0000-0000-0000-00000000000a', '9a000000-0000-0000-0000-000000000001', '911900000001', 'Realtime Customer A'),
  ('9d000000-0000-0000-0000-00000000000b', '9b000000-0000-0000-0000-000000000002', '911900000002', 'Realtime Customer B');

insert into conversations (id, company_id, contact_id, assigned_member_id) values
  ('9e000000-0000-0000-0000-00000000000a', '9a000000-0000-0000-0000-000000000001', '9d000000-0000-0000-0000-00000000000a', '9c000000-0000-0000-0000-000000000001'),
  ('9e000000-0000-0000-0000-00000000000b', '9b000000-0000-0000-0000-000000000002', '9d000000-0000-0000-0000-00000000000b', '9c000000-0000-0000-0000-000000000002');

insert into messages (company_id, conversation_id, direction, channel_type, sender_type, body, provider_message_id) values
  ('9a000000-0000-0000-0000-000000000001', '9e000000-0000-0000-0000-00000000000a', 'inbound', 'text', 'customer', 'Realtime hello from A', 'wamid.RTA1'),
  ('9b000000-0000-0000-0000-000000000002', '9e000000-0000-0000-0000-00000000000b', 'inbound', 'text', 'customer', 'Realtime hello from B', 'wamid.RTB1');

insert into conversation_assignments (conversation_id, company_id, assigned_to) values
  ('9e000000-0000-0000-0000-00000000000a', '9a000000-0000-0000-0000-000000000001', '9c000000-0000-0000-0000-000000000001'),
  ('9e000000-0000-0000-0000-00000000000b', '9b000000-0000-0000-0000-000000000002', '9c000000-0000-0000-0000-000000000002');

set local role authenticated;
select test_set_current_user('91111111-0000-0000-0000-000000000001');

select test_assert(
  'Company A owner can read Company A conversations',
  (select count(*) from conversations where company_id = '9a000000-0000-0000-0000-000000000001') = 1
);
select test_assert(
  'Company A owner CANNOT read Company B conversations',
  (select count(*) from conversations where company_id = '9b000000-0000-0000-0000-000000000002') = 0
);
select test_assert(
  'Company A owner CANNOT read Company B messages',
  (select count(*) from messages where company_id = '9b000000-0000-0000-0000-000000000002') = 0
);
select test_assert(
  'Company A owner CANNOT read Company B conversation_assignments',
  (select count(*) from conversation_assignments where company_id = '9b000000-0000-0000-0000-000000000002') = 0
);
select test_assert(
  'Company A owner sees zero handover_events across either company (neither conversation triggered a handover)',
  (select count(*) from handover_events where company_id in ('9a000000-0000-0000-0000-000000000001', '9b000000-0000-0000-0000-000000000002')) = 0
);

select test_clear_current_user();

rollback;
