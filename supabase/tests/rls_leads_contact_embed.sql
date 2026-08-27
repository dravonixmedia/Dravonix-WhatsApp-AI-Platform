-- P0 deadline-recovery fix (migration 33): leads -> contacts embed grant
-- regression test.
--
-- Migration 26 (00000000000026_close_phone_bypass.sql) revoked table-level
-- SELECT on public.leads from authenticated and re-granted a column
-- allowlist that omitted contact_id. apps/web/lib/repositories/
-- leadsRepository.ts's LEAD_SELECT_COLUMNS (listLeads/getLead) and
-- apps/web/lib/repositories/globalSearchRepository.ts's searchLeads all
-- select a PostgREST embedded relation `contacts (display_name,
-- profile_name)`, which PostgREST compiles into a join on
-- `contacts.id = leads.contact_id` -- requiring SELECT privilege on
-- leads.contact_id even though contact_id is never in the embed's own
-- output list. Without it, every one of those queries raised `42501
-- permission denied for table leads` as the authenticated role, which
-- surfaced to the client as the Next.js dashboard's "Something went wrong"
-- error boundary. Reproduced directly against hosted staging before writing
-- migration 33.
--
-- This test harness has no PostgREST layer (see supabase/tests/README.md --
-- these tests run raw SQL against a scratch Postgres database, never
-- through PostgREST itself), so the composed access pattern below is the
-- exact SQL-privilege equivalent of what PostgREST generates for
-- `.select("id, contacts(display_name, profile_name)")` on leads: a query
-- whose own text never lists contact_id, but whose join condition
-- references it, which is precisely the shape Postgres' column-privilege
-- check cares about -- privileges are enforced on every column a query
-- *references* (including implicit join columns), not only the ones it
-- returns. This is the same class of column-reference-without-selection
-- behavior rls_phone_direct_access_revoke.sql already exercises for
-- migration 26's whatsapp_wa_id/phone_number exclusions; this file
-- exercises the complementary case migration 26 got wrong.
--
-- Without migration 33 applied, section 2 below raises an uncaught
-- "permission denied for table leads" exception, which aborts and fails
-- this entire script (ON_ERROR_STOP=1) -- i.e. this test fails against
-- migrations 1-32 and passes once migration 33 is applied, exactly as
-- required.

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

create or replace function test_assert_raises(description text, sql_text text, expected_message text) returns void
  language plpgsql
  as $$
  declare
    caught text;
    did_raise boolean := false;
  begin
    begin
      execute sql_text;
    exception
      when others then
        caught := sqlerrm;
        did_raise := true;
    end;

    if not did_raise then
      raise exception 'ASSERTION FAILED: % -- expected exception "%" but none was raised', description, expected_message;
    end if;
    if caught <> expected_message then
      raise exception 'ASSERTION FAILED: % -- expected exception "%" but got "%"', description, expected_message, caught;
    end if;
    raise notice 'OK: %', description;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- 1. Privilege-model sanity: migration 33 must add exactly one column grant,
--    nothing else. (Items 5, 6, 7 of the P0 regression checklist.)
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_assert('authenticated can now select leads.contact_id (migration 33 applied)',
    has_column_privilege('authenticated', 'public.leads', 'contact_id', 'SELECT'));
  perform test_assert('authenticated still cannot select leads.phone_number -- migration 26''s protection is untouched',
    not has_column_privilege('authenticated', 'public.leads', 'phone_number', 'SELECT'));
  perform test_assert('authenticated still has NO table-level SELECT on leads -- migration 33 is column-only, not a restoration',
    not has_table_privilege('authenticated', 'public.leads', 'SELECT'));
  perform test_assert('authenticated retains SELECT on the pre-existing safe leads.customer_name column',
    has_column_privilege('authenticated', 'public.leads', 'customer_name', 'SELECT'));
  perform test_assert('anon still has no table-level SELECT on leads',
    not has_table_privilege('anon', 'public.leads', 'SELECT'));
  perform test_assert('anon still cannot select leads.contact_id -- migration 33 only ever grants to authenticated',
    not has_column_privilege('anon', 'public.leads', 'contact_id', 'SELECT'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: two companies, every leads-relevant company role in Company A
-- (including company_accounts, which must remain denied), a contact + lead
-- in each company.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('91000001-0000-0000-0000-000000000001', 'owner-embed-a@example.test'),
  ('91000001-0000-0000-0000-000000000002', 'admin-embed-a@example.test'),
  ('91000001-0000-0000-0000-000000000003', 'manager-embed-a@example.test'),
  ('91000001-0000-0000-0000-000000000004', 'teamlead-embed-a@example.test'),
  ('91000001-0000-0000-0000-000000000005', 'sales-embed-a@example.test'),
  ('91000001-0000-0000-0000-000000000006', 'accounts-embed-a@example.test'),
  ('91000002-0000-0000-0000-000000000001', 'owner-embed-b@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('92000001-0000-0000-0000-000000000001', 'Leads Embed Co A', 'leads-embed-co-a', 'active', true),
  ('92000002-0000-0000-0000-000000000001', 'Leads Embed Co B', 'leads-embed-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('93000001-0000-0000-0000-000000000001', '92000001-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('93000001-0000-0000-0000-000000000002', '92000001-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000002', 'company_admin', true),
  ('93000001-0000-0000-0000-000000000003', '92000001-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000003', 'manager', true),
  ('93000001-0000-0000-0000-000000000004', '92000001-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000004', 'team_leader', true),
  ('93000001-0000-0000-0000-000000000005', '92000001-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000005', 'sales_person', true),
  ('93000001-0000-0000-0000-000000000006', '92000001-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000006', 'company_accounts', true),
  ('93000002-0000-0000-0000-000000000001', '92000002-0000-0000-0000-000000000001', '91000002-0000-0000-0000-000000000001', 'company_owner', true);

insert into contacts (id, company_id, whatsapp_wa_id, display_name, profile_name) values
  ('94000001-0000-0000-0000-000000000001', '92000001-0000-0000-0000-000000000001', '971500000001', 'Embed Test Contact A', 'Contact A Profile'),
  ('94000002-0000-0000-0000-000000000001', '92000002-0000-0000-0000-000000000001', '971500000002', 'Embed Test Contact B', 'Contact B Profile');

insert into leads (id, company_id, contact_id, customer_name, phone_number, stage, source) values
  ('95000001-0000-0000-0000-000000000001', '92000001-0000-0000-0000-000000000001', '94000001-0000-0000-0000-000000000001', 'Embed Test Lead A', '971500000001', 'new', 'whatsapp_chatbot'),
  ('95000002-0000-0000-0000-000000000001', '92000002-0000-0000-0000-000000000001', '94000002-0000-0000-0000-000000000001', 'Embed Test Lead B', '971500000002', 'new', 'whatsapp_chatbot');

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE BUG ITSELF: the composed leads -> contacts embed query, exactly as
--    PostgREST would issue it for LEAD_SELECT_COLUMNS / searchLeads. Every
--    role holding leads.view must be able to run this without error and get
--    the correct joined contact fields. (Items 1, 2, 9 of the checklist.)
--    Without migration 33 this raises "permission denied for table leads"
--    and aborts the whole script -- there is no try/catch here on purpose.
-- ---------------------------------------------------------------------------

do $$
declare
  v_users text[] := array[
    '91000001-0000-0000-0000-000000000001', -- owner
    '91000001-0000-0000-0000-000000000002', -- admin
    '91000001-0000-0000-0000-000000000003', -- manager
    '91000001-0000-0000-0000-000000000004', -- team_leader
    '91000001-0000-0000-0000-000000000005'  -- sales_person
  ];
  v_labels text[] := array['owner', 'admin', 'manager', 'team_leader', 'sales_person'];
  u text;
  i int;
  v_display text;
  v_profile text;
begin
  for i in 1..array_length(v_users, 1) loop
    u := v_users[i];
    perform test_set_current_user(u::uuid);
    select c.display_name, c.profile_name into v_display, v_profile
      from public.leads l
      left join public.contacts c on c.id = l.contact_id
      where l.id = '95000001-0000-0000-0000-000000000001';
    perform test_assert(
      format('%s: the leads -> contacts embed query (PostgREST-equivalent) succeeds, no permission error', v_labels[i]),
      true -- reaching this line at all proves no exception was raised above
    );
    perform test_assert(
      format('%s: the embed query returns the correct joined contact display_name', v_labels[i]),
      v_display = 'Embed Test Contact A'
    );
    perform test_assert(
      format('%s: the embed query returns the correct joined contact profile_name', v_labels[i]),
      v_profile = 'Contact A Profile'
    );
  end loop;
end;
$$;

-- Cross-company sanity: Company B's owner can use the same fixed embed for
-- their OWN company's lead -- the fix is not company-A-specific.
do $$
declare v_display text; begin
  perform test_set_current_user('91000002-0000-0000-0000-000000000001'); -- owner of Company B
  select c.display_name into v_display
    from public.leads l
    left join public.contacts c on c.id = l.contact_id
    where l.id = '95000002-0000-0000-0000-000000000001';
  perform test_assert('Company B owner: the embed query works for their own company''s lead too', v_display = 'Embed Test Contact B');
end; $$;

-- ---------------------------------------------------------------------------
-- 3. RLS remains fully authoritative for row scope -- migration 33 is a
--    column grant, not a row-visibility change. (Items 3, 4, 8, 10.)
-- ---------------------------------------------------------------------------

-- company_accounts holds no leads.view permission -- RLS (leads_select_member)
-- must still filter every row, even though the column-privilege check now
-- passes. This must return zero rows, not raise a permission error --
-- proving the denial is RLS-based (row scope), not privilege-based.
do $$
declare v_count integer; begin
  perform test_set_current_user('91000001-0000-0000-0000-000000000006'); -- company_accounts
  select count(*) into v_count
    from public.leads l
    left join public.contacts c on c.id = l.contact_id
    where l.id = '95000001-0000-0000-0000-000000000001';
  perform test_assert('company_accounts (no leads.view): RLS still returns zero rows for the embed query', v_count = 0);
end; $$;

-- Cross-tenant: Company B's owner must get zero rows for Company A's lead,
-- not an error and not another company's data.
do $$
declare v_count integer; begin
  perform test_set_current_user('91000002-0000-0000-0000-000000000001'); -- owner of Company B
  select count(*) into v_count
    from public.leads l
    left join public.contacts c on c.id = l.contact_id
    where l.id = '95000001-0000-0000-0000-000000000001'; -- Company A's lead
  perform test_assert('cross-tenant: Company B''s owner gets zero rows for Company A''s lead', v_count = 0);
end; $$;

-- Contacts table tenant isolation is independently intact: Company B's
-- owner cannot directly read Company A's contact row either.
do $$
declare v_count integer; begin
  perform test_set_current_user('91000002-0000-0000-0000-000000000001'); -- owner of Company B
  select count(*) into v_count from public.contacts where id = '94000001-0000-0000-0000-000000000001';
  perform test_assert('cross-tenant: Company B''s owner cannot directly read Company A''s contact row', v_count = 0);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Migration 26's other protections remain fully intact after migration
--    33 -- phone_number still denied, table-level SELECT still not restored.
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_set_current_user('91000001-0000-0000-0000-000000000001'); -- owner
  perform test_assert_raises(
    'owner: direct "select phone_number from leads" is still denied after migration 33',
    $sql$ select phone_number from public.leads where id = '95000001-0000-0000-0000-000000000001' $sql$,
    'permission denied for table leads'
  );
  perform test_assert_raises(
    'owner: "select * from leads" is still denied after migration 33 (no table-level SELECT was restored)',
    $sql$ select * from public.leads where id = '95000001-0000-0000-0000-000000000001' $sql$,
    'permission denied for table leads'
  );
end;
$$;

-- Existing allowed columns still work directly, unaffected by migration 33.
do $$
declare v_name text; begin
  perform test_set_current_user('91000001-0000-0000-0000-000000000001'); -- owner
  select customer_name into v_name from public.leads where id = '95000001-0000-0000-0000-000000000001';
  perform test_assert('owner can still directly select the pre-existing safe leads.customer_name column', v_name = 'Embed Test Lead A');
end; $$;

reset role;

rollback;
