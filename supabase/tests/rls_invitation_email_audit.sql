-- Invitation email delivery audit RPC hardening tests (migrations 19 + 20).
-- Run after rls_client_onboarding.sql (via supabase/tests/run.sh), against
-- the same throwaway local Postgres database -- never a hosted Supabase
-- project.

begin;

insert into auth.users (id, email) values
  ('82000001-0000-0000-0000-000000000001', 'super-admin-email@example.test'),
  ('82000001-0000-0000-0000-000000000002', 'owner-a-email@example.test'),
  ('82000001-0000-0000-0000-000000000003', 'owner-b-email@example.test'),
  ('82000001-0000-0000-0000-000000000004', 'unrelated-email@example.test');

insert into platform_members (user_id, role, is_active) values
  ('82000001-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('92000001-0000-0000-0000-000000000001', 'Email Audit Co A', 'email-audit-co-a', 'active', true),
  ('92000001-0000-0000-0000-000000000002', 'Email Audit Co B', 'email-audit-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('93000001-0000-0000-0000-000000000001', '92000001-0000-0000-0000-000000000001', '82000001-0000-0000-0000-000000000002', 'company_owner', true),
  ('93000001-0000-0000-0000-000000000002', '92000001-0000-0000-0000-000000000002', '82000001-0000-0000-0000-000000000003', 'company_owner', true);

insert into company_invitations (id, company_id, email, role, token_hash, expires_at) values
  ('94000001-0000-0000-0000-000000000001', '92000001-0000-0000-0000-000000000001', 'invitee@example.test', 'viewer', 'deadbeef0000000000000000000000000000000000000000000000000000aa', now() + interval '7 days');

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
-- Hardening sweep.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.proname = 'record_invitation_email_event'
      and p.prosecdef
      and exists (
        select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%'
      )
  ) then
    raise exception 'ASSERTION FAILED: record_invitation_email_event must be SECURITY DEFINER with an empty search_path';
  end if;
  raise notice 'OK: record_invitation_email_event is SECURITY DEFINER with an empty search_path';
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'record_invitation_email_event(uuid, text, text, text, text, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon must not be able to execute record_invitation_email_event';
  end if;
  raise notice 'OK: anon cannot execute record_invitation_email_event';
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc where proname = 'record_invitation_email_event'
      and pg_get_function_identity_arguments(oid) = 'p_invitation_id uuid, p_event text, p_masked_recipient text, p_provider_message_id text, p_error_code text'
  ) then
    raise exception 'ASSERTION FAILED: the old 5-arg record_invitation_email_event overload must not still exist (migration 20 must drop it, not merely add a 6-arg overload alongside it)';
  end if;
  raise notice 'OK: only the new 6-arg record_invitation_email_event signature exists';
end;
$$;

-- ---------------------------------------------------------------------------
-- Unauthenticated caller rejected.
-- ---------------------------------------------------------------------------

select test_clear_current_user();
select test_assert_raises(
  'unauthenticated caller cannot record an invitation email event',
  $sql$ select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'sent', 'i***@example.test', 'resend-msg-1', null) $sql$,
  'unauthorized'
);

-- ---------------------------------------------------------------------------
-- Cross-tenant caller rejected: Company B's owner cannot record an event for
-- Company A's invitation.
-- ---------------------------------------------------------------------------

select test_set_current_user('82000001-0000-0000-0000-000000000003');
set local role authenticated;
select test_assert_raises(
  'Company B owner cannot record an email event for Company A''s invitation',
  $sql$ select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'sent', 'i***@example.test', 'resend-msg-1', null) $sql$,
  'permission_denied'
);
reset role;

-- ---------------------------------------------------------------------------
-- Unrelated user (no membership anywhere) rejected.
-- ---------------------------------------------------------------------------

select test_set_current_user('82000001-0000-0000-0000-000000000004');
set local role authenticated;
select test_assert_raises(
  'a user with no membership anywhere cannot record an email event',
  $sql$ select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'sent', 'i***@example.test', 'resend-msg-1', null) $sql$,
  'permission_denied'
);
reset role;

-- ---------------------------------------------------------------------------
-- Invalid p_event value rejected.
-- ---------------------------------------------------------------------------

select test_set_current_user('82000001-0000-0000-0000-000000000002');
set local role authenticated;
select test_assert_raises(
  'an invalid p_event value is rejected',
  $sql$ select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'delivered', 'i***@example.test', 'resend-msg-1', null) $sql$,
  'invalid_event'
);

-- ---------------------------------------------------------------------------
-- Nonexistent invitation id rejected.
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'a nonexistent invitation id is rejected',
  $sql$ select record_invitation_email_event('94000001-0000-0000-0000-000000000099', 'sent', 'i***@example.test', 'resend-msg-1', null) $sql$,
  'invitation_not_found'
);

-- ---------------------------------------------------------------------------
-- Company A's owner (team.manage holder) can record a 'sent' event, which
-- writes a masked-recipient, no-raw-token audit_logs row.
-- ---------------------------------------------------------------------------

select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'sent', 'i***@example.test', 'resend-msg-42', null);
reset role;

do $$
declare
  v_row audit_logs%rowtype;
begin
  select * into v_row from audit_logs
    where company_id = '92000001-0000-0000-0000-000000000001'
      and action = 'invitation_email_sent'
      and target_id = '94000001-0000-0000-0000-000000000001';

  perform test_assert('invitation_email_sent audit row was written', found);
  perform test_assert(
    'the audit row records the masked recipient and provider message id, never a raw token',
    v_row.metadata->>'recipient' = 'i***@example.test'
    and v_row.metadata->>'provider_message_id' = 'resend-msg-42'
    and v_row.metadata->>'error_code' is null
    and (v_row.metadata::text) not like '%deadbeef%'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- A super_admin (no company membership at all) can also record an event --
-- the same dual-authorization path as the invitation RPCs themselves.
-- ---------------------------------------------------------------------------

select test_set_current_user('82000001-0000-0000-0000-000000000001');
set local role authenticated;
select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'failed', 'i***@example.test', null, 'validation_error');
reset role;

do $$
begin
  perform test_assert(
    'super_admin can record an invitation_email_failed event with an error_code',
    exists (
      select 1 from audit_logs
      where company_id = '92000001-0000-0000-0000-000000000001'
        and action = 'invitation_email_failed'
        and target_id = '94000001-0000-0000-0000-000000000001'
        and metadata->>'error_code' = 'validation_error'
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Migration 20: a sanitized error_message and a fixed 'zeptomail' provider
-- tag are recorded alongside error_code, and omitting p_error_message
-- (positional callers unaware of the new trailing parameter) still works.
-- ---------------------------------------------------------------------------

select test_set_current_user('82000001-0000-0000-0000-000000000002');
set local role authenticated;
select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'failed', 'i***@example.test', null, 'http_500', 'ZeptoMail request failed with status 500');
reset role;

do $$
declare
  v_row audit_logs%rowtype;
begin
  select * into v_row from audit_logs
    where company_id = '92000001-0000-0000-0000-000000000001'
      and action = 'invitation_email_failed'
      and target_id = '94000001-0000-0000-0000-000000000001'
      and metadata->>'error_code' = 'http_500';

  perform test_assert('the http_500 audit row was written', found);
  perform test_assert(
    'the audit row records the sanitized error_message and the provider tag',
    v_row.metadata->>'error_message' = 'ZeptoMail request failed with status 500'
    and v_row.metadata->>'provider' = 'zeptomail'
  );
end;
$$;

select test_set_current_user('82000001-0000-0000-0000-000000000002');
set local role authenticated;
select record_invitation_email_event('94000001-0000-0000-0000-000000000001', 'sent', 'i***@example.test', 'resend-msg-99', null);
reset role;

do $$
begin
  perform test_assert(
    'omitting the new trailing p_error_message parameter still succeeds (backward-compatible positional call)',
    exists (
      select 1 from audit_logs
      where company_id = '92000001-0000-0000-0000-000000000001'
        and action = 'invitation_email_sent'
        and target_id = '94000001-0000-0000-0000-000000000001'
        and metadata->>'provider_message_id' = 'resend-msg-99'
        and metadata->>'error_message' is null
    )
  );
end;
$$;

select test_clear_current_user();

rollback;
