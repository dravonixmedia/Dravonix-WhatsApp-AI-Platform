-- Dravonix WhatsApp AI Platform
-- Contacts, conversations, messages, media, transcriptions, generated audio.

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  whatsapp_wa_id text not null,
  profile_name text,
  display_name text,
  is_blocked boolean not null default false,
  last_detected_language text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, whatsapp_wa_id)
);

comment on column contacts.profile_name is
  'WhatsApp profile name as reported by Meta. Not assumed to be legally accurate (Master Prompt section 15).';

create index contacts_company_id_idx on contacts (company_id);

create table contact_preferences (
  contact_id uuid primary key references contacts (id) on delete cascade,
  reply_mode text
    check (reply_mode in ('text_only', 'voice_only', 'text_and_voice', 'auto')),
  preferred_language text,
  updated_at timestamptz not null default now()
);

create type conversation_state as enum (
  'ai_active',
  'handover_requested',
  'queued_for_agent',
  'human_active',
  'paused',
  'closed'
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  whatsapp_phone_number_id uuid references whatsapp_phone_numbers (id) on delete set null,
  state conversation_state not null default 'ai_active',
  last_message_at timestamptz,
  last_ai_summary text,
  unresolved_questions text[] not null default '{}',
  handover_reason text,
  assigned_member_id uuid references company_members (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_company_id_idx on conversations (company_id);
create index conversations_company_state_idx on conversations (company_id, state);
create index conversations_contact_id_idx on conversations (contact_id);

create table conversation_assignments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  assigned_to uuid not null references company_members (id) on delete cascade,
  assigned_by uuid references company_members (id) on delete set null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz
);

create index conversation_assignments_conversation_id_idx on conversation_assignments (conversation_id);

create table conversation_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  author_member_id uuid references company_members (id) on delete set null,
  note text not null,
  created_at timestamptz not null default now()
);

create index conversation_notes_conversation_id_idx on conversation_notes (conversation_id);

create type message_direction as enum ('inbound', 'outbound');
create type message_channel_type as enum ('text', 'audio', 'template', 'system');
create type message_sender_type as enum ('customer', 'ai', 'human_agent', 'system');

create table messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  direction message_direction not null,
  channel_type message_channel_type not null,
  sender_type message_sender_type not null,
  sender_member_id uuid references company_members (id) on delete set null,
  provider_message_id text,
  body text,
  detected_language text,
  language_confidence numeric(3, 2),
  reply_mode text,
  ai_structured_response jsonb,
  created_at timestamptz not null default now(),
  unique (provider_message_id)
);

comment on column messages.provider_message_id is
  'Meta WhatsApp message ID (wamid). Unique constraint is the core idempotency mechanism for inbound webhook retries and outbound send confirmations -- see ADR-0002.';

create index messages_company_id_idx on messages (company_id);
create index messages_conversation_id_created_at_idx on messages (conversation_id, created_at);

create type message_status as enum ('sent', 'delivered', 'read', 'failed');

create table message_status_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  message_id uuid not null references messages (id) on delete cascade,
  status message_status not null,
  failure_reason text,
  provider_timestamp timestamptz,
  created_at timestamptz not null default now()
);

comment on table message_status_events is
  'Append-only. Every status event is kept (not just the latest) so out-of-order delivery from Meta can be reconciled by rank rather than blind overwrite -- see ADR-0002.';

create index message_status_events_message_id_idx on message_status_events (message_id);

create type media_kind as enum ('inbound_audio', 'outbound_audio', 'knowledge_document');

create table media_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  kind media_kind not null,
  message_id uuid references messages (id) on delete cascade,
  storage_key text not null,
  mime_type text,
  size_bytes bigint,
  duration_seconds numeric(6, 2),
  provider_media_id text,
  retention_expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

comment on column media_files.storage_key is
  'Tenant-scoped storage key of the form companies/{company_id}/... built exclusively by packages/storage/src/keys.ts -- see ADR-0007.';

create index media_files_company_id_idx on media_files (company_id);
create index media_files_retention_idx on media_files (retention_expires_at) where deleted_at is null;

create table transcriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  media_file_id uuid not null references media_files (id) on delete cascade,
  message_id uuid references messages (id) on delete cascade,
  provider text not null,
  raw_text text not null,
  corrected_text text,
  detected_language text,
  language_confidence numeric(3, 2),
  corrected_by_member_id uuid references company_members (id) on delete set null,
  corrected_at timestamptz,
  created_at timestamptz not null default now()
);

create index transcriptions_company_id_idx on transcriptions (company_id);

create table generated_audio (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  message_id uuid references messages (id) on delete cascade,
  media_file_id uuid references media_files (id) on delete cascade,
  provider text not null,
  voice_id text,
  language text,
  source_text text not null,
  created_at timestamptz not null default now()
);

create index generated_audio_company_id_idx on generated_audio (company_id);

create trigger contacts_set_updated_at
  before update on contacts
  for each row execute function set_updated_at();

create trigger conversations_set_updated_at
  before update on conversations
  for each row execute function set_updated_at();

alter table contacts enable row level security;
alter table contact_preferences enable row level security;
alter table conversations enable row level security;
alter table conversation_assignments enable row level security;
alter table conversation_notes enable row level security;
alter table messages enable row level security;
alter table message_status_events enable row level security;
alter table media_files enable row level security;
alter table transcriptions enable row level security;
alter table generated_audio enable row level security;

create policy contacts_select_member on contacts
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy contact_preferences_select_member on contact_preferences
  for select
  using (
    exists (
      select 1 from contacts c
      where c.id = contact_preferences.contact_id
        and (has_company_permission(c.company_id, 'conversations.view') or is_platform_staff())
    )
  );

create policy conversations_select_member on conversations
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy conversation_assignments_select_member on conversation_assignments
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy conversation_notes_select_member on conversation_notes
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy conversation_notes_insert_member on conversation_notes
  for insert
  with check (has_company_permission(company_id, 'conversations.reply'));

create policy conversation_assignments_insert_member on conversation_assignments
  for insert
  with check (has_company_permission(company_id, 'conversations.assign'));

create policy conversation_assignments_update_member on conversation_assignments
  for update
  using (has_company_permission(company_id, 'conversations.assign'))
  with check (has_company_permission(company_id, 'conversations.assign'));

create policy messages_select_member on messages
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy message_status_events_select_member on message_status_events
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy media_files_select_member on media_files
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy transcriptions_select_member on transcriptions
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

create policy generated_audio_select_member on generated_audio
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());
