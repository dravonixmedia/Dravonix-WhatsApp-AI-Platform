-- Dravonix WhatsApp AI Platform
-- Knowledge base, AI settings, voice settings, handover rules.
-- See docs/architecture/adr-0004-ai-provider-architecture.md and
-- docs/architecture/adr-0005-speech-provider-architecture.md.

create type knowledge_source_type as enum (
  'company_profile',
  'service',
  'product',
  'faq',
  'pricing',
  'location',
  'policy',
  'document'
);

create type knowledge_ingestion_status as enum (
  'pending',
  'processing',
  'ready',
  'failed',
  'disabled'
);

create table knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  source_type knowledge_source_type not null,
  title text not null,
  is_enabled boolean not null default true,
  ingestion_status knowledge_ingestion_status not null default 'ready',
  ingestion_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_sources_company_id_idx on knowledge_sources (company_id);

create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  knowledge_source_id uuid not null references knowledge_sources (id) on delete cascade,
  original_filename text,
  storage_key text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create index knowledge_documents_company_id_idx on knowledge_documents (company_id);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  knowledge_source_id uuid not null references knowledge_sources (id) on delete cascade,
  content text not null,
  content_tsv tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding vector(1536),
  chunk_index integer not null default 0,
  created_at timestamptz not null default now()
);

comment on column knowledge_chunks.embedding is
  'pgvector column, populated only when an embedding provider is configured. Retrieval falls back to full-text search (content_tsv) otherwise -- see packages/knowledge.';

create index knowledge_chunks_company_id_idx on knowledge_chunks (company_id);
create index knowledge_chunks_tsv_idx on knowledge_chunks using gin (content_tsv);
create index knowledge_chunks_source_id_idx on knowledge_chunks (knowledge_source_id);

create table ai_settings (
  company_id uuid primary key references companies (id) on delete cascade,
  system_prompt_notes text,
  reply_length text not null default 'medium' check (reply_length in ('short', 'medium', 'long')),
  required_disclaimers text[] not null default '{}',
  unknown_answer_behavior text not null default 'escalate'
    check (unknown_answer_behavior in ('escalate', 'static_fallback', 'best_effort')),
  updated_at timestamptz not null default now()
);

create table voice_settings (
  company_id uuid primary key references companies (id) on delete cascade,
  is_enabled boolean not null default true,
  provider text not null default 'google',
  default_voice_by_language jsonb not null default '{}'::jsonb,
  speaking_rate numeric(3, 2) not null default 1.0,
  max_reply_duration_seconds integer not null default 60,
  max_incoming_duration_seconds integer not null default 180,
  reply_mode text not null default 'auto'
    check (reply_mode in ('text_only', 'voice_only', 'text_and_voice', 'auto')),
  retention_days integer not null default 30,
  fallback_behavior text not null default 'text_only_with_notice'
    check (fallback_behavior in ('text_only_with_notice', 'escalate', 'retry_once')),
  updated_at timestamptz not null default now()
);

create type handover_trigger_type as enum (
  'customer_request',
  'low_confidence',
  'negative_sentiment',
  'payment_or_policy_dispute',
  'high_value_lead',
  'restricted_topic',
  'missing_knowledge',
  'keyword',
  'repeated_failure',
  'provider_failure',
  'business_hours'
);

create table handover_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  trigger_type handover_trigger_type not null,
  configuration jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index handover_rules_company_id_idx on handover_rules (company_id);

create trigger knowledge_sources_set_updated_at
  before update on knowledge_sources
  for each row execute function set_updated_at();

create trigger ai_settings_set_updated_at
  before update on ai_settings
  for each row execute function set_updated_at();

create trigger voice_settings_set_updated_at
  before update on voice_settings
  for each row execute function set_updated_at();

alter table knowledge_sources enable row level security;
alter table knowledge_documents enable row level security;
alter table knowledge_chunks enable row level security;
alter table ai_settings enable row level security;
alter table voice_settings enable row level security;
alter table handover_rules enable row level security;

create policy knowledge_sources_select_member on knowledge_sources
  for select
  using (has_company_permission(company_id, 'knowledge.view') or is_platform_staff());

create policy knowledge_sources_manage_member on knowledge_sources
  for all
  using (has_company_permission(company_id, 'knowledge.manage'))
  with check (has_company_permission(company_id, 'knowledge.manage'));

create policy knowledge_documents_select_member on knowledge_documents
  for select
  using (has_company_permission(company_id, 'knowledge.view') or is_platform_staff());

create policy knowledge_chunks_select_member on knowledge_chunks
  for select
  using (has_company_permission(company_id, 'knowledge.view') or is_platform_staff());

create policy ai_settings_select_member on ai_settings
  for select
  using (has_company_permission(company_id, 'ai_settings.view') or is_platform_staff());

create policy ai_settings_manage_member on ai_settings
  for all
  using (has_company_permission(company_id, 'ai_settings.manage'))
  with check (has_company_permission(company_id, 'ai_settings.manage'));

create policy voice_settings_select_member on voice_settings
  for select
  using (has_company_permission(company_id, 'ai_settings.view') or is_platform_staff());

create policy voice_settings_manage_member on voice_settings
  for all
  using (has_company_permission(company_id, 'ai_settings.manage'))
  with check (has_company_permission(company_id, 'ai_settings.manage'));

create policy handover_rules_select_member on handover_rules
  for select
  using (has_company_permission(company_id, 'ai_settings.view') or is_platform_staff());

create policy handover_rules_manage_member on handover_rules
  for all
  using (has_company_permission(company_id, 'ai_settings.manage'))
  with check (has_company_permission(company_id, 'ai_settings.manage'));
