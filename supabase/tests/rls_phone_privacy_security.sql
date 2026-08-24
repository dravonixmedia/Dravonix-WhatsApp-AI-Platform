-- Phase 3A.1 secure phone read layer (migration 25) RLS/RPC hardening
-- tests. Run after rls_role_team_security.sql (via supabase/tests/run.sh),
-- against the same throwaway local Postgres database -- never a hosted
-- Supabase project. Migration 25 is purely additive: it does NOT revoke
-- direct contacts.whatsapp_wa_id access (that is Phase 3A.2 / Migration
-- 26), so this file only proves the new authorization layer behaves
-- correctly -- it does not (and at this stage cannot) prove the old direct
-- bypass is closed.

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
-- Hardening sweep for every new migration-25 function.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'mask_wa_id', 'phone_is_full_for_caller', 'get_conversation_phone_displays',
    'get_lead_phone_displays', 'search_company_conversations', 'search_company_leads',
    'get_conversation_send_target'
  ];
begin
  foreach fn in array fns loop
    if not exists (
      select 1 from pg_proc p
      where p.proname = fn
        and exists (
          select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%'
        )
    ) then
      raise exception 'ASSERTION FAILED: function % does not have an empty search_path set', fn;
    end if;
    if has_function_privilege('anon', (select oid from pg_proc where proname = fn limit 1), 'execute') then
      raise exception 'ASSERTION FAILED: function % is executable by anon', fn;
    end if;
    raise notice 'OK: % has an empty search_path and is not executable by anon', fn;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Company A: owner, admin, manager, team_leader, two sales persons,
-- company_accounts. One contact with TWO non-closed... actually exactly one
-- non-closed conversation is possible per contact (see the ingest
-- repository's own invariant) -- to model "Contact A has a conversation
-- assigned to Sales Person A and a DIFFERENT conversation assigned to Sales
-- Person B" (Phase 3A audit section 9/12), the fixture below gives contact
-- A a CLOSED conversation (assigned to Sales Person B, assignment persists
-- through close -- migration 24's handover_close_conversation never clears
-- assigned_member_id) and a currently-open one (assigned to Sales Person
-- A) -- exactly the real-world shape a repeat customer produces.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('b0000001-0000-0000-0000-000000000001', 'super-admin-3@example.test'),
  ('b3000001-0000-0000-0000-000000000001', 'owner-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000002', 'admin-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000003', 'manager-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000004', 'teamlead-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000005', 'sales-a-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000006', 'sales-b-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000007', 'accounts-b3@example.test'),
  ('b3000001-0000-0000-0000-000000000008', 'sales-deactivated-b3@example.test'),
  ('b3000002-0000-0000-0000-000000000001', 'owner-c3@example.test');

insert into platform_members (user_id, role, is_active) values
  ('b0000001-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('c3000001-0000-0000-0000-000000000001', 'Phone Sec Co A', 'phone-sec-co-a', 'active', true),
  ('c3000002-0000-0000-0000-000000000001', 'Phone Sec Co B', 'phone-sec-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('d3000001-0000-0000-0000-000000000001', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('d3000001-0000-0000-0000-000000000002', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000002', 'company_admin', true),
  ('d3000001-0000-0000-0000-000000000003', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000003', 'manager', true),
  ('d3000001-0000-0000-0000-000000000004', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000004', 'team_leader', true),
  ('d3000001-0000-0000-0000-000000000005', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000005', 'sales_person', true),
  ('d3000001-0000-0000-0000-000000000006', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000006', 'sales_person', true),
  ('d3000001-0000-0000-0000-000000000007', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000007', 'company_accounts', true),
  ('d3000001-0000-0000-0000-000000000008', 'c3000001-0000-0000-0000-000000000001', 'b3000001-0000-0000-0000-000000000008', 'sales_person', false),
  ('d3000002-0000-0000-0000-000000000001', 'c3000002-0000-0000-0000-000000000001', 'b3000002-0000-0000-0000-000000000001', 'company_owner', true);

-- Contact A: the repeat-customer shape -- one closed conversation
-- (historically assigned to Sales Person B) and one open conversation
-- (currently assigned to Sales Person A). Contact Z: a second, unrelated
-- contact used for the fully-unassigned-conversation case. Contact X in
-- Company B for cross-tenant checks.
insert into contacts (id, company_id, whatsapp_wa_id, display_name) values
  ('e3000001-0000-0000-0000-000000000001', 'c3000001-0000-0000-0000-000000000001', '971501234567', 'Contact A'),
  ('e3000001-0000-0000-0000-000000000002', 'c3000001-0000-0000-0000-000000000001', '971509998888', 'Contact Z'),
  ('e3000002-0000-0000-0000-000000000001', 'c3000002-0000-0000-0000-000000000001', '971505555555', 'Contact X');

insert into conversations (id, company_id, contact_id, state, assigned_member_id) values
  -- Contact A, closed, historically assigned to sales-b.
  ('f3000001-0000-0000-0000-000000000001', 'c3000001-0000-0000-0000-000000000001', 'e3000001-0000-0000-0000-000000000001', 'closed', 'd3000001-0000-0000-0000-000000000006'),
  -- Contact A, open, currently assigned to sales-a.
  ('f3000001-0000-0000-0000-000000000002', 'c3000001-0000-0000-0000-000000000001', 'e3000001-0000-0000-0000-000000000001', 'human_active', 'd3000001-0000-0000-0000-000000000005'),
  -- Contact Z, open, unassigned.
  ('f3000001-0000-0000-0000-000000000003', 'c3000001-0000-0000-0000-000000000001', 'e3000001-0000-0000-0000-000000000002', 'handover_requested', null),
  -- Company B, cross-tenant.
  ('f3000002-0000-0000-0000-000000000001', 'c3000002-0000-0000-0000-000000000001', 'e3000002-0000-0000-0000-000000000001', 'human_active', null);

insert into leads (id, company_id, contact_id, conversation_id, customer_name, assigned_member_id) values
  ('a3000001-0000-0000-0000-000000000001', 'c3000001-0000-0000-0000-000000000001', 'e3000001-0000-0000-0000-000000000001', 'f3000001-0000-0000-0000-000000000002', 'Contact A Lead', 'd3000001-0000-0000-0000-000000000005');

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. mask_wa_id format (SQL mirror of maskPhoneNumber.ts).
-- ---------------------------------------------------------------------------

select test_set_current_user('b0000001-0000-0000-0000-000000000001'); -- super_admin (any authenticated caller can call this pure function)

select test_assert('mask_wa_id keeps the last 4 digits, stars the rest', mask_wa_id('971501234567') = '********4567');
select test_assert('mask_wa_id on a <=4 digit value stars everything', mask_wa_id('1234') = '****');
select test_assert('mask_wa_id strips a leading + before masking', mask_wa_id('+971501234567') = '********4567');

-- ---------------------------------------------------------------------------
-- 2. Company-wide roles: owner/admin/manager/team_leader all get full
--    number on any conversation they legitimately access, regardless of
--    assignment.
-- ---------------------------------------------------------------------------

do $$
declare
  v_display text;
  v_visibility text;
begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000001'); -- owner
  select phone_display, phone_visibility into v_display, v_visibility
    from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]); -- unassigned conversation
  perform test_assert('owner gets FULL number even on an unassigned conversation', v_display = '971501234567' or v_visibility = 'full');
  perform test_assert('owner: phone_visibility is exactly full', v_visibility = 'full');
end;
$$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000002'); -- admin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]);
  perform test_assert('admin gets FULL number company-wide', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000003'); -- manager
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]);
  perform test_assert('manager gets FULL number company-wide', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000004'); -- team_leader
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]);
  perform test_assert('team_leader gets FULL number company-wide', v_visibility = 'full');
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Sales Person: conversation-scoped, contextual visibility (the core
--    Phase 3A property). Sales Person A is assigned to conversation 2
--    (open) but NOT conversation 1 (closed, assigned to Sales Person B) --
--    same contact, no contact-level leakage.
-- ---------------------------------------------------------------------------

select test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a

do $$
declare v_visibility text; begin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000002'::uuid]);
  perform test_assert('sales-a gets FULL number on the conversation assigned to them', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-a gets MASKED number on the OTHER conversation for the SAME contact (assigned to sales-b) -- no contact-level leakage', v_visibility = 'masked');
end; $$;

do $$
declare v_visibility text; begin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]);
  perform test_assert('sales-a gets MASKED number on a fully unassigned conversation', v_visibility = 'masked');
end; $$;

do $$
declare v_display text; begin
  select phone_display into v_display from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('the masked result for sales-a is exactly the expected mask, never the raw number', v_display = '********4567');
  perform test_assert('the masked result for sales-a never contains the raw full digit string anywhere', position('971501234567' in v_display) = 0);
end; $$;

-- Batch call: proves the two conversations for the same contact resolve
-- independently within a SINGLE RPC call (the real list/batch shape).
do $$
declare
  v_full_count integer;
  v_masked_count integer;
begin
  select
    count(*) filter (where phone_visibility = 'full'),
    count(*) filter (where phone_visibility = 'masked')
    into v_full_count, v_masked_count
    from get_conversation_phone_displays(array[
      'f3000001-0000-0000-0000-000000000001'::uuid,
      'f3000001-0000-0000-0000-000000000002'::uuid,
      'f3000001-0000-0000-0000-000000000003'::uuid
    ]);
  perform test_assert('batch call: sales-a gets exactly 1 full result across all 3 conversations', v_full_count = 1);
  perform test_assert('batch call: sales-a gets exactly 2 masked results', v_masked_count = 2);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reassignment immediately changes visibility (no caching/stickiness).
-- ---------------------------------------------------------------------------

select test_set_current_user('b3000001-0000-0000-0000-000000000001'); -- owner (team.manage not needed for a raw assignment update in this test)
reset role;
update conversations set assigned_member_id = 'd3000001-0000-0000-0000-000000000006' -- reassign conv 2 to sales-b
  where id = 'f3000001-0000-0000-0000-000000000002';
set local role authenticated;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000002'::uuid]);
  perform test_assert('sales-a immediately loses full access the moment conv 2 is reassigned away from them', v_visibility = 'masked');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000006'); -- sales-b
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000002'::uuid]);
  perform test_assert('sales-b immediately gains full access the moment conv 2 is reassigned to them', v_visibility = 'full');
end; $$;

-- Restore for later assertions.
reset role;
update conversations set assigned_member_id = 'd3000001-0000-0000-0000-000000000005'
  where id = 'f3000001-0000-0000-0000-000000000002';
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 5. End Human Assistance nulls assigned_member_id -- Sales Person's
--    visibility on that same conversation immediately becomes masked.
-- ---------------------------------------------------------------------------

select test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a, currently assigned to conv 2

do $$
declare v_visibility_before text; begin
  select phone_visibility into v_visibility_before from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000002'::uuid]);
  perform test_assert('sanity: sales-a has full access before End Human Assistance', v_visibility_before = 'full');
end;
$$;

-- sales_person holds no conversations.close (Phase 2) -- End Human
-- Assistance must be performed by a role that does (manager, here), then
-- sales-a's own phone visibility on that same conversation is re-checked.
select test_set_current_user('b3000001-0000-0000-0000-000000000003'); -- manager
select handover_end_human_assistance('f3000001-0000-0000-0000-000000000002');

do $$
declare v_visibility_after text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a
  select phone_visibility into v_visibility_after from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000002'::uuid]);
  perform test_assert('sales-a immediately loses full access once End Human Assistance nulls assigned_member_id', v_visibility_after = 'masked');
end;
$$;

-- Restore conv 2 to human_active/assigned-to-sales-a for the remaining tests.
reset role;
update conversations set state = 'human_active', assigned_member_id = 'd3000001-0000-0000-0000-000000000005'
  where id = 'f3000001-0000-0000-0000-000000000002';
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 6. Closed conversation: assignment-specific behavior is preserved exactly
--    as stored -- sales-b (assigned to the CLOSED conversation) still gets
--    full access to it.
-- ---------------------------------------------------------------------------

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000006'); -- sales-b
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-b (assigned to the CLOSED conversation) still gets full access to it', v_visibility = 'full');
end; $$;

-- ---------------------------------------------------------------------------
-- 7. Company Accounts: no customer phone access at all -- zero rows, not a
--    masked row.
-- ---------------------------------------------------------------------------

do $$
declare v_count integer; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000007'); -- accounts
  select count(*) into v_count from get_conversation_phone_displays(array[
    'f3000001-0000-0000-0000-000000000001'::uuid,
    'f3000001-0000-0000-0000-000000000002'::uuid,
    'f3000001-0000-0000-0000-000000000003'::uuid
  ]);
  perform test_assert('company_accounts gets zero rows back -- not even a masked placeholder', v_count = 0);
end; $$;

select test_assert_raises(
  'company_accounts cannot call search_company_conversations at all (no conversations.view)',
  $sql$ select * from search_company_conversations('c3000001-0000-0000-0000-000000000001', '971501234567', 10) $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 8. Cross-tenant: Company B's owner gets nothing for Company A's
--    conversations.
-- ---------------------------------------------------------------------------

do $$
declare v_count integer; begin
  perform test_set_current_user('b3000002-0000-0000-0000-000000000001'); -- owner of Company B
  select count(*) into v_count from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000002'::uuid]);
  perform test_assert('Company B''s owner gets zero rows for a Company A conversation', v_count = 0);
end; $$;

-- ---------------------------------------------------------------------------
-- 9. Deactivated member: loses access entirely, same as every other
--    has_company_permission-gated check in this codebase.
-- ---------------------------------------------------------------------------

do $$
declare v_count integer; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000008'); -- deactivated sales person
  select count(*) into v_count from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]);
  perform test_assert('a deactivated member gets zero rows back, even for an otherwise-unassigned conversation', v_count = 0);
end; $$;

-- ---------------------------------------------------------------------------
-- 10. Super Admin: full number regardless of company/assignment.
-- ---------------------------------------------------------------------------

do $$
declare v_visibility text; begin
  perform test_set_current_user('b0000001-0000-0000-0000-000000000001'); -- super_admin
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000002-0000-0000-0000-000000000001'::uuid]); -- Company B's conversation
  perform test_assert('super_admin gets FULL number even for a company they are not a member of', v_visibility = 'full');
end; $$;

-- ---------------------------------------------------------------------------
-- 11. Leads: same conversation-scoped principle, keyed by the lead's own
--     assigned_member_id.
-- ---------------------------------------------------------------------------

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a, assigned to the lead
  select phone_visibility into v_visibility from get_lead_phone_displays(array['a3000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-a (assigned to the lead) gets FULL number on it', v_visibility = 'full');
end; $$;

do $$
declare v_visibility text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000006'); -- sales-b, not assigned to the lead
  select phone_visibility into v_visibility from get_lead_phone_displays(array['a3000001-0000-0000-0000-000000000001'::uuid]);
  perform test_assert('sales-b (not assigned to the lead, even though assigned to its contact''s other conversation) gets MASKED number', v_visibility = 'masked');
end; $$;

-- ---------------------------------------------------------------------------
-- 12. Search: name/full-number search for company-wide roles; Sales Person
--     full-number search works only for their own authorized conversation;
--     a full-number query never surfaces an unassigned/other-assigned
--     conversation via phone at all (no existence oracle); a short (<=4
--     digit) query still finds it, masked.
-- ---------------------------------------------------------------------------

do $$
declare v_ids uuid[];
begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000001'); -- owner
  select array_agg(conversation_id) into v_ids from search_company_conversations('c3000001-0000-0000-0000-000000000001', '971509998888', 10);
  perform test_assert('owner: full-number search matches the exact conversation company-wide', v_ids @> array['f3000001-0000-0000-0000-000000000003'::uuid]);
end;
$$;

do $$
declare v_ids uuid[];
begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a
  -- Full number of conv 2 (assigned to sales-a) -- allowed to match.
  select array_agg(conversation_id) into v_ids from search_company_conversations('c3000001-0000-0000-0000-000000000001', '971501234567', 10);
  perform test_assert('sales-a: full-number search matches conv 2, which is assigned to them', v_ids @> array['f3000001-0000-0000-0000-000000000002'::uuid]);
end;
$$;

do $$
declare v_ids uuid[];
begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a
  -- Full number of Contact Z's conversation -- sales-a is NOT authorized
  -- for it (unassigned) -- must not match on the phone criterion at all.
  select array_agg(conversation_id) into v_ids from search_company_conversations('c3000001-0000-0000-0000-000000000001', '971509998888', 10);
  perform test_assert(
    'sales-a: a full company-wide number they are not authorized for never matches via phone -- no existence oracle',
    v_ids is null or not (v_ids @> array['f3000001-0000-0000-0000-000000000003'::uuid])
  );
end;
$$;

do $$
declare v_ids uuid[];
begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a
  -- Last 4 digits of Contact Z's number -- allowed to match (masked result).
  select array_agg(conversation_id) into v_ids from search_company_conversations('c3000001-0000-0000-0000-000000000001', '8888', 10);
  perform test_assert(
    'sales-a: a last-4-digit query DOES match an unauthorized conversation (privacy-safe partial search)',
    v_ids @> array['f3000001-0000-0000-0000-000000000003'::uuid]
  );
end;
$$;

do $$
declare v_visibility text; begin
  -- Confirm the last-4 match above still only ever renders MASKED, never full.
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005');
  select phone_visibility into v_visibility from get_conversation_phone_displays(array['f3000001-0000-0000-0000-000000000003'::uuid]);
  perform test_assert('the last-4-matched conversation still displays masked for sales-a, search never grants display access', v_visibility = 'masked');
end; $$;

-- Leads search: same rule, via search_company_leads.
do $$
declare v_ids uuid[];
begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a, assigned to the lead
  select array_agg(lead_id) into v_ids from search_company_leads('c3000001-0000-0000-0000-000000000001', '971501234567', 10);
  perform test_assert('sales-a: full-number lead search matches their own assigned lead', v_ids @> array['a3000001-0000-0000-0000-000000000001'::uuid]);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. get_conversation_send_target: the outbound-routing lookup added for
--     sendHumanReplyAction (Phase 3A security-review sweep found it running
--     under the invoking user's own `authenticated` session, reading
--     contacts.whatsapp_wa_id directly -- not actually a service_role
--     trusted-backend path as earlier phase notes had assumed). Returns the
--     RAW wa_id (never masked -- it addresses the real outbound Graph API
--     call), gated by the same conversations.view/is_platform_staff()
--     boundary this read already relied on before this migration existed.
-- ---------------------------------------------------------------------------

do $$
declare v_wa_id text; v_phone_number_id text; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000005'); -- sales-a, may view conv 2
  select whatsapp_wa_id, phone_number_id into v_wa_id, v_phone_number_id
    from get_conversation_send_target('f3000001-0000-0000-0000-000000000002');
  perform test_assert('get_conversation_send_target returns the real raw wa_id for an authorized caller', v_wa_id = '971501234567');
end; $$;

do $$
declare v_count integer; begin
  perform test_set_current_user('b3000001-0000-0000-0000-000000000007'); -- company_accounts (no conversations.view)
  select count(*) into v_count from get_conversation_send_target('f3000001-0000-0000-0000-000000000002');
  perform test_assert('get_conversation_send_target returns zero rows for a caller with no conversations.view', v_count = 0);
end; $$;

do $$
declare v_count integer; begin
  perform test_set_current_user('b3000002-0000-0000-0000-000000000001'); -- owner of Company B
  select count(*) into v_count from get_conversation_send_target('f3000001-0000-0000-0000-000000000002'); -- Company A's conversation
  perform test_assert('get_conversation_send_target returns zero rows for a cross-tenant caller', v_count = 0);
end; $$;

reset role;

rollback;
