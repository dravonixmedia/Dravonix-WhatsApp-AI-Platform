-- Dravonix WhatsApp AI Platform
-- Core tenancy: companies, platform-level staff, company membership, roles/permissions,
-- and the helper functions every later RLS policy depends on.
--
-- See docs/architecture/adr-0001-multi-tenant-strategy.md for the rationale behind
-- shared tables + company_id + RLS (instead of database- or schema-per-tenant), and
-- DATABASE.md for the full table catalogue.

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------

create type company_status as enum (
  'onboarding',
  'active',
  'suspended',
  'manually_suspended',
  'closed'
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status company_status not null default 'onboarding',
  is_demo boolean not null default false,
  timezone text not null default 'Asia/Kolkata',
  default_currency text not null default 'INR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table companies is 'One row per client tenant. is_demo=true marks Stage A seeded/demo companies (e.g. Dravonix Media) that must never be treated as billable production tenants.';

create table company_settings (
  company_id uuid primary key references companies (id) on delete cascade,
  bot_name text not null default 'Assistant',
  welcome_message text,
  tone text not null default 'friendly_professional',
  enabled_languages text[] not null default array['en'],
  fallback_language text not null default 'en',
  default_reply_mode text not null default 'auto'
    check (default_reply_mode in ('text_only', 'voice_only', 'text_and_voice', 'auto')),
  confidence_threshold numeric(3, 2) not null default 0.55,
  ai_active boolean not null default true,
  restricted_topics text[] not null default '{}',
  static_fallback_message text not null default
    'Automated assistance is temporarily unavailable. Our team will respond as soon as possible.',
  business_hours jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table company_branding (
  company_id uuid primary key references companies (id) on delete cascade,
  display_name text,
  logo_url text,
  primary_color text,
  secondary_color text,
  accent_color text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Platform-level staff (Dravonix Media super-admin / support / billing admin)
-- Deliberately a separate table from company_members: platform roles never
-- imply company membership and vice versa (Master Prompt section 9).
-- ---------------------------------------------------------------------------

create type platform_role as enum (
  'super_admin',
  'platform_support',
  'platform_billing_admin'
);

create table platform_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role platform_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table platform_members is 'Dravonix Media staff. Presence here grants platform-level access only through explicit, audited server-side paths -- never through a blanket RLS bypass.';

-- ---------------------------------------------------------------------------
-- Company roles, permissions, role_permissions (permission matrix)
-- ---------------------------------------------------------------------------

create type company_role as enum (
  'company_owner',
  'company_admin',
  'manager',
  'agent',
  'knowledge_editor',
  'billing_viewer',
  'viewer'
);

create table permissions (
  key text primary key,
  description text not null
);

create table role_permissions (
  role company_role not null,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (role, permission_key)
);

create table company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role company_role not null,
  is_active boolean not null default true,
  invited_at timestamptz not null default now(),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_members_user_id_idx on company_members (user_id) where is_active;
create index company_members_company_id_idx on company_members (company_id);

-- ---------------------------------------------------------------------------
-- Helper functions used throughout RLS policies (SECURITY DEFINER so they can
-- read company_members/platform_members regardless of the calling role's own
-- RLS visibility, while remaining read-only and narrowly scoped).
-- ---------------------------------------------------------------------------

create or replace function current_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id
  from company_members
  where user_id = auth.uid()
    and is_active = true;
$$;

comment on function current_company_ids() is
  'Active company memberships for the calling user. Queried live from company_members (not JWT claims) so a disabled member loses access immediately, without waiting for token refresh.';

create or replace function is_company_member(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from company_members
    where company_id = target_company_id
      and user_id = auth.uid()
      and is_active = true
  );
$$;

create or replace function has_company_permission(target_company_id uuid, permission_key_param text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from company_members cm
    join role_permissions rp on rp.role = cm.role
    where cm.company_id = target_company_id
      and cm.user_id = auth.uid()
      and cm.is_active = true
      and rp.permission_key = permission_key_param
  );
$$;

create or replace function current_platform_role()
returns platform_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from platform_members
  where user_id = auth.uid()
    and is_active = true;
$$;

create or replace function is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from platform_members
    where user_id = auth.uid() and is_active = true
  );
$$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger, reused by every table with an updated_at column
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger companies_set_updated_at
  before update on companies
  for each row execute function set_updated_at();

create trigger company_settings_set_updated_at
  before update on company_settings
  for each row execute function set_updated_at();

create trigger company_branding_set_updated_at
  before update on company_branding
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table companies enable row level security;
alter table company_settings enable row level security;
alter table company_branding enable row level security;
alter table company_members enable row level security;
alter table platform_members enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;

-- companies: members can read their own company; platform staff can read all.
-- Writes to companies happen only through the service-role-backed super-admin API
-- (apps/api), never directly from authenticated browser sessions, so no INSERT/
-- UPDATE/DELETE policy is granted to the `authenticated` role here.
create policy companies_select_member on companies
  for select
  using (id in (select current_company_ids()) or is_platform_staff());

create policy company_settings_select_member on company_settings
  for select
  using (company_id in (select current_company_ids()) or is_platform_staff());

create policy company_settings_update_admin on company_settings
  for update
  using (has_company_permission(company_id, 'settings.manage'))
  with check (has_company_permission(company_id, 'settings.manage'));

create policy company_branding_select_member on company_branding
  for select
  using (company_id in (select current_company_ids()) or is_platform_staff());

create policy company_branding_update_admin on company_branding
  for update
  using (has_company_permission(company_id, 'settings.manage'))
  with check (has_company_permission(company_id, 'settings.manage'));

-- company_members: a member can see other members of their own company (for
-- team management); platform staff can see all. No self-service inserts --
-- invitations happen through the API using the service role, which enforces
-- inviter permission (`team.manage`) before writing.
create policy company_members_select_same_company on company_members
  for select
  using (company_id in (select current_company_ids()) or is_platform_staff());

-- platform_members: only visible to other platform staff, never to company members.
create policy platform_members_select_platform_staff on platform_members
  for select
  using (is_platform_staff());

-- permissions / role_permissions: readable by any authenticated user (used by
-- client-side UI to render permission-aware navigation; the *authorization*
-- decision is always re-checked server-side, per project policy on client vs
-- server authorization).
create policy permissions_select_authenticated on permissions
  for select
  using (auth.role() = 'authenticated' or is_platform_staff());

create policy role_permissions_select_authenticated on role_permissions
  for select
  using (auth.role() = 'authenticated' or is_platform_staff());
