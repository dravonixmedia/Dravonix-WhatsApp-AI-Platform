-- Meta/WhatsApp Batch 3, Slice C (migration 38): DB-level regression coverage
-- for client_disconnect_whatsapp_account -- the one client-facing RPC that
-- lets a company owner/admin disconnect their OWN Embedded-Signup-connected
-- WhatsApp Business Account. Covers: RPC privilege boundaries (anon), the
-- real has_company_permission(whatsapp.manage) authorization boundary
-- (a role without whatsapp.manage is denied; a real owner of a DIFFERENT
-- company is denied even when calling with their own real user id), refusal
-- to touch a manual_admin-sourced row, successful disconnect (status,
-- credential-field clearing, phone-number cascade), and a regression sweep
-- confirming migration 35/37's own RPCs are untouched.

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
-- Fixtures: Company A (an embedded_signup connection the owner will
-- disconnect, plus a manual_admin connection this RPC must refuse to touch)
-- and Company B (its own owner, and its own connection -- for the
-- cross-tenant denial test).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('d0000001-0000-0000-0000-000000000001', 'owner-a@example.test'),
  ('d0000002-0000-0000-0000-000000000001', 'manager-a@example.test'),
  ('d0000003-0000-0000-0000-000000000001', 'owner-b@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('d0100001-0000-0000-0000-000000000001', 'Client Disconnect Co A', 'client-disconnect-co-a', 'active', true),
  ('d0100002-0000-0000-0000-000000000001', 'Client Disconnect Co B', 'client-disconnect-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('d0210001-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('d0210002-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'd0000002-0000-0000-0000-000000000001', 'manager', true),
  ('d0210003-0000-0000-0000-000000000001', 'd0100002-0000-0000-0000-000000000001', 'd0000003-0000-0000-0000-000000000001', 'company_owner', true);

-- Company A's embedded_signup connection -- the one under test.
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source, encrypted_access_token, encryption_key_version, token_expires_at) values
  ('d0300001-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'WABA_CLIENT_DISCONNECT_A', 'Co A', 'connected', true, 'embedded_signup', '{"v":1,"kv":1,"iv":"AA","ct":"BB"}', 1, now() + interval '60 days');
insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('d0400001-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001', 'PHONE_CLIENT_DISCONNECT_A', '+910000000201', 'connected');

-- Company A's pre-existing manual_admin connection -- this RPC must refuse
-- to touch it (see migration 38's own header comment for why).
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source) values
  ('d0300002-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'WABA_MANUAL_CLIENT_A', 'Co A (manual)', 'connected', true, 'manual_admin');

-- Company B's own connection -- used for the cross-tenant denial test.
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source, encrypted_access_token, encryption_key_version) values
  ('d0300003-0000-0000-0000-000000000001', 'd0100002-0000-0000-0000-000000000001', 'WABA_CLIENT_DISCONNECT_B', 'Co B', 'connected', true, 'embedded_signup', '{"v":1,"kv":1,"iv":"CC","ct":"DD"}', 1);

-- ---------------------------------------------------------------------------
-- Hardening: empty search_path, not executable by anon.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.proname = 'client_disconnect_whatsapp_account'
      and exists (
        select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%'
      )
  ) then
    raise exception 'ASSERTION FAILED: client_disconnect_whatsapp_account does not have an empty search_path set';
  end if;
  if has_function_privilege('anon', (select oid from pg_proc where proname = 'client_disconnect_whatsapp_account' limit 1), 'execute') then
    raise exception 'ASSERTION FAILED: client_disconnect_whatsapp_account is executable by anon';
  end if;
  raise notice 'OK: client_disconnect_whatsapp_account has an empty search_path and is not executable by anon';
end;
$$;

do $$
begin
  set local role anon;
  begin
    perform id from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001');
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on client_disconnect_whatsapp_account';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on client_disconnect_whatsapp_account';
  end;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 1. Authorization boundary: a role WITHOUT whatsapp.manage (manager, which
--    has whatsapp.view only -- migration 9) is denied, even for their own
--    real company.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('d0000002-0000-0000-0000-000000000001'); -- Company A manager (whatsapp.view only)

select test_assert_raises(
  'a company member WITHOUT whatsapp.manage (manager) is denied, even for their own company''s own account',
  $sql$ select id from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001') $sql$,
  'permission_denied'
);

do $$
begin
  perform test_assert(
    'the denied manager''s call left the account fully connected',
    (select status from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') = 'connected'
  );
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2. Authorization boundary: a REAL company_owner of a DIFFERENT company
--    (Company B) cannot disconnect Company A's account by passing Company
--    A's own company_id -- has_company_permission(p_company_id, ...) is
--    false because they hold no membership row for Company A at all, not
--    merely filtered after the fact.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('d0000003-0000-0000-0000-000000000001'); -- Company B owner

select test_assert_raises(
  'a real company_owner of a DIFFERENT company cannot disconnect this company''s account, even knowing its id',
  $sql$ select id from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001') $sql$,
  'permission_denied'
);

reset role;

-- ---------------------------------------------------------------------------
-- 2b. Authorization boundary: a REVOKED (is_active = false) former member of
--     Company A -- even one still carrying the company_owner role on their
--     row -- is denied exactly like someone with no membership at all.
-- ---------------------------------------------------------------------------

update company_members set is_active = false where id = 'd0210001-0000-0000-0000-000000000001';

set local role authenticated;
select test_set_current_user('d0000001-0000-0000-0000-000000000001');

select test_assert_raises(
  'a revoked (is_active=false) former company_owner of Company A is denied, even though their membership row still shows the role',
  $sql$ select id from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001') $sql$,
  'permission_denied'
);

reset role;

update company_members set is_active = true where id = 'd0210001-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 3. This RPC refuses to touch a manual_admin-sourced row, even for the
--    account's own company owner with whatsapp.manage.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('d0000001-0000-0000-0000-000000000001'); -- Company A owner (whatsapp.manage)

select test_assert_raises(
  'a company owner with whatsapp.manage still cannot disconnect a manual_admin-sourced connection through this RPC',
  $sql$ select id from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300002-0000-0000-0000-000000000001') $sql$,
  'whatsapp_account_not_client_managed'
);

do $$
begin
  perform test_assert(
    'the manual_admin account is untouched',
    (select status from whatsapp_accounts where id = 'd0300002-0000-0000-0000-000000000001') = 'connected'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Not-found: an id that doesn't belong to the caller's own company (even
--    a real embedded_signup row -- Company B's) is rejected identically to a
--    genuinely nonexistent id.
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'an account id belonging to another company is rejected as not found -- never operates cross-tenant even under the correct company_id parameter',
  $sql$ select id from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300003-0000-0000-0000-000000000001') $sql$,
  'whatsapp_account_not_found'
);

do $$
begin
  perform test_assert(
    'Company B''s account was completely untouched by Company A''s attempt',
    (select status from whatsapp_accounts where id = 'd0300003-0000-0000-0000-000000000001') = 'connected'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Successful disconnect: status disabled, every credential field cleared,
--    and the cascade to phone numbers.
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
  v_status whatsapp_connection_status;
begin
  select id, status into v_id, v_status
    from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001');

  perform test_assert('disconnect returns the same account id', v_id = 'd0300001-0000-0000-0000-000000000001');
  perform test_assert('disconnect returns status disabled', v_status = 'disabled');
  perform test_assert(
    'the account row itself is now disabled',
    (select status from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') = 'disabled'
  );
  perform test_assert(
    'encrypted_access_token is cleared on disconnect',
    (select encrypted_access_token from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') is null
  );
  perform test_assert(
    'encryption_key_version is cleared on disconnect',
    (select encryption_key_version from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') is null
  );
  perform test_assert(
    'token_expires_at is cleared on disconnect',
    (select token_expires_at from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') is null
  );
  perform test_assert(
    'the phone number under this account is cascaded to disabled',
    (select status from whatsapp_phone_numbers where id = 'd0400001-0000-0000-0000-000000000001') = 'disabled'
  );
  perform test_assert(
    'no row was hard-deleted -- the account and phone number still exist',
    exists (select 1 from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001')
    and exists (select 1 from whatsapp_phone_numbers where id = 'd0400001-0000-0000-0000-000000000001')
  );
end;
$$;

-- Disconnecting again (already disabled) is a safe no-op re-disable, not an error.
do $$
declare
  v_status whatsapp_connection_status;
begin
  select status into v_status
    from client_disconnect_whatsapp_account('d0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001');
  perform test_assert('disconnecting an already-disabled account is a safe no-op, not an error', v_status = 'disabled');
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 6. Regression: migration 35's Super Admin RPCs and migration 37's signup
--    RPCs are completely untouched by this migration.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values ('d0000004-0000-0000-0000-000000000001', 'super-admin-disconnect@example.test');
insert into platform_members (user_id, role, is_active) values ('d0000004-0000-0000-0000-000000000001', 'super_admin', true);

set local role authenticated;
select test_set_current_user('d0000004-0000-0000-0000-000000000001');

do $$
declare
  v_account_id uuid;
begin
  select id into v_account_id
    from admin_connect_whatsapp_account('d0100002-0000-0000-0000-000000000001', 'WABA_MIGRATION_38_REGRESSION', 'Regression check', false);
  perform test_assert('migration 35''s admin_connect_whatsapp_account still works unchanged for Super Admin', v_account_id is not null);
end;
$$;

reset role;

set local role service_role;
do $$
declare
  v_id uuid;
begin
  select id into v_id
    from create_whatsapp_signup_attempt('d0100001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', repeat('f', 64), now() + interval '5 minutes');
  perform test_assert('migration 37''s create_whatsapp_signup_attempt still works unchanged', v_id is not null);
end;
$$;
reset role;

rollback;
