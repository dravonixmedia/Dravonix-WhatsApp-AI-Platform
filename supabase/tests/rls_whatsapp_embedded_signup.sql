-- Meta/WhatsApp Batch 3, Slice A (migration 37): DB-level regression coverage
-- for the signup-attempt state machine (pending -> processing -> completed,
-- with expired/failed terminal states) and its three service-role-only RPCs
-- (create_whatsapp_signup_attempt, claim_whatsapp_signup_attempt,
-- complete_whatsapp_signup). Covers: RPC privilege boundaries (anon,
-- authenticated, service_role), direct table write denial, nonce_hash
-- non-exposure, the atomic pending->processing compare-and-set (including
-- sequential replay rejection -- see the concurrency note near the end for
-- why true concurrent transactions aren't exercised here), cross-tenant
-- WABA/phone takeover rejection, same-company reconnect/update semantics,
-- the manual_admin -> embedded_signup upgrade path, credential-failure
-- metadata clearing on success, and a regression sweep confirming migration
-- 35's Super Admin RPCs and the company-match trigger are untouched.

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
-- Fixtures: Company A (with an existing manual_admin WABA/phone, for the
-- upgrade-path tests) and Company B (with its own existing WABA/phone, for
-- cross-tenant takeover tests). Two initiating users, one per company.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('c0000001-0000-0000-0000-000000000001', 'initiator-a@example.test'),
  ('c0000002-0000-0000-0000-000000000001', 'company-a-owner@example.test'),
  ('c0000003-0000-0000-0000-000000000001', 'initiator-b@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('c0100001-0000-0000-0000-000000000001', 'Embedded Signup Co A', 'embedded-signup-co-a', 'active', true),
  ('c0100002-0000-0000-0000-000000000001', 'Embedded Signup Co B', 'embedded-signup-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('c0210001-0000-0000-0000-000000000001', 'c0100001-0000-0000-0000-000000000001', 'c0000002-0000-0000-0000-000000000001', 'company_owner', true);

-- Company A's pre-existing manual_admin connection (Batch 1 path) --
-- used below to prove the manual_admin -> embedded_signup upgrade.
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source) values
  ('c0300001-0000-0000-0000-000000000001', 'c0100001-0000-0000-0000-000000000001', 'WABA_MANUAL_A', 'Co A (manual)', 'connected', true, 'manual_admin');
insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('c0400001-0000-0000-0000-000000000001', 'c0100001-0000-0000-0000-000000000001', 'c0300001-0000-0000-0000-000000000001', 'PHONE_MANUAL_A', '+910000000101', 'connected');

-- Company B's own existing connection -- used below as the cross-tenant
-- takeover target.
insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account, connection_source) values
  ('c0300002-0000-0000-0000-000000000001', 'c0100002-0000-0000-0000-000000000001', 'WABA_EXISTING_B', 'Co B', 'connected', true, 'manual_admin');
insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('c0400002-0000-0000-0000-000000000001', 'c0100002-0000-0000-0000-000000000001', 'c0300002-0000-0000-0000-000000000001', 'PHONE_EXISTING_B', '+910000000102', 'connected');

-- ---------------------------------------------------------------------------
-- Hardening sweep: all three new SECURITY DEFINER functions have an empty
-- search_path and are not executable by anon (same pattern as migration 35's
-- own test file).
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'create_whatsapp_signup_attempt', 'claim_whatsapp_signup_attempt', 'complete_whatsapp_signup'
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
    if has_function_privilege('authenticated', (select oid from pg_proc where proname = fn limit 1), 'execute') then
      raise exception 'ASSERTION FAILED: function % is executable by authenticated', fn;
    end if;
    raise notice 'OK: % has an empty search_path and is executable by neither anon nor authenticated', fn;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. RPC privilege boundaries: anon and authenticated are both denied
--    EXECUTE on all three RPCs (this is enforced at the grant level, so the
--    call never even reaches the function body -- confirmed by the
--    insufficient_privilege exception, not a business-logic error).
-- ---------------------------------------------------------------------------

do $$
begin
  set local role anon;
  begin
    perform id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('a', 64), now() + interval '5 minutes');
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on create_whatsapp_signup_attempt';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on create_whatsapp_signup_attempt';
  end;
  begin
    perform id from claim_whatsapp_signup_attempt(gen_random_uuid(), 'c0100001-0000-0000-0000-000000000001', repeat('a', 64));
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on claim_whatsapp_signup_attempt';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on claim_whatsapp_signup_attempt';
  end;
  begin
    perform whatsapp_account_id from complete_whatsapp_signup(gen_random_uuid(), 'c0100001-0000-0000-0000-000000000001', 'X', 'Y', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz);
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on complete_whatsapp_signup';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on complete_whatsapp_signup';
  end;
end;
$$;
reset role;

set local role authenticated;
select test_set_current_user('c0000002-0000-0000-0000-000000000001'); -- a real Company A owner

do $$
begin
  begin
    perform id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('a', 64), now() + interval '5 minutes');
    raise exception 'ASSERTION FAILED: authenticated should be denied EXECUTE on create_whatsapp_signup_attempt, even a real member of the target company';
  exception
    when insufficient_privilege then
      raise notice 'OK: authenticated (real Company A owner) is denied EXECUTE on create_whatsapp_signup_attempt';
  end;
  begin
    perform id from claim_whatsapp_signup_attempt(gen_random_uuid(), 'c0100001-0000-0000-0000-000000000001', repeat('a', 64));
    raise exception 'ASSERTION FAILED: authenticated should be denied EXECUTE on claim_whatsapp_signup_attempt';
  exception
    when insufficient_privilege then
      raise notice 'OK: authenticated is denied EXECUTE on claim_whatsapp_signup_attempt';
  end;
  begin
    perform whatsapp_account_id from complete_whatsapp_signup(gen_random_uuid(), 'c0100001-0000-0000-0000-000000000001', 'X', 'Y', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz);
    raise exception 'ASSERTION FAILED: authenticated should be denied EXECUTE on complete_whatsapp_signup';
  exception
    when insufficient_privilege then
      raise notice 'OK: authenticated is denied EXECUTE on complete_whatsapp_signup';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. nonce_hash is never browser-readable, and no authenticated caller can
--    write to whatsapp_signup_attempts directly -- the table is server-only
--    (no SELECT/INSERT/UPDATE/DELETE policy at all, not even for the
--    owning company).
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_assert(
    'authenticated (real Company A owner) sees zero rows in whatsapp_signup_attempts -- no SELECT policy exists',
    (select count(*) from whatsapp_signup_attempts) = 0
  );
end;
$$;

select test_assert_raises(
  'authenticated cannot directly INSERT into whatsapp_signup_attempts, bypassing the RPC entirely',
  $sql$ insert into whatsapp_signup_attempts (company_id, initiated_by_user_id, nonce_hash, expires_at) values ('c0100001-0000-0000-0000-000000000001', 'c0000002-0000-0000-0000-000000000001', repeat('b', 64), now() + interval '5 minutes') $sql$,
  'new row violates row-level security policy for table "whatsapp_signup_attempts"'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3. service_role: create_whatsapp_signup_attempt validations, then a
--    successful creation.
-- ---------------------------------------------------------------------------

set local role service_role;

select test_assert_raises(
  'create_whatsapp_signup_attempt rejects an unknown company',
  $sql$ select id from create_whatsapp_signup_attempt('00000000-0000-0000-0000-000000000000', 'c0000001-0000-0000-0000-000000000001', repeat('a', 64), now() + interval '5 minutes') $sql$,
  'company_not_found'
);

select test_assert_raises(
  'create_whatsapp_signup_attempt rejects an unknown initiating user',
  $sql$ select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', repeat('a', 64), now() + interval '5 minutes') $sql$,
  'initiating_user_not_found'
);

select test_assert_raises(
  'create_whatsapp_signup_attempt rejects a malformed nonce_hash (wrong length)',
  $sql$ select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', 'tooshort', now() + interval '5 minutes') $sql$,
  'invalid_nonce_hash'
);

select test_assert_raises(
  'create_whatsapp_signup_attempt rejects a malformed nonce_hash (uppercase hex is not accepted)',
  $sql$ select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', upper(repeat('a', 64)), now() + interval '5 minutes') $sql$,
  'invalid_nonce_hash'
);

select test_assert_raises(
  'create_whatsapp_signup_attempt rejects an already-past expiry',
  $sql$ select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('c', 64), now() - interval '1 minute') $sql$,
  'invalid_expiry'
);

select test_assert_raises(
  'create_whatsapp_signup_attempt rejects an expiry further than 15 minutes out',
  $sql$ select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('d', 64), now() + interval '1 hour') $sql$,
  'invalid_expiry'
);

do $$
declare
  v_id uuid;
  v_expires_at timestamptz;
begin
  select id, expires_at into v_id, v_expires_at
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('1', 64), now() + interval '5 minutes');
  perform test_assert('service_role can create a signup attempt', v_id is not null);
  perform test_assert(
    'a freshly created attempt starts in status pending',
    (select status from whatsapp_signup_attempts where id = v_id) = 'pending'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. claim_whatsapp_signup_attempt: the atomic pending -> processing
--    compare-and-set, and every rejection path. A second sequential claim
--    of the SAME attempt failing (below) is the concrete, provable
--    consequence of the single `UPDATE ... WHERE status = 'pending'`
--    structure: within one transaction, once the first UPDATE has run,
--    the row's status is no longer 'pending', so a second UPDATE with the
--    identical predicate matches zero rows by construction -- this is
--    exactly the guarantee that also holds between two genuinely
--    concurrent transactions (Postgres row-level locking serializes them
--    the same way), just exercised here sequentially rather than with two
--    real concurrent connections. See the note near the end of this file
--    for why true concurrency isn't attempted in this harness.
-- ---------------------------------------------------------------------------

do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('2', 64);
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');

  perform test_assert(
    'a valid claim (correct id/company/nonce, not expired) succeeds',
    (select id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce)) = v_attempt_id
  );
  perform test_assert(
    'the claimed attempt is now in status processing',
    (select status from whatsapp_signup_attempts where id = v_attempt_id) = 'processing'
  );

  begin
    perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);
    raise exception 'ASSERTION FAILED: a second claim of the same (already-processing) attempt should fail';
  exception
    when others then
      if sqlerrm = 'signup_attempt_not_claimable' then
        raise notice 'OK: a second claim of the same attempt fails (no replay of a successful claim)';
      else
        raise;
      end if;
  end;
end;
$$;

select test_assert_raises(
  'claim fails when the company_id does not match the attempt''s own company',
  $sql$
    with fresh as (
      select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('3', 64), now() + interval '5 minutes')
    )
    select id from claim_whatsapp_signup_attempt((select id from fresh), 'c0100002-0000-0000-0000-000000000001', repeat('3', 64))
  $sql$,
  'signup_attempt_not_claimable'
);

select test_assert_raises(
  'claim fails when the nonce_hash does not match',
  $sql$
    with fresh as (
      select id from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', repeat('4', 64), now() + interval '5 minutes')
    )
    select id from claim_whatsapp_signup_attempt((select id from fresh), 'c0100001-0000-0000-0000-000000000001', repeat('9', 64))
  $sql$,
  'signup_attempt_not_claimable'
);

do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('5', 64);
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  -- Backdate both created_at and expires_at directly (service_role bypasses
  -- RLS; this is test-fixture manipulation, not a real write path -- no
  -- application code ever does this). Both must move together to satisfy
  -- the whatsapp_signup_attempts_expiry_bounded check constraint
  -- (expires_at > created_at) while still landing expires_at in the past
  -- relative to the real now().
  update whatsapp_signup_attempts
    set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'
    where id = v_attempt_id;

  begin
    perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);
    raise exception 'ASSERTION FAILED: claiming an expired attempt should fail';
  exception
    when others then
      if sqlerrm = 'signup_attempt_not_claimable' then
        raise notice 'OK: an expired attempt cannot be claimed';
      else
        raise;
      end if;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. complete_whatsapp_signup: non-processing rejection, successful
--    completion, replay rejection, cross-tenant takeover rejection, and
--    same-company reconnect/manual_admin-upgrade update semantics.
-- ---------------------------------------------------------------------------

do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('6', 64);
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  -- Deliberately NOT claimed -- still 'pending'.
  begin
    perform whatsapp_account_id from complete_whatsapp_signup(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', 'WABA_NEVER_CLAIMED', 'PHONE_NEVER_CLAIMED', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz);
    raise exception 'ASSERTION FAILED: completing a still-pending (never claimed) attempt should fail';
  exception
    when others then
      if sqlerrm = 'signup_attempt_not_processing' then
        raise notice 'OK: completion is rejected for an attempt that was never claimed (still pending)';
      else
        raise;
      end if;
  end;
end;
$$;

-- Independent adversarial-review addition: complete_whatsapp_signup must
-- never trust p_company_id in isolation. A genuinely 'processing' attempt
-- that legitimately belongs to Company A must be rejected outright when
-- called with Company B's company_id, and must write nothing for either
-- company -- the initial locked lookup ("where id = p_attempt_id and
-- company_id = p_company_id and status = 'processing'") is what enforces
-- this, and this test exercises exactly that mismatch directly, distinct
-- from the already-connected-WABA/phone takeover tests below (which use
-- the CORRECT company_id but a colliding asset identifier).
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('61', 32); -- 64 hex chars
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);
  -- v_attempt_id now genuinely 'processing', owned by Company A.

  begin
    perform whatsapp_account_id from complete_whatsapp_signup(
      v_attempt_id, 'c0100002-0000-0000-0000-000000000001', -- Company B, NOT the attempt's real owner
      'WABA_COMPANY_MISMATCH_ATTEMPT', 'PHONE_COMPANY_MISMATCH_ATTEMPT', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz
    );
    raise exception 'ASSERTION FAILED: completing a real processing attempt with a MISMATCHED company_id should be rejected';
  exception
    when others then
      if sqlerrm = 'signup_attempt_not_processing' then
        raise notice 'OK: complete_whatsapp_signup rejects a company_id that does not match the attempt''s own real owner, even though the attempt genuinely is processing';
      else
        raise;
      end if;
  end;

  perform test_assert(
    'the company-mismatch completion attempt wrote no whatsapp_accounts row for either company',
    not exists (select 1 from whatsapp_accounts where waba_id = 'WABA_COMPANY_MISMATCH_ATTEMPT')
  );
  perform test_assert(
    'the company-mismatch completion attempt left the real attempt untouched (still processing, not completed)',
    (select status from whatsapp_signup_attempts where id = v_attempt_id) = 'processing'
  );

  -- Clean up: complete it correctly with Company A so it doesn't linger as
  -- an orphaned 'processing' row for the rest of this file (harmless either
  -- way since the whole file rolls back, but keeps intent clear).
  perform whatsapp_account_id from complete_whatsapp_signup(
    v_attempt_id, 'c0100001-0000-0000-0000-000000000001',
    'WABA_COMPANY_MISMATCH_CLEANUP', 'PHONE_COMPANY_MISMATCH_CLEANUP', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz
  );
end;
$$;

-- Successful completion for a brand-new WABA/phone (Company A), and the
-- manual_admin -> embedded_signup upgrade in the SAME test, since the
-- upgrade path reuses WABA_MANUAL_A from the fixtures.
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('7', 64);
  v_account_id uuid;
  v_phone_id uuid;
begin
  -- Pre-set failure metadata on the manual_admin row, to prove it gets
  -- cleared by a successful completion below.
  update whatsapp_accounts set credential_error_code = 'exchange_failed', credential_failed_at = now()
    where id = 'c0300001-0000-0000-0000-000000000001';
  update whatsapp_phone_numbers set last_connection_error_code = 'exchange_failed', last_connection_error_at = now()
    where id = 'c0400001-0000-0000-0000-000000000001';

  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);

  select whatsapp_account_id, whatsapp_phone_number_id into v_account_id, v_phone_id
    from complete_whatsapp_signup(
      v_attempt_id, 'c0100001-0000-0000-0000-000000000001',
      'WABA_MANUAL_A', 'PHONE_MANUAL_A', 'business-123', 'Co A (upgraded)', '+910000000101',
      '{"v":1,"kv":1,"iv":"AA","ct":"BB"}', 1::smallint, now() + interval '60 days'
    );

  perform test_assert('completing an upgrade re-uses the existing manual_admin row id, not a new one', v_account_id = 'c0300001-0000-0000-0000-000000000001');
  perform test_assert('completing re-uses the existing phone row id, not a new one', v_phone_id = 'c0400001-0000-0000-0000-000000000001');
  perform test_assert(
    'the upgraded row''s connection_source is now embedded_signup',
    (select connection_source from whatsapp_accounts where id = v_account_id) = 'embedded_signup'
  );
  perform test_assert(
    'exactly one whatsapp_accounts row still exists for WABA_MANUAL_A -- no duplicate row was created by the upgrade',
    (select count(*) from whatsapp_accounts where waba_id = 'WABA_MANUAL_A') = 1
  );
  perform test_assert(
    'the upgraded row''s credential_error_code was cleared by the successful completion',
    (select credential_error_code from whatsapp_accounts where id = v_account_id) is null
  );
  perform test_assert(
    'the upgraded row''s credential_failed_at was cleared by the successful completion',
    (select credential_failed_at from whatsapp_accounts where id = v_account_id) is null
  );
  perform test_assert(
    'the upgraded phone row''s last_connection_error_code was cleared by the successful completion',
    (select last_connection_error_code from whatsapp_phone_numbers where id = v_phone_id) is null
  );
  perform test_assert(
    'resulting_whatsapp_account_id is populated on the now-completed attempt',
    (select resulting_whatsapp_account_id from whatsapp_signup_attempts where id = v_attempt_id) = v_account_id
  );
  perform test_assert(
    'the completed attempt''s status is now completed',
    (select status from whatsapp_signup_attempts where id = v_attempt_id) = 'completed'
  );

  -- Replay rejection: the same (now-completed) attempt cannot be completed
  -- again.
  begin
    perform whatsapp_account_id from complete_whatsapp_signup(
      v_attempt_id, 'c0100001-0000-0000-0000-000000000001',
      'WABA_MANUAL_A', 'PHONE_MANUAL_A', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz
    );
    raise exception 'ASSERTION FAILED: completing an already-completed attempt should fail (no replay)';
  exception
    when others then
      if sqlerrm = 'signup_attempt_not_processing' then
        raise notice 'OK: a completed attempt cannot be replayed through complete_whatsapp_signup';
      else
        raise;
      end if;
  end;
end;
$$;

-- Same-company reconnect: completing again for Company A with the SAME
-- waba_id (now embedded_signup) updates rather than duplicates.
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('8', 64);
  v_account_id uuid;
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);

  select whatsapp_account_id into v_account_id
    from complete_whatsapp_signup(
      v_attempt_id, 'c0100001-0000-0000-0000-000000000001',
      'WABA_MANUAL_A', 'PHONE_MANUAL_A', 'business-123', 'Co A (reconnected)', '+910000000101',
      '{"v":1,"kv":1,"iv":"CC","ct":"DD"}', 1::smallint, now() + interval '60 days'
    );

  perform test_assert('a same-company reconnect updates the existing account row id', v_account_id = 'c0300001-0000-0000-0000-000000000001');
  perform test_assert(
    'still exactly one whatsapp_accounts row for WABA_MANUAL_A after the reconnect',
    (select count(*) from whatsapp_accounts where waba_id = 'WABA_MANUAL_A') = 1
  );
  perform test_assert(
    'still exactly one whatsapp_phone_numbers row for PHONE_MANUAL_A after the reconnect',
    (select count(*) from whatsapp_phone_numbers where phone_number_id = 'PHONE_MANUAL_A') = 1
  );
  perform test_assert(
    'the reconnect updated the stored business_name',
    (select business_name from whatsapp_accounts where id = v_account_id) = 'Co A (reconnected)'
  );
end;
$$;

-- Cross-tenant WABA takeover: Company A cannot claim Company B's existing
-- WABA_EXISTING_B through completion.
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('9', 64);
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);

  begin
    perform whatsapp_account_id from complete_whatsapp_signup(
      v_attempt_id, 'c0100001-0000-0000-0000-000000000001',
      'WABA_EXISTING_B', 'PHONE_TAKEOVER_ATTEMPT_1', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz
    );
    raise exception 'ASSERTION FAILED: completing with another company''s existing waba_id should be rejected';
  exception
    when others then
      if sqlerrm = 'waba_already_connected_to_another_company' then
        raise notice 'OK: cross-tenant WABA takeover via complete_whatsapp_signup is rejected';
      else
        raise;
      end if;
  end;

  perform test_assert(
    'the rejected takeover attempt did not change WABA_EXISTING_B''s owning company',
    (select company_id from whatsapp_accounts where waba_id = 'WABA_EXISTING_B') = 'c0100002-0000-0000-0000-000000000001'
  );
  perform test_assert(
    'the rejected takeover attempt left the signup attempt in processing (not completed, not silently failed)',
    (select status from whatsapp_signup_attempts where id = v_attempt_id) = 'processing'
  );
end;
$$;

-- Cross-tenant phone takeover: Company A cannot claim Company B's existing
-- PHONE_EXISTING_B through completion, even under a brand-new waba_id.
do $$
declare
  v_attempt_id uuid;
  v_nonce text := repeat('a1', 32); -- 64 hex chars total
begin
  select id into v_attempt_id
    from create_whatsapp_signup_attempt('c0100001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', v_nonce, now() + interval '5 minutes');
  perform id from claim_whatsapp_signup_attempt(v_attempt_id, 'c0100001-0000-0000-0000-000000000001', v_nonce);

  begin
    perform whatsapp_account_id from complete_whatsapp_signup(
      v_attempt_id, 'c0100001-0000-0000-0000-000000000001',
      'WABA_TAKEOVER_ATTEMPT_2', 'PHONE_EXISTING_B', null::text, null::text, null::text, 'ct', 1::smallint, null::timestamptz
    );
    raise exception 'ASSERTION FAILED: completing with another company''s existing phone_number_id should be rejected';
  exception
    when others then
      if sqlerrm = 'phone_number_already_connected_to_another_company' then
        raise notice 'OK: cross-tenant phone takeover via complete_whatsapp_signup is rejected';
      else
        raise;
      end if;
  end;

  perform test_assert(
    'the rejected takeover attempt did not change PHONE_EXISTING_B''s owning company',
    (select company_id from whatsapp_phone_numbers where phone_number_id = 'PHONE_EXISTING_B') = 'c0100002-0000-0000-0000-000000000001'
  );
  perform test_assert(
    'the rejected phone-takeover attempt did NOT leave behind a new whatsapp_accounts row for WABA_TAKEOVER_ATTEMPT_2',
    not exists (select 1 from whatsapp_accounts where waba_id = 'WABA_TAKEOVER_ATTEMPT_2')
  );
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 6. Regression: migration 35's Super Admin RPCs and the company-match
--    trigger are completely untouched by this migration.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values ('c0000004-0000-0000-0000-000000000001', 'super-admin-embedded@example.test');
insert into platform_members (user_id, role, is_active) values ('c0000004-0000-0000-0000-000000000001', 'super_admin', true);

set local role authenticated;
select test_set_current_user('c0000004-0000-0000-0000-000000000001');

do $$
declare
  v_account_id uuid;
begin
  select id into v_account_id
    from admin_connect_whatsapp_account('c0100002-0000-0000-0000-000000000001', 'WABA_MIGRATION_35_REGRESSION', 'Regression check', false);
  perform test_assert('migration 35''s admin_connect_whatsapp_account still works unchanged for Super Admin', v_account_id is not null);
end;
$$;

select test_assert_raises(
  'the whatsapp_phone_numbers company-match trigger (migration 35) still rejects a raw insert with mismatched company_id',
  $sql$ insert into whatsapp_phone_numbers (company_id, whatsapp_account_id, phone_number_id, status) values ('c0100002-0000-0000-0000-000000000001', 'c0300001-0000-0000-0000-000000000001', 'PHONE_TRIGGER_STILL_WORKS', 'connected') $sql$,
  'whatsapp_phone_number_company_mismatch'
);

reset role;

set local role service_role;
select test_assert_raises(
  'the whatsapp_phone_numbers company-match trigger fires even for service_role (independent of RLS bypass -- triggers are not an RLS mechanism)',
  $sql$ insert into whatsapp_phone_numbers (company_id, whatsapp_account_id, phone_number_id, status) values ('c0100002-0000-0000-0000-000000000001', 'c0300001-0000-0000-0000-000000000001', 'PHONE_TRIGGER_SERVICE_ROLE', 'connected') $sql$,
  'whatsapp_phone_number_company_mismatch'
);
reset role;

-- ---------------------------------------------------------------------------
-- Concurrency note: this harness runs everything in a single Postgres
-- session/transaction, so two genuinely concurrent transactions racing on
-- the same claim_whatsapp_signup_attempt call cannot be represented here
-- without a second live connection, which this SQL-file-based harness does
-- not provide. What IS proven above is the actual mechanism that makes
-- concurrent claims safe: a single `UPDATE ... WHERE status = 'pending'`
-- statement, which by Postgres's own row-level locking semantics can only
-- be satisfied by one transaction at a time for a given row regardless of
-- how many transactions attempt it concurrently -- the sequential
-- second-claim-fails test above exercises the exact same WHERE-clause
-- state transition a concurrent second claim would also fail against, once
-- the first has committed (or, under real concurrency, once the first has
-- acquired the row lock). complete_whatsapp_signup's `for update` row lock
-- (section 5 above) provides the identical guarantee for the
-- processing -> completed transition. This is a documented harness
-- limitation, not a claim that concurrency was directly exercised.
-- ---------------------------------------------------------------------------

rollback;
