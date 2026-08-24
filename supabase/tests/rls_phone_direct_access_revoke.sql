-- Phase 3A.2 (migration 26): direct raw phone-column access closure tests.
-- Run after rls_phone_privacy_security.sql (via supabase/tests/run.sh),
-- against the same throwaway local Postgres database -- never a hosted
-- Supabase project. Migration 25 built the secure phone read layer and
-- proved its authorization behavior; this file proves the complementary
-- half -- that after migration 26, NO authenticated session, regardless of
-- app-level company role (including Owner, and including platform
-- super_admin, whose Postgres connection role is `authenticated` exactly
-- like everyone else -- their full-access privilege comes entirely from
-- phone_is_full_for_caller's app-level check inside the RPC, never from a
-- raw column grant), can read contacts.whatsapp_wa_id or leads.phone_number
-- via a bare SQL/PostgREST-shaped query, while every migration-25 RPC
-- keeps working exactly as before.

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
-- 0. Privilege-model sanity: authenticated/anon must have lost table-level
--    SELECT entirely on both tables (proves migration 26 actually ran, not
--    just that RLS happens to deny these particular rows).
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_assert('authenticated has lost table-level SELECT on contacts',
    not has_table_privilege('authenticated', 'public.contacts', 'SELECT'));
  perform test_assert('authenticated has lost table-level SELECT on leads',
    not has_table_privilege('authenticated', 'public.leads', 'SELECT'));
  perform test_assert('authenticated still cannot select contacts.whatsapp_wa_id at the column level',
    not has_column_privilege('authenticated', 'public.contacts', 'whatsapp_wa_id', 'SELECT'));
  perform test_assert('authenticated still cannot select leads.phone_number at the column level',
    not has_column_privilege('authenticated', 'public.leads', 'phone_number', 'SELECT'));
  perform test_assert('authenticated retains SELECT on the safe contacts.display_name column',
    has_column_privilege('authenticated', 'public.contacts', 'display_name', 'SELECT'));
  perform test_assert('authenticated retains SELECT on the safe leads.customer_name column',
    has_column_privilege('authenticated', 'public.leads', 'customer_name', 'SELECT'));
  perform test_assert('anon has lost table-level SELECT on contacts',
    not has_table_privilege('anon', 'public.contacts', 'SELECT'));
  perform test_assert('anon has lost table-level SELECT on leads',
    not has_table_privilege('anon', 'public.leads', 'SELECT'));
  perform test_assert('service_role is completely unaffected -- retains full table-level SELECT on contacts',
    has_table_privilege('service_role', 'public.contacts', 'SELECT'));
  perform test_assert('service_role is completely unaffected -- retains full table-level SELECT on leads',
    has_table_privilege('service_role', 'public.leads', 'SELECT'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: one company with every company-wide role plus an assigned and
-- an unassigned Sales Person, a Company Accounts member, a cross-tenant
-- company, and platform super_admin.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('b0000001-0000-0000-0000-000000000002', 'super-admin-4@example.test'),
  ('b4000001-0000-0000-0000-000000000001', 'owner-b4@example.test'),
  ('b4000001-0000-0000-0000-000000000002', 'admin-b4@example.test'),
  ('b4000001-0000-0000-0000-000000000003', 'manager-b4@example.test'),
  ('b4000001-0000-0000-0000-000000000004', 'teamlead-b4@example.test'),
  ('b4000001-0000-0000-0000-000000000005', 'sales-assigned-b4@example.test'),
  ('b4000001-0000-0000-0000-000000000006', 'sales-unassigned-b4@example.test'),
  ('b4000001-0000-0000-0000-000000000007', 'accounts-b4@example.test'),
  ('b4000002-0000-0000-0000-000000000001', 'owner-c4@example.test');

insert into platform_members (user_id, role, is_active) values
  ('b0000001-0000-0000-0000-000000000002', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('c4000001-0000-0000-0000-000000000001', 'Phone Revoke Co A', 'phone-revoke-co-a', 'active', true),
  ('c4000002-0000-0000-0000-000000000001', 'Phone Revoke Co B', 'phone-revoke-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('d4000001-0000-0000-0000-000000000001', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('d4000001-0000-0000-0000-000000000002', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000002', 'company_admin', true),
  ('d4000001-0000-0000-0000-000000000003', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000003', 'manager', true),
  ('d4000001-0000-0000-0000-000000000004', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000004', 'team_leader', true),
  ('d4000001-0000-0000-0000-000000000005', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000005', 'sales_person', true),
  ('d4000001-0000-0000-0000-000000000006', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000006', 'sales_person', true),
  ('d4000001-0000-0000-0000-000000000007', 'c4000001-0000-0000-0000-000000000001', 'b4000001-0000-0000-0000-000000000007', 'company_accounts', true),
  ('d4000002-0000-0000-0000-000000000001', 'c4000002-0000-0000-0000-000000000001', 'b4000002-0000-0000-0000-000000000001', 'company_owner', true);

insert into contacts (id, company_id, whatsapp_wa_id, display_name) values
  ('e4000001-0000-0000-0000-000000000001', 'c4000001-0000-0000-0000-000000000001', '971511112222', 'Revoke Test Contact'),
  ('e4000002-0000-0000-0000-000000000001', 'c4000002-0000-0000-0000-000000000001', '971522223333', 'Revoke Test Contact B');

insert into conversations (id, company_id, contact_id, state, assigned_member_id) values
  ('f4000001-0000-0000-0000-000000000001', 'c4000001-0000-0000-0000-000000000001', 'e4000001-0000-0000-0000-000000000001', 'human_active', 'd4000001-0000-0000-0000-000000000005'),
  ('f4000002-0000-0000-0000-000000000001', 'c4000002-0000-0000-0000-000000000001', 'e4000002-0000-0000-0000-000000000001', 'human_active', null);

insert into leads (id, company_id, contact_id, conversation_id, customer_name, phone_number, assigned_member_id) values
  ('a4000001-0000-0000-0000-000000000001', 'c4000001-0000-0000-0000-000000000001', 'e4000001-0000-0000-0000-000000000001', 'f4000001-0000-0000-0000-000000000001', 'Revoke Test Lead', '971511112222', 'd4000001-0000-0000-0000-000000000005');

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. Direct raw column access: denied for every role, unconditionally.
--    Postgres reports this as a table-level permission error (there is no
--    partial table-level grant left at all for these two columns), which is
--    exactly the point -- there is no "entitled enough" role that can read
--    the raw column straight from the table anymore.
-- ---------------------------------------------------------------------------

do $$
declare
  v_users text[] := array[
    'b4000001-0000-0000-0000-000000000001', -- owner
    'b4000001-0000-0000-0000-000000000002', -- admin
    'b4000001-0000-0000-0000-000000000003', -- manager
    'b4000001-0000-0000-0000-000000000004', -- team_leader
    'b4000001-0000-0000-0000-000000000005', -- sales-assigned
    'b4000001-0000-0000-0000-000000000006', -- sales-unassigned
    'b4000001-0000-0000-0000-000000000007', -- company_accounts
    'b0000001-0000-0000-0000-000000000002'  -- super_admin (their Postgres role is still `authenticated`)
  ];
  v_labels text[] := array[
    'owner', 'admin', 'manager', 'team_leader', 'sales-assigned', 'sales-unassigned', 'company_accounts', 'super_admin'
  ];
  u text;
  i int;
begin
  for i in 1..array_length(v_users, 1) loop
    u := v_users[i];
    perform test_set_current_user(u::uuid);
    perform test_assert_raises(
      format('%s: direct "select whatsapp_wa_id from contacts" is denied, even for their own company''s row', v_labels[i]),
      $sql$ select whatsapp_wa_id from public.contacts where id = 'e4000001-0000-0000-0000-000000000001' $sql$,
      'permission denied for table contacts'
    );
    perform test_assert_raises(
      format('%s: direct "select phone_number from leads" is denied, even for their own company''s row', v_labels[i]),
      $sql$ select phone_number from public.leads where id = 'a4000001-0000-0000-0000-000000000001' $sql$,
      'permission denied for table leads'
    );
    perform test_assert_raises(
      format('%s: cannot smuggle whatsapp_wa_id through a select * either', v_labels[i]),
      $sql$ select * from public.contacts where id = 'e4000001-0000-0000-0000-000000000001' $sql$,
      'permission denied for table contacts'
    );
  end loop;
end;
$$;

-- Safe columns remain directly selectable -- this migration narrows, it
-- does not remove, direct read access to non-sensitive columns.
do $$
declare v_name text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000001'); -- owner
  select display_name into v_name from public.contacts where id = 'e4000001-0000-0000-0000-000000000001';
  perform test_assert('owner can still directly select the safe contacts.display_name column', v_name = 'Revoke Test Contact');
end; $$;

do $$
declare v_name text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000001'); -- owner
  select customer_name into v_name from public.leads where id = 'a4000001-0000-0000-0000-000000000001';
  perform test_assert('owner can still directly select the safe leads.customer_name column', v_name = 'Revoke Test Lead');
end; $$;

-- ---------------------------------------------------------------------------
-- 2. The secure RPC layer is completely unaffected -- every role gets
--    exactly the same authorized behavior migration 25 already proved,
--    now with the raw direct path closed alongside it.
-- ---------------------------------------------------------------------------

do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000001'); -- owner
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('owner: RPC still returns FULL after migration 26', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000002'); -- admin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('admin: RPC still returns FULL after migration 26', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000003'); -- manager
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('manager: RPC still returns FULL after migration 26', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000004'); -- team_leader
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('team_leader: RPC still returns FULL after migration 26', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; v_display text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000005'); -- sales-assigned
  select phone_display, phone_visibility into v_display, v_visibility from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-assigned: RPC still returns FULL on their own conversation after migration 26', v_visibility = 'full');
  perform test_assert('sales-assigned: RPC returns the real raw number (only through the audited function)', v_display = '971511112222');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000006'); -- sales-unassigned
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-unassigned: RPC still returns MASKED (not their conversation) after migration 26', v_visibility = 'masked');
end; $$;

do $$
declare v_count integer; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000007'); -- company_accounts
  select count(*) into v_count from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('company_accounts: RPC still returns zero rows (denied) after migration 26', v_count = 0);
end; $$;

do $$
declare v_count integer; begin
  perform test_set_current_user('b4000002-0000-0000-0000-000000000001'); -- owner of Company B
  select count(*) into v_count from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('cross-tenant: Company B''s owner still gets zero rows for Company A''s conversation after migration 26', v_count = 0);
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b0000001-0000-0000-0000-000000000002'); -- super_admin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f4000002-0000-0000-0000-000000000001'::uuid]); -- Company B's conversation
  perform test_assert('super_admin: RPC still returns FULL cross-company after migration 26, via the audited path only', v_visibility = 'full');
end; $$;

-- Leads: same shape, briefly re-confirmed.
do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000005'); -- sales-assigned, assigned to the lead
  select phone_visibility into v_visibility from get_lead_phone_displays(array['a4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-assigned: lead RPC still returns FULL after migration 26', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000006'); -- sales-unassigned, not assigned to the lead
  select phone_visibility into v_visibility from get_lead_phone_displays(array['a4000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-unassigned: lead RPC still returns MASKED after migration 26', v_visibility = 'masked');
end; $$;

-- Search RPCs: still work post-revoke (they read the raw column internally
-- as the SECURITY DEFINER function owner, never as the caller).
do $$
declare v_ids uuid[]; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000001'); -- owner
  select array_agg(conversation_id) into v_ids from search_company_conversations('c4000001-0000-0000-0000-000000000001', '971511112222', 10);
  perform test_assert('owner: search_company_conversations still finds the row by full number after migration 26', v_ids @> array['f4000001-0000-0000-0000-000000000001'::uuid]);
end; $$;

-- Outbound send-target RPC: still resolves the raw wa_id for the send
-- pipeline, server-side only.
do $$
declare v_wa_id text; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000005'); -- sales-assigned, may view this conversation
  select whatsapp_wa_id into v_wa_id from get_conversation_send_target('f4000001-0000-0000-0000-000000000001');
  perform test_assert('get_conversation_send_target still resolves the raw wa_id needed to address an outbound reply after migration 26', v_wa_id = '971511112222');
end; $$;

do $$
declare v_count integer; begin
  perform test_set_current_user('b4000002-0000-0000-0000-000000000001'); -- owner of Company B
  select count(*) into v_count from get_conversation_send_target('f4000001-0000-0000-0000-000000000001'); -- Company A's conversation
  perform test_assert('get_conversation_send_target: cross-tenant caller gets zero rows, never Company A''s wa_id', v_count = 0);
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Network-payload invariant: a masked RPC row never carries the raw
--    number anywhere in its shape -- no secondary/hidden field, and the
--    displayed value itself never contains the raw digit string.
-- ---------------------------------------------------------------------------

do $$
declare v_row record; v_json jsonb; v_key_count integer; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000006'); -- sales-unassigned -- masked case
  select * into v_row from get_conversation_phone_displays(array['f4000001-0000-0000-0000-000000000001'::uuid]);
  v_json := to_jsonb(v_row);
  select count(*) into v_key_count from jsonb_object_keys(v_json);
  perform test_assert('masked conversation row has exactly the 3 documented fields -- no hidden raw column', v_key_count = 3);
  perform test_assert('masked conversation row never contains the raw digit string anywhere in its payload', position('971511112222' in v_json::text) = 0);
end; $$;

do $$
declare v_row record; v_json jsonb; v_key_count integer; begin
  perform test_set_current_user('b4000001-0000-0000-0000-000000000006'); -- sales-unassigned -- masked case
  select * into v_row from get_lead_phone_displays(array['a4000001-0000-0000-0000-000000000001'::uuid]);
  v_json := to_jsonb(v_row);
  select count(*) into v_key_count from jsonb_object_keys(v_json);
  perform test_assert('masked lead row has exactly the 3 documented fields -- no hidden raw column', v_key_count = 3);
  perform test_assert('masked lead row never contains the raw digit string anywhere in its payload', position('971511112222' in v_json::text) = 0);
end; $$;

reset role;

rollback;
