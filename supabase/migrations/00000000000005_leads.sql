-- Dravonix WhatsApp AI Platform
-- Lead collection (Master Prompt section 15).

create type lead_stage as enum (
  'new',
  'qualifying',
  'qualified',
  'proposal_sent',
  'won',
  'lost'
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  customer_name text,
  company_name text,
  phone_number text,
  email text,
  service_interest text,
  product_interest text,
  budget text,
  preferred_timeline text,
  location text,
  branch text,
  notes text,
  source text not null default 'whatsapp_chatbot',
  score integer,
  stage lead_stage not null default 'new',
  assigned_member_id uuid references company_members (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index leads_company_id_idx on leads (company_id);
create index leads_company_stage_idx on leads (company_id, stage);

create table lead_fields (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  service text,
  product text,
  campaign text,
  intent text,
  field_key text not null,
  field_label text not null,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'select', 'date', 'boolean')),
  is_required boolean not null default false,
  display_order integer not null default 0
);

comment on table lead_fields is
  'Configurable per-company lead-form fields, scoped by service/product/campaign/intent -- Master Prompt section 15.';

create index lead_fields_company_id_idx on lead_fields (company_id);

create table lead_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  actor_member_id uuid references company_members (id) on delete set null,
  created_at timestamptz not null default now()
);

create index lead_events_lead_id_idx on lead_events (lead_id);

create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();

alter table leads enable row level security;
alter table lead_fields enable row level security;
alter table lead_events enable row level security;

create policy leads_select_member on leads
  for select
  using (has_company_permission(company_id, 'leads.view') or is_platform_staff());

create policy leads_update_member on leads
  for update
  using (has_company_permission(company_id, 'leads.manage'))
  with check (has_company_permission(company_id, 'leads.manage'));

create policy lead_fields_select_member on lead_fields
  for select
  using (has_company_permission(company_id, 'leads.view') or is_platform_staff());

create policy lead_fields_manage_member on lead_fields
  for all
  using (has_company_permission(company_id, 'leads.manage'))
  with check (has_company_permission(company_id, 'leads.manage'));

create policy lead_events_select_member on lead_events
  for select
  using (has_company_permission(company_id, 'leads.view') or is_platform_staff());
