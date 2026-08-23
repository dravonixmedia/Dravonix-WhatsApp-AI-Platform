-- Dravonix WhatsApp AI Platform
-- Human-friendly team member identity resolution (Super Admin "Users & Roles"
-- card + client Team page). Audited first: no profiles/platform_users table
-- exists anywhere in this schema, company_members/auth.users have no
-- full_name/display_name column, and no signup path in this codebase ever
-- populates auth.users.raw_user_meta_data -- so a real display name is not
-- currently collectible, and email is the best available human identity for
-- now (the existing masked "User ••1234" fallback stays as the last resort).
--
-- auth.users.email cannot be read for *other* users through the regular
-- Supabase client (no PostgREST access to the auth schema, and using it
-- would require an authenticated user's own row, not an arbitrary other
-- one) -- this is a new SECURITY DEFINER RPC granting exactly the same
-- visibility boundary the existing company_members_select_same_company RLS
-- policy already grants for the underlying rows (any current member of the
-- same company, or platform staff), just also resolving the auth email for
-- rows the caller could already see the (masked) user id for. Never
-- broadens read access, never permits a cross-tenant company_id lookup, and
-- never exposes a raw auth.users.id/company_members.user_id.

create or replace function list_company_member_identities(p_company_id uuid)
returns table (member_id uuid, email text)
language sql
security definer
stable
set search_path = ''
as $$
  select cm.id, u.email
  from public.company_members cm
  join auth.users u on u.id = cm.user_id
  where cm.company_id = p_company_id
    and (p_company_id in (select public.current_company_ids()) or public.is_platform_staff());
$$;

revoke all on function list_company_member_identities(uuid) from public, anon;
grant execute on function list_company_member_identities(uuid) to authenticated;
