-- Client onboarding foundation RLS/RPC hardening tests (migration 18).
-- Run after rls_super_admin.sql (via supabase/tests/run.sh), against the
-- same throwaway local Postgres database -- never a hosted Supabase project.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: one super_admin, one company with an owner (team.manage) and a
-- viewer (no team.manage), a second company for cross-tenant checks, and an
-- unrelated user with no membership anywhere.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('80000001-0000-0000-0000-000000000001', 'super-admin@example.test'),
  ('80000001-0000-0000-0000-000000000002', 'owner-a@example.test'),
  ('80000001-0000-0000-0000-000000000003', 'viewer-a@example.test'),
  ('80000001-0000-0000-0000-000000000004', 'owner-b@example.test'),
  ('80000001-0000-0000-0000-000000000005', 'unrelated@example.test'),
  ('80000001-0000-0000-0000-000000000006', 'new-teammate@example.test');

insert into platform_members (user_id, role, is_active) values
  ('80000001-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('90000001-0000-0000-0000-000000000001', 'Onboard Co A', 'onboard-co-a', 'active', true),
  ('90000001-0000-0000-0000-000000000002', 'Onboard Co B', 'onboard-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('91000001-0000-0000-0000-000000000001', '90000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000002', 'company_owner', true),
  ('91000001-0000-0000-0000-000000000002', '90000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000003', 'viewer', true),
  ('91000001-0000-0000-0000-000000000003', '90000001-0000-0000-0000-000000000002', '80000001-0000-0000-0000-000000000004', 'company_owner', true);

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
declare
  fn text;
  fns text[] := array[
    'create_company_invitation', 'admin_resend_company_invitation', 'admin_revoke_company_invitation',
    'accept_company_invitation', 'company_change_member_role', 'company_deactivate_member',
    'update_company_profile', 'list_company_member_identities', 'update_user_display_name',
    'admin_update_user_display_name'
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
-- 1. Super admin can invite a company owner. Tenant-bound, audited.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('80000001-0000-0000-0000-000000000001'); -- super_admin

do $$
declare
  v_invitation_id uuid;
  v_expires timestamptz;
  v_token text;
begin
  select id, expires_at, raw_token into v_invitation_id, v_expires, v_token
    from create_company_invitation('90000001-0000-0000-0000-000000000001', 'New-Teammate@Example.test', 'company_admin');

  perform test_assert('create_company_invitation returns a real invitation id', v_invitation_id is not null);
  perform test_assert('create_company_invitation returns a non-empty raw token', v_token is not null and length(v_token) > 0);
  perform test_assert(
    'the invitation email is normalized to lowercase',
    (select email from company_invitations where id = v_invitation_id) = 'new-teammate@example.test'
  );
  perform test_assert(
    'member_invited audit row was written, tenant-scoped to the invited company',
    exists (select 1 from audit_logs where company_id = '90000001-0000-0000-0000-000000000001' and action = 'member_invited' and target_id = v_invitation_id::text)
  );

  create temporary table t_invitation (id uuid, token text);
  insert into t_invitation values (v_invitation_id, v_token);
end;
$$;

grant select on t_invitation to anon;

-- get_invitation_preview is deliberately anon-callable (a visitor has no
-- session yet when they open an accept-invite link).
reset role;
set local role anon;
select test_clear_current_user();

select test_assert(
  'anon can preview a real invitation by token -- company name, email, role, status only',
  (select company_name from get_invitation_preview((select token from t_invitation))) = 'Onboard Co A'
  and (select status from get_invitation_preview((select token from t_invitation))) = 'pending'
);

select test_assert(
  'get_invitation_preview returns no row for a bogus token',
  not exists (select 1 from get_invitation_preview('not-a-real-token'))
);

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 2 & 3. Accepting the invitation is tenant-bound and requires a matching
-- authenticated email -- the invited user then has real, company-scoped
-- access (verified by resolving into exactly the right company).
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'a different authenticated user (email does not match the invitation) cannot accept it',
  $sql$ select accept_company_invitation((select token from t_invitation)) $sql$,
  'email_mismatch'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000005')) _; -- unrelated user

select test_set_current_user('80000001-0000-0000-0000-000000000006'); -- new-teammate, matches invitation email

do $$
declare
  v_company_id uuid;
  v_role company_role;
begin
  select company_id, role into v_company_id, v_role from accept_company_invitation((select token from t_invitation));
  perform test_assert(
    'the matching invited user can accept and is resolved into exactly the invited company with the invited role',
    v_company_id = '90000001-0000-0000-0000-000000000001' and v_role = 'company_admin'
  );
end;
$$;

-- A genuinely repeated attempt against the same (now-accepted) token
-- confirms it is rejected, not silently re-processed.
select test_assert_raises(
  'accepting an already-accepted invitation a second time is rejected',
  $sql$ select accept_company_invitation((select token from t_invitation)) $sql$,
  'invitation_not_pending'
);

select test_assert(
  'the accepted teammate now has an active company_members row scoped to the invited company only',
  exists (
    select 1 from company_members
    where user_id = '80000001-0000-0000-0000-000000000006' and company_id = '90000001-0000-0000-0000-000000000001'
      and role = 'company_admin' and is_active = true
  )
);

select test_assert(
  'the accepted teammate has no membership in the unrelated Company B',
  not exists (select 1 from company_members where user_id = '80000001-0000-0000-0000-000000000006' and company_id = '90000001-0000-0000-0000-000000000002')
);

select test_assert(
  'member_activated audit row exists for the accepted teammate',
  exists (select 1 from audit_logs where action = 'member_activated' and company_id = '90000001-0000-0000-0000-000000000001')
);

-- ---------------------------------------------------------------------------
-- 4/5/6. Cross-tenant and permission rejections.
-- ---------------------------------------------------------------------------

select test_set_current_user('80000001-0000-0000-0000-000000000004'); -- owner of Company B

select test_assert_raises(
  'Company B''s owner cannot change a Company A member''s role (cross-tenant rejected)',
  $sql$ select company_change_member_role('91000001-0000-0000-0000-000000000001', 'viewer') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'Company B''s owner cannot invite into Company A (cross-tenant rejected)',
  $sql$ select create_company_invitation('90000001-0000-0000-0000-000000000001', 'someone@example.test', 'agent') $sql$,
  'permission_denied'
);

select test_set_current_user('80000001-0000-0000-0000-000000000003'); -- viewer in Company A, no team.manage

select test_assert_raises(
  'a viewer cannot invite a member (no team.manage)',
  $sql$ select create_company_invitation('90000001-0000-0000-0000-000000000001', 'someone@example.test', 'agent') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'a viewer cannot change another member''s role',
  $sql$ select company_change_member_role('91000001-0000-0000-0000-000000000001', 'viewer') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'a viewer cannot edit the company profile (no settings.manage)',
  $sql$ select update_company_profile('90000001-0000-0000-0000-000000000001', 'New Name', null, null) $sql$,
  'permission_denied'
);

-- Revoked-member rejection: deactivate the viewer, then confirm their own
-- has_company_permission-gated call now fails too (is_active=false is
-- excluded by has_company_permission's own definition).
reset role;
update company_members set is_active = false where id = '91000001-0000-0000-0000-000000000002';
set local role authenticated;
select test_set_current_user('80000001-0000-0000-0000-000000000003');

select test_assert_raises(
  'a revoked (is_active=false) member is rejected the same as a non-member',
  $sql$ select update_company_profile('90000001-0000-0000-0000-000000000001', 'New Name', null, null) $sql$,
  'permission_denied'
);

reset role;
update company_members set is_active = true where id = '91000001-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- 7. Owner can edit allowed company profile fields; is_demo/status/plan/
-- entitlements remain out of reach by construction (no such RPC parameter
-- exists) and via the existing super_admin-only gates.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('80000001-0000-0000-0000-000000000002'); -- owner of Company A

select test_assert(
  'the owner can update their own company''s name/industry/country',
  (select name from update_company_profile('90000001-0000-0000-0000-000000000001', 'Onboard Co A Renamed', 'Interior Fit-Out', 'India')) = 'Onboard Co A Renamed'
);

select test_assert(
  'company_profile_changed audit row was written',
  exists (select 1 from audit_logs where company_id = '90000001-0000-0000-0000-000000000001' and action = 'company_profile_changed')
);

select test_assert(
  'is_demo is untouched by update_company_profile -- it has no parameter for it',
  (select is_demo from companies where id = '90000001-0000-0000-0000-000000000001') = true
);

-- 9/10: owner cannot assign a plan or alter entitlements -- those remain
-- migration-17 Super Admin-only RPCs, unchanged by this migration.
select test_assert_raises(
  'a company owner cannot assign a plan (Super Admin only)',
  $sql$ select admin_assign_plan('90000001-0000-0000-0000-000000000001', 'starter') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'a company owner cannot set a platform entitlement override (Super Admin only)',
  $sql$ select admin_set_company_entitlement('90000001-0000-0000-0000-000000000001', 'web_research_enabled', true, null, 'x') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 11. Knowledge sources: owner/admin can manage (insert/update/delete) via
-- the existing knowledge.manage RLS policy -- no new RPC, direct writes.
-- ---------------------------------------------------------------------------

do $$
declare
  v_source_id uuid;
begin
  insert into knowledge_sources (company_id, source_type, title)
    values ('90000001-0000-0000-0000-000000000001', 'faq', 'Test FAQ')
    returning id into v_source_id;

  perform test_assert('owner can insert a knowledge source into their own company', v_source_id is not null);
  perform test_assert(
    'knowledge_source_added audit row was written',
    exists (select 1 from audit_logs where action = 'knowledge_source_added' and target_id = v_source_id::text)
  );

  update knowledge_sources set is_enabled = false where id = v_source_id;
  perform test_assert(
    'knowledge_source_changed audit row was written on update',
    exists (select 1 from audit_logs where action = 'knowledge_source_changed' and target_id = v_source_id::text)
  );

  delete from knowledge_sources where id = v_source_id;
  perform test_assert(
    'knowledge_source_removed audit row was written on delete',
    exists (select 1 from audit_logs where action = 'knowledge_source_removed' and target_id = v_source_id::text)
  );
end;
$$;

select test_set_current_user('80000001-0000-0000-0000-000000000004'); -- owner of Company B, no knowledge.manage on Company A

select test_assert_raises(
  'Company B''s owner cannot insert a knowledge source into Company A (cross-tenant rejected by RLS)',
  $sql$ insert into knowledge_sources (company_id, source_type, title) values ('90000001-0000-0000-0000-000000000001', 'faq', 'Cross-tenant attempt') $sql$,
  'new row violates row-level security policy for table "knowledge_sources"'
);

-- ---------------------------------------------------------------------------
-- ai_settings / company_settings writes are also audited via trigger.
-- ---------------------------------------------------------------------------

select test_set_current_user('80000001-0000-0000-0000-000000000002'); -- owner of Company A

do $$
begin
  insert into ai_settings (company_id, reply_length) values ('90000001-0000-0000-0000-000000000001', 'short')
    on conflict (company_id) do update set reply_length = excluded.reply_length;
  perform test_assert(
    'ai_settings_changed audit row was written',
    exists (select 1 from audit_logs where company_id = '90000001-0000-0000-0000-000000000001' and action = 'ai_settings_changed')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. admin_resend_company_invitation rotates the token/expiry each call and
-- is rejected once the invitation is no longer pending -- the only
-- server-side guard behind the Super Admin / Team Settings "Resend" button
-- (diagnosed: the button itself previously discarded this RPC's result and
-- showed no feedback either way, fixed in apps/web/components/InvitationActions.tsx;
-- this proves the RPC it calls is itself correct).
-- ---------------------------------------------------------------------------

do $$
declare
  v_invitation_id uuid;
  v_first_token text;
  v_first_hash text;
  v_second_token text;
  v_second_hash text;
  v_expires_before timestamptz;
  v_expires_after timestamptz;
begin
  select id, raw_token into v_invitation_id, v_first_token
    from create_company_invitation('90000001-0000-0000-0000-000000000001', 'resend-target@example.test', 'viewer');

  select token_hash, expires_at into v_first_hash, v_expires_before
    from company_invitations where id = v_invitation_id;

  select expires_at, raw_token into v_expires_after, v_second_token
    from admin_resend_company_invitation(v_invitation_id);

  select token_hash into v_second_hash from company_invitations where id = v_invitation_id;

  perform test_assert(
    'admin_resend_company_invitation issues a new raw token, different from the original',
    v_second_token is not null and v_second_token <> v_first_token
  );
  perform test_assert(
    'the stored token_hash changes on resend -- the previous token is invalidated, not merely re-issued',
    v_second_hash <> v_first_hash
  );
  -- now() is frozen for the lifetime of this transaction, so both calls'
  -- `now() + interval '7 days'` land on the identical instant here --
  -- >= (not >) is the correct, transaction-safe invariant to check.
  perform test_assert('resend does not move expires_at backward', v_expires_after >= v_expires_before);
  perform test_assert(
    'invitation_resent audit row was written',
    exists (select 1 from audit_logs where action = 'invitation_resent' and target_id = v_invitation_id::text)
  );

  perform admin_revoke_company_invitation(v_invitation_id);
end;
$$;

select test_assert_raises(
  'resending a revoked (non-pending) invitation is rejected -- Resend has no effect once an invitation is no longer pending',
  $sql$ select admin_resend_company_invitation((select id from company_invitations where email = 'resend-target@example.test')) $sql$,
  'invitation_not_pending'
);

-- ---------------------------------------------------------------------------
-- 13. list_company_member_identities (human-friendly Users & Roles / Team
-- page display) mirrors the exact visibility boundary of the existing
-- company_members_select_same_company RLS policy -- same-company member or
-- platform staff, never a cross-tenant read.
-- ---------------------------------------------------------------------------

select test_set_current_user('80000001-0000-0000-0000-000000000002'); -- owner-a, Company A

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from list_company_member_identities('90000001-0000-0000-0000-000000000001')
    where email = 'owner-a@example.test';

  perform test_assert(
    'Company A owner resolves their own email for Company A''s member list',
    v_count = 1
  );
end;
$$;

select test_set_current_user('80000001-0000-0000-0000-000000000004'); -- owner-b, Company B

do $$
declare
  v_count int;
begin
  select count(*) into v_count from list_company_member_identities('90000001-0000-0000-0000-000000000001');

  perform test_assert(
    'Company B owner gets zero rows querying Company A''s member identities (cross-tenant read denied)',
    v_count = 0
  );
end;
$$;

select test_set_current_user('80000001-0000-0000-0000-000000000001'); -- super_admin, no membership anywhere

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from list_company_member_identities('90000001-0000-0000-0000-000000000001')
    where email = 'owner-a@example.test';

  perform test_assert(
    'Platform staff can resolve member identities for a company they are not a member of',
    v_count = 1
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Editable display names (update_user_display_name /
-- admin_update_user_display_name). Fixtures reused: owner-a (company_owner,
-- Company A), viewer-a (viewer, Company A -- no team.manage), new-teammate
-- (company_admin, Company A, accepted earlier in this file), owner-b
-- (company_owner, Company B), super_admin, and unrelated (no membership
-- anywhere).
-- ---------------------------------------------------------------------------

select test_set_current_user('80000001-0000-0000-0000-000000000002'); -- owner-a, Company A

do $$
declare
  v_member_id uuid;
  v_display_name_before text;
  v_name text;
begin
  -- user_profiles has no cross-user SELECT policy (see the migration's own
  -- comment: every cross-user read goes through list_company_member_identities
  -- so the company-membership/platform-staff boundary is enforced in one
  -- place) -- so "no profile row yet" is observed the same way the app
  -- observes it, through that RPC, not a direct table query.
  v_member_id := (select id from company_members where user_id = '80000001-0000-0000-0000-000000000003');
  select display_name into v_display_name_before
    from list_company_member_identities('90000001-0000-0000-0000-000000000001')
    where member_id = v_member_id;
  perform test_assert('no display name is set for viewer-a before the first edit (lazy creation, not backfilled)', v_display_name_before is null);

  select display_name into v_name from update_user_display_name('80000001-0000-0000-0000-000000000003', 'Viewer A Name');
  perform test_assert('company owner can set a member display name in their own company', v_name = 'Viewer A Name');

  perform test_assert(
    'the shared identity lookup RPC now resolves the newly-created display name (lazy creation confirmed via the authorized read path)',
    (select display_name from list_company_member_identities('90000001-0000-0000-0000-000000000001') where member_id = v_member_id) = 'Viewer A Name'
  );
  perform test_assert(
    'the edit did not change viewer-a''s auth.users.email',
    (select email from auth.users where id = '80000001-0000-0000-0000-000000000003') = 'viewer-a@example.test'
  );
  perform test_assert(
    'the edit did not change viewer-a''s company role or membership',
    exists (select 1 from company_members where user_id = '80000001-0000-0000-0000-000000000003' and company_id = '90000001-0000-0000-0000-000000000001' and role = 'viewer' and is_active = true)
  );
  perform test_assert(
    'user_display_name_changed audit row was written for the admin edit, actor-attributed and not a self-edit',
    exists (
      select 1 from audit_logs
      where action = 'user_display_name_changed' and target_id = '80000001-0000-0000-0000-000000000003'
        and actor_user_id = '80000001-0000-0000-0000-000000000002'
        and (metadata->>'self_edit')::boolean = false
    )
  );
end;
$$;

select test_set_current_user('80000001-0000-0000-0000-000000000006'); -- new-teammate, company_admin, Company A

do $$
declare
  v_name text;
begin
  select display_name into v_name from update_user_display_name('80000001-0000-0000-0000-000000000003', '  Renée O''Malley-García  ');
  perform test_assert('company admin can also set a member display name in their own company', v_name = 'Renée O''Malley-García');
  perform test_assert('the stored name is trimmed and accepts non-English/Unicode characters unchanged', v_name = 'Renée O''Malley-García');
end;
$$;

select test_set_current_user('80000001-0000-0000-0000-000000000003'); -- viewer-a, no team.manage

select test_assert_raises(
  'a viewer (no team.manage) cannot rename another member',
  $sql$ select update_user_display_name('80000001-0000-0000-0000-000000000002', 'Hijacked Name') $sql$,
  'permission_denied'
);

do $$
declare
  v_name text;
begin
  select display_name into v_name from update_user_display_name('80000001-0000-0000-0000-000000000003', 'My Own Name');
  perform test_assert('a user without team.manage can still edit their own display name (self-edit bypass)', v_name = 'My Own Name');
end;
$$;

select test_assert_raises(
  'an empty display name is rejected',
  $sql$ select update_user_display_name('80000001-0000-0000-0000-000000000003', '   ') $sql$,
  'invalid_display_name'
);

select test_assert_raises(
  'an overlong display name (>150 chars) is rejected',
  $sql$ select update_user_display_name('80000001-0000-0000-0000-000000000003', repeat('x', 151)) $sql$,
  'display_name_too_long'
);

select test_set_current_user('80000001-0000-0000-0000-000000000004'); -- owner-b, Company B

select test_assert_raises(
  'cross-tenant name edit is rejected -- Company B''s owner cannot rename a Company A member',
  $sql$ select update_user_display_name('80000001-0000-0000-0000-000000000003', 'Cross Tenant Rename') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'a company owner (not platform staff) cannot call the Super Admin-only admin_update_user_display_name RPC',
  $sql$ select admin_update_user_display_name('80000001-0000-0000-0000-000000000003', 'Should Not Work') $sql$,
  'permission_denied'
);

select test_set_current_user('80000001-0000-0000-0000-000000000001'); -- super_admin

do $$
declare
  v_name text;
begin
  select display_name into v_name from admin_update_user_display_name('80000001-0000-0000-0000-000000000003', 'Renamed By Admin');
  perform test_assert('Super Admin can rename any DRAIVA member via the dedicated admin RPC', v_name = 'Renamed By Admin');
  perform test_assert(
    'the Super Admin edit is audited as a platform_staff actor, not a self-edit',
    exists (
      select 1 from audit_logs
      where action = 'user_display_name_changed' and target_id = '80000001-0000-0000-0000-000000000003'
        and actor_type = 'platform_staff' and actor_user_id = '80000001-0000-0000-0000-000000000001'
        and (metadata->>'self_edit')::boolean = false
    )
  );
end;
$$;

select test_assert_raises(
  'renaming a nonexistent user is rejected',
  $sql$ select admin_update_user_display_name('00000000-0000-0000-0000-000000000999', 'Nobody') $sql$,
  'target_user_not_found'
);

reset role;

rollback;
