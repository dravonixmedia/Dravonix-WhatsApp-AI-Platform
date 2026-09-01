-- Meta/WhatsApp Batch 1 (migration 35): DB-level regression coverage for the
-- four Super-Admin-only WhatsApp connection RPCs (admin_connect_whatsapp_
-- account, admin_connect_whatsapp_phone_number, admin_set_whatsapp_account_
-- status, admin_set_whatsapp_phone_number_status) and the company-match
-- trigger on whatsapp_phone_numbers. Covers authorization (every non-Super-
-- Admin role, anon), cross-company takeover rejection, the disconnect/
-- reconnect lifecycle, inbound-routing exclusion of disconnected mappings,
-- historical-conversation integrity, and credential-column non-exposure.

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
-- Fixtures: one super_admin; Company A with owner/admin/manager/team_leader/
-- sales_person/company_accounts members (the full non-Super-Admin role
-- sweep); Company B with its own owner (cross-company case). Company A
-- starts with one already-connected WABA and phone number, plus a real
-- historical conversation/message referencing that phone number (for the
-- disconnect-preserves-history test). Company B has its own separate WABA.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('b0000001-0000-0000-0000-000000000001', 'super-admin-wa@example.test'),
  ('b0200001-0000-0000-0000-000000000001', 'owner-wa-a@example.test'),
  ('b0200001-0000-0000-0000-000000000002', 'admin-wa-a@example.test'),
  ('b0200001-0000-0000-0000-000000000003', 'manager-wa-a@example.test'),
  ('b0200001-0000-0000-0000-000000000004', 'teamlead-wa-a@example.test'),
  ('b0200001-0000-0000-0000-000000000005', 'sales-wa-a@example.test'),
  ('b0200001-0000-0000-0000-000000000006', 'accounts-wa-a@example.test'),
  ('b0200002-0000-0000-0000-000000000001', 'owner-wa-b@example.test');

insert into platform_members (user_id, role, is_active) values
  ('b0000001-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('b0100001-0000-0000-0000-000000000001', 'WA Connection Co A', 'wa-connection-co-a', 'active', true),
  ('b0100002-0000-0000-0000-000000000001', 'WA Connection Co B', 'wa-connection-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('b0210001-0000-0000-0000-000000000001', 'b0100001-0000-0000-0000-000000000001', 'b0200001-0000-0000-0000-000000000001', 'company_owner', true),
  ('b0210001-0000-0000-0000-000000000002', 'b0100001-0000-0000-0000-000000000001', 'b0200001-0000-0000-0000-000000000002', 'company_admin', true),
  ('b0210001-0000-0000-0000-000000000003', 'b0100001-0000-0000-0000-000000000001', 'b0200001-0000-0000-0000-000000000003', 'manager', true),
  ('b0210001-0000-0000-0000-000000000004', 'b0100001-0000-0000-0000-000000000001', 'b0200001-0000-0000-0000-000000000004', 'team_leader', true),
  ('b0210001-0000-0000-0000-000000000005', 'b0100001-0000-0000-0000-000000000001', 'b0200001-0000-0000-0000-000000000005', 'sales_person', true),
  ('b0210001-0000-0000-0000-000000000006', 'b0100001-0000-0000-0000-000000000001', 'b0200001-0000-0000-0000-000000000006', 'company_accounts', true),
  ('b0210002-0000-0000-0000-000000000001', 'b0100002-0000-0000-0000-000000000001', 'b0200002-0000-0000-0000-000000000001', 'company_owner', true);

insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account) values
  ('b0300001-0000-0000-0000-000000000001', 'b0100001-0000-0000-0000-000000000001', 'WABA_A_EXISTING', 'Co A Business', 'connected', true),
  ('b0300002-0000-0000-0000-000000000001', 'b0100002-0000-0000-0000-000000000001', 'WABA_B_EXISTING', 'Co B Business', 'connected', true);

insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('b0400001-0000-0000-0000-000000000001', 'b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'PHONE_A_EXISTING', '+910000000001', 'connected');

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('b0500001-0000-0000-0000-000000000001', 'b0100001-0000-0000-0000-000000000001', '919999999999', 'Historical Contact');

insert into conversations (id, company_id, contact_id, whatsapp_phone_number_id, state) values
  ('b0600001-0000-0000-0000-000000000001', 'b0100001-0000-0000-0000-000000000001', 'b0500001-0000-0000-0000-000000000001', 'b0400001-0000-0000-0000-000000000001', 'ai_active');

insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body) values
  ('b0700001-0000-0000-0000-000000000001', 'b0100001-0000-0000-0000-000000000001', 'b0600001-0000-0000-0000-000000000001', 'inbound', 'text', 'customer', 'wamid.HISTORICAL1', 'Hello, is this real content that must survive a disconnect?');

-- ---------------------------------------------------------------------------
-- Hardening sweep: every new SECURITY DEFINER function has an empty
-- search_path and is not executable by anon.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'admin_connect_whatsapp_account', 'admin_connect_whatsapp_phone_number',
    'admin_set_whatsapp_account_status', 'admin_set_whatsapp_phone_number_status'
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

set local role authenticated;
select test_set_current_user('b0000001-0000-0000-0000-000000000001'); -- super_admin

-- ---------------------------------------------------------------------------
-- 1. Super Admin can connect a new WABA (item 5) and a new phone number
--    under it (item 6). Neither return value includes any credential
--    column (item 17).
-- ---------------------------------------------------------------------------

do $$
declare
  v_account_id uuid;
  v_status whatsapp_connection_status;
  v_phone_id uuid;
begin
  select id, status into v_account_id, v_status
    from admin_connect_whatsapp_account(
      'b0100001-0000-0000-0000-000000000001', 'WABA_A_NEW', 'Co A New Business', false
    );
  perform test_assert('Super Admin can connect a new WABA', v_account_id is not null);
  perform test_assert('a freshly connected WABA is status connected', v_status = 'connected');

  select id into v_phone_id
    from admin_connect_whatsapp_phone_number(
      'b0100001-0000-0000-0000-000000000001', v_account_id, 'PHONE_A_NEW', '+910000000099'
    );
  perform test_assert('Super Admin can connect a new phone number under the new WABA', v_phone_id is not null);
end;
$$;

-- item 17: the RPCs' own return columns never include encrypted_access_token
-- (structural check against the function signature itself, not just this
-- call's result shape).
do $$
begin
  perform test_assert(
    'admin_connect_whatsapp_account never returns encrypted_access_token',
    pg_get_function_result((select oid from pg_proc where proname = 'admin_connect_whatsapp_account' limit 1))
      not ilike '%encrypted_access_token%'
  );
  perform test_assert(
    'admin_connect_whatsapp_phone_number never returns encrypted_access_token',
    pg_get_function_result((select oid from pg_proc where proname = 'admin_connect_whatsapp_phone_number' limit 1))
      not ilike '%encrypted_access_token%'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Duplicate WABA from the SAME company is a safe update, not a rejection
--    (re-running a registration with corrected details is legitimate).
--    (item 7, same-company half)
-- ---------------------------------------------------------------------------

do $$
declare
  v_business_name text;
begin
  select business_name into v_business_name
    from admin_connect_whatsapp_account(
      'b0100001-0000-0000-0000-000000000001', 'WABA_A_EXISTING', 'Co A Business (corrected)', true
    );
  perform test_assert(
    'reconnecting the SAME company''s existing waba_id updates metadata rather than failing',
    v_business_name = 'Co A Business (corrected)'
  );
  perform test_assert(
    'exactly one whatsapp_accounts row still exists for this waba_id -- no duplicate row was inserted',
    (select count(*) from whatsapp_accounts where waba_id = 'WABA_A_EXISTING') = 1
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Duplicate WABA / cross-company takeover is rejected with a safe,
--    deterministic error (items 7 cross-company half, 9).
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'connecting Company B to Company A''s existing waba_id is rejected (cross-company WABA takeover)',
  $sql$ select id from admin_connect_whatsapp_account('b0100002-0000-0000-0000-000000000001', 'WABA_A_EXISTING', 'Hostile takeover', false) $sql$,
  'waba_already_connected_to_another_company'
);

do $$
begin
  perform test_assert(
    'the cross-company WABA takeover attempt above did not change WABA_A_EXISTING''s owning company',
    (select company_id from whatsapp_accounts where waba_id = 'WABA_A_EXISTING') = 'b0100001-0000-0000-0000-000000000001'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Duplicate phone_number_id / cross-company takeover is rejected (items
--    8, 10).
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'connecting Company B to Company A''s existing phone_number_id is rejected (cross-company phone takeover)',
  $sql$ select id from admin_connect_whatsapp_phone_number('b0100002-0000-0000-0000-000000000001', 'b0300002-0000-0000-0000-000000000001', 'PHONE_A_EXISTING', '+919999999998') $sql$,
  'phone_number_already_connected_to_another_company'
);

do $$
begin
  perform test_assert(
    'the cross-company phone takeover attempt above did not change PHONE_A_EXISTING''s owning company',
    (select company_id from whatsapp_phone_numbers where phone_number_id = 'PHONE_A_EXISTING') = 'b0100001-0000-0000-0000-000000000001'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. A phone number can never attach to a WhatsApp account belonging to a
--    DIFFERENT company than the phone's own p_company_id (item 11).
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'connecting a phone number under Company A while passing Company B''s whatsapp_account_id is rejected',
  $sql$ select id from admin_connect_whatsapp_phone_number('b0100001-0000-0000-0000-000000000001', 'b0300002-0000-0000-0000-000000000001', 'PHONE_A_MISMATCH_ATTEMPT', null) $sql$,
  'whatsapp_account_not_found'
);

do $$
begin
  perform test_assert(
    'the mismatched-account attempt above never created a phone row',
    not exists (select 1 from whatsapp_phone_numbers where phone_number_id = 'PHONE_A_MISMATCH_ATTEMPT')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Defense-in-depth: the trigger itself rejects a raw insert whose
--    company_id disagrees with its whatsapp_account_id's real company,
--    independent of the RPC layer above.
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'the whatsapp_phone_numbers company-match trigger rejects a raw insert with mismatched company_id, even bypassing the RPC',
  $sql$ insert into whatsapp_phone_numbers (company_id, whatsapp_account_id, phone_number_id, status) values ('b0100002-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'PHONE_TRIGGER_BYPASS_ATTEMPT', 'connected') $sql$,
  'whatsapp_phone_number_company_mismatch'
);

-- ---------------------------------------------------------------------------
-- 7. Disconnect / reconnect lifecycle (items 14, 15, 16).
--
-- Disconnecting the WABA cascades to disable its phone number; the phone
-- cannot be individually reconnected while the account is still disabled;
-- reconnecting the account, then the phone, restores normal status; and the
-- historical conversation/message from the fixtures are untouched by any of
-- this the whole way through.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status whatsapp_connection_status;
begin
  select status into v_status
    from admin_set_whatsapp_account_status('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'disabled');
  perform test_assert('disconnecting the WABA sets its own status to disabled', v_status = 'disabled');

  perform test_assert(
    'disconnecting the WABA cascades to disable its existing phone number',
    (select status from whatsapp_phone_numbers where id = 'b0400001-0000-0000-0000-000000000001') = 'disabled'
  );
end;
$$;

-- item 14: a disabled mapping must not be resolvable for inbound routing --
-- proven against the EXACT predicate the real ingest repository applies
-- (status = 'connected'), directly at the SQL layer.
do $$
begin
  perform test_assert(
    'a disconnected phone_number_id no longer resolves under the real inbound-routing predicate (status = ''connected'')',
    not exists (
      select 1 from whatsapp_phone_numbers
      where phone_number_id = 'PHONE_A_EXISTING' and status = 'connected'
    )
  );
end;
$$;

select test_assert_raises(
  'a phone number cannot be reconnected while its parent WABA is still disabled',
  $sql$ select id from admin_set_whatsapp_phone_number_status('b0100001-0000-0000-0000-000000000001', 'b0400001-0000-0000-0000-000000000001', 'connected') $sql$,
  'whatsapp_account_disabled'
);

-- Correction (Meta/WhatsApp Batch 1 independent review): the SAME invariant
-- must also hold through admin_connect_whatsapp_phone_number, not only
-- admin_set_whatsapp_phone_number_status -- both re-registering the
-- existing phone and connecting a brand new one under a still-disabled WABA
-- must be rejected the same way, or the account-level disconnect could be
-- silently reopened via the "connect" RPC instead of the "status" RPC.
select test_assert_raises(
  're-registering the existing phone via admin_connect_whatsapp_phone_number is rejected while its parent WABA is still disabled',
  $sql$ select id from admin_connect_whatsapp_phone_number('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'PHONE_A_EXISTING', null) $sql$,
  'whatsapp_account_disabled'
);

select test_assert_raises(
  'connecting a brand new phone number via admin_connect_whatsapp_phone_number is rejected while its parent WABA is still disabled',
  $sql$ select id from admin_connect_whatsapp_phone_number('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'PHONE_A_NEW_WHILE_DISABLED', null) $sql$,
  'whatsapp_account_disabled'
);

do $$
begin
  perform test_assert(
    'the rejected new-phone-while-disabled attempt above never created a row',
    not exists (select 1 from whatsapp_phone_numbers where phone_number_id = 'PHONE_A_NEW_WHILE_DISABLED')
  );
  perform test_assert(
    'the rejected re-registration attempt above left the existing phone number''s status untouched (still disabled)',
    (select status from whatsapp_phone_numbers where id = 'b0400001-0000-0000-0000-000000000001') = 'disabled'
  );
end;
$$;

do $$
declare
  v_account_status whatsapp_connection_status;
  v_phone_status whatsapp_connection_status;
begin
  select status into v_account_status
    from admin_set_whatsapp_account_status('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'connected');
  perform test_assert('reconnecting the WABA succeeds', v_account_status = 'connected');
  perform test_assert(
    'reconnecting the WABA does NOT cascade back to its phone numbers -- the phone remains disabled',
    (select status from whatsapp_phone_numbers where id = 'b0400001-0000-0000-0000-000000000001') = 'disabled'
  );

  select status into v_phone_status
    from admin_set_whatsapp_phone_number_status('b0100001-0000-0000-0000-000000000001', 'b0400001-0000-0000-0000-000000000001', 'connected');
  perform test_assert('the phone number can now be explicitly reconnected', v_phone_status = 'connected');
  perform test_assert(
    'the reconnected phone_number_id resolves again under the real inbound-routing predicate',
    exists (select 1 from whatsapp_phone_numbers where phone_number_id = 'PHONE_A_EXISTING' and status = 'connected')
  );
end;
$$;

-- item 15: historical conversation/message integrity -- unaffected by any
-- of the disconnect/reconnect cycle above.
do $$
begin
  perform test_assert(
    'the historical conversation still references the same phone number row after the disconnect/reconnect cycle',
    (select whatsapp_phone_number_id from conversations where id = 'b0600001-0000-0000-0000-000000000001')
      = 'b0400001-0000-0000-0000-000000000001'
  );
  perform test_assert(
    'the historical message body is byte-for-byte unchanged',
    (select body from messages where id = 'b0700001-0000-0000-0000-000000000001')
      = 'Hello, is this real content that must survive a disconnect?'
  );
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8. Authorization sweep (items 1-4): anon, an ordinary authenticated user
--    with no platform role, and every non-Super-Admin Company A role are all
--    denied. Only super_admin (already proven above) succeeds.
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_clear_current_user();
  set local role anon;
  begin
    perform id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_ANON_ATTEMPT', null, false);
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on admin_connect_whatsapp_account, but the call succeeded';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on admin_connect_whatsapp_account';
  end;
end;
$$;

reset role;

set local role authenticated;

select test_set_current_user('b0200001-0000-0000-0000-000000000001'); -- Company A owner
select test_assert_raises(
  'a company owner (real Company A member, no platform role) cannot connect a WABA -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_OWNER_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

select test_set_current_user('b0200001-0000-0000-0000-000000000002'); -- Company A admin
select test_assert_raises(
  'a company admin cannot connect a WABA -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_ADMIN_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

select test_set_current_user('b0200001-0000-0000-0000-000000000003'); -- Company A manager
select test_assert_raises(
  'a manager cannot connect a WABA -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_MANAGER_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

select test_set_current_user('b0200001-0000-0000-0000-000000000004'); -- Company A team_leader
select test_assert_raises(
  'a team leader cannot connect a WABA -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_TEAMLEAD_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

select test_set_current_user('b0200001-0000-0000-0000-000000000005'); -- Company A sales_person
select test_assert_raises(
  'a sales person cannot connect a WABA -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_SALES_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

select test_set_current_user('b0200001-0000-0000-0000-000000000006'); -- Company A company_accounts
select test_assert_raises(
  'a company_accounts member cannot connect a WABA -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_ACCOUNTS_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

-- Also sweep admin_connect_whatsapp_phone_number, admin_set_whatsapp_account_status,
-- and admin_set_whatsapp_phone_number_status with the same denied owner --
-- one representative non-Super-Admin role is sufficient once the full role
-- sweep above has already proven admin_connect_whatsapp_account's own gate.
select test_assert_raises(
  'a company owner cannot connect a phone number -- Super Admin only',
  $sql$ select id from admin_connect_whatsapp_phone_number('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'PHONE_OWNER_ATTEMPT', null) $sql$,
  'permission_denied'
);
select test_assert_raises(
  'a company owner cannot change a WABA''s status -- Super Admin only',
  $sql$ select id from admin_set_whatsapp_account_status('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'disabled') $sql$,
  'permission_denied'
);
select test_assert_raises(
  'a company owner cannot change a phone number''s status -- Super Admin only',
  $sql$ select id from admin_set_whatsapp_phone_number_status('b0100001-0000-0000-0000-000000000001', 'b0400001-0000-0000-0000-000000000001', 'disabled') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 9. item 12: no generic authenticated user (even a real Company A owner,
--    who legitimately holds whatsapp.view and can see these very rows) may
--    directly INSERT/UPDATE/DELETE the underlying tables -- RLS still has
--    zero write policies for any non-service role, exactly as before this
--    migration. Explicitly re-selects the owner here rather than relying on
--    whichever role the sweep above left active.
-- ---------------------------------------------------------------------------

select test_set_current_user('b0200001-0000-0000-0000-000000000001'); -- Company A owner

select test_assert_raises(
  'a company owner cannot directly INSERT into whatsapp_accounts, bypassing the RPC entirely',
  $sql$ insert into whatsapp_accounts (company_id, waba_id) values ('b0100001-0000-0000-0000-000000000001', 'WABA_RAW_INSERT_ATTEMPT') $sql$,
  'new row violates row-level security policy for table "whatsapp_accounts"'
);
-- RLS with only a SELECT policy does not raise on UPDATE -- with no
-- applicable USING policy for UPDATE, the row is simply invisible to the
-- update, so it silently matches zero rows rather than throwing (verified
-- directly against this exact table/policy before writing this assertion).
do $$
begin
  update whatsapp_accounts set business_name = 'Hijacked' where id = 'b0300001-0000-0000-0000-000000000001';
  perform test_assert(
    'a company owner cannot directly UPDATE whatsapp_accounts -- RLS silently matches zero rows, bypassing the RPC entirely never succeeds',
    (select business_name from whatsapp_accounts where id = 'b0300001-0000-0000-0000-000000000001') = 'Co A Business (corrected)'
  );
end;
$$;
select test_assert_raises(
  'a company owner cannot directly INSERT into whatsapp_phone_numbers, bypassing the RPC entirely',
  $sql$ insert into whatsapp_phone_numbers (company_id, whatsapp_account_id, phone_number_id) values ('b0100001-0000-0000-0000-000000000001', 'b0300001-0000-0000-0000-000000000001', 'PHONE_RAW_INSERT_ATTEMPT') $sql$,
  'new row violates row-level security policy for table "whatsapp_phone_numbers"'
);

-- ---------------------------------------------------------------------------
-- 10. Cross-company: Company B's own owner cannot use their real membership
--     to manipulate Company A's mappings under any pairing (rounds out
--     items 9/10's authorization angle, distinct from the takeover-by-id
--     tests in sections 3-4 above, which ran as super_admin).
-- ---------------------------------------------------------------------------

select test_set_current_user('b0200002-0000-0000-0000-000000000001'); -- Company B owner
select test_assert_raises(
  'Company B''s owner cannot connect a WABA for Company A -- Super Admin only, not merely cross-tenant',
  $sql$ select id from admin_connect_whatsapp_account('b0100001-0000-0000-0000-000000000001', 'WABA_CROSS_TENANT_ATTEMPT', null, false) $sql$,
  'permission_denied'
);

reset role;

-- ---------------------------------------------------------------------------
-- 11. item 13: client SELECT visibility remains permission-scoped -- the
--     pre-existing (migration 3) SELECT-only policy is unmodified by this
--     migration and still requires whatsapp.view or platform staff. This is
--     a regression check, not a new behavior.
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_assert(
    'the whatsapp_accounts SELECT policy is unchanged by this migration -- still permission-scoped, not opened to all authenticated users',
    exists (
      select 1 from pg_policies
      where tablename = 'whatsapp_accounts'
        and policyname = 'whatsapp_accounts_select_member'
        and qual ilike '%whatsapp.view%'
    )
  );
  perform test_assert(
    'whatsapp_accounts still has exactly one policy (SELECT-only) -- this migration added no new RLS policy, only RPCs',
    (select count(*) from pg_policies where tablename = 'whatsapp_accounts') = 1
  );
  perform test_assert(
    'whatsapp_phone_numbers still has exactly one policy (SELECT-only)',
    (select count(*) from pg_policies where tablename = 'whatsapp_phone_numbers') = 1
  );
end;
$$;

rollback;
