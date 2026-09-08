-- Meta/WhatsApp Batch 3, Slice D (migration 39): DB-level regression
-- coverage for the two real production defects this migration fixes:
--
-- 1. whatsapp_registration_pins -- a new server-only table, RLS-enabled
--    with NO policy for any role (same pattern as whatsapp_signup_attempts,
--    migration 37): confirms anon/authenticated can neither read nor write
--    it directly, and confirms service_role (the only intended caller) can.
--
-- 2. complete_whatsapp_signup's new one-active-WABA-per-company behavior:
--    connecting a DIFFERENT waba_id for a company that already has a
--    non-disabled whatsapp_accounts row disables every other such row (and
--    its phone numbers) for that SAME company, clears embedded_signup
--    credential fields on the superseded row, never touches another
--    company's rows, and never disables the row that was just
--    (re)connected.

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
-- Fixtures: Company X (with a pre-existing manual_admin connection, the
-- exact scenario that produced the real staging bug), Company Y (a
-- completely separate company, used to prove cross-tenant isolation).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('d0000001-0000-0000-0000-000000000001', 'initiator-x@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('d0100001-0000-0000-0000-000000000001', 'Active WABA Co X', 'active-waba-co-x', 'active', true),
  ('d0100002-0000-0000-0000-000000000001', 'Active WABA Co Y', 'active-waba-co-y', 'active', true);

-- Company X's pre-existing manual_admin connection.
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source) values
  ('d0300001-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'WABA_OLD_MANUAL', 'Co X (manual)', 'connected', true, 'manual_admin');
insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('d0400001-0000-0000-0000-000000000001', 'd0100001-0000-0000-0000-000000000001', 'd0300001-0000-0000-0000-000000000001', 'PHONE_OLD_MANUAL', '+910000000201', 'connected');

-- Company Y's own, entirely unrelated connection -- must be untouched by
-- anything that happens to Company X below.
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source) values
  ('d0300002-0000-0000-0000-000000000001', 'd0100002-0000-0000-0000-000000000001', 'WABA_CO_Y', 'Co Y', 'connected', true, 'manual_admin');
insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('d0400002-0000-0000-0000-000000000001', 'd0100002-0000-0000-0000-000000000001', 'd0300002-0000-0000-0000-000000000001', 'PHONE_CO_Y', '+910000000202', 'connected');

-- ---------------------------------------------------------------------------
-- 1. whatsapp_registration_pins: no policy for any role.
-- ---------------------------------------------------------------------------

set local role anon;

do $$
begin
  perform test_assert(
    'anon sees zero rows in whatsapp_registration_pins -- no SELECT policy exists (same as whatsapp_signup_attempts, migration 37)',
    (select count(*) from whatsapp_registration_pins) = 0
  );
end;
$$;

reset role;

set local role authenticated;

do $$
begin
  perform test_assert(
    'authenticated sees zero rows in whatsapp_registration_pins -- no SELECT policy exists',
    (select count(*) from whatsapp_registration_pins) = 0
  );
end;
$$;

select test_assert_raises(
  'authenticated cannot directly INSERT into whatsapp_registration_pins, bypassing service_role entirely',
  $sql$ insert into whatsapp_registration_pins (phone_number_id, registration_pin_encrypted, registration_pin_key_version) values ('PHONE_RLS_PROBE', '{"v":1,"kv":1,"iv":"AA","ct":"BB"}', 1) $sql$,
  'new row violates row-level security policy for table "whatsapp_registration_pins"'
);

reset role;

set local role service_role;

do $$
begin
  insert into whatsapp_registration_pins (phone_number_id, registration_pin_encrypted, registration_pin_key_version)
    values ('PHONE_SERVICE_ROLE_WRITE', '{"v":1,"kv":1,"iv":"AA","ct":"BB"}', 1);
  perform test_assert(
    'service_role can insert into whatsapp_registration_pins',
    (select count(*) from whatsapp_registration_pins where phone_number_id = 'PHONE_SERVICE_ROLE_WRITE') = 1
  );

  insert into whatsapp_registration_pins (phone_number_id, registration_pin_encrypted, registration_pin_key_version)
    values ('PHONE_SERVICE_ROLE_WRITE', '{"v":1,"kv":1,"iv":"CC","ct":"DD"}', 1)
    on conflict (phone_number_id) do update set registration_pin_encrypted = excluded.registration_pin_encrypted;
  perform test_assert(
    'service_role can upsert (update-on-conflict) an existing whatsapp_registration_pins row rather than duplicating it',
    (select count(*) from whatsapp_registration_pins where phone_number_id = 'PHONE_SERVICE_ROLE_WRITE') = 1
  );
  perform test_assert(
    'the upsert actually updated the stored envelope',
    (select registration_pin_encrypted from whatsapp_registration_pins where phone_number_id = 'PHONE_SERVICE_ROLE_WRITE') = '{"v":1,"kv":1,"iv":"CC","ct":"DD"}'
  );
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2. complete_whatsapp_signup: one-active-WABA-per-company.
-- ---------------------------------------------------------------------------

set local role service_role;

-- Embedded Signup connects a DIFFERENT WABA for Company X, which already
-- has a connected manual_admin row (WABA_OLD_MANUAL) -- the exact real
-- staging scenario.
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('1', 64);
  v_new_account_id uuid;
  v_new_phone_id uuid;
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('d0100001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'd0100001-0000-0000-0000-000000000001', v_nonce);

  select whatsapp_account_id, whatsapp_phone_number_id into v_new_account_id, v_new_phone_id
    from complete_whatsapp_signup(
      v_attempt_id, 'd0100001-0000-0000-0000-000000000001',
      'WABA_NEW_ES', 'PHONE_NEW_ES', 'business-x', 'Co X (Embedded Signup)', '+910000000203',
      '{"v":1,"kv":1,"iv":"EE","ct":"FF"}', 1::smallint, now() + interval '60 days'
    );

  perform test_assert('the new Embedded Signup connection is connected', (select status from whatsapp_accounts where id = v_new_account_id) = 'connected');
  perform test_assert('the new Embedded Signup connection has connection_source embedded_signup', (select connection_source from whatsapp_accounts where id = v_new_account_id) = 'embedded_signup');
  perform test_assert('the new phone row is connected', (select status from whatsapp_phone_numbers where id = v_new_phone_id) = 'connected');

  perform test_assert(
    'the previously-active manual_admin row for Company X is now disabled',
    (select status from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') = 'disabled'
  );
  perform test_assert(
    'the previously-active manual_admin row''s phone number is now disabled',
    (select status from whatsapp_phone_numbers where id = 'd0400001-0000-0000-0000-000000000001') = 'disabled'
  );
  perform test_assert(
    'the superseded manual_admin row was NOT deleted -- historical data preserved',
    exists (select 1 from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001')
  );
  perform test_assert(
    'the superseded manual_admin row''s waba_id is unchanged -- history is preserved, not overwritten',
    (select waba_id from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') = 'WABA_OLD_MANUAL'
  );

  perform test_assert(
    'Company X now has exactly one non-disabled (active) whatsapp_accounts row',
    (select count(*) from whatsapp_accounts where company_id = 'd0100001-0000-0000-0000-000000000001' and status <> 'disabled') = 1
  );
  perform test_assert(
    'Company Y''s completely separate connection is entirely untouched',
    (select status from whatsapp_accounts where id = 'd0300002-0000-0000-0000-000000000001') = 'connected'
  );
  perform test_assert(
    'Company Y''s phone number is entirely untouched',
    (select status from whatsapp_phone_numbers where id = 'd0400002-0000-0000-0000-000000000001') = 'connected'
  );
end;
$$;

-- A SECOND Embedded Signup completion for Company X, with yet ANOTHER
-- different WABA -- proves the newly-active embedded_signup row from the
-- previous step gets correctly superseded in turn (including its
-- credential fields being cleared, mirroring client_disconnect_whatsapp_account's
-- own clearing behavior, migration 38), and that the ALREADY-disabled
-- manual_admin row is left alone (still disabled, not reactivated, not
-- touched again).
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('2', 64);
  v_newer_account_id uuid;
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('d0100001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'd0100001-0000-0000-0000-000000000001', v_nonce);

  select whatsapp_account_id into v_newer_account_id
    from complete_whatsapp_signup(
      v_attempt_id, 'd0100001-0000-0000-0000-000000000001',
      'WABA_NEWER_ES', 'PHONE_NEWER_ES', 'business-x-2', 'Co X (Embedded Signup, again)', '+910000000204',
      '{"v":1,"kv":1,"iv":"GG","ct":"HH"}', 1::smallint, now() + interval '60 days'
    );

  perform test_assert('the newer Embedded Signup connection is connected', (select status from whatsapp_accounts where id = v_newer_account_id) = 'connected');

  perform test_assert(
    'the PREVIOUS Embedded Signup connection (WABA_NEW_ES) is now disabled',
    (select status from whatsapp_accounts where waba_id = 'WABA_NEW_ES') = 'disabled'
  );
  perform test_assert(
    'the superseded embedded_signup row''s encrypted_access_token was cleared (credential hygiene, same as client_disconnect_whatsapp_account)',
    (select encrypted_access_token from whatsapp_accounts where waba_id = 'WABA_NEW_ES') is null
  );
  perform test_assert(
    'the superseded embedded_signup row''s encryption_key_version was cleared',
    (select encryption_key_version from whatsapp_accounts where waba_id = 'WABA_NEW_ES') is null
  );
  perform test_assert(
    'the superseded embedded_signup row''s token_expires_at was cleared',
    (select token_expires_at from whatsapp_accounts where waba_id = 'WABA_NEW_ES') is null
  );
  perform test_assert(
    'the superseded embedded_signup row''s phone number is now disabled too',
    (select status from whatsapp_phone_numbers where phone_number_id = 'PHONE_NEW_ES') = 'disabled'
  );

  perform test_assert(
    'the ORIGINAL manual_admin row remains disabled (not reactivated by this second switch)',
    (select status from whatsapp_accounts where id = 'd0300001-0000-0000-0000-000000000001') = 'disabled'
  );
  perform test_assert(
    'Company X still has exactly one non-disabled (active) whatsapp_accounts row after two switches',
    (select count(*) from whatsapp_accounts where company_id = 'd0100001-0000-0000-0000-000000000001' and status <> 'disabled') = 1
  );
  perform test_assert(
    'Company X now has three total whatsapp_accounts rows -- none were deleted across two switches',
    (select count(*) from whatsapp_accounts where company_id = 'd0100001-0000-0000-0000-000000000001') = 3
  );
  perform test_assert(
    'Company Y remains completely untouched after Company X''s second switch',
    (select status from whatsapp_accounts where id = 'd0300002-0000-0000-0000-000000000001') = 'connected'
  );
end;
$$;

-- A reconnect of the SAME (currently active) WABA does not disable itself
-- or anything else -- pure regression, since this is the existing
-- migration-37 upgrade/reconnect path this migration must not break.
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('3', 64);
  v_account_id uuid;
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('d0100001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'd0100001-0000-0000-0000-000000000001', v_nonce);

  select whatsapp_account_id into v_account_id
    from complete_whatsapp_signup(
      v_attempt_id, 'd0100001-0000-0000-0000-000000000001',
      'WABA_NEWER_ES', 'PHONE_NEWER_ES', 'business-x-2', 'Co X (Embedded Signup, reconnected)', '+910000000204',
      '{"v":1,"kv":1,"iv":"II","ct":"JJ"}', 1::smallint, now() + interval '60 days'
    );

  perform test_assert(
    'reconnecting the currently-active WABA keeps it connected (does not disable itself)',
    (select status from whatsapp_accounts where id = v_account_id) = 'connected'
  );
  perform test_assert(
    'reconnecting the currently-active WABA does not change the count of active rows',
    (select count(*) from whatsapp_accounts where company_id = 'd0100001-0000-0000-0000-000000000001' and status <> 'disabled') = 1
  );
  perform test_assert(
    'reconnecting the currently-active WABA does not create a new row',
    (select count(*) from whatsapp_accounts where company_id = 'd0100001-0000-0000-0000-000000000001') = 3
  );
end;
$$;

reset role;

rollback;
