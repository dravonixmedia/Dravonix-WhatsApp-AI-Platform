-- Dravonix WhatsApp AI Platform
-- Human Handover Inbox (final plan: /root/.claude/plans/bright-sniffing-mountain.md).
--
-- Adds: collaborative-handover columns (ai_mode, separate from conversation
-- state), the durable outbound-message reserve/claim/lease/finalize lifecycle,
-- a durable source-keyed handover_events table (fixes redelivery-after-
-- End-human-assistance duplicate handovers), and every SECURITY DEFINER RPC
-- required for dashboard writes (hardened: empty search_path, fully-qualified
-- names, explicit auth.uid()/membership/company/permission checks, row
-- locking, minimal return projections, signature-qualified REVOKE/GRANT) and
-- worker writes (separate, service_role-only RPC family).

-- ---------------------------------------------------------------------------
-- 1. Conversation workflow/AI-mode columns
-- ---------------------------------------------------------------------------

alter table conversations
  add column state_changed_at timestamptz not null default now(),
  add column handover_last_read_at timestamptz;

comment on column conversations.state_changed_at is
  'Maintained by conversations_set_state_changed_at, independent of updated_at (which also bumps on unrelated writes). Used to derive handover-inbox priority (time spent waiting unclaimed).';
comment on column conversations.handover_last_read_at is
  'Last time a human read this conversation in the Human Handover inbox. Null means never read -- unread_count then counts every inbound message in the conversation''s history.';

create or replace function set_conversation_state_changed_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state is distinct from new.state then
    new.state_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger conversations_set_state_changed_at
  before update on conversations
  for each row execute function set_conversation_state_changed_at();

create type conversation_ai_mode as enum ('active', 'paused');

alter table conversations
  add column ai_mode conversation_ai_mode not null default 'active';

comment on column conversations.ai_mode is
  'Independent of state: whether the AI keeps auto-replying while a human assists. Flipped only by the explicit Pause AI / Resume AI actions -- never implied by state alone (Human Handover Inbox: AI continues collaboratively by default).';

-- ---------------------------------------------------------------------------
-- 2. New permissions: reassign (Start human conversation / reply override)
--    and reconcile (manual delivery reconciliation). Owner/admin/manager
--    only -- agent intentionally excluded, mirroring the existing
--    assign/view permission split.
-- ---------------------------------------------------------------------------

insert into permissions (key, description) values
  ('conversations.reassign', 'Reassign a conversation already claimed by another team member, or reply on their behalf'),
  ('conversations.reconcile', 'Manually resolve an outbound message stuck in delivery_unknown');

insert into role_permissions (role, permission_key) values
  ('company_owner', 'conversations.reassign'),
  ('company_admin', 'conversations.reassign'),
  ('manager', 'conversations.reassign'),
  ('company_owner', 'conversations.reconcile'),
  ('company_admin', 'conversations.reconcile'),
  ('manager', 'conversations.reconcile');

-- ---------------------------------------------------------------------------
-- 3. Outbound-message lifecycle columns, leases, and failure classification
-- ---------------------------------------------------------------------------

create type outbound_delivery_status as enum (
  'reserved',         -- row exists, no provider call has started
  'sending',          -- a provider call is in progress, claimed by exactly one caller
  'sent',             -- Meta accepted, provider_message_id recorded
  'send_failed',      -- Meta definitively rejected/errored before acceptance -- retry-eligible only if retryable
  'delivery_unknown'  -- acceptance by Meta could not be confirmed durably -- NEVER auto-resent
);

alter table messages
  add column idempotency_key text,
  add column outbound_status outbound_delivery_status,
  add column source_message_id uuid references messages (id) on delete set null,
  add column send_claimed_at timestamptz,
  add column send_lease_expires_at timestamptz,
  add column send_attempt_count integer not null default 0,
  add column last_send_error_code text,
  add column retryable boolean,
  add column legacy_outbound boolean not null default false;

comment on column messages.idempotency_key is
  'Set only on human-reply outbound rows, before the WhatsApp send is attempted. Server-composited as "<memberId>:<conversationId>:<clientKey>" so a client-generated key is always scoped, never trusted raw. Enforced unique so a second reservation attempt for the same logical reply is rejected before any second WhatsApp send is even considered.';
comment on column messages.source_message_id is
  'Set only on AI-reply outbound rows: the inbound message that triggered this reply. Combined with channel_type in a partial unique index (messages_source_message_channel_uq_idx, covering every row here regardless of legacy_outbound) so one inbound message can produce at most one AI reply per reply channel (text/audio) -- including across the migration-12 cutover, so a replayed pre-migration queue job or retry can never resend a reply a deterministically-linked legacy row already covers. Null on a legacy_outbound row means the backfill in section 3a below could not deterministically reconstruct which inbound message triggered it (an ambiguous historical duplicate) -- never a fabricated guess, and therefore also never part of this uniqueness rule (NULL never collides with NULL).';
comment on column messages.send_lease_expires_at is
  'While outbound_status=sending, no other caller may claim this row until this lease expires. A stale expired lease is either reclaimed by a natural retry or flipped to delivery_unknown by the scheduled outbound-reconciler Worker -- whichever guarded update wins the race is correct either way; never both.';
comment on column messages.retryable is
  'Classification of the most recent send failure: true for transient provider errors (rate limit, 5xx, network failure before acceptance) eligible for automatic reclaim; false for permanent errors (bad token, invalid recipient, malformed payload, non-rate-limit 4xx) requiring a configuration fix or an authorized manual action before any retry.';
comment on column messages.legacy_outbound is
  'True only for a direction=outbound, sender_type=ai row that existed before this migration ran (backfilled by section 3a below), never set by any post-migration insert or update path -- enforced by messages_legacy_outbound_scope_check (scopes it to outbound/ai rows only), messages_ai_reply_source_check (the only way source_message_id may be null), and the messages_prevent_legacy_outbound_flag trigger (rejects any insert, or update, that actually transitions this value -- a no-op reaffirmation of the current value is allowed). Deliberately NOT excluded from the source_message_id/channel_type partial uniqueness index -- a deterministically-linked legacy row must still block a replayed pre-migration queue job or retry from creating a second, live reservation for the same inbound message and channel. Every legacy_outbound row is a real historical WhatsApp send that must never be deleted or reattributed.';

-- ---------------------------------------------------------------------------
-- 3a. Legacy outbound-message backfill, for databases with rows written
--     before this migration (pre-migration-12 databases only -- a fresh
--     database has no direction='outbound' rows yet and every statement
--     below is a no-op on it).
--
-- Every pre-migration-12 insert path -- recordOutboundMessage
-- (message-consumer), recordOutboundTextMessage and
-- recordOutboundVoiceMessage (voice-consumer), all replaced in "Human
-- Handover Inbox (4/N)" -- called deps.whatsappProvider.sendText/... first
-- and only inserted the row afterwards, wrapped in recordOutboundSafely,
-- with providerMessageId a required (non-optional) parameter sourced from
-- that call's own successful return value. A thrown send error propagated
-- out of the caller before any insert was attempted, so no pre-migration
-- code path ever persisted a reserved/pending/failed outbound row -- every
-- existing outbound row already represents a send Meta accepted. 'sent' is
-- therefore the only status this data can correctly hold, not a guess;
-- 'delivered'/'read' are never assigned here since no pre-migration path
-- ever recorded a delivery/read receipt on the messages row itself (that
-- evidence, where it exists, lives in message_status_events, which this
-- migration does not touch). Every such row is also flagged legacy_outbound
-- = true -- it is preserved exactly as sent, never deleted, never given a
-- fabricated source_message_id merely to satisfy a constraint.
-- ---------------------------------------------------------------------------

update messages
  set outbound_status = 'sent',
      legacy_outbound = true
  where direction = 'outbound'
    and outbound_status is null;

-- Every one of those same pre-migration call sites also always inserted
-- sender_type = 'ai' (no human-reply feature existed before this migration --
-- reserve_human_outbound_message and friends are new in this file), so
-- source_message_id (also new) has no prior column to read it from.
--
-- Deterministic-pairing rule: for each conversation, independently for each
-- AI reply channel (text, audio -- the only two a pre-migration-12 AI reply
-- could ever use; template/system outbound rows were never sender_type='ai'),
-- walk the conversation's messages in (created_at, id) order maintaining a
-- FIFO queue of inbound message ids not yet claimed *for that channel*. Each
-- unset AI outbound row on that channel claims the oldest still-queued
-- inbound message -- the same order the old message-consumer/voice-consumer
-- actually processed inbound messages in. Channels are queued independently
-- (rather than sharing one queue across every AI outbound row) because one
-- inbound message can legitimately produce both a text AND an audio AI reply
-- (a dual-channel turn) -- consuming that inbound id for the text pairing
-- must never remove it from the audio channel's own queue, or the two
-- legitimate siblings would be mismatched to different inbound messages.
--
-- An AI outbound row on a channel whose queue is already empty when it's
-- reached -- i.e. an extra reply on that channel with no fresh inbound
-- message left to explain it -- is a historical duplicate (e.g. the
-- pre-migration retry-bug bursts seen in production: the same reply
-- re-sent several times for one inbound message). It is deliberately left
-- with source_message_id null rather than re-paired to an inbound message
-- another reply on the same channel already claimed: that inbound message
-- already has its one deterministic reply, and attributing a second,
-- indistinguishable duplicate to it would be a fabricated relationship, not
-- a reconstructed one. messages_ai_reply_source_check's legacy_outbound
-- branch (below) is exactly what allows this row to remain valid with a
-- null source_message_id.
--
-- Every predicate touched here is "... is null", so re-running this
-- migration (or this block alone) against an already-backfilled database is
-- a no-op.
do $$
declare
  v_conv record;
  v_channel message_channel_type;
  v_channels constant message_channel_type[] := array['text', 'audio']::message_channel_type[];
  v_msg record;
  v_pending_inbound uuid[];
begin
  for v_conv in
    select distinct conversation_id
    from messages
    where direction = 'outbound' and sender_type = 'ai' and source_message_id is null
  loop
    foreach v_channel in array v_channels
    loop
      v_pending_inbound := '{}';
      for v_msg in
        select id, direction, source_message_id
        from messages
        where conversation_id = v_conv.conversation_id
          and (direction = 'inbound'
               or (direction = 'outbound' and sender_type = 'ai' and channel_type = v_channel))
        order by created_at, id
      loop
        if v_msg.direction = 'inbound' then
          v_pending_inbound := v_pending_inbound || v_msg.id;
        elsif v_msg.source_message_id is null and array_length(v_pending_inbound, 1) > 0 then
          update messages set source_message_id = v_pending_inbound[1] where id = v_msg.id;
          v_pending_inbound := v_pending_inbound[2 : array_length(v_pending_inbound, 1)];
        end if;
        -- else: this channel's queue is already empty -- an ambiguous
        -- historical duplicate. Left source_message_id null, deliberately.
      end loop;
    end loop;
  end loop;
end $$;

-- idempotency_key: Postgres never treats NULL as equal to NULL for
-- uniqueness, so unlimited inbound/non-human-reply rows (which never set
-- this column) coexist safely without any WHERE predicate, and a plain
-- ON CONFLICT (col) target correctly matches a plain constraint.
alter table messages add constraint messages_idempotency_key_uq unique (idempotency_key);

-- source_message_id/channel_type: a partial unique index, not a plain
-- constraint -- scoped to every row with a real source_message_id
-- (direction=outbound, sender_type=ai, source_message_id not null),
-- deliberately NOT excluding legacy_outbound rows. This is the strict
-- "at most one AI reply per inbound message per channel" rule
-- reserve_ai_outbound_message's ON CONFLICT depends on for its idempotent
-- redelivery handling, and it must cover a deterministically-linked legacy
-- row too: if a pre-migration-12 queue job or retry is replayed after this
-- migration deploys, reserve_ai_outbound_message must see the already-linked
-- legacy reply as a conflict and hand back its existing terminal 'sent'
-- status, never insert a second live row that goes on to resend the same
-- WhatsApp message. Only rows the section 3a backfill left with
-- source_message_id null (ambiguous duplicate bursts, never deterministically
-- claimed) fall outside this index -- NULL never collides with NULL under
-- any unique index, partial or not, so those are unaffected either way. The
-- predicate must be repeated verbatim in reserve_ai_outbound_message's ON
-- CONFLICT clause for Postgres to infer this index as the arbiter (see
-- section 6 below) -- every row that function inserts always satisfies it,
-- so this is safe, not merely convenient.
create unique index messages_source_message_channel_uq_idx on messages (source_message_id, channel_type)
  where direction = 'outbound' and sender_type = 'ai' and source_message_id is not null;

alter table messages add constraint messages_outbound_fields_check check (
  (direction = 'inbound' and outbound_status is null and idempotency_key is null and source_message_id is null and legacy_outbound = false)
  or (direction = 'outbound' and outbound_status is not null)
);
alter table messages add constraint messages_sender_member_id_check check (
  (sender_type = 'human_agent' and sender_member_id is not null)
  or (sender_type = 'ai' and sender_member_id is null)
  or (sender_type not in ('human_agent', 'ai'))
);
alter table messages add constraint messages_human_reply_idempotency_check check (
  not (direction = 'outbound' and sender_type = 'human_agent') or idempotency_key is not null
);

-- legacy_outbound may only ever be true on a direction=outbound,
-- sender_type=ai row -- the only shape any pre-migration-12 outbound insert
-- path ever produced. This is what guarantees inbound rows, human-reply
-- rows, and every future AI reply alike can never be flagged legacy, without
-- needing a created_at cutover: the *shape* of a legacy row is what's
-- checked, never a timestamp.
alter table messages add constraint messages_legacy_outbound_scope_check check (
  not legacy_outbound or (direction = 'outbound' and sender_type = 'ai')
);

-- Every *new* (non-legacy) AI reply must always have source_message_id --
-- that is what reserve_ai_outbound_message always provides, and what the
-- partial uniqueness index above depends on. A legacy_outbound row may have
-- source_message_id null (an ambiguous historical duplicate the section 3a
-- backfill could not deterministically reconstruct) only when it is also
-- unmistakably shaped like the backfill itself produced -- outbound_status
-- already resolved to 'sent', a real provider_message_id on file, and no
-- reservation/lease lifecycle marker ever touched it (send_claimed_at,
-- send_lease_expires_at, send_attempt_count, last_send_error_code,
-- retryable all still at their pristine defaults). reserve_ai_outbound_message
-- always inserts with outbound_status='sending' and send_claimed_at set, so
-- no row that ever went through the real reservation lifecycle -- even one
-- with a wrongly-flipped legacy_outbound -- could ever satisfy this branch;
-- ordinary future inserts cannot back into looking legacy by accident.
alter table messages add constraint messages_ai_reply_source_check check (
  not (direction = 'outbound' and sender_type = 'ai')
  or source_message_id is not null
  or (
    legacy_outbound = true
    and outbound_status = 'sent'
    and provider_message_id is not null
    and send_claimed_at is null
    and send_lease_expires_at is null
    and send_attempt_count = 0
    and last_send_error_code is null
    and retryable is null
  )
);

-- Defense-in-depth: even if a future RPC has a bug, this trigger rejects any
-- outbound_status transition outside the approved set at the schema level.
create or replace function enforce_outbound_status_transition() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.outbound_status is not distinct from new.outbound_status then
    return new;
  end if;
  if old.outbound_status = 'reserved' and new.outbound_status = 'sending' then return new; end if;
  if old.outbound_status = 'sending' and new.outbound_status in ('sent', 'send_failed', 'delivery_unknown') then return new; end if;
  if old.outbound_status = 'send_failed' and new.outbound_status = 'sending' then return new; end if;
  if old.outbound_status = 'delivery_unknown' and new.outbound_status in ('sent', 'send_failed') then return new; end if;
  raise exception 'invalid_status_transition';
end;
$$;

create trigger messages_enforce_outbound_status_transition
  before update of outbound_status on messages
  for each row execute function enforce_outbound_status_transition();

-- Defense-in-depth for legacy_outbound itself: created *after* section 3a's
-- backfill UPDATE has already run (so it never blocks that one, legitimate
-- write), this trigger rejects any *transition* of legacy_outbound -- insert
-- with it true, or update from false to true (fabricating history) or from
-- true to false (stripping a real historical row of its classification, with
-- no separately justified admin/migration path implemented to allow it). A
-- no-op reaffirmation of the row's current value (true->true or false->false
-- -- e.g. a full-column UPDATE that happens to list legacy_outbound unchanged)
-- is explicitly allowed: checking `old.legacy_outbound is distinct from
-- new.legacy_outbound` rather than merely `new.legacy_outbound`, so this
-- never blocks an ordinary update to an already-legacy row that isn't
-- actually trying to change the flag. No RPC in this migration (or any
-- future one) should ever need to transition it at all; the column exists to
-- describe rows this migration itself is backfilling, not a flag application
-- code sets. Combined with messages_legacy_outbound_scope_check and
-- messages_ai_reply_source_check above, this is what makes "ordinary future
-- inserts cannot claim to be legacy accidentally" hold even against a buggy
-- future RPC, not just against the RPCs that exist today.
create or replace function prevent_legacy_outbound_flag() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.legacy_outbound then
      raise exception 'legacy_outbound_not_settable';
    end if;
    return new;
  end if;

  if old.legacy_outbound is distinct from new.legacy_outbound then
    raise exception 'legacy_outbound_not_settable';
  end if;
  return new;
end;
$$;

create trigger messages_prevent_legacy_outbound_flag
  before insert or update of legacy_outbound on messages
  for each row execute function prevent_legacy_outbound_flag();

-- ---------------------------------------------------------------------------
-- 4. handover_events: durable, source-keyed handover idempotency.
--    NOT keyed by conversation.state -- a delayed/redelivered queue message
--    arriving after the conversation has cycled all the way back through
--    ai_active (via End human assistance) must remain a permanent no-op.
-- ---------------------------------------------------------------------------

create table handover_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  source_message_id uuid references messages (id) on delete set null,
  source_type text not null check (source_type in ('text', 'voice', 'system')),
  handover_event_key text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (handover_event_key)
);

comment on table handover_events is
  'Durable record of every handover-triggering event, keyed by the originating message (or an explicit idempotency key for system-sourced handovers) -- NOT by conversation.state. A delayed/redelivered queue message that already fired a handover once is a permanent no-op here, even after the conversation later returns to ai_active and could in principle re-enter handover_requested for a genuinely new reason.';

create index handover_events_conversation_id_idx on handover_events (conversation_id);

alter table handover_events enable row level security;

-- Direct writes are never allowed for any client role -- the only insert path
-- is trigger_handover, which runs as the function/table owner and so
-- bypasses RLS by Postgres default (the same mechanism audit_logs/
-- notifications already rely on for their service-role-only writes).
revoke insert, update, delete on handover_events from public, anon, authenticated;

create policy handover_events_select_member on handover_events
  for select
  using (has_company_permission(company_id, 'conversations.view') or is_platform_staff());

-- ---------------------------------------------------------------------------
-- 5. trigger_handover: the one atomic, source-keyed handover operation
--    called by every trusted background source (message-consumer,
--    voice-consumer, and any future one) via the service-role client.
-- ---------------------------------------------------------------------------

create or replace function trigger_handover(
  p_conversation_id uuid,
  p_reason text,
  p_source_message_id uuid,
  p_source_type text,
  p_idempotency_key text default null
)
returns table (id uuid, state conversation_state, handover_reason text, is_new_event boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_event_key text;
  v_event_id uuid;
  v_notified_count integer := 0;
  v_recipient record;
begin
  if p_source_type not in ('text', 'voice', 'system') then
    raise exception 'invalid_source_type';
  end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then
    raise exception 'conversation_not_found';
  end if;

  if p_source_message_id is not null then
    if not exists (
      select 1 from public.messages
      where public.messages.id = p_source_message_id
        and public.messages.conversation_id = p_conversation_id
        and public.messages.company_id = v_conv.company_id
    ) then
      raise exception 'source_message_mismatch';
    end if;
    v_event_key := 'handover_msg:' || p_source_message_id::text;
  else
    if p_idempotency_key is null then
      raise exception 'idempotency_key_required';
    end if;
    v_event_key := 'handover_sys:' || p_idempotency_key;
  end if;

  insert into public.handover_events
      (conversation_id, company_id, source_message_id, source_type, handover_event_key, reason)
    values (p_conversation_id, v_conv.company_id, p_source_message_id, p_source_type, v_event_key, p_reason)
    on conflict (handover_event_key) do nothing
    returning public.handover_events.id into v_event_id;

  if v_event_id is null then
    -- Durable no-op: this exact originating message already triggered a
    -- handover at some point in this conversation's history, regardless of
    -- what state it's in right now.
    return query select v_conv.id, v_conv.state, v_conv.handover_reason, false;
    return;
  end if;

  if v_conv.state <> 'ai_active' then
    -- A genuinely new escalation signal arriving while already mid-handover:
    -- recorded for audit, but does not re-transition or re-notify.
    return query select v_conv.id, v_conv.state, v_conv.handover_reason, true;
    return;
  end if;

  update public.conversations set state = 'handover_requested', handover_reason = p_reason
    where public.conversations.id = p_conversation_id
    returning * into v_conv;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_conv.company_id, null, 'system', 'handover.requested', 'conversation', p_conversation_id::text,
            jsonb_build_object('reason', p_reason, 'handover_event_id', v_event_id, 'source_type', p_source_type));

  for v_recipient in
    select distinct cm.user_id
    from public.company_members cm
    join public.role_permissions rp on rp.role = cm.role
    where cm.company_id = v_conv.company_id
      and cm.is_active = true
      and rp.permission_key = 'conversations.assign'
  loop
    insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body)
      values (v_conv.company_id, 'company_admin', 'in_app', v_recipient.user_id,
              'human_handover_requested', 'New handover requested', p_reason);
    v_notified_count := v_notified_count + 1;
  end loop;

  if v_notified_count = 0 then
    for v_recipient in
      select distinct cm.user_id
      from public.company_members cm
      where cm.company_id = v_conv.company_id
        and cm.is_active = true
        and cm.role in ('company_owner', 'company_admin')
    loop
      insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body)
        values (v_conv.company_id, 'company_admin', 'in_app', v_recipient.user_id,
                'human_handover_requested', 'New handover requested (no assign-permission holder found)', p_reason);
      v_notified_count := v_notified_count + 1;
    end loop;
  end if;

  if v_notified_count = 0 then
    -- Ultimate fallback: a single row, visible to every platform-staff
    -- member via the existing is_platform_staff() RLS clause (no per-recipient
    -- fan-out needed for that tier). The transaction never commits with zero
    -- notification rows.
    insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body)
      values (v_conv.company_id, 'platform_staff', 'in_app', null,
              'human_handover_requested', 'Handover requested with no eligible company recipient', p_reason);
  end if;

  return query select v_conv.id, v_conv.state, v_conv.handover_reason, true;
end;
$$;

revoke all on function trigger_handover(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function trigger_handover(uuid, text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. AI outbound reserve/finalize -- service_role only. company_id/
--    conversation_id/sender_type are always derived from the source
--    (inbound) message row, never accepted as a parameter.
-- ---------------------------------------------------------------------------

create or replace function reserve_ai_outbound_message(
  p_source_message_id uuid,
  p_channel_type message_channel_type
)
returns table (id uuid, claimed boolean, outbound_status outbound_delivery_status, provider_message_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.messages%rowtype;
  v_id uuid;
  v_status public.outbound_delivery_status;
  v_provider_message_id text;
begin
  select * into v_source from public.messages where public.messages.id = p_source_message_id;
  if not found or v_source.direction <> 'inbound' then
    raise exception 'source_message_not_found';
  end if;

  -- legacy_outbound is never listed here -- it keeps its column default of
  -- false. The ON CONFLICT predicate below deliberately does NOT filter on
  -- legacy_outbound, so it also matches an existing legacy row -- if
  -- p_source_message_id/p_channel_type was already deterministically linked
  -- to a pre-migration-12 reply (section 3a's backfill), this insert
  -- conflicts against that legacy row instead of creating a second, live
  -- one; the fallthrough logic below then finds and returns that existing
  -- (already 'sent') row with claimed=false, exactly as it would for any
  -- other already-resolved reservation. This is what keeps a replayed
  -- pre-migration queue job or retry from resending a message Meta already
  -- accepted once. The predicate must still be repeated verbatim here for
  -- Postgres to infer messages_source_message_channel_uq_idx (a partial
  -- index) as this statement's arbiter.
  insert into public.messages
      (company_id, conversation_id, direction, channel_type, sender_type, source_message_id,
       outbound_status, send_claimed_at, send_lease_expires_at, send_attempt_count)
    values
      (v_source.company_id, v_source.conversation_id, 'outbound', p_channel_type, 'ai', p_source_message_id,
       'sending', now(), now() + interval '2 minutes', 1)
    on conflict (source_message_id, channel_type)
      where direction = 'outbound' and sender_type = 'ai' and source_message_id is not null
    do nothing
    returning public.messages.id into v_id;

  if v_id is not null then
    return query select v_id, true, 'sending'::public.outbound_delivery_status, null::text;
    return;
  end if;

  -- A reservation already exists (redelivered queue message, or a prior
  -- send_failed/expired-lease attempt). Guarded claim -- only one caller's
  -- UPDATE can match, so two Workers racing the same redelivered message
  -- can't both proceed to call Meta.
  update public.messages
    set outbound_status = 'sending',
        send_claimed_at = now(),
        send_lease_expires_at = now() + interval '2 minutes',
        send_attempt_count = public.messages.send_attempt_count + 1
    where public.messages.source_message_id = p_source_message_id and public.messages.channel_type = p_channel_type
      and (
        public.messages.outbound_status = 'reserved'
        or (public.messages.outbound_status = 'send_failed' and public.messages.retryable = true)
        or (public.messages.outbound_status = 'sending' and public.messages.send_lease_expires_at < now())
      )
    returning public.messages.id, public.messages.outbound_status, public.messages.provider_message_id
    into v_id, v_status, v_provider_message_id;

  if found then
    return query select v_id, true, v_status, v_provider_message_id;
    return;
  end if;

  -- Could not claim: already sending elsewhere, already sent (including a
  -- deterministically-linked legacy_outbound row -- outbound_status='sent'
  -- never matches the guarded UPDATE above, legacy or not), a permanent
  -- (non-retryable) send_failed, or delivery_unknown (never auto-resent).
  -- The caller (message-consumer/voice-consumer) treats claimed=false with
  -- outbound_status='sent' as already fully handled: no Anthropic call, no
  -- WhatsApp/ElevenLabs send, no finalize call.
  return query
    select m.id, false, m.outbound_status, m.provider_message_id
    from public.messages m
    where m.source_message_id = p_source_message_id and m.channel_type = p_channel_type;
end;
$$;

create or replace function finalize_ai_outbound_message(
  p_message_id uuid,
  p_status outbound_delivery_status,
  p_provider_message_id text,
  p_body text,
  p_error_code text default null,
  p_retryable boolean default null
)
returns table (id uuid, outbound_status outbound_delivery_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.messages%rowtype;
begin
  if p_status not in ('sent', 'send_failed', 'delivery_unknown') then
    raise exception 'invalid_status_transition';
  end if;

  select * into v_msg from public.messages where public.messages.id = p_message_id for update;
  if not found or v_msg.sender_type <> 'ai' then raise exception 'message_not_found'; end if;
  if v_msg.outbound_status <> 'sending' then raise exception 'invalid_status_transition'; end if;

  update public.messages
    set outbound_status = p_status,
        provider_message_id = coalesce(p_provider_message_id, public.messages.provider_message_id),
        body = coalesce(p_body, public.messages.body),
        last_send_error_code = p_error_code,
        retryable = p_retryable
    where public.messages.id = p_message_id
    returning public.messages.id, public.messages.outbound_status into id, outbound_status;

  if p_status = 'sent' then
    update public.conversations set last_message_at = now() where public.conversations.id = v_msg.conversation_id;
  end if;
  return next;
end;
$$;

revoke all on function reserve_ai_outbound_message(uuid, message_channel_type) from public, anon, authenticated;
grant execute on function reserve_ai_outbound_message(uuid, message_channel_type) to service_role;
revoke all on function finalize_ai_outbound_message(uuid, outbound_delivery_status, text, text, text, boolean) from public, anon, authenticated;
grant execute on function finalize_ai_outbound_message(uuid, outbound_delivery_status, text, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Human outbound reserve/finalize -- authenticated only. sender_member_id
--    is always derived from auth.uid(); company_id is always derived from
--    the conversation. Restricted to the assigned member, or an override
--    holder (conversations.reassign), audited distinctly.
-- ---------------------------------------------------------------------------

create or replace function reserve_human_outbound_message(
  p_conversation_id uuid,
  p_body text,
  p_idempotency_key text
)
returns table (id uuid, claimed boolean, outbound_status outbound_delivery_status, provider_message_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_member_id uuid;
  v_key text;
  v_id uuid;
  v_status public.outbound_delivery_status;
  v_provider_message_id text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key_required';
  end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;
  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_conv.company_id, 'conversations.reply') then
    raise exception 'permission_denied';
  end if;
  if v_conv.state <> 'human_active' then raise exception 'invalid_state_transition'; end if;

  select cm.id into v_member_id from public.company_members cm
    where cm.company_id = v_conv.company_id and cm.user_id = auth.uid() and cm.is_active = true;

  if v_conv.assigned_member_id is null then
    raise exception 'conversation_not_assigned';
  end if;

  if v_conv.assigned_member_id <> v_member_id then
    if not public.has_company_permission(v_conv.company_id, 'conversations.reassign') then
      raise exception 'conversation_not_assigned_to_caller';
    end if;
    -- Manager override: allowed to reply without reassigning; audited
    -- distinctly, never silently changes assigned_member_id.
    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_conv.company_id, auth.uid(), 'user', 'handover.manager_override_reply', 'conversation',
              p_conversation_id::text,
              jsonb_build_object('assigned_member_id', v_conv.assigned_member_id, 'acting_member_id', v_member_id));
  end if;

  -- Scope the client-supplied key to (member, conversation) server-side, so
  -- it's never trusted as globally unique on its own.
  v_key := v_member_id::text || ':' || p_conversation_id::text || ':' || p_idempotency_key;

  insert into public.messages
      (company_id, conversation_id, direction, channel_type, sender_type, sender_member_id, body,
       idempotency_key, outbound_status, send_claimed_at, send_lease_expires_at, send_attempt_count)
    values
      (v_conv.company_id, p_conversation_id, 'outbound', 'text', 'human_agent', v_member_id, p_body,
       v_key, 'sending', now(), now() + interval '2 minutes', 1)
    on conflict (idempotency_key) do nothing
    returning public.messages.id into v_id;

  if v_id is not null then
    return query select v_id, true, 'sending'::public.outbound_delivery_status, null::text;
    return;
  end if;

  update public.messages
    set outbound_status = 'sending',
        send_claimed_at = now(),
        send_lease_expires_at = now() + interval '2 minutes',
        send_attempt_count = public.messages.send_attempt_count + 1
    where public.messages.idempotency_key = v_key
      and (
        public.messages.outbound_status = 'reserved'
        or (public.messages.outbound_status = 'send_failed' and public.messages.retryable = true)
        or (public.messages.outbound_status = 'sending' and public.messages.send_lease_expires_at < now())
      )
    returning public.messages.id, public.messages.outbound_status, public.messages.provider_message_id
    into v_id, v_status, v_provider_message_id;

  if found then
    return query select v_id, true, v_status, v_provider_message_id;
    return;
  end if;

  return query
    select m.id, false, m.outbound_status, m.provider_message_id
    from public.messages m where m.idempotency_key = v_key;
end;
$$;

create or replace function finalize_human_outbound_message(
  p_message_id uuid,
  p_status outbound_delivery_status,
  p_provider_message_id text,
  p_error_code text default null,
  p_retryable boolean default null
)
returns table (id uuid, outbound_status outbound_delivery_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_msg public.messages%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_status not in ('sent', 'send_failed', 'delivery_unknown') then
    raise exception 'invalid_status_transition';
  end if;

  select * into v_msg from public.messages where public.messages.id = p_message_id for update;
  if not found or v_msg.sender_type <> 'human_agent' then raise exception 'message_not_found'; end if;

  select cm.id into v_member_id from public.company_members cm
    where cm.company_id = v_msg.company_id and cm.user_id = auth.uid() and cm.is_active = true;

  -- Cannot finalize (or, by extension, edit) a reservation owned by a
  -- different employee -- prevents touching an arbitrary/another employee's
  -- message row, even under the reply-override permission (which authorizes
  -- sending a *new* message, not editing someone else's in-flight one).
  if v_msg.sender_member_id is distinct from v_member_id then raise exception 'not_reservation_owner'; end if;
  if v_msg.outbound_status <> 'sending' then raise exception 'invalid_status_transition'; end if;

  update public.messages
    set outbound_status = p_status,
        provider_message_id = coalesce(p_provider_message_id, public.messages.provider_message_id),
        last_send_error_code = p_error_code,
        retryable = p_retryable
    where public.messages.id = p_message_id
    returning public.messages.id, public.messages.outbound_status into id, outbound_status;

  if p_status = 'sent' then
    update public.conversations set last_message_at = now(), handover_last_read_at = now()
      where public.conversations.id = v_msg.conversation_id;
  end if;
  return next;
end;
$$;

revoke all on function reserve_human_outbound_message(uuid, text, text) from public, anon;
grant execute on function reserve_human_outbound_message(uuid, text, text) to authenticated;
revoke all on function finalize_human_outbound_message(uuid, outbound_delivery_status, text, text, boolean) from public, anon;
grant execute on function finalize_human_outbound_message(uuid, outbound_delivery_status, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Manual delivery reconciliation -- never sends a WhatsApp message
--    (Postgres functions cannot make HTTP calls); only ever transitions a
--    delivery_unknown row to sent or send_failed.
-- ---------------------------------------------------------------------------

create or replace function reconcile_outbound_message(
  p_message_id uuid,
  p_resolution text,
  p_provider_message_id text default null,
  p_reason text default null
)
returns table (id uuid, outbound_status outbound_delivery_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.messages%rowtype;
  v_member_id uuid;
  v_new_status public.outbound_delivery_status;
  v_actor_user_id uuid;
  v_actor_type text;
begin
  if p_resolution not in ('confirm_sent', 'confirm_not_sent') then
    raise exception 'invalid_resolution';
  end if;

  select * into v_msg from public.messages where public.messages.id = p_message_id for update;
  if not found or v_msg.direction <> 'outbound' then raise exception 'message_not_found'; end if;
  if v_msg.outbound_status <> 'delivery_unknown' then raise exception 'invalid_status_transition'; end if;

  if v_msg.sender_type = 'human_agent' then
    if auth.uid() is null then raise exception 'unauthorized'; end if;
    if not public.has_company_permission(v_msg.company_id, 'conversations.reconcile') then
      raise exception 'permission_denied';
    end if;
    select cm.id into v_member_id from public.company_members cm
      where cm.company_id = v_msg.company_id and cm.user_id = auth.uid() and cm.is_active = true;
    v_actor_user_id := auth.uid();
    v_actor_type := 'user';
  elsif v_msg.sender_type = 'ai' then
    -- Only the trusted service-role path may reconcile an AI-authored
    -- message -- there is no per-employee owner of an AI reply to check
    -- against, and this keeps human-authored reconciliation strictly
    -- attributable to a real acting user for audit purposes.
    if auth.uid() is not null then raise exception 'permission_denied'; end if;
    v_actor_user_id := null;
    v_actor_type := 'system';
  else
    raise exception 'message_not_found';
  end if;

  v_new_status := case p_resolution when 'confirm_sent' then 'sent'::public.outbound_delivery_status
                                     else 'send_failed'::public.outbound_delivery_status end;

  update public.messages
    set outbound_status = v_new_status,
        provider_message_id = coalesce(p_provider_message_id, public.messages.provider_message_id)
    where public.messages.id = p_message_id
    returning public.messages.id, public.messages.outbound_status into id, outbound_status;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_msg.company_id, v_actor_user_id, v_actor_type, 'handover.outbound_reconciled', 'message',
            p_message_id::text,
            jsonb_build_object('previous_status', 'delivery_unknown', 'final_status', v_new_status,
                                'reason', p_reason, 'provider_message_id', p_provider_message_id));

  return next;
end;
$$;

revoke all on function reconcile_outbound_message(uuid, text, text, text) from public, anon;
grant execute on function reconcile_outbound_message(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Scheduled lease-expiry sweep -- service_role only, called by the
--    outbound-reconciler Worker's Cron Trigger. Never sends or resends
--    anything; only ever transitions an expired 'sending' row to
--    'delivery_unknown' plus an audit/notification trail.
-- ---------------------------------------------------------------------------

create or replace function expire_stale_outbound_sends()
returns setof messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.messages%rowtype;
  v_recipient record;
begin
  for v_row in
    update public.messages
      set outbound_status = 'delivery_unknown'
      where outbound_status = 'sending' and send_lease_expires_at < now()
      returning public.messages.*
  loop
    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_row.company_id, null, 'system', 'handover.outbound_lease_expired', 'message', v_row.id::text,
              jsonb_build_object('conversation_id', v_row.conversation_id, 'sender_type', v_row.sender_type));

    for v_recipient in
      select distinct cm.user_id
      from public.company_members cm
      join public.role_permissions rp on rp.role = cm.role
      where cm.company_id = v_row.company_id and cm.is_active = true and rp.permission_key = 'conversations.assign'
    loop
      insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body)
        values (v_row.company_id, 'company_admin', 'in_app', v_recipient.user_id, 'message_processing_failed',
                'Outbound message delivery status unknown',
                'An outbound WhatsApp message needs manual reconciliation.');
    end loop;

    return next v_row;
  end loop;
  return;
end;
$$;

revoke all on function expire_stale_outbound_sends() from public, anon, authenticated;
grant execute on function expire_stale_outbound_sends() to service_role;

-- ---------------------------------------------------------------------------
-- 10. Dashboard mutation RPCs -- authenticated only, hardened per the
--     template above: security definer, empty search_path, fully-qualified
--     names, auth.uid()/membership/permission checks in order, row-locked,
--     minimal projection, fixed exception vocabulary.
-- ---------------------------------------------------------------------------

create or replace function handover_assign_to_me(p_conversation_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_member_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;

  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
    raise exception 'permission_denied';
  end if;

  select cm.id into v_member_id from public.company_members cm
    where cm.company_id = v_conv.company_id and cm.user_id = auth.uid() and cm.is_active = true;

  if v_conv.assigned_member_id is not null then raise exception 'conversation_already_claimed'; end if;
  if v_conv.state not in ('handover_requested', 'queued_for_agent') then
    raise exception 'invalid_state_transition';
  end if;

  update public.conversations set assigned_member_id = v_member_id, state = 'human_active'
    where public.conversations.id = p_conversation_id returning * into v_conv;
  insert into public.conversation_assignments (conversation_id, company_id, assigned_to, assigned_by)
    values (p_conversation_id, v_conv.company_id, v_member_id, v_member_id);
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.assigned_to_self', 'conversation', p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

create or replace function handover_assign_to_member(p_conversation_id uuid, p_target_member_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_target public.company_members%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;

  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
    raise exception 'permission_denied';
  end if;

  select * into v_target from public.company_members
    where public.company_members.id = p_target_member_id
      and public.company_members.company_id = v_conv.company_id
      and public.company_members.is_active = true;
  if not found then raise exception 'target_member_not_found'; end if;

  if v_conv.state <> 'handover_requested' then raise exception 'invalid_state_transition'; end if;

  update public.conversations set assigned_member_id = p_target_member_id, state = 'queued_for_agent'
    where public.conversations.id = p_conversation_id returning * into v_conv;
  insert into public.conversation_assignments (conversation_id, company_id, assigned_to, assigned_by)
    values (p_conversation_id, v_conv.company_id, p_target_member_id,
            (select cm.id from public.company_members cm
               where cm.company_id = v_conv.company_id and cm.user_id = auth.uid() and cm.is_active = true));
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.assigned_to_member', 'conversation',
            p_conversation_id::text, jsonb_build_object('target_member_id', p_target_member_id));
  insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body)
    values (v_conv.company_id, 'company_admin', 'in_app', v_target.user_id, 'human_handover_requested',
            'A conversation has been assigned to you', v_conv.handover_reason);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

create or replace function handover_start(p_conversation_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_member_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;

  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
    raise exception 'permission_denied';
  end if;

  select cm.id into v_member_id from public.company_members cm
    where cm.company_id = v_conv.company_id and cm.user_id = auth.uid() and cm.is_active = true;

  if v_conv.assigned_member_id = v_member_id and v_conv.state = 'queued_for_agent' then
    -- (A) already assigned to caller
    update public.conversations set state = 'human_active'
      where public.conversations.id = p_conversation_id returning * into v_conv;
  elsif v_conv.assigned_member_id is null and v_conv.state in ('handover_requested', 'queued_for_agent') then
    -- (B) unassigned: claim for caller
    update public.conversations set assigned_member_id = v_member_id, state = 'human_active'
      where public.conversations.id = p_conversation_id returning * into v_conv;
    insert into public.conversation_assignments (conversation_id, company_id, assigned_to, assigned_by)
      values (p_conversation_id, v_conv.company_id, v_member_id, v_member_id);
  elsif v_conv.assigned_member_id is not null and v_conv.assigned_member_id <> v_member_id then
    -- (C) assigned to someone else: only an explicit override may proceed
    if not public.has_company_permission(v_conv.company_id, 'conversations.reassign') then
      raise exception 'conversation_not_assigned_to_caller';
    end if;
    update public.conversations set assigned_member_id = v_member_id, state = 'human_active'
      where public.conversations.id = p_conversation_id returning * into v_conv;
    insert into public.conversation_assignments (conversation_id, company_id, assigned_to, assigned_by)
      values (p_conversation_id, v_conv.company_id, v_member_id, v_member_id);
  else
    raise exception 'invalid_state_transition';
  end if;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.started', 'conversation', p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

create or replace function handover_mark_queued(p_conversation_id uuid)
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
  if not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
    raise exception 'permission_denied';
  end if;
  if v_conv.state <> 'handover_requested' then raise exception 'invalid_state_transition'; end if;

  update public.conversations set state = 'queued_for_agent'
    where public.conversations.id = p_conversation_id returning * into v_conv;
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.marked_queued', 'conversation', p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

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
  if not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
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
  if not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
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

create or replace function handover_pause_ai(p_conversation_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_member_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;
  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;

  select cm.id into v_member_id from public.company_members cm
    where cm.company_id = v_conv.company_id and cm.user_id = auth.uid() and cm.is_active = true;

  if v_conv.assigned_member_id is distinct from v_member_id
     and not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
    raise exception 'permission_denied';
  end if;

  update public.conversations set ai_mode = 'paused'
    where public.conversations.id = p_conversation_id returning * into v_conv;
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.ai_paused', 'conversation', p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

create or replace function handover_resume_ai(p_conversation_id uuid)
returns table (id uuid, state conversation_state, ai_mode conversation_ai_mode,
               assigned_member_id uuid, handover_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_member_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_conv from public.conversations where public.conversations.id = p_conversation_id for update;
  if not found then raise exception 'conversation_not_found'; end if;
  if not public.is_company_member(v_conv.company_id) then raise exception 'not_a_member'; end if;

  select cm.id into v_member_id from public.company_members cm
    where cm.company_id = v_conv.company_id and cm.user_id = auth.uid() and cm.is_active = true;

  if v_conv.assigned_member_id is distinct from v_member_id
     and not public.has_company_permission(v_conv.company_id, 'conversations.assign') then
    raise exception 'permission_denied';
  end if;

  update public.conversations set ai_mode = 'active'
    where public.conversations.id = p_conversation_id returning * into v_conv;
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_conv.company_id, auth.uid(), 'user', 'handover.ai_resumed', 'conversation', p_conversation_id::text);

  return query select v_conv.id, v_conv.state, v_conv.ai_mode, v_conv.assigned_member_id, v_conv.handover_reason;
end;
$$;

create or replace function handover_mark_read(p_conversation_id uuid)
returns table (id uuid, handover_last_read_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select public.conversations.company_id into v_company_id
    from public.conversations where public.conversations.id = p_conversation_id;
  if v_company_id is null then raise exception 'conversation_not_found'; end if;
  if not public.has_company_permission(v_company_id, 'conversations.view') then
    raise exception 'permission_denied';
  end if;

  update public.conversations set handover_last_read_at = now()
    where public.conversations.id = p_conversation_id
    returning public.conversations.id, public.conversations.handover_last_read_at into id, handover_last_read_at;
  return next;
end;
$$;

revoke all on function handover_assign_to_me(uuid) from public, anon;
grant execute on function handover_assign_to_me(uuid) to authenticated;
revoke all on function handover_assign_to_member(uuid, uuid) from public, anon;
grant execute on function handover_assign_to_member(uuid, uuid) to authenticated;
revoke all on function handover_start(uuid) from public, anon;
grant execute on function handover_start(uuid) to authenticated;
revoke all on function handover_mark_queued(uuid) from public, anon;
grant execute on function handover_mark_queued(uuid) to authenticated;
revoke all on function handover_end_human_assistance(uuid) from public, anon;
grant execute on function handover_end_human_assistance(uuid) to authenticated;
revoke all on function handover_close_conversation(uuid) from public, anon;
grant execute on function handover_close_conversation(uuid) to authenticated;
revoke all on function handover_pause_ai(uuid) from public, anon;
grant execute on function handover_pause_ai(uuid) to authenticated;
revoke all on function handover_resume_ai(uuid) from public, anon;
grant execute on function handover_resume_ai(uuid) to authenticated;
revoke all on function handover_mark_read(uuid) from public, anon;
grant execute on function handover_mark_read(uuid) to authenticated;
