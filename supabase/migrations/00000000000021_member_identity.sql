-- Dravonix WhatsApp AI Platform
-- Human-friendly, editable team member identity (Super Admin "Users & Roles"
-- card + client Team page). Audited first: no profiles/platform_users table
-- exists anywhere in this schema, company_members/auth.users have no
-- full_name/display_name column, and no signup path in this codebase ever
-- populates auth.users.raw_user_meta_data -- so a real display name was not
-- previously collectible, and email was the best available human identity
-- (the existing masked "User ••1234" fallback stays as the final resort).
-- This migration adds the smallest canonical profile structure so a real,
-- editable display name now exists: one row per auth user (never one per
-- company membership -- a person has a single name across every company
-- they belong to), created lazily on first edit rather than backfilled for
-- every existing auth user.
--
-- auth.users.email cannot be read for *other* users through the regular
-- Supabase client (no PostgREST access to the auth schema, and using it
-- would require an authenticated user's own row, not an arbitrary other
-- one) -- list_company_member_identities is a SECURITY DEFINER RPC granting
-- exactly the same visibility boundary the existing
-- company_members_select_same_company RLS policy already grants for the
-- underlying rows (any current member of the same company, or platform
-- staff), just also resolving the auth email and profile display name for
-- rows the caller could already see the (masked) user id for. Never
-- broadens read access, never permits a cross-tenant company_id lookup.

-- ---------------------------------------------------------------------------
-- 1. user_profiles: one row per auth user, created lazily on first name
--    edit. Deliberately holds nothing but the editable display name --
--    email stays canonical in auth.users, and no company/role/platform-role
--    field lives here (a profile is never scoped to a single company).
-- ---------------------------------------------------------------------------

create table user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table user_profiles is
  'One row per auth user (never per company membership) holding only the editable display name. Absence of a row is normal and expected -- it just means the identity display falls back to email. Never stores email, company_id, role, or any auth secret.';

alter table user_profiles enable row level security;

-- Direct table access is deliberately narrow: a user may always read their
-- own profile row (needed for the self-edit surface to show its current
-- value), and nothing else -- every other read (an admin resolving another
-- member's name) goes through list_company_member_identities below so the
-- existing company-membership/platform-staff boundary is enforced in one
-- place. No RLS INSERT/UPDATE policy exists at all -- every write, including
-- a user's own, goes through the update_user_display_name RPC so validation
-- and audit logging can never be bypassed by a direct table write.

create policy user_profiles_select_own on user_profiles
  for select
  using (user_id = auth.uid());

revoke insert, update, delete on user_profiles from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. list_company_member_identities: now also resolves the profile display
--    name (left join -- a missing profile row must not hide the member).
-- ---------------------------------------------------------------------------

create or replace function list_company_member_identities(p_company_id uuid)
returns table (member_id uuid, user_id uuid, email text, display_name text)
language sql
security definer
stable
set search_path = ''
as $$
  select cm.id, cm.user_id, u.email, up.display_name
  from public.company_members cm
  join auth.users u on u.id = cm.user_id
  left join public.user_profiles up on up.user_id = cm.user_id
  where cm.company_id = p_company_id
    and (p_company_id in (select public.current_company_ids()) or public.is_platform_staff());
$$;

revoke all on function list_company_member_identities(uuid) from public, anon;
grant execute on function list_company_member_identities(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Display-name write RPCs. Two narrowly-scoped functions, never one
--    generic profile-update RPC -- mirroring this codebase's existing split
--    between a company-scoped RPC and a dedicated admin_* RPC for the same
--    kind of write (company_change_member_role vs.
--    admin_change_company_member_role in migration 17): each function
--    checks exactly one authorization story, so neither can be reasoned
--    about as "sometimes also allows X".
--
-- 3a. update_user_display_name: the client Team page's and the self-edit
--     surface's write path. Authorizes exactly two callers: the user
--     themselves (any authenticated user may rename themselves), or a
--     caller who holds team.manage in a company the target is *currently*
--     an active member of (the same permission that already gates
--     company_change_member_role/company_deactivate_member --
--     company_owner and company_admin only; manager/agent/knowledge_editor/
--     etc. do not have team.manage and are rejected). A company role can
--     never reach a user outside a company it shares with the caller.
-- ---------------------------------------------------------------------------
--
-- Returns updated_user_id (not user_id): the same plpgsql bare-identifier
-- ambiguity documented on create_company_invitation's invitation_email
-- column -- naming this OUT parameter user_id would be ambiguous against
-- the ON CONFLICT (user_id) target below.

create or replace function update_user_display_name(p_user_id uuid, p_display_name text)
returns table (updated_user_id uuid, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_normalized text;
  v_is_self boolean;
  v_shared_company_id uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'unauthorized'; end if;

  v_normalized := nullif(trim(p_display_name), '');
  if v_normalized is null then raise exception 'invalid_display_name'; end if;
  if length(v_normalized) > 150 then raise exception 'display_name_too_long'; end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'target_user_not_found';
  end if;

  v_is_self := (v_caller = p_user_id);

  if not v_is_self then
    select cm_caller.company_id into v_shared_company_id
      from public.company_members cm_caller
      join public.company_members cm_target
        on cm_target.company_id = cm_caller.company_id
       and cm_target.user_id = p_user_id
       and cm_target.is_active = true
      where cm_caller.user_id = v_caller
        and cm_caller.is_active = true
        and public.has_company_permission(cm_caller.company_id, 'team.manage')
      limit 1;

    if v_shared_company_id is null then
      raise exception 'permission_denied';
    end if;
  end if;

  insert into public.user_profiles (user_id, display_name, created_at, updated_at)
    values (p_user_id, v_normalized, now(), now())
    on conflict (user_id) do update
      set display_name = excluded.display_name,
          updated_at = now();

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_shared_company_id, v_caller, 'user', 'user_display_name_changed', 'user_profile', p_user_id::text,
            jsonb_build_object('self_edit', v_is_self));

  return query select p_user_id, v_normalized;
end;
$$;

revoke all on function update_user_display_name(uuid, text) from public, anon;
grant execute on function update_user_display_name(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b. admin_update_user_display_name: the Super Admin "Users & Roles" card's
--     write path, mirroring admin_change_company_member_role/
--     admin_deactivate_company_member's exact authorization check (strictly
--     current_platform_role() = 'super_admin', not merely any platform
--     staff, and not gated on any company membership -- a Super Admin can
--     rename any DRAIVA user).
-- ---------------------------------------------------------------------------

create or replace function admin_update_user_display_name(p_user_id uuid, p_display_name text)
returns table (updated_user_id uuid, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_normalized text;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  v_normalized := nullif(trim(p_display_name), '');
  if v_normalized is null then raise exception 'invalid_display_name'; end if;
  if length(v_normalized) > 150 then raise exception 'display_name_too_long'; end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'target_user_not_found';
  end if;

  insert into public.user_profiles (user_id, display_name, created_at, updated_at)
    values (p_user_id, v_normalized, now(), now())
    on conflict (user_id) do update
      set display_name = excluded.display_name,
          updated_at = now();

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (null, v_caller, 'platform_staff', 'user_display_name_changed', 'user_profile', p_user_id::text,
            jsonb_build_object('self_edit', false));

  return query select p_user_id, v_normalized;
end;
$$;

revoke all on function admin_update_user_display_name(uuid, text) from public, anon;
grant execute on function admin_update_user_display_name(uuid, text) to authenticated;
