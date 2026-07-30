-- Dravonix WhatsApp AI Platform
-- WhatsApp Business Account + phone number + template storage.
-- See docs/architecture/adr-0002-webhook-architecture.md.

create type whatsapp_connection_status as enum (
  'not_connected',
  'pending',
  'connected',
  'permission_error',
  'connection_error',
  'disabled'
);

create table whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  waba_id text not null,
  business_name text,
  status whatsapp_connection_status not null default 'not_connected',
  -- Sensitive access tokens are encrypted at rest (packages/core encryption
  -- helper) before being written here; never stored or logged in plaintext.
  encrypted_access_token text,
  token_expires_at timestamptz,
  last_error text,
  is_test_account boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id)
);

create index whatsapp_accounts_company_id_idx on whatsapp_accounts (company_id);

create table whatsapp_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  whatsapp_account_id uuid not null references whatsapp_accounts (id) on delete cascade,
  phone_number_id text not null,
  display_phone_number text,
  status whatsapp_connection_status not null default 'not_connected',
  webhook_health_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone_number_id)
);

comment on column whatsapp_phone_numbers.phone_number_id is
  'Meta Graph API phone_number_id. The single source of truth used to route an inbound webhook to a company -- see packages/whatsapp/src/routing.ts.';

create index whatsapp_phone_numbers_company_id_idx on whatsapp_phone_numbers (company_id);

create type whatsapp_template_status as enum (
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'disabled'
);

create table whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  whatsapp_account_id uuid not null references whatsapp_accounts (id) on delete cascade,
  name text not null,
  language text not null default 'en',
  category text,
  status whatsapp_template_status not null default 'draft',
  body text not null,
  variables jsonb not null default '[]'::jsonb,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (whatsapp_account_id, name, language)
);

create index whatsapp_templates_company_id_idx on whatsapp_templates (company_id);

create trigger whatsapp_accounts_set_updated_at
  before update on whatsapp_accounts
  for each row execute function set_updated_at();

create trigger whatsapp_phone_numbers_set_updated_at
  before update on whatsapp_phone_numbers
  for each row execute function set_updated_at();

create trigger whatsapp_templates_set_updated_at
  before update on whatsapp_templates
  for each row execute function set_updated_at();

alter table whatsapp_accounts enable row level security;
alter table whatsapp_phone_numbers enable row level security;
alter table whatsapp_templates enable row level security;

create policy whatsapp_accounts_select_member on whatsapp_accounts
  for select
  using (has_company_permission(company_id, 'whatsapp.view') or is_platform_staff());

create policy whatsapp_phone_numbers_select_member on whatsapp_phone_numbers
  for select
  using (has_company_permission(company_id, 'whatsapp.view') or is_platform_staff());

create policy whatsapp_templates_select_member on whatsapp_templates
  for select
  using (has_company_permission(company_id, 'whatsapp.view') or is_platform_staff());
