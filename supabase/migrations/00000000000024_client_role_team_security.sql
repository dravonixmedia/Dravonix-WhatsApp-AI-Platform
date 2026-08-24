-- Dravonix WhatsApp AI Platform
-- Phase 2 role model expansion, part 2 of 2: permission matrix updates,
-- team.manage revival (with owner protection), the new conversations.close
-- permission, invitation/role-change/deactivation hierarchy hardening, and
-- the "at most one active company_owner per company" database safety
-- constraint.
--
-- Builds on 00000000000023_role_model_expansion.sql (team_leader,
-- sales_person, company_accounts enum values, already committed). This file
-- never removes an enum value, never deletes a company_members/
-- company_invitations row, and never modifies Dravonix Media's existing
-- company_admin member -- the zero-owner state there is a known,
-- deliberately-untouched staging remediation item (see section 8 below and
-- the migration-24 rollout report).
--
-- Explicitly NOT touched here: ZeptoMail, invitation email branding/
-- delivery, Supabase Auth email confirmation/resume, Cloudflare, Meta/WABA
-- credentials, handover_pause_ai/handover_resume_ai/conversations.ai_mode
-- (unchanged -- still gated on assigned member OR conversations.assign,
-- exactly as before), phone-number masking, Live Conversation scroll
-- behavior, the three-column workspace, Support & Requests, payments,
-- Research/Settings, sidebar structure, and production.

-- ---------------------------------------------------------------------------
-- 0. Safety guard: knowledge_editor and viewer have no approved semantic
--    mapping (unlike agent -> sales_person and billing_viewer ->
--    company_accounts below). Phase 1's read-only hosted-staging
--    verification found zero active members and zero pending invitations
--    for both roles -- if that ever stops being true in some other
--    environment this migration is applied to, abort loudly rather than
--    silently leaving real users on a role this migration is about to
--    retire from every active permission grant and UI surface.
-- ---------------------------------------------------------------------------

do $$
declare
  v_active_count integer;
  v_pending_count integer;
begin
  select count(*) into v_active_count
    from company_members
    where role in ('knowledge_editor', 'viewer') and is_active = true;

  select count(*) into v_pending_count
    from company_invitations
    where role in ('knowledge_editor', 'viewer') and status = 'pending';

  if v_active_count > 0 or v_pending_count > 0 then
    raise exception
      'legacy_role_usage_requires_manual_migration: % active member(s) and % pending invitation(s) hold knowledge_editor/viewer -- no approved semantic mapping exists for these roles, migration 24 aborted (nothing changed)',
      v_active_count, v_pending_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Legacy role remaps: agent -> sales_person, billing_viewer ->
--    company_accounts. Approved 1:1 mappings (Phase 1/2 planning) -- these
--    are no-ops on current hosted staging (verified zero rows for both
--    roles) but keep migration behavior deterministic if another
--    pre-production environment carries such rows. Every company_members
--    row is remapped (both active and inactive -- these are permanent role
--    renames, not a historical-audit field); company_invitations rows are
--    remapped only while still pending -- an already accepted/revoked/
--    expired invitation is a historical record of what was actually
--    offered at the time and is left untouched.
-- ---------------------------------------------------------------------------

update company_members set role = 'sales_person' where role = 'agent';
update company_members set role = 'company_accounts' where role = 'billing_viewer';
update company_invitations set role = 'sales_person' where role = 'agent' and status = 'pending';
update company_invitations set role = 'company_accounts' where role = 'billing_viewer' and status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. New permission key: conversations.close. Splits "End Human Assistance /
--    Close Conversation" out of conversations.assign so Sales Person (which
--    needs conversations.assign for the existing claim/assignment workflow)
--    can be excluded from ending/closing a handover, matching the approved
--    role model -- Pause/Resume AI is untouched (section 6 below) and keeps
--    checking conversations.assign exactly as it always has.
-- ---------------------------------------------------------------------------

insert into permissions (key, description) values
  ('conversations.close', 'End Human Assistance or Close a conversation');

-- ---------------------------------------------------------------------------
-- 3. Permission matrix: team.manage revival (owner/admin only -- Client
--    Dashboard Permission Hardening, migration 22, had revoked it from
--    every client role when team management moved to Super Admin-only;
--    Phase 2 restores it to the client Team page, now with owner protection
--    enforced at the RPC layer, sections 5-8 below), team.view widening,
--    conversations.close grants, and the three new roles' full grants.
--    team.display_name.manage is unchanged (still company_owner/
--    company_admin only, from migration 22).
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission_key) values
  ('company_owner', 'team.manage'),
  ('company_admin', 'team.manage')
on conflict (role, permission_key) do nothing;

insert into role_permissions (role, permission_key) values
  ('manager', 'team.view')
on conflict (role, permission_key) do nothing;

insert into role_permissions (role, permission_key) values
  ('company_owner', 'conversations.close'),
  ('company_admin', 'conversations.close'),
  ('manager', 'conversations.close')
on conflict (role, permission_key) do nothing;

-- team_leader: frontline operational supervisor. No conversations.reassign,
-- no usage.view, no team.manage/team.display_name.manage, no billing/company
-- administration -- narrower than manager by exactly those permissions.
insert into role_permissions (role, permission_key) values
  ('team_leader', 'conversations.view'),
  ('team_leader', 'conversations.reply'),
  ('team_leader', 'conversations.assign'),
  ('team_leader', 'conversations.close'),
  ('team_leader', 'leads.view'),
  ('team_leader', 'leads.manage'),
  ('team_leader', 'knowledge.view'),
  ('team_leader', 'ai_settings.view'),
  ('team_leader', 'team.view'),
  ('team_leader', 'whatsapp.view');

-- sales_person: replaces the old Agent concept. No conversations.close (must
-- not End Human Assistance or Close Conversation even if assigned -- section
-- 6 enforces this server-side with no assigned-member bypass), no
-- conversations.reassign, no team.manage/team.display_name.manage, no
-- usage.view, no billing.view.
insert into role_permissions (role, permission_key) values
  ('sales_person', 'conversations.view'),
  ('sales_person', 'conversations.reply'),
  ('sales_person', 'conversations.assign'),
  ('sales_person', 'leads.view'),
  ('sales_person', 'leads.manage'),
  ('sales_person', 'knowledge.view'),
  ('sales_person', 'ai_settings.view'),
  ('sales_person', 'team.view');

-- company_accounts: finance-focused. Deliberately no team.view (per Phase 2
-- spec) and no conversations.*/leads.*/knowledge.*/ai_settings.*/
-- whatsapp.*/team.*/company-administration of any kind. billing.pay does
-- not exist yet (Phase 6) -- billing.view is the read-only surface this
-- role gets today.
insert into role_permissions (role, permission_key) values
  ('company_accounts', 'billing.view'),
  ('company_accounts', 'usage.view');

-- ---------------------------------------------------------------------------
-- 4. Database owner-protection safety net: at most one ACTIVE company_owner
--    per company, enforced by the database itself regardless of which RPC
--    (or a future bug in one) attempts the write. Deliberately NOT an
--    unconditional "exactly one owner" constraint -- Phase 1 verification
--    found Dravonix Media (active members, zero owners) and DRA TS (zero
--    members) already in a zero-owner state; a partial unique index only
--    ever rejects a *second* active owner, never requires a first one, so
--    both remain valid rows under this constraint (see section 8's
--    reporting query). No existing row is modified to satisfy this index --
--    no company in the current dataset has more than one active owner, so
--    creating it is a no-op against current data.
-- ---------------------------------------------------------------------------

create unique index company_members_one_active_owner_uq
  on company_members (company_id)
  where role = 'company_owner' and is_active = true;

comment on index company_members_one_active_owner_uq is
  'At most one ACTIVE company_owner per company_id -- not "exactly one" (a company may legitimately have zero, e.g. before its first owner accepts an invitation, or a known pre-Phase-2 staging gap such as Dravonix Media). Ordinary role-change/deactivation RPCs (company_change_member_role, admin_change_company_member_role, company_deactivate_member, admin_deactivate_company_member) add their own friendlier permission_denied-style checks in front of this, but this index is the actual, unbypassable backstop -- including against a future RPC bug. A dedicated Super Admin-only Transfer Ownership workflow (deferred to a later phase) will be the only sanctioned way to move ownership from one member to another.';

-- ---------------------------------------------------------------------------
-- 5. create_company_invitation: client invitation hierarchy. The client
--    path (team.manage holder, not super_admin) may never invite a
--    company_owner, and may only invite from the five non-owner roles of
--    the active six-role client model. The super_admin path keeps its
--    broader role authority (e.g. bootstrapping a brand new company's first
--    owner) but must still never be allowed to create a second active
--    owner -- enforced here as a friendly business-rule rejection in
--    addition to (never instead of) the unbypassable partial unique index
--    above, which would otherwise only surface this as a raw constraint
--    violation at accept_company_invitation time.
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
  v_is_super_admin boolean;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  -- current_platform_role() returns NULL for a non-platform-staff caller
  -- (the common case) -- "= 'super_admin'" on a NULL yields NULL, not
  -- false, which plpgsql's IF treats as "don't raise", silently bypassing
  -- every check below it. IS NOT DISTINCT FROM is the null-safe equality
  -- that always yields a real boolean.
  v_is_super_admin := (public.current_platform_role() is not distinct from 'super_admin');
  if not v_is_super_admin and not public.has_company_permission(p_company_id, 'team.manage') then
    raise exception 'permission_denied';
  end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  if p_role = 'company_owner' then
    if not v_is_super_admin then raise exception 'cannot_invite_owner'; end if;
    if exists (
      select 1 from public.company_members
      where public.company_members.company_id = p_company_id
        and public.company_members.role = 'company_owner'
        and public.company_members.is_active = true
    ) then
      raise exception 'owner_already_exists';
    end if;
  elsif not v_is_super_admin
    and p_role not in ('company_admin', 'manager', 'team_leader', 'sales_person', 'company_accounts')
  then
    raise exception 'invalid_role_for_invitation';
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
  'Returns table column is named invitation_email (not email) to avoid a plpgsql bare-identifier ambiguity against the ON CONFLICT (company_id, lower(email)) target above -- the RETURN QUERY SELECT list still assigns v_row.email into that position positionally. Phase 2: rejects company_owner from the client (team.manage) path outright (cannot_invite_owner), restricts the client path to the five non-owner active roles (invalid_role_for_invitation), and rejects any invitation -- client or super_admin -- for a company_owner role when an active owner already exists (owner_already_exists), backstopped by company_members_one_active_owner_uq at accept time.';

revoke all on function create_company_invitation(uuid, text, company_role) from public, anon;
grant execute on function create_company_invitation(uuid, text, company_role) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. company_change_member_role / company_deactivate_member: client team-
--    management RPCs (team.manage holder). Owner protection: the current
--    company_owner can never be touched by these (role changed away from,
--    or deactivated), and no client action may promote anyone to
--    company_owner or assign a legacy/unsupported role. This is the
--    server-side enforcement the Phase 2 spec requires "do not rely on the
--    dropdown" for -- these checks hold even if the UI ever renders a bad
--    option.
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

  if v_member.role = 'company_owner' then raise exception 'cannot_change_owner'; end if;
  if p_new_role not in ('company_admin', 'manager', 'team_leader', 'sales_person', 'company_accounts') then
    raise exception 'invalid_target_role';
  end if;

  v_old_role := v_member.role;
  update public.company_members set role = p_new_role where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_member.company_id, auth.uid(), 'user', 'member_role_changed', 'company_member', p_member_id::text,
            jsonb_build_object('old_role', v_old_role, 'new_role', p_new_role));

  return query select v_member.id, v_member.role;
end;
$$;

comment on function company_change_member_role(uuid, company_role) is
  'Phase 2 owner protection: rejects any attempt to change the role of a member whose current role is company_owner (cannot_change_owner), and restricts p_new_role to the five non-owner active roles (invalid_target_role) -- a client can never promote anyone to company_owner or assign a legacy role (agent/knowledge_editor/billing_viewer/viewer) through this RPC, regardless of what a compromised or buggy client sends.';

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
  if v_member.role = 'company_owner' then raise exception 'cannot_deactivate_owner'; end if;

  update public.company_members set is_active = false, disabled_at = now()
    where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_member.company_id, auth.uid(), 'user', 'member_deactivated', 'company_member', p_member_id::text);

  return query select v_member.id, v_member.is_active;
end;
$$;

comment on function company_deactivate_member(uuid) is
  'Phase 2 owner protection: a member whose current role is company_owner can never be deactivated through this client RPC (cannot_deactivate_owner) -- ownership changes are deferred to a future Super Admin-only Transfer Ownership workflow.';

revoke all on function company_deactivate_member(uuid) from public, anon;
grant execute on function company_deactivate_member(uuid) to authenticated;

-- company_reactivate_member: the symmetric counterpart the client Team page
-- needs (Owner/Admin "deactivate/reactivate normal members") -- no client
-- RPC previously existed for this (only re-accepting an invitation could
-- reactivate a member, via accept_company_invitation). No owner-role block
-- is needed here the way company_deactivate_member needs one -- an owner
-- can never be deactivated through the client flow in the first place, so a
-- client can never encounter an inactive company_owner row to reactivate;
-- if one somehow exists (pre-Phase-2 legacy data) and another active owner
-- already exists for the same company, company_members_one_active_owner_uq
-- (section 4 above) is the backstop that rejects the reactivation outright.
create or replace function company_reactivate_member(p_member_id uuid)
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
  if v_member.is_active then raise exception 'member_already_active'; end if;

  update public.company_members set is_active = true, disabled_at = null
    where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_member.company_id, auth.uid(), 'user', 'member_reactivated', 'company_member', p_member_id::text);

  return query select v_member.id, v_member.is_active;
end;
$$;

revoke all on function company_reactivate_member(uuid) from public, anon;
grant execute on function company_reactivate_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. admin_change_company_member_role / admin_deactivate_company_member:
--    Super Admin RPCs (migration 17). Ordinary Super Admin role/deactivate
--    actions must also protect the existing owner -- they may not demote or
--    deactivate the current active company_owner, and may not promote a
--    second member to company_owner while an active one already exists
--    (promoting into a *zero-owner* company, e.g. the known Dravonix Media
--    staging gap, remains allowed -- this is exactly how that gap gets
--    fixed, deliberately not automated by this migration). A dedicated
--    Transfer Ownership workflow (deferred) will be the only way to move
--    ownership between two members atomically once one already exists.
-- ---------------------------------------------------------------------------

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

  if v_member.role = 'company_owner' and v_member.is_active = true and p_new_role <> 'company_owner' then
    raise exception 'cannot_demote_owner';
  end if;
  if p_new_role = 'company_owner' and v_member.role <> 'company_owner' then
    if exists (
      select 1 from public.company_members
      where public.company_members.company_id = p_company_id
        and public.company_members.role = 'company_owner'
        and public.company_members.is_active = true
    ) then
      raise exception 'owner_already_exists';
    end if;
  end if;

  v_old_role := v_member.role;
  update public.company_members set role = p_new_role where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'member_role_changed', 'company_member', p_member_id::text,
            jsonb_build_object('old_role', v_old_role, 'new_role', p_new_role));

  return query select v_member.id, v_member.role;
end;
$$;

comment on function admin_change_company_member_role(uuid, uuid, company_role) is
  'Phase 2 owner protection for ordinary Super Admin role management: refuses to demote the current active company_owner away from that role (cannot_demote_owner) and refuses to promote a second member to company_owner while an active one already exists (owner_already_exists) -- promoting into a zero-owner company (no active owner currently exists) is deliberately still allowed, since that is the sanctioned way to repair a zero-owner state like Dravonix Media''s. A dedicated Transfer Ownership workflow (deferred) is the only sanctioned way to atomically move ownership once a company already has one.';

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
  if v_member.role = 'company_owner' and v_member.is_active = true then
    raise exception 'cannot_deactivate_owner';
  end if;

  update public.company_members set is_active = false, disabled_at = now()
    where public.company_members.id = p_member_id returning * into v_member;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'user', 'member_deactivated', 'company_member', p_member_id::text);

  return query select v_member.id, v_member.is_active;
end;
$$;

comment on function admin_deactivate_company_member(uuid, uuid) is
  'Phase 2 owner protection: an active company_owner can never be deactivated through this ordinary Super Admin flow (cannot_deactivate_owner) -- deferred to a future Transfer Ownership workflow.';

revoke all on function admin_deactivate_company_member(uuid, uuid) from public, anon;
grant execute on function admin_deactivate_company_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7b. admin_invite_company_member (migration 17): the same one-owner safety
--     rule as create_company_invitation/admin_change_company_member_role
--     above -- assigning company_owner directly (this RPC activates
--     membership immediately, with no invitation/accept step) must not be
--     allowed to create a second active owner. Promoting into a zero-owner
--     company remains allowed, same rationale as section 7.
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

  if p_role = 'company_owner' and exists (
    select 1 from public.company_members
    where public.company_members.company_id = p_company_id
      and public.company_members.role = 'company_owner'
      and public.company_members.is_active = true
  ) then
    raise exception 'owner_already_exists';
  end if;

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

-- ---------------------------------------------------------------------------
-- 8. Human Handover close/end authorization: handover_end_human_assistance
--    and handover_close_conversation now require conversations.close
--    instead of conversations.assign -- Sales Person holds
--    conversations.assign (for the existing claim/assignment workflow) but
--    not conversations.close, so it loses End/Close specifically while
--    keeping everything else unchanged. Deliberately no assigned-member
--    bypass is added (matching the existing code shape, which never
--    consulted assigned_member_id here either) -- Sales Person cannot End
--    Human Assistance or Close a Conversation even when it is the assigned
--    member. handover_pause_ai/handover_resume_ai/conversations.ai_mode are
--    NOT touched by this migration -- they keep checking exactly "assigned
--    member OR conversations.assign", unchanged from migration 12.
-- ---------------------------------------------------------------------------

create or replace function handover_end_human_assistance(p_conversation_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;
  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_conv.company_id, 'conversations.close') then
    raise exception 'permission_denied';
  end if;
  if v_conv.state not in ('handover_requested', 'queued_for_agent', 'human_active') then
    raise exception 'invalid_state_transition';
  end if;

  update public.conversations
    set state = 'ai_active', assigned_member_id = null, handover_reason = null
    where public.conversations.id = p_conversation_id returning * into v_conv;

  update public.conversation_assignments set unassigned_at = now()
    where conversation_id = p_conversation_id and unassigned_at is null;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.ended_human_assistance', 'conversation',
            p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

create or replace function handover_close_conversation(p_conversation_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;
  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_conv.company_id, 'conversations.close') then
    raise exception 'permission_denied';
  end if;
  if v_conv.state = 'closed' then raise exception 'invalid_state_transition'; end if;

  update public.conversations set state = 'closed'
    where public.conversations.id = p_conversation_id returning * into v_conv;
  update public.conversation_assignments set unassigned_at = now()
    where conversation_id = p_conversation_id and unassigned_at is null;
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.closed', 'conversation', p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

revoke all on function handover_end_human_assistance(uuid) from public, anon;
grant execute on function handover_end_human_assistance(uuid) to authenticated;
revoke all on function handover_close_conversation(uuid) from public, anon;
grant execute on function handover_close_conversation(uuid) to authenticated;
