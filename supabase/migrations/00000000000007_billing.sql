-- Dravonix WhatsApp AI Platform
-- Plans, entitlements, subscriptions, invoices, payments, service charges.
-- See docs/architecture/adr-0006-billing-state-machine.md.

create table plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table plans is 'Stable plan identity (Starter/Business/Professional). Commercial details live in plan_versions so existing subscriptions can keep an older snapshot -- Master Prompt section 20.';

create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans (id) on delete cascade,
  version integer not null,
  monthly_price numeric(12, 2) not null,
  currency text not null default 'INR',
  grace_period_days integer not null default 5,
  is_current boolean not null default true,
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (plan_id, version)
);

create index plan_versions_plan_id_idx on plan_versions (plan_id);

create table plan_entitlements (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references plan_versions (id) on delete cascade,
  feature_key text not null,
  numeric_limit numeric,
  is_enabled boolean not null default true,
  unique (plan_version_id, feature_key)
);

comment on table plan_entitlements is
  'feature_key examples: whatsapp_numbers, staff_seats, voice_enabled, monthly_messages, monthly_voice_minutes, document_knowledge_base, api_access. numeric_limit null means the feature is boolean-only (see is_enabled).';

create table company_entitlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  feature_key text not null,
  numeric_limit numeric,
  is_enabled boolean not null default true,
  reason text,
  granted_by uuid references platform_members (user_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (company_id, feature_key)
);

comment on table company_entitlements is
  'Per-company overrides on top of the plan (super-admin add-ons/overrides). packages/billing merges plan_entitlements + company_entitlements, with company_entitlements taking precedence.';

-- Internal, deterministic subscription state machine -- ADR-0006. Never derived
-- directly from a payment provider's own status vocabulary.
create type subscription_state as enum (
  'onboarding',
  'trial',
  'active',
  'payment_due',
  'grace_period',
  'suspended',
  'cancel_at_period_end',
  'cancelled',
  'manually_suspended',
  'closed'
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  plan_version_id uuid not null references plan_versions (id),
  state subscription_state not null default 'onboarding',
  provider text not null default 'razorpay',
  provider_subscription_id text,
  provider_status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_period_end timestamptz,
  suspension_reason text,
  cancellation_reason text,
  reactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id)
);

comment on table subscriptions is
  'One active subscription row per company (MVP: single subscription per tenant). state is the sole driver of entitlement checks; provider_status is stored for observability only.';

create index subscriptions_state_idx on subscriptions (state);

create table subscription_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  subscription_id uuid not null references subscriptions (id) on delete cascade,
  from_state subscription_state,
  to_state subscription_state not null,
  event text not null,
  provider_event_id text,
  is_manual_override boolean not null default false,
  actor_user_id uuid references auth.users (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  unique (provider_event_id)
);

comment on table subscription_events is
  'Append-only audit trail of every state transition, including manual super-admin overrides (is_manual_override=true) -- required by Master Prompt section 22.';

create index subscription_events_subscription_id_idx on subscription_events (subscription_id);

create type invoice_kind as enum ('subscription', 'service_charge', 'usage_overage');
create type invoice_status as enum ('draft', 'pending', 'partially_paid', 'paid', 'void', 'refunded');

create table invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  kind invoice_kind not null,
  invoice_number text not null unique,
  status invoice_status not null default 'draft',
  currency text not null default 'INR',
  subtotal numeric(12, 2) not null default 0,
  tax numeric(12, 2) not null default 0,
  discount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  due_date date,
  paid_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index invoices_company_id_idx on invoices (company_id);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_price numeric(12, 2) not null default 0,
  amount numeric(12, 2) not null default 0
);

create index invoice_items_invoice_id_idx on invoice_items (invoice_id);

create type payment_method as enum ('razorpay', 'manual_bank_transfer', 'manual_upi', 'other');
create type payment_status as enum ('pending', 'succeeded', 'failed', 'refunded');

create table payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  invoice_id uuid references invoices (id) on delete set null,
  method payment_method not null,
  status payment_status not null default 'pending',
  amount numeric(12, 2) not null,
  currency text not null default 'INR',
  provider_payment_id text,
  provider_reference text,
  payment_proof_storage_key text,
  submitted_by_user_id uuid references auth.users (id) on delete set null,
  approved_by_user_id uuid references platform_members (user_id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  notes text,
  created_at timestamptz not null default now(),
  unique (provider_payment_id)
);

comment on table payments is
  'Manual payments (bank transfer/UPI) require approved_by_user_id to be a platform_billing_admin or super_admin -- company users can never approve their own submission (Master Prompt section 25), enforced in packages/billing, not just by this schema.';

create index payments_company_id_idx on payments (company_id);

create table payment_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  subscription_id uuid references subscriptions (id) on delete cascade,
  provider text not null,
  provider_event_id text not null,
  status text not null,
  raw_payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

comment on table payment_attempts is
  'Raw provider webhook events, stored for idempotency (unique provider+event id) and replay/debugging. Never trust frontend payment-success parameters alone -- Master Prompt section 24.';

create index payment_attempts_subscription_id_idx on payment_attempts (subscription_id);

create type service_charge_status as enum (
  'not_created',
  'pending',
  'partially_paid',
  'paid',
  'waived',
  'refunded',
  'cancelled'
);

create table service_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  description text not null default 'Dravonix WhatsApp AI Platform implementation and service charge',
  amount numeric(12, 2) not null,
  currency text not null default 'INR',
  tax numeric(12, 2) not null default 0,
  discount numeric(12, 2) not null default 0,
  status service_charge_status not null default 'not_created',
  invoice_id uuid references invoices (id) on delete set null,
  due_date date,
  paid_date date,
  payment_provider text,
  payment_reference text,
  waiver_reason text,
  refund_status text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table service_charges is
  'One-time implementation/service charge (Master Prompt section 19A), independent of the recurring subscription. A company may not move to production activation until status is paid, waived, or overridden by a super-admin.';

create index service_charges_company_id_idx on service_charges (company_id);

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

create trigger invoices_set_updated_at
  before update on invoices
  for each row execute function set_updated_at();

create trigger service_charges_set_updated_at
  before update on service_charges
  for each row execute function set_updated_at();

alter table plans enable row level security;
alter table plan_versions enable row level security;
alter table plan_entitlements enable row level security;
alter table company_entitlements enable row level security;
alter table subscriptions enable row level security;
alter table subscription_events enable row level security;
alter table invoices enable row level security;
alter table invoice_items enable row level security;
alter table payments enable row level security;
alter table payment_attempts enable row level security;
alter table service_charges enable row level security;

-- Plans/plan_versions/plan_entitlements are public catalogue data (needed to
-- render pricing to any authenticated company admin considering an upgrade).
create policy plans_select_authenticated on plans
  for select
  using (auth.role() = 'authenticated' or is_platform_staff());

create policy plan_versions_select_authenticated on plan_versions
  for select
  using (auth.role() = 'authenticated' or is_platform_staff());

create policy plan_entitlements_select_authenticated on plan_entitlements
  for select
  using (auth.role() = 'authenticated' or is_platform_staff());

create policy company_entitlements_select_member on company_entitlements
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());

create policy subscriptions_select_member on subscriptions
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());

create policy subscription_events_select_member on subscription_events
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());

create policy invoices_select_member on invoices
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());

create policy invoice_items_select_member on invoice_items
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());

create policy payments_select_member on payments
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());

-- Company admins may submit a manual payment proof themselves (insert only,
-- status forced to 'pending' by application logic); approval is service-role
-- only, so no update policy is granted to authenticated company members.
create policy payments_insert_member on payments
  for insert
  with check (has_company_permission(company_id, 'billing.manage') and status = 'pending');

create policy payment_attempts_select_platform on payment_attempts
  for select
  using (is_platform_staff());

create policy service_charges_select_member on service_charges
  for select
  using (has_company_permission(company_id, 'billing.view') or is_platform_staff());
