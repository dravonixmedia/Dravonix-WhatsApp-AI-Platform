-- Dravonix WhatsApp AI Platform
-- Usage metering, notifications, webhook/job observability, audit logging,
-- support-access sessions.

create type usage_metric as enum (
  'whatsapp_inbound_messages',
  'whatsapp_outbound_messages',
  'whatsapp_template_messages',
  'active_contacts',
  'claude_input_tokens',
  'claude_cached_input_tokens',
  'claude_output_tokens',
  'claude_requests',
  'speech_to_text_seconds',
  'text_to_speech_characters',
  'generated_voice_seconds',
  'stored_audio_bytes',
  'knowledge_storage_bytes',
  'document_processing_jobs',
  'staff_seats',
  'whatsapp_numbers',
  'failed_provider_calls'
);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  metric usage_metric not null,
  quantity numeric not null,
  is_billable boolean not null default true,
  provider_request_id text,
  conversation_id uuid references conversations (id) on delete set null,
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  unique (idempotency_key)
);

comment on table usage_events is
  'Raw, immutable per-event usage records (Master Prompt section 26). is_billable=false separates failed/free attempts from billable usage. Aggregated into usage_summaries per billing period; raw rows are retained for audit.';

create index usage_events_company_metric_idx on usage_events (company_id, metric, occurred_at);

create table usage_summaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  metric usage_metric not null,
  period_start date not null,
  period_end date not null,
  total_quantity numeric not null default 0,
  billable_quantity numeric not null default 0,
  estimated_cost numeric(12, 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, metric, period_start, period_end)
);

create index usage_summaries_company_id_idx on usage_summaries (company_id);

create type notification_channel as enum ('in_app', 'email', 'whatsapp_template');
create type notification_audience as enum ('company_admin', 'customer_contact', 'platform_staff');

create table notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete cascade,
  audience notification_audience not null,
  channel notification_channel not null,
  recipient_user_id uuid references auth.users (id) on delete set null,
  recipient_contact_id uuid references contacts (id) on delete set null,
  category text not null,
  subject text,
  body text not null,
  sent_at timestamptz,
  read_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

comment on table notifications is
  'category examples: renewal_upcoming, payment_failed, grace_period_started, account_suspended, whatsapp_disconnected, handover_requested, high_value_lead. Billing notifications are always audience=company_admin -- never sent to customer contacts (Master Prompt section 32).';

create index notifications_company_id_idx on notifications (company_id);

create type webhook_event_status as enum ('received', 'processed', 'duplicate', 'unrouted', 'failed');
create type webhook_event_source as enum ('whatsapp', 'razorpay');

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  source webhook_event_source not null,
  provider_event_id text not null,
  company_id uuid references companies (id) on delete set null,
  status webhook_event_status not null default 'received',
  raw_payload jsonb not null,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source, provider_event_id)
);

comment on table webhook_events is
  'Idempotency + audit record for every inbound webhook delivery (ADR-0002). company_id is null for status=unrouted events (unknown phone_number_id), which are kept for admin visibility rather than dropped.';

create index webhook_events_status_idx on webhook_events (status);
create index webhook_events_company_id_idx on webhook_events (company_id);

create type job_failure_status as enum ('retrying', 'dead_letter', 'resolved');

create table job_failures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete set null,
  queue_name text not null,
  job_id text not null,
  correlation_id text,
  attempt integer not null default 1,
  status job_failure_status not null default 'retrying',
  error text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table job_failures is
  'Dead-letter visibility for apps/workers/* consumers (ADR-0003), retriable from the super-admin dashboard.';

create index job_failures_status_idx on job_failures (status);
create index job_failures_company_id_idx on job_failures (company_id);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_type text not null default 'user' check (actor_type in ('user', 'platform_staff', 'system')),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table audit_logs is
  'Every sensitive action -- logins, setting changes, knowledge changes, billing actions, manual suspensions, handovers, support access, invitations, role changes, WhatsApp connection changes, and every super-admin action -- is written here (Master Prompt sections 9, 17, 18). Writes happen only via the service-role-backed audit writer in packages/observability, never directly from client code.';

create index audit_logs_company_id_idx on audit_logs (company_id);
create index audit_logs_actor_user_id_idx on audit_logs (actor_user_id);
create index audit_logs_created_at_idx on audit_logs (created_at);

create table support_access_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  platform_user_id uuid not null references platform_members (user_id) on delete cascade,
  reason text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table support_access_sessions is
  'Time-limited, audited support access (Master Prompt section 9): a platform_support/super_admin user accessing a company workspace must have an active, unexpired row here, and every such session is itself an audit_logs entry. The dashboard must visibly banner "support access active" for the duration.';

create index support_access_sessions_company_id_idx on support_access_sessions (company_id);
create index support_access_sessions_active_idx on support_access_sessions (platform_user_id) where ended_at is null;

create trigger usage_summaries_set_updated_at
  before update on usage_summaries
  for each row execute function set_updated_at();

alter table usage_events enable row level security;
alter table usage_summaries enable row level security;
alter table notifications enable row level security;
alter table webhook_events enable row level security;
alter table job_failures enable row level security;
alter table audit_logs enable row level security;
alter table support_access_sessions enable row level security;

create policy usage_events_select_member on usage_events
  for select
  using (has_company_permission(company_id, 'usage.view') or is_platform_staff());

create policy usage_summaries_select_member on usage_summaries
  for select
  using (has_company_permission(company_id, 'usage.view') or is_platform_staff());

create policy notifications_select_recipient on notifications
  for select
  using (
    recipient_user_id = auth.uid()
    or (company_id is not null and has_company_permission(company_id, 'settings.manage'))
    or is_platform_staff()
  );

-- webhook_events, job_failures: platform-staff only; company dashboards never
-- see raw webhook payloads directly.
create policy webhook_events_select_platform on webhook_events
  for select
  using (is_platform_staff());

create policy job_failures_select_platform on job_failures
  for select
  using (is_platform_staff());

create policy audit_logs_select_member on audit_logs
  for select
  using (
    (company_id is not null and has_company_permission(company_id, 'audit.view'))
    or is_platform_staff()
  );

create policy support_access_sessions_select_platform on support_access_sessions
  for select
  using (is_platform_staff());
