-- Dravonix WhatsApp AI Platform
-- Super Admin test-client foundation.
--
-- Adds the minimal schema needed to run the Super Admin dashboard against a
-- real internal demo/test tenant: two nullable profile columns on companies
-- (industry/country -- neither existed before), and a family of
-- SECURITY DEFINER RPCs for every privileged Super Admin mutation (company
-- lifecycle, member management, plan/subscription assignment, entitlement
-- overrides, support-access sessions). Every RPC follows the template
-- established in 00000000000012_human_handover.sql: security definer, empty
-- search_path, fully-qualified names, explicit auth.uid()/role checks, row
-- locking, minimal projection, fixed exception vocabulary, signature-
-- qualified REVOKE/GRANT. No generic "admin update" RPC exists anywhere in
-- this file -- every mutation is its own narrow, single-purpose function.
--
-- Authorization model: these RPCs gate on current_platform_role() =
-- 'super_admin' specifically, not merely is_platform_staff() -- an active
-- platform_support or platform_billing_admin row is NOT sufficient to call
-- any mutation here (raises permission_denied). The two support-access RPCs
-- are the deliberate exception: any active platform staff member may open a
-- time-limited support-access session, matching support_access_sessions'
-- existing purpose.
--
-- Known, deliberately out-of-scope limitation (unchanged by this migration):
-- is_platform_staff() remains OR'd into the SELECT policies of most tenant
-- tables (companies, conversations, messages, etc.), so any active platform
-- staff member -- including platform_support -- still has broad read access
-- today. Narrowing that read surface per platform_role is a separate,
-- larger RLS project, not part of this pass; this migration only ensures no
-- *mutation* introduced here is reachable by a non-super_admin platform
-- role.

-- ---------------------------------------------------------------------------
-- 1. companies: industry / country profile columns (did not exist before).
-- ---------------------------------------------------------------------------

alter table companies
  add column industry text,
  add column country text;

comment on column companies.industry is
  'Free-text industry/vertical label (e.g. "Interior Fit-Out"). Nullable -- optional profile metadata, not required for a company to function.';
comment on column companies.country is
  'Free-text country label (e.g. "India"). Nullable, matching industry -- no ISO-3166 enum exists yet; kept as plain text rather than inventing a separate geography table.';

-- ---------------------------------------------------------------------------
-- 2. Company lifecycle RPCs (create / suspend / reactivate / close).
-- ---------------------------------------------------------------------------

create or replace function admin_create_company(
  p_name text,
  p_industry text default null,
  p_country text default null,
  p_timezone text default 'Asia/Kolkata',
  p_currency text default 'INR',
  p_is_demo boolean default false
)
returns table (id uuid, name text, slug text, status company_status, is_demo boolean,
               industry text, country text, timezone text, default_currency text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_row public.companies%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'invalid_company_name'; end if;

  v_slug := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then v_slug := 'company'; end if;
  if exists (select 1 from public.companies where public.companies.slug = v_slug) then
    v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into public.companies (name, slug, status, is_demo, industry, country, timezone, default_currency)
    values (trim(p_name), v_slug, 'onboarding', p_is_demo, p_industry, p_country,
            coalesce(p_timezone, 'Asia/Kolkata'), coalesce(p_currency, 'INR'))
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_row.id, auth.uid(), 'user', 'company_created', 'company', v_row.id::text,
            jsonb_build_object('name', v_row.name, 'is_demo', v_row.is_demo));

  return query select v_row.id, v_row.name, v_row.slug, v_row.status, v_row.is_demo,
                       v_row.industry, v_row.country, v_row.timezone, v_row.default_currency, v_row.created_at;
end;
$$;

revoke all on function admin_create_company(text, text, text, text, text, boolean) from public, anon;
grant execute on function admin_create_company(text, text, text, text, text, boolean) to authenticated;

create or replace function admin_suspend_company(p_company_id uuid, p_reason text default null)
returns table (id uuid, status company_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.companies%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_row from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if v_row.status = 'closed' then raise exception 'invalid_state_transition'; end if;

  update public.companies set status = 'manually_suspended' where public.companies.id = p_company_id returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'company_suspended', 'company', p_company_id::text,
            jsonb_build_object('reason', p_reason));

  return query select v_row.id, v_row.status;
end;
$$;

revoke all on function admin_suspend_company(uuid, text) from public, anon;
grant execute on function admin_suspend_company(uuid, text) to authenticated;

create or replace function admin_reactivate_company(p_company_id uuid)
returns table (id uuid, status company_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.companies%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_row from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if v_row.status not in ('suspended', 'manually_suspended') then raise exception 'invalid_state_transition'; end if;

  update public.companies set status = 'active' where public.companies.id = p_company_id returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'user', 'company_reactivated', 'company', p_company_id::text);

  return query select v_row.id, v_row.status;
end;
$$;

revoke all on function admin_reactivate_company(uuid) from public, anon;
grant execute on function admin_reactivate_company(uuid) to authenticated;

create or replace function admin_close_company(p_company_id uuid, p_reason text default null)
returns table (id uuid, status company_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.companies%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_row from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if v_row.status = 'closed' then raise exception 'invalid_state_transition'; end if;

  update public.companies set status = 'closed' where public.companies.id = p_company_id returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'company_closed', 'company', p_company_id::text,
            jsonb_build_object('reason', p_reason));

  return query select v_row.id, v_row.status;
end;
$$;

revoke all on function admin_close_company(uuid, text) from public, anon;
grant execute on function admin_close_company(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Member management RPCs. No single-owner enforcement is added: nothing
--    in the existing schema (no partial unique index, no check constraint)
--    requires exactly one company_owner, so multiple owners remain possible,
--    matching the existing product decision (or absence of one) rather than
--    silently inventing a new restriction here.
-- ---------------------------------------------------------------------------

create or replace function admin_invite_company_member(p_company_id uuid, p_email text, p_role company_role)
returns table (id uuid, company_id uuid, user_id uuid, role company_role, is_active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company public.companies%rowtype;
  v_target_user_id uuid;
  v_existing public.company_members%rowtype;
  v_row public.company_members%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_company from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;

  select auth.users.id into v_target_user_id from auth.users where auth.users.email = p_email;
  if v_target_user_id is null then raise exception 'user_not_found'; end if;

  select * into v_existing from public.company_members
    where public.company_members.company_id = p_company_id and public.company_members.user_id = v_target_user_id;

  if found and v_existing.is_active then
    raise exception 'member_already_active';
  elsif found then
    update public.company_members
      set role = p_role, is_active = true, disabled_at = null
      where public.company_members.id = v_existing.id
      returning * into v_row;
  else
    insert into public.company_members (company_id, user_id, role, is_active)
      values (p_company_id, v_target_user_id, p_role, true)
      returning * into v_row;
  end if;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'member_invited', 'company_member', v_row.id::text,
            jsonb_build_object('user_id', v_target_user_id, 'email', p_email, 'role', p_role));

  return query select v_row.id, v_row.company_id, v_row.user_id, v_row.role, v_row.is_active;
end;
$$;

revoke all on function admin_invite_company_member(uuid, text, company_role) from public, anon;
grant execute on function admin_invite_company_member(uuid, text, company_role) to authenticated;

create or replace function admin_change_company_member_role(p_company_id uuid, p_member_id uuid, p_new_role company_role)
returns table (id uuid, role company_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.company_members%rowtype;
  v_old_role public.company_role;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_member from public.company_members
    where public.company_members.id = p_member_id and public.company_members.company_id = p_company_id
    for update;
  if not found then raise exception 'target_member_not_found'; end if;

  v_old_role := v_member.role;
  update public.company_members set role = p_new_role where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'member_role_changed', 'company_member', p_member_id::text,
            jsonb_build_object('old_role', v_old_role, 'new_role', p_new_role));

  return query select v_member.id, v_member.role;
end;
$$;

revoke all on function admin_change_company_member_role(uuid, uuid, company_role) from public, anon;
grant execute on function admin_change_company_member_role(uuid, uuid, company_role) to authenticated;

create or replace function admin_deactivate_company_member(p_company_id uuid, p_member_id uuid)
returns table (id uuid, is_active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.company_members%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_member from public.company_members
    where public.company_members.id = p_member_id and public.company_members.company_id = p_company_id
    for update;
  if not found then raise exception 'target_member_not_found'; end if;

  update public.company_members set is_active = false, disabled_at = now()
    where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'user', 'member_deactivated', 'company_member', p_member_id::text);

  return query select v_member.id, v_member.is_active;
end;
$$;

revoke all on function admin_deactivate_company_member(uuid, uuid) from public, anon;
grant execute on function admin_deactivate_company_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Plans / subscriptions RPCs.
-- ---------------------------------------------------------------------------

create or replace function admin_assign_plan(p_company_id uuid, p_plan_key text)
returns table (company_id uuid, plan_version_id uuid, state subscription_state)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company public.companies%rowtype;
  v_plan_version_id uuid;
  v_sub public.subscriptions%rowtype;
  v_had_existing boolean;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_company from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;

  select pv.id into v_plan_version_id
    from public.plan_versions pv join public.plans p on p.id = pv.plan_id
    where p.key = p_plan_key and p.is_active = true and pv.is_current = true;
  if v_plan_version_id is null then raise exception 'plan_not_found'; end if;

  select * into v_sub from public.subscriptions where public.subscriptions.company_id = p_company_id for update;
  v_had_existing := found;

  if v_had_existing then
    update public.subscriptions set plan_version_id = v_plan_version_id
      where public.subscriptions.company_id = p_company_id returning * into v_sub;
  else
    insert into public.subscriptions (company_id, plan_version_id, state)
      values (p_company_id, v_plan_version_id, 'onboarding')
      returning * into v_sub;
  end if;

  insert into public.subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, notes)
    values (p_company_id, v_sub.id, v_sub.state, v_sub.state, 'plan_assigned', true, auth.uid(), p_plan_key);

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'plan_assigned', 'subscription', v_sub.id::text,
            jsonb_build_object('plan_key', p_plan_key, 'plan_version_id', v_plan_version_id));

  return query select v_sub.company_id, v_sub.plan_version_id, v_sub.state;
end;
$$;

revoke all on function admin_assign_plan(uuid, text) from public, anon;
grant execute on function admin_assign_plan(uuid, text) to authenticated;

create or replace function admin_change_subscription_state(p_company_id uuid, p_new_state subscription_state, p_reason text default null)
returns table (company_id uuid, state subscription_state)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions%rowtype;
  v_old_state public.subscription_state;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  select * into v_sub from public.subscriptions where public.subscriptions.company_id = p_company_id for update;
  if not found then raise exception 'subscription_not_found'; end if;

  v_old_state := v_sub.state;
  update public.subscriptions set state = p_new_state
    where public.subscriptions.company_id = p_company_id returning * into v_sub;

  insert into public.subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, notes)
    values (p_company_id, v_sub.id, v_old_state, p_new_state, 'manual_state_change', true, auth.uid(), p_reason);

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'subscription_changed', 'subscription', v_sub.id::text,
            jsonb_build_object('from_state', v_old_state, 'to_state', p_new_state, 'reason', p_reason));

  return query select v_sub.company_id, v_sub.state;
end;
$$;

revoke all on function admin_change_subscription_state(uuid, subscription_state, text) from public, anon;
grant execute on function admin_change_subscription_state(uuid, subscription_state, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Entitlement override RPC, plus the two production research feature keys
--    (web_research_enabled, research_requests_monthly), seeded onto every
--    existing current plan_version. This only prepares the entitlement data
--    model -- it does NOT change what actually gates the DRAIVA Research
--    staging feature (RESEARCH_STAGING_ENABLED + companies.is_demo remain
--    exactly as they are); wiring production research to read these keys is
--    a separate, later change.
-- ---------------------------------------------------------------------------

insert into plan_entitlements (plan_version_id, feature_key, is_enabled, numeric_limit)
select pv.id, 'web_research_enabled', (p.key in ('business', 'professional')), null
from plan_versions pv join plans p on p.id = pv.plan_id
where pv.is_current = true
on conflict (plan_version_id, feature_key) do nothing;

insert into plan_entitlements (plan_version_id, feature_key, is_enabled, numeric_limit)
select pv.id, 'research_requests_monthly', true,
  case p.key when 'business' then 50 when 'professional' then 200 else 0 end
from plan_versions pv join plans p on p.id = pv.plan_id
where pv.is_current = true
on conflict (plan_version_id, feature_key) do nothing;

create or replace function admin_set_company_entitlement(
  p_company_id uuid,
  p_feature_key text,
  p_is_enabled boolean,
  p_numeric_limit numeric default null,
  p_reason text default null
)
returns table (company_id uuid, feature_key text, is_enabled boolean, numeric_limit numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.company_entitlements%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if p_feature_key is null or length(trim(p_feature_key)) = 0 then raise exception 'invalid_feature_key'; end if;

  insert into public.company_entitlements (company_id, feature_key, is_enabled, numeric_limit, reason, granted_by)
    values (p_company_id, p_feature_key, p_is_enabled, p_numeric_limit, p_reason, auth.uid())
    on conflict on constraint company_entitlements_company_id_feature_key_key do update
      set is_enabled = excluded.is_enabled,
          numeric_limit = excluded.numeric_limit,
          reason = excluded.reason,
          granted_by = excluded.granted_by
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'entitlement_changed', 'company_entitlement', v_row.id::text,
            jsonb_build_object('feature_key', p_feature_key, 'is_enabled', p_is_enabled,
                                'numeric_limit', p_numeric_limit, 'reason', p_reason));

  return query select v_row.company_id, v_row.feature_key, v_row.is_enabled, v_row.numeric_limit;
end;
$$;

revoke all on function admin_set_company_entitlement(uuid, text, boolean, numeric, text) from public, anon;
grant execute on function admin_set_company_entitlement(uuid, text, boolean, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Demo-company billing guard: a company with is_demo=true can never have a
--    real payment-provider subscription id attached, regardless of which
--    code path writes to subscriptions (this RPC family never sets one, but
--    the guard lives at the schema level so it holds for every future write
--    path too, not just this migration's RPCs).
-- ---------------------------------------------------------------------------

create or replace function enforce_demo_company_not_billable() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_demo boolean;
begin
  if new.provider_subscription_id is not null then
    select is_demo into v_is_demo from public.companies where public.companies.id = new.company_id;
    if v_is_demo then
      raise exception 'demo_company_cannot_be_billable';
    end if;
  end if;
  return new;
end;
$$;

create trigger subscriptions_enforce_demo_not_billable
  before insert or update of provider_subscription_id on subscriptions
  for each row execute function enforce_demo_company_not_billable();

-- ---------------------------------------------------------------------------
-- 7. Support-access session RPCs. Any active platform staff member (not just
--    super_admin) may open a time-limited session -- that is the point of
--    support_access_sessions -- but the window is bounded (max 4 hours) and
--    every open/close is audited. Ending early is restricted to the session
--    owner or a super_admin.
-- ---------------------------------------------------------------------------

create or replace function admin_start_support_access(p_company_id uuid, p_reason text, p_duration_minutes integer default 60)
returns table (id uuid, company_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.support_access_sessions%rowtype;
  v_minutes integer;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'reason_required'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  v_minutes := least(greatest(coalesce(p_duration_minutes, 60), 1), 240);

  insert into public.support_access_sessions (company_id, platform_user_id, reason, expires_at)
    values (p_company_id, auth.uid(), p_reason, now() + (v_minutes || ' minutes')::interval)
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'support_access_started', 'support_access_session', v_row.id::text,
            jsonb_build_object('reason', p_reason, 'expires_at', v_row.expires_at));

  return query select v_row.id, v_row.company_id, v_row.expires_at;
end;
$$;

revoke all on function admin_start_support_access(uuid, text, integer) from public, anon;
grant execute on function admin_start_support_access(uuid, text, integer) to authenticated;

create or replace function admin_end_support_access(p_session_id uuid)
returns table (id uuid, ended_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.support_access_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_row from public.support_access_sessions where public.support_access_sessions.id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if v_row.ended_at is not null then raise exception 'session_already_ended'; end if;
  if v_row.platform_user_id <> auth.uid() and public.current_platform_role() is distinct from 'super_admin' then
    raise exception 'permission_denied';
  end if;

  update public.support_access_sessions set ended_at = now()
    where public.support_access_sessions.id = p_session_id returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_row.company_id, auth.uid(), 'user', 'support_access_ended', 'support_access_session', p_session_id::text);

  return query select v_row.id, v_row.ended_at;
end;
$$;

revoke all on function admin_end_support_access(uuid) from public, anon;
grant execute on function admin_end_support_access(uuid) to authenticated;
