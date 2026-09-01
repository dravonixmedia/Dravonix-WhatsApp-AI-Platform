-- Meta/WhatsApp Batch 2 (migration 36): DB-level regression coverage for the
-- service-window fallback template model (admin_register_whatsapp_template,
-- admin_set_service_window_fallback_template) and the human-initiated
-- re-engagement template reservation (reserve_human_template_outbound_message),
-- plus the trigger-level defense-in-depth on
-- whatsapp_accounts.service_window_fallback_template_id and a direct check
-- of the raw "most recent qualifying inbound customer message" query the
-- application layer (packages/handover) relies on.

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
-- Fixtures: one super_admin; Company A with owner (assigned agent + Super
-- Admin-equivalent reassign holder), a second owner (manager-override
-- holder), an 'agent' (reply but no reassign), and 'company_accounts' (zero
-- permissions); Company B with its own owner (cross-tenant case). Company A
-- has one connected WABA/phone and one conversation in human_active, plus a
-- second conversation in ai_active (for the window-query fixtures and the
-- invalid-state-transition test).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('e0000001-0000-0000-0000-000000000001', 'super-admin-sw@example.test'),
  ('e0200001-0000-0000-0000-000000000001', 'owner-sw-a@example.test'),
  ('e0200001-0000-0000-0000-000000000002', 'agent-sw-a@example.test'),
  ('e0200001-0000-0000-0000-000000000003', 'accounts-sw-a@example.test'),
  ('e0200002-0000-0000-0000-000000000001', 'owner-sw-b@example.test');

insert into platform_members (user_id, role, is_active) values
  ('e0000001-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('e0100001-0000-0000-0000-000000000001', 'SW Co A', 'sw-co-a', 'active', true),
  ('e0100002-0000-0000-0000-000000000001', 'SW Co B', 'sw-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('e0210001-0000-0000-0000-000000000001', 'e0100001-0000-0000-0000-000000000001', 'e0200001-0000-0000-0000-000000000001', 'company_owner', true),
  ('e0210001-0000-0000-0000-000000000002', 'e0100001-0000-0000-0000-000000000001', 'e0200001-0000-0000-0000-000000000002', 'agent', true),
  ('e0210001-0000-0000-0000-000000000003', 'e0100001-0000-0000-0000-000000000001', 'e0200001-0000-0000-0000-000000000003', 'company_accounts', true),
  ('e0210002-0000-0000-0000-000000000001', 'e0100002-0000-0000-0000-000000000001', 'e0200002-0000-0000-0000-000000000001', 'company_owner', true);

insert into whatsapp_accounts (id, company_id, waba_id, business_name, status, is_test_account) values
  ('e0300001-0000-0000-0000-000000000001', 'e0100001-0000-0000-0000-000000000001', 'WABA_SW_A', 'SW Co A Business', 'connected', true),
  ('e0300002-0000-0000-0000-000000000001', 'e0100002-0000-0000-0000-000000000001', 'WABA_SW_B', 'SW Co B Business', 'connected', true);

insert into whatsapp_phone_numbers (id, company_id, whatsapp_account_id, phone_number_id, display_phone_number, status) values
  ('e0400001-0000-0000-0000-000000000001', 'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', 'PHONE_SW_A', '+910000000010', 'connected');

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('e0500001-0000-0000-0000-000000000001', 'e0100001-0000-0000-0000-000000000001', '919999999901', 'SW Contact A');

insert into conversations (id, company_id, contact_id, whatsapp_phone_number_id, state, assigned_member_id) values
  ('e0600001-0000-0000-0000-000000000001', 'e0100001-0000-0000-0000-000000000001', 'e0500001-0000-0000-0000-000000000001', 'e0400001-0000-0000-0000-000000000001', 'human_active', 'e0210001-0000-0000-0000-000000000002'),
  ('e0600001-0000-0000-0000-000000000002', 'e0100001-0000-0000-0000-000000000001', 'e0500001-0000-0000-0000-000000000001', 'e0400001-0000-0000-0000-000000000001', 'ai_active', null);

-- Window-query fixtures on conv2 (ai_active): an inbound message from 30
-- hours ago (outside the window), an outbound AI reply from 10 hours ago
-- (must NEVER be treated as the qualifying timestamp), and a genuinely
-- recent inbound message from 2 hours ago (inside the window).
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, created_at) values
  ('e0700001-0000-0000-0000-000000000001', 'e0100001-0000-0000-0000-000000000001', 'e0600001-0000-0000-0000-000000000002', 'inbound', 'text', 'customer', 'wamid.SW.OLD', 'old message', now() - interval '30 hours');

insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, source_message_id, outbound_status, created_at) values
  ('e0700001-0000-0000-0000-000000000002', 'e0100001-0000-0000-0000-000000000001', 'e0600001-0000-0000-0000-000000000002', 'outbound', 'text', 'ai', 'wamid.SW.OUT', 'an AI reply', 'e0700001-0000-0000-0000-000000000001', 'sent', now() - interval '10 hours');

insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, provider_message_id, body, created_at) values
  ('e0700001-0000-0000-0000-000000000003', 'e0100001-0000-0000-0000-000000000001', 'e0600001-0000-0000-0000-000000000002', 'inbound', 'text', 'customer', 'wamid.SW.RECENT', 'recent message', now() - interval '2 hours');

-- ---------------------------------------------------------------------------
-- Hardening sweep: every new SECURITY DEFINER function has an empty
-- search_path and is not executable by anon.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'admin_register_whatsapp_template', 'admin_set_service_window_fallback_template',
    'reserve_human_template_outbound_message'
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
-- 0. Direct check of the raw "most recent qualifying inbound customer
--    message" query the application layer (packages/handover's
--    getServiceWindowState/getLastCustomerMessageAt) relies on -- proves it
--    picks the genuinely most recent INBOUND row, never an outbound one,
--    using only the existing messages_conversation_id_created_at_idx.
-- ---------------------------------------------------------------------------

do $$
declare
  v_last timestamptz;
begin
  select created_at into v_last
    from messages
    where conversation_id = 'e0600001-0000-0000-0000-000000000002'
      and direction = 'inbound' and sender_type = 'customer'
    order by created_at desc limit 1;
  perform test_assert(
    'the raw window query returns the most recent INBOUND customer message, ignoring the more recent outbound AI reply',
    v_last = (select created_at from messages where id = 'e0700001-0000-0000-0000-000000000003')
  );
end;
$$;

set local role authenticated;
select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- super_admin

-- ---------------------------------------------------------------------------
-- 1. admin_register_whatsapp_template: Super Admin registers a new template;
--    re-registering the same (account, name, language) updates in place.
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
  v_status whatsapp_template_status;
begin
  select id, status into v_id, v_status
    from admin_register_whatsapp_template(
      'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
      'reengagement_v1', 'en', 'UTILITY', 'approved', 'We would like to continue helping you.', '[]'::jsonb
    );
  perform test_assert('Super Admin can register a new approved template', v_status = 'approved');

  perform test_assert(
    're-registering the SAME (account, name, language) updates in place rather than creating a duplicate',
    (select count(*) from whatsapp_templates where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'reengagement_v1' and language = 'en') = 1
  );

  perform admin_register_whatsapp_template(
    'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
    'reengagement_v1', 'en', 'UTILITY', 'approved', 'Updated body text.', '[]'::jsonb
  );
  perform test_assert(
    'the re-registration above updated the existing row (still exactly one)',
    (select count(*) from whatsapp_templates where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'reengagement_v1' and language = 'en') = 1
  );
end;
$$;

-- A second, deliberately NOT approved template, and a template registered
-- under Company B's own WABA (cross-company fixture for later rejection
-- tests).
select admin_register_whatsapp_template(
  'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
  'pending_template', 'en', 'UTILITY', 'pending_review', 'Not yet approved.', '[]'::jsonb
);
select admin_register_whatsapp_template(
  'e0100002-0000-0000-0000-000000000001', 'e0300002-0000-0000-0000-000000000001',
  'company_b_template', 'en', 'UTILITY', 'approved', 'Company B only.', '[]'::jsonb
);

-- ---------------------------------------------------------------------------
-- 2. admin_set_service_window_fallback_template: approved template accepted;
--    not-approved / wrong-account / wrong-company templates rejected; null
--    clears it.
-- ---------------------------------------------------------------------------

do $$
declare
  v_template_id uuid;
begin
  select id into v_template_id from whatsapp_templates
    where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'reengagement_v1';

  perform test_assert(
    'Super Admin can set an approved template as the WABA fallback',
    (select service_window_fallback_template_id from admin_set_service_window_fallback_template(
      'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', v_template_id
    )) = v_template_id
  );
end;
$$;

select test_assert_raises(
  'setting a not-yet-approved template as the fallback is rejected',
  $sql$ select id from admin_set_service_window_fallback_template(
    'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
    (select id from whatsapp_templates where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'pending_template')
  ) $sql$,
  'whatsapp_template_not_approved'
);

select test_assert_raises(
  'setting a Company B template as Company A''s WABA fallback is rejected',
  $sql$ select id from admin_set_service_window_fallback_template(
    'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
    (select id from whatsapp_templates where whatsapp_account_id = 'e0300002-0000-0000-0000-000000000001' and name = 'company_b_template')
  ) $sql$,
  'whatsapp_template_not_found'
);

do $$
begin
  perform test_assert(
    'clearing the fallback template (p_template_id = null) succeeds',
    (select service_window_fallback_template_id from admin_set_service_window_fallback_template(
      'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', null
    )) is null
  );
  -- Re-set it for the reserve_human_template_outbound_message tests below.
  perform admin_set_service_window_fallback_template(
    'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
    (select id from whatsapp_templates where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'reengagement_v1')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Trigger-level defense-in-depth on
--    whatsapp_accounts.service_window_fallback_template_id, independent of
--    the RPC. whatsapp_accounts has no UPDATE policy at all (unchanged since
--    migration 3), so a raw UPDATE would just silently match zero rows
--    without ever reaching the trigger (Meta/WhatsApp Batch 1's own
--    established finding) -- a raw INSERT of a brand-new row is what
--    actually exercises the BEFORE INSERT trigger, since a BEFORE ROW
--    trigger fires before RLS's WITH CHECK is evaluated. Runs as Super
--    Admin (is_platform_staff() visibility) so the trigger's own lookup can
--    see the cross-company template row.
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'a raw INSERT of a new whatsapp_accounts row bypassing the RPC is rejected for a fallback template belonging to a different WABA',
  $sql$ insert into whatsapp_accounts (id, company_id, waba_id, status, service_window_fallback_template_id) values (
    'e0300001-0000-0000-0000-000000000099', 'e0100001-0000-0000-0000-000000000001', 'WABA_SW_A_BOGUS', 'connected',
    (select id from whatsapp_templates where whatsapp_account_id = 'e0300002-0000-0000-0000-000000000001' and name = 'company_b_template')
  ) $sql$,
  'service_window_fallback_template_account_mismatch'
);

select test_assert_raises(
  'a raw INSERT of a new whatsapp_accounts row bypassing the RPC is rejected for a nonexistent fallback template id',
  $sql$ insert into whatsapp_accounts (id, company_id, waba_id, status, service_window_fallback_template_id) values (
    'e0300001-0000-0000-0000-000000000098', 'e0100001-0000-0000-0000-000000000001', 'WABA_SW_A_BOGUS2', 'connected', gen_random_uuid()
  ) $sql$,
  'service_window_fallback_template_not_found'
);

do $$
begin
  perform test_assert(
    'neither rejected raw INSERT attempt above created a row, and the real fallback template is untouched',
    not exists (select 1 from whatsapp_accounts where waba_id in ('WABA_SW_A_BOGUS', 'WABA_SW_A_BOGUS2'))
    and (select service_window_fallback_template_id from whatsapp_accounts where id = 'e0300001-0000-0000-0000-000000000001')
      = (select id from whatsapp_templates where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'reengagement_v1')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Authorization sweep for admin_register_whatsapp_template /
--    admin_set_service_window_fallback_template: every non-Super-Admin role,
--    anon, and a cross-tenant Company B owner.
-- ---------------------------------------------------------------------------

select test_set_current_user('e0200001-0000-0000-0000-000000000001'); -- Company A owner (real member, no platform role)
select test_assert_raises(
  'a company owner cannot register a WhatsApp template -- Super Admin only',
  $sql$ select id from admin_register_whatsapp_template('e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', 'owner_attempt', 'en') $sql$,
  'permission_denied'
);
select test_assert_raises(
  'a company owner cannot set the service-window fallback template -- Super Admin only',
  $sql$ select id from admin_set_service_window_fallback_template('e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', null) $sql$,
  'permission_denied'
);

select test_set_current_user('e0200002-0000-0000-0000-000000000001'); -- Company B owner (cross-tenant)
select test_assert_raises(
  'Company B''s owner cannot register a template for Company A -- Super Admin only, not merely cross-tenant',
  $sql$ select id from admin_register_whatsapp_template('e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', 'cross_tenant_attempt', 'en') $sql$,
  'permission_denied'
);

reset role;

do $$
begin
  perform test_clear_current_user();
  set local role anon;
  begin
    perform id from admin_register_whatsapp_template('e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', 'anon_attempt', 'en');
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on admin_register_whatsapp_template, but the call succeeded';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on admin_register_whatsapp_template';
  end;
end;
$$;

reset role;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 5. reserve_human_template_outbound_message: full authorization + state +
--    no-fallback-configured + idempotency + cross-tenant sweep.
-- ---------------------------------------------------------------------------

reset role;

do $$
begin
  perform test_clear_current_user();
  set local role anon;
  begin
    perform id from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000001', 'anon-key');
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on reserve_human_template_outbound_message, but the call succeeded';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on reserve_human_template_outbound_message';
  end;
end;
$$;

reset role;
set local role authenticated;

select test_set_current_user('e0200001-0000-0000-0000-000000000003'); -- company_accounts: real member, zero permissions
select test_assert_raises(
  'a company_accounts member (zero permissions) cannot reserve the re-engagement template',
  $sql$ select id from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000001', 'accounts-key') $sql$,
  'permission_denied'
);

select test_set_current_user('e0200002-0000-0000-0000-000000000001'); -- Company B owner
select test_assert_raises(
  'Company B''s owner cannot reserve a re-engagement template for a Company A conversation',
  $sql$ select id from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000001', 'cross-tenant-key') $sql$,
  'not_a_member'
);

select test_set_current_user('e0200001-0000-0000-0000-000000000002'); -- agent, assigned to conv1 but conv2 is ai_active
select test_assert_raises(
  'reserve_human_template_outbound_message rejects a conversation outside human_active',
  $sql$ select id from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000002', 'wrong-state-key') $sql$,
  'invalid_state_transition'
);

-- Clear the fallback template momentarily to prove the "no fallback
-- configured" rejection, then restore it for the success/idempotency cases.
select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- super_admin
select admin_set_service_window_fallback_template('e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001', null);
select test_set_current_user('e0200001-0000-0000-0000-000000000002'); -- agent, assigned to conv1 (human_active)
select test_assert_raises(
  'reserve_human_template_outbound_message fails safely when no fallback template is configured',
  $sql$ select id from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000001', 'no-template-key') $sql$,
  'no_fallback_template_configured'
);
select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- super_admin
select admin_set_service_window_fallback_template(
  'e0100001-0000-0000-0000-000000000001', 'e0300001-0000-0000-0000-000000000001',
  (select id from whatsapp_templates where whatsapp_account_id = 'e0300001-0000-0000-0000-000000000001' and name = 'reengagement_v1')
);

select test_set_current_user('e0200001-0000-0000-0000-000000000002'); -- agent, assigned to conv1
do $$
declare
  v_id uuid;
  v_claimed boolean;
  v_status outbound_delivery_status;
  v_name text;
  v_language text;
begin
  select id, claimed, outbound_status, template_name, template_language
    into v_id, v_claimed, v_status, v_name, v_language
    from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000001', 'reengage-key-1');

  perform test_assert('the assigned agent can reserve the configured re-engagement template', v_claimed = true);
  perform test_assert('the reservation is in status sending', v_status = 'sending');
  perform test_assert('the reservation returns the real configured template name/language', v_name = 'reengagement_v1' and v_language = 'en');
  perform test_assert(
    'the reservation row is a real messages row: outbound, channel_type template, sender_type human_agent',
    (select direction = 'outbound' and channel_type = 'template' and sender_type = 'human_agent'
       from messages where id = v_id)
  );

  -- Idempotency: the SAME idempotency key while still "sending" must not
  -- create a second row -- claimed=false, same message id.
  perform test_assert(
    'a second reserve call with the same idempotency key while still sending returns claimed=false, same id',
    (select claimed = false and id = v_id from reserve_human_template_outbound_message('e0600001-0000-0000-0000-000000000001', 'reengage-key-1'))
  );

  perform finalize_human_outbound_message(v_id, 'sent', 'wamid.SW.TEMPLATE1');
end;
$$;

do $$
begin
  perform test_assert(
    'finalize_human_outbound_message (migration 12, unmodified) finalizes the template reservation exactly like any other human-authored message',
    (select outbound_status = 'sent' and provider_message_id = 'wamid.SW.TEMPLATE1' from messages where conversation_id = 'e0600001-0000-0000-0000-000000000001' and channel_type = 'template')
  );
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 6. Regression: whatsapp_accounts/whatsapp_templates SELECT-only RLS
--    policies are completely unmodified by this migration.
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_assert(
    'whatsapp_accounts still has exactly one policy (SELECT-only) -- this migration added no new RLS policy, only RPCs',
    (select count(*) from pg_policies where tablename = 'whatsapp_accounts') = 1
  );
  perform test_assert(
    'whatsapp_templates still has exactly one policy (SELECT-only)',
    (select count(*) from pg_policies where tablename = 'whatsapp_templates') = 1
  );
  perform test_assert(
    'no RPC in this migration returns encrypted_access_token',
    pg_get_function_result((select oid from pg_proc where proname = 'admin_register_whatsapp_template' limit 1)) not ilike '%encrypted_access_token%'
    and pg_get_function_result((select oid from pg_proc where proname = 'admin_set_service_window_fallback_template' limit 1)) not ilike '%encrypted_access_token%'
    and pg_get_function_result((select oid from pg_proc where proname = 'reserve_human_template_outbound_message' limit 1)) not ilike '%encrypted_access_token%'
  );
end;
$$;

rollback;
