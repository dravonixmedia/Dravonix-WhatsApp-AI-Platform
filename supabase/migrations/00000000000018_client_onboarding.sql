-- Dravonix WhatsApp AI Platform
-- Client onboarding foundation: secure company-owner/team invitations, a
-- narrow company-profile-only RPC, company-scoped team-management RPCs, and
-- audit triggers on the settings/knowledge tables that already accept direct
-- authenticated writes via RLS (company_settings, ai_settings,
-- voice_settings, knowledge_sources) so those writes are audited without
-- being converted into new RPCs.
--
-- No new auth/RBAC system: every RPC here authorizes via the existing
-- current_platform_role()/has_company_permission()/is_company_member()
-- helpers (00000000000002_core_tenancy.sql), the existing company_role enum,
-- and the existing 'team.manage'/'settings.manage' permission keys. No
-- generic "admin update" RPC.

-- ---------------------------------------------------------------------------
-- 1. company_invitations: durable, token-based invite records. The raw token
--    is returned once (by create/resend) and never stored -- only its SHA-256
--    hash is persisted, matching how a password reset link is handled by
--    Supabase Auth itself. No email is sent by this migration or any RPC
--    here; the raw token is the caller's responsibility to deliver out of
--    band (see apps/web's Server Actions).
-- ---------------------------------------------------------------------------

create type company_invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table company_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  email text not null,
  role company_role not null,
  token_hash text not null unique,
  status company_invitation_status not null default 'pending',
  invited_by uuid references auth.users (id),
  accepted_by_user_id uuid references auth.users (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index company_invitations_company_id_idx on company_invitations (company_id);
-- At most one pending invitation per (company, email) at a time -- resending
-- rotates the existing row's token rather than creating a duplicate.
create unique index company_invitations_pending_email_uq
  on company_invitations (company_id, lower(email))
  where status = 'pending';

comment on column company_invitations.token_hash is
  'sha256(raw token), hex-encoded. The raw token itself is never stored -- create_company_invitation and admin_resend_company_invitation return it exactly once to the caller, the same pattern Supabase Auth uses for its own recovery links.';
comment on column company_invitations.email is
  'The invited address, matched case-insensitively against the accepting Auth user''s own auth.users.email inside accept_company_invitation -- email alone never grants access; a real authenticated session with a matching address is required.';

alter table company_invitations enable row level security;

create policy company_invitations_select_member on company_invitations
  for select
  using (has_company_permission(company_id, 'team.manage') or is_platform_staff());

-- ---------------------------------------------------------------------------
-- 2. Invitation RPCs. create/revoke/resend are dual-authorized: a super_admin
--    (bootstrapping a brand new company's first owner, before any team.manage
--    holder exists) or an existing team.manage holder of that same company
--    (inviting a teammate). accept is authenticated-only and re-verifies the
--    caller's own email against the invitation before creating/reactivating
--    membership.
-- ---------------------------------------------------------------------------

create or replace function create_company_invitation(p_company_id uuid, p_email text, p_role company_role)
returns table (id uuid, invitation_email text, role company_role, expires_at timestamptz, raw_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.company_invitations%rowtype;
  v_token text;
  v_normalized_email text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' and not public.has_company_permission(p_company_id, 'team.manage') then
    raise exception 'permission_denied';
  end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  v_normalized_email := lower(trim(p_email));
  if v_normalized_email is null or v_normalized_email = '' or v_normalized_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email';
  end if;

  if exists (
    select 1 from public.company_members cm
    join auth.users u on u.id = cm.user_id
    where cm.company_id = p_company_id and cm.is_active = true and lower(u.email) = v_normalized_email
  ) then
    raise exception 'member_already_active';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.company_invitations (company_id, email, role, token_hash, invited_by, expires_at)
    values (p_company_id, v_normalized_email, p_role, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(), now() + interval '7 days')
    on conflict (company_id, lower(email)) where status = 'pending' do update
      set role = excluded.role,
          token_hash = excluded.token_hash,
          invited_by = excluded.invited_by,
          expires_at = excluded.expires_at,
          created_at = now()
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'member_invited', 'company_invitation', v_row.id::text,
            jsonb_build_object('email', v_normalized_email, 'role', p_role));

  return query select v_row.id, v_row.email, v_row.role, v_row.expires_at, v_token;
end;
$$;

comment on function create_company_invitation(uuid, text, company_role) is
  'Returns table column is named invitation_email (not email) to avoid a plpgsql bare-identifier ambiguity against the ON CONFLICT (company_id, lower(email)) target above -- the RETURN QUERY SELECT list still assigns v_row.email into that position positionally.';

revoke all on function create_company_invitation(uuid, text, company_role) from public, anon;
grant execute on function create_company_invitation(uuid, text, company_role) to authenticated;

create or replace function admin_resend_company_invitation(p_invitation_id uuid)
returns table (id uuid, expires_at timestamptz, raw_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.company_invitations%rowtype;
  v_token text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_row from public.company_invitations where public.company_invitations.id = p_invitation_id for update;
  if not found then raise exception 'invitation_not_found'; end if;
  if public.current_platform_role() is distinct from 'super_admin' and not public.has_company_permission(v_row.company_id, 'team.manage') then
    raise exception 'permission_denied';
  end if;
  if v_row.status <> 'pending' then raise exception 'invitation_not_pending'; end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  update public.company_invitations
    set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
        expires_at = now() + interval '7 days'
    where public.company_invitations.id = p_invitation_id
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_row.company_id, auth.uid(), 'user', 'invitation_resent', 'company_invitation', p_invitation_id::text);

  return query select v_row.id, v_row.expires_at, v_token;
end;
$$;

revoke all on function admin_resend_company_invitation(uuid) from public, anon;
grant execute on function admin_resend_company_invitation(uuid) to authenticated;

create or replace function admin_revoke_company_invitation(p_invitation_id uuid)
returns table (id uuid, status company_invitation_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.company_invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_row from public.company_invitations where public.company_invitations.id = p_invitation_id for update;
  if not found then raise exception 'invitation_not_found'; end if;
  if public.current_platform_role() is distinct from 'super_admin' and not public.has_company_permission(v_row.company_id, 'team.manage') then
    raise exception 'permission_denied';
  end if;
  if v_row.status <> 'pending' then raise exception 'invitation_not_pending'; end if;

  update public.company_invitations set status = 'revoked' where public.company_invitations.id = p_invitation_id returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_row.company_id, auth.uid(), 'user', 'invitation_revoked', 'company_invitation', p_invitation_id::text);

  return query select v_row.id, v_row.status;
end;
$$;

revoke all on function admin_revoke_company_invitation(uuid) from public, anon;
grant execute on function admin_revoke_company_invitation(uuid) to authenticated;

-- accept_company_invitation: the only step that ever creates/reactivates a
-- company_members row from an invitation. Requires BOTH a real authenticated
-- session (auth.uid() not null) AND that session's own auth.users.email to
-- match the invitation's email, case-insensitively -- an invitation token
-- alone, without a matching authenticated identity, grants nothing.
create or replace function accept_company_invitation(p_token text)
returns table (company_id uuid, role company_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.company_invitations%rowtype;
  v_caller_email text;
  v_existing public.company_members%rowtype;
  v_member public.company_members%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_invitation from public.company_invitations
    where public.company_invitations.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    for update;
  if not found then raise exception 'invitation_not_found'; end if;
  if v_invitation.status <> 'pending' then raise exception 'invitation_not_pending'; end if;
  if v_invitation.expires_at < now() then
    update public.company_invitations set status = 'expired' where public.company_invitations.id = v_invitation.id;
    raise exception 'invitation_expired';
  end if;

  select auth.users.email into v_caller_email from auth.users where auth.users.id = auth.uid();
  if v_caller_email is null or lower(v_caller_email) <> v_invitation.email then
    raise exception 'email_mismatch';
  end if;

  select * into v_existing from public.company_members
    where public.company_members.company_id = v_invitation.company_id and public.company_members.user_id = auth.uid();

  if found then
    update public.company_members
      set role = v_invitation.role, is_active = true, disabled_at = null
      where public.company_members.id = v_existing.id
      returning * into v_member;
  else
    insert into public.company_members (company_id, user_id, role, is_active)
      values (v_invitation.company_id, auth.uid(), v_invitation.role, true)
      returning * into v_member;
  end if;

  update public.company_invitations
    set status = 'accepted', accepted_at = now(), accepted_by_user_id = auth.uid()
    where public.company_invitations.id = v_invitation.id;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_invitation.company_id, auth.uid(), 'user', 'member_activated', 'company_member', v_member.id::text,
            jsonb_build_object('invitation_id', v_invitation.id, 'role', v_invitation.role));

  return query select v_member.company_id, v_member.role;
end;
$$;

revoke all on function accept_company_invitation(text) from public, anon;
grant execute on function accept_company_invitation(text) to authenticated;

-- get_invitation_preview: the one deliberately anon-callable function in
-- this migration -- a visitor arriving at the accept-invite page has no
-- session yet, so rendering "join <company> as <role>" before sign-in/sign-up
-- requires a read that doesn't depend on auth.uid(). Discloses only the
-- company name, invited email, role, status, and expiry -- never any other
-- company data -- and only for a token that hashes to a real row.
create or replace function get_invitation_preview(p_token text)
returns table (company_name text, invitation_email text, role company_role, status company_invitation_status, expires_at timestamptz)
language sql
security definer
stable
set search_path = ''
as $$
  select c.name, ci.email, ci.role, ci.status, ci.expires_at
  from public.company_invitations ci
  join public.companies c on c.id = ci.company_id
  where ci.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

revoke all on function get_invitation_preview(text) from public;
grant execute on function get_invitation_preview(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Company-scoped team-management RPCs (team.manage permission), distinct
--    from the Super Admin RPCs in migration 17 -- these authorize via the
--    caller's own company membership/permission, never via platform_role.
-- ---------------------------------------------------------------------------

create or replace function company_change_member_role(p_member_id uuid, p_new_role company_role)
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

  select * into v_member from public.company_members where public.company_members.id = p_member_id for update;
  if not found then raise exception 'target_member_not_found'; end if;
  if not public.has_company_permission(v_member.company_id, 'team.manage') then raise exception 'permission_denied'; end if;

  v_old_role := v_member.role;
  update public.company_members set role = p_new_role where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_member.company_id, auth.uid(), 'user', 'member_role_changed', 'company_member', p_member_id::text,
            jsonb_build_object('old_role', v_old_role, 'new_role', p_new_role));

  return query select v_member.id, v_member.role;
end;
$$;

revoke all on function company_change_member_role(uuid, company_role) from public, anon;
grant execute on function company_change_member_role(uuid, company_role) to authenticated;

create or replace function company_deactivate_member(p_member_id uuid)
returns table (id uuid, is_active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.company_members%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_member from public.company_members where public.company_members.id = p_member_id for update;
  if not found then raise exception 'target_member_not_found'; end if;
  if not public.has_company_permission(v_member.company_id, 'team.manage') then raise exception 'permission_denied'; end if;

  update public.company_members set is_active = false, disabled_at = now()
    where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_member.company_id, auth.uid(), 'user', 'member_deactivated', 'company_member', p_member_id::text);

  return query select v_member.id, v_member.is_active;
end;
$$;

revoke all on function company_deactivate_member(uuid) from public, anon;
grant execute on function company_deactivate_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. update_company_profile: the only write path a company user has to the
--    companies row -- name/industry/country only, by construction (no
--    parameter exists for is_demo, status, timezone, or default_currency;
--    those keep their own existing RPCs/remain Super Admin-only).
-- ---------------------------------------------------------------------------

create or replace function update_company_profile(p_company_id uuid, p_name text, p_industry text, p_country text)
returns table (id uuid, name text, industry text, country text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.companies%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.has_company_permission(p_company_id, 'settings.manage') then raise exception 'permission_denied'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'invalid_company_name'; end if;

  update public.companies
    set name = trim(p_name), industry = p_industry, country = p_country
    where public.companies.id = p_company_id
    returning * into v_row;
  if not found then raise exception 'company_not_found'; end if;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'user', 'company_profile_changed', 'company', p_company_id::text);

  return query select v_row.id, v_row.name, v_row.industry, v_row.country;
end;
$$;

revoke all on function update_company_profile(uuid, text, text, text) from public, anon;
grant execute on function update_company_profile(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Audit triggers for the settings/knowledge tables that already accept
--    direct authenticated writes via their own RLS policies (company_settings,
--    ai_settings, voice_settings, knowledge_sources) -- these were never
--    converted into RPCs (their existing "for all" RLS policies already gate
--    writes on the same permission an RPC would check), so a lightweight
--    AFTER trigger is how their changes reach audit_logs. auth.uid() is used
--    directly (these run in the same authenticated request that performed
--    the write, so it always reflects the real actor); a null actor (e.g. a
--    service-role write) is recorded as such rather than guessed.
-- ---------------------------------------------------------------------------

create or replace function audit_company_settings_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (new.company_id, auth.uid(), case when auth.uid() is null then 'system' else 'user' end,
            'company_settings_changed', 'company_settings', new.company_id::text);
  return new;
end;
$$;

create trigger company_settings_audit_change
  after update on company_settings
  for each row execute function audit_company_settings_change();

create or replace function audit_ai_settings_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (new.company_id, auth.uid(), case when auth.uid() is null then 'system' else 'user' end,
            'ai_settings_changed', 'ai_settings', new.company_id::text);
  return new;
end;
$$;

create trigger ai_settings_audit_change
  after insert or update on ai_settings
  for each row execute function audit_ai_settings_change();

create trigger voice_settings_audit_change
  after insert or update on voice_settings
  for each row execute function audit_ai_settings_change();

create or replace function audit_knowledge_source_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_id uuid;
  v_action text;
begin
  if tg_op = 'DELETE' then
    v_company_id := old.company_id;
    v_id := old.id;
    v_action := 'knowledge_source_removed';
  elsif tg_op = 'INSERT' then
    v_company_id := new.company_id;
    v_id := new.id;
    v_action := 'knowledge_source_added';
  else
    v_company_id := new.company_id;
    v_id := new.id;
    v_action := 'knowledge_source_changed';
  end if;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_company_id, auth.uid(), case when auth.uid() is null then 'system' else 'user' end,
            v_action, 'knowledge_source', v_id::text);

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger knowledge_sources_audit_change
  after insert or update or delete on knowledge_sources
  for each row execute function audit_knowledge_source_change();

-- ---------------------------------------------------------------------------
-- 6. Every company needs a company_settings/ai_settings/voice_settings row
--    before its own owner can ever save AI Settings for the first time:
--    company_settings only has an UPDATE RLS policy (migration 2), never
--    INSERT, so a company with no such row (every company created by
--    admin_create_company before this migration, including the existing
--    DRAIVA Test Client) would hit a bare RLS violation on first save.
--    admin_create_company is redefined here (CREATE OR REPLACE against the
--    same signature migration 17 already deployed) to insert all three
--    default rows atomically at creation time going forward; the backfill
--    below is a one-time, idempotent fix for companies that already exist.
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

  insert into public.company_settings (company_id) values (v_row.id);
  insert into public.ai_settings (company_id) values (v_row.id);
  insert into public.voice_settings (company_id) values (v_row.id);

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_row.id, auth.uid(), 'user', 'company_created', 'company', v_row.id::text,
            jsonb_build_object('name', v_row.name, 'is_demo', v_row.is_demo));

  return query select v_row.id, v_row.name, v_row.slug, v_row.status, v_row.is_demo,
                       v_row.industry, v_row.country, v_row.timezone, v_row.default_currency, v_row.created_at;
end;
$$;

-- Idempotent backfill for any company (e.g. the existing DRAIVA Test Client)
-- created before this migration redefined admin_create_company above.
insert into company_settings (company_id)
select c.id from companies c
where not exists (select 1 from company_settings cs where cs.company_id = c.id);

insert into ai_settings (company_id)
select c.id from companies c
where not exists (select 1 from ai_settings a where a.company_id = c.id);

insert into voice_settings (company_id)
select c.id from companies c
where not exists (select 1 from voice_settings v where v.company_id = c.id);
