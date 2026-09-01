-- Dravonix WhatsApp AI Platform
-- Meta/WhatsApp Batch 2: 24-hour customer service window + safe template
-- fallback foundation.
--
-- Objective: DRAIVA must never attempt an invalid free-form WhatsApp message
-- once Meta's 24-hour customer service window has closed for a conversation.
-- The window itself is computed purely from existing, already-indexed data
-- (messages.direction = 'inbound', ordered by the existing
-- messages_conversation_id_created_at_idx) -- this migration adds NO new
-- index or column for that read.
--
-- What THIS migration actually adds:
--   1. whatsapp_accounts.service_window_fallback_template_id -- the ONE
--      Meta-approved template Dravonix has configured as a company's/WABA's
--      safe fallback once the free-form window closes. Null means none is
--      configured yet.
--   2. admin_register_whatsapp_template / admin_set_service_window_fallback_template
--      -- Super-Admin-only SECURITY DEFINER RPCs. whatsapp_templates
--      (migration 3) has had zero writers and zero write RLS policy since
--      its creation, exactly like whatsapp_accounts/whatsapp_phone_numbers
--      before Meta/WhatsApp Batch 1 (migration 35) -- these are its first.
--      Registering a template here NEVER submits anything to Meta for
--      approval; it records a template Dravonix has already had approved
--      via Meta Business Manager, so it can be selected as a fallback.
--   3. reserve_human_template_outbound_message -- lets an assigned human
--      agent deliberately send the conversation's configured re-engagement
--      template once the free-form window has closed. The agent never
--      supplies a template id/name (Phase 8's "do not let the browser
--      choose arbitrary template IDs" rule) -- this always resolves and
--      validates the ONE account-configured, currently-approved fallback
--      template itself and returns its name/language.
--
-- What THIS migration deliberately does NOT add:
--   - No new outbound_delivery_status or message_channel_type enum value.
--     channel_type = 'template' already existed (migration 4) as a valid
--     outbound channel; reserve_ai_outbound_message and
--     finalize_ai_outbound_message (migration 12) already accept it
--     unmodified. A "blocked, no fallback configured" outcome is
--     represented as the EXISTING 'send_failed' status with a descriptive
--     last_send_error_code (see @dravonix/handover's outboundMessage.ts:
--     'whatsapp_service_window_no_fallback_template' /
--     'whatsapp_service_window_fallback_template_not_approved') rather than
--     a new status value -- deliberately avoiding `alter type ... add
--     value`, whose new value cannot safely be referenced by any function
--     created later in this SAME migration transaction (PostgreSQL: a
--     newly added enum value cannot be used until the transaction that
--     added it has committed).
--   - reserve_ai_outbound_message / finalize_ai_outbound_message /
--     reserve_human_outbound_message / finalize_human_outbound_message
--     (migration 12) are entirely UNCHANGED -- not one line edited. The
--     AI-path template fallback reuses reserve_ai_outbound_message /
--     finalize_ai_outbound_message exactly as they already exist, with
--     channel_type = 'template'; the human explicit re-engagement send
--     reuses finalize_human_outbound_message exactly as it already exists.
--   - No Embedded Signup, OAuth, or per-tenant credential storage.
--   - No dynamic template parameter substitution: the configured fallback
--     template is expected to be a fixed-text re-engagement message with no
--     variable placeholders (see the column comment below) -- this batch
--     sends it with zero body parameters. A future batch can add parameter
--     mapping if a real use case needs it.

-- ---------------------------------------------------------------------------
-- 1. The one designated service-window fallback template per WhatsApp
--    Business Account.
-- ---------------------------------------------------------------------------

alter table whatsapp_accounts
  add column service_window_fallback_template_id uuid references whatsapp_templates (id) on delete set null;

comment on column whatsapp_accounts.service_window_fallback_template_id is
  'The single Meta-approved template DRAIVA may send as a free-form-reply fallback once the 24-hour WhatsApp customer service window has closed for a conversation on this account (Meta/WhatsApp Batch 2). Null means no fallback is configured -- an outside-window AI/voice reply then fails safely (outbound_status = send_failed, last_send_error_code = whatsapp_service_window_no_fallback_template) rather than attempting an invalid free-form send. Set only via admin_set_service_window_fallback_template (Super Admin only). Expected to reference a template with no variable placeholders -- this batch never substitutes template parameters, always sending it with zero body components.';

-- Defense-in-depth, independent of the RPCs below: a WABA can never point
-- its fallback at a template belonging to a different account or company,
-- even via a future bug or direct database access.
create or replace function enforce_service_window_fallback_template_match()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_template public.whatsapp_templates%rowtype;
begin
  if new.service_window_fallback_template_id is null then
    return new;
  end if;

  select * into v_template
    from public.whatsapp_templates
    where id = new.service_window_fallback_template_id;

  if not found then
    raise exception 'service_window_fallback_template_not_found';
  end if;
  if v_template.whatsapp_account_id <> new.id then
    raise exception 'service_window_fallback_template_account_mismatch';
  end if;
  if v_template.company_id <> new.company_id then
    raise exception 'service_window_fallback_template_company_mismatch';
  end if;

  return new;
end;
$$;

create trigger whatsapp_accounts_enforce_fallback_template_match
  before insert or update on whatsapp_accounts
  for each row execute function enforce_service_window_fallback_template_match();

-- ---------------------------------------------------------------------------
-- 2. admin_register_whatsapp_template: Super Admin registers a template
--    already approved via Meta Business Manager. Never calls Meta; never
--    submits anything for approval. Safe to re-run for the same
--    (whatsapp_account_id, name, language): updates in place rather than
--    failing, matching admin_connect_whatsapp_account's (migration 35)
--    convention.
-- ---------------------------------------------------------------------------

create or replace function admin_register_whatsapp_template(
  p_company_id uuid,
  p_whatsapp_account_id uuid,
  p_name text,
  p_language text,
  p_category text default null,
  p_status whatsapp_template_status default 'approved',
  p_body text default '',
  p_variables jsonb default '[]'::jsonb
)
returns table (id uuid, name text, language text, category text, status whatsapp_template_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_language text := nullif(btrim(coalesce(p_language, '')), '');
  v_account public.whatsapp_accounts%rowtype;
  v_existing public.whatsapp_templates%rowtype;
  v_template public.whatsapp_templates%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if v_name is null then raise exception 'invalid_template_name'; end if;
  if v_language is null then raise exception 'invalid_template_language'; end if;

  select * into v_account
    from public.whatsapp_accounts
    where public.whatsapp_accounts.id = p_whatsapp_account_id
      and public.whatsapp_accounts.company_id = p_company_id;
  if not found then raise exception 'whatsapp_account_not_found'; end if;

  select * into v_existing
    from public.whatsapp_templates
    where public.whatsapp_templates.whatsapp_account_id = p_whatsapp_account_id
      and public.whatsapp_templates.name = v_name
      and public.whatsapp_templates.language = v_language;

  if found then
    update public.whatsapp_templates
      set category = p_category,
          status = p_status,
          body = coalesce(p_body, ''),
          variables = coalesce(p_variables, '[]'::jsonb)
      where public.whatsapp_templates.id = v_existing.id
      returning * into v_template;
  else
    insert into public.whatsapp_templates
        (company_id, whatsapp_account_id, name, language, category, status, body, variables)
      values
        (p_company_id, p_whatsapp_account_id, v_name, v_language, p_category, p_status,
         coalesce(p_body, ''), coalesce(p_variables, '[]'::jsonb))
      returning * into v_template;
  end if;

  return query select v_template.id, v_template.name, v_template.language, v_template.category, v_template.status;
end;
$$;

revoke all on function admin_register_whatsapp_template(uuid, uuid, text, text, text, whatsapp_template_status, text, jsonb) from public, anon;
grant execute on function admin_register_whatsapp_template(uuid, uuid, text, text, text, whatsapp_template_status, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_set_service_window_fallback_template: designate (or, with
--    p_template_id = null, clear) the fallback template for a WABA. Rejects
--    a not-found/wrong-company/wrong-account/not-yet-approved template
--    rather than silently accepting it -- never fabricates or guesses an
--    approved template.
-- ---------------------------------------------------------------------------

create or replace function admin_set_service_window_fallback_template(
  p_company_id uuid,
  p_whatsapp_account_id uuid,
  p_template_id uuid
)
returns table (id uuid, service_window_fallback_template_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.whatsapp_accounts%rowtype;
  v_template public.whatsapp_templates%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_account
    from public.whatsapp_accounts
    where public.whatsapp_accounts.id = p_whatsapp_account_id
      and public.whatsapp_accounts.company_id = p_company_id;
  if not found then raise exception 'whatsapp_account_not_found'; end if;

  if p_template_id is not null then
    select * into v_template
      from public.whatsapp_templates
      where public.whatsapp_templates.id = p_template_id
        and public.whatsapp_templates.whatsapp_account_id = p_whatsapp_account_id
        and public.whatsapp_templates.company_id = p_company_id;
    if not found then raise exception 'whatsapp_template_not_found'; end if;
    if v_template.status <> 'approved' then raise exception 'whatsapp_template_not_approved'; end if;
  end if;

  update public.whatsapp_accounts
    set service_window_fallback_template_id = p_template_id
    where public.whatsapp_accounts.id = p_whatsapp_account_id
    returning public.whatsapp_accounts.id, public.whatsapp_accounts.service_window_fallback_template_id
    into id, service_window_fallback_template_id;

  return next;
end;
$$;

revoke all on function admin_set_service_window_fallback_template(uuid, uuid, uuid) from public, anon;
grant execute on function admin_set_service_window_fallback_template(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. reserve_human_template_outbound_message: an assigned/authorized human
--    agent may deliberately send the conversation's configured
--    re-engagement template once the free-form service window has closed.
--    Mirrors reserve_human_outbound_message's (migration 12) authorization
--    exactly, but hardcodes channel_type = 'template' and never accepts a
--    body/template id from the caller -- it always resolves the ONE
--    account-configured, currently-approved template itself (SECURITY
--    DEFINER, bypasses RLS, so this is correct regardless of the calling
--    agent's own whatsapp.view grant) and returns its name/language so the
--    caller can build the real Graph API request.
--    finalize_human_outbound_message (migration 12, unchanged) finalizes
--    this reservation exactly like any other human-authored outbound
--    message.
-- ---------------------------------------------------------------------------

create or replace function reserve_human_template_outbound_message(
  p_conversation_id uuid,
  p_idempotency_key text
)
returns table (
  id uuid,
  claimed boolean,
  outbound_status outbound_delivery_status,
  provider_message_id text,
  template_name text,
  template_language text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_member_id uuid;
  v_account_id uuid;
  v_template public.whatsapp_templates%rowtype;
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
  end if;

  select whatsapp_account_id into v_account_id
    from public.whatsapp_phone_numbers
    where public.whatsapp_phone_numbers.id = v_conv.whatsapp_phone_number_id;
  if v_account_id is null then raise exception 'whatsapp_account_not_found'; end if;

  select t.* into v_template
    from public.whatsapp_accounts a
    join public.whatsapp_templates t on t.id = a.service_window_fallback_template_id
    where a.id = v_account_id and t.status = 'approved';
  if not found then raise exception 'no_fallback_template_configured'; end if;

  -- Scope the client-supplied key to (member, conversation) server-side,
  -- exactly like reserve_human_outbound_message.
  v_key := v_member_id::text || ':' || p_conversation_id::text || ':' || p_idempotency_key;

  insert into public.messages
      (company_id, conversation_id, direction, channel_type, sender_type, sender_member_id,
       idempotency_key, outbound_status, send_claimed_at, send_lease_expires_at, send_attempt_count)
    values
      (v_conv.company_id, p_conversation_id, 'outbound', 'template', 'human_agent', v_member_id,
       v_key, 'sending', now(), now() + interval '2 minutes', 1)
    on conflict (idempotency_key) do nothing
    returning public.messages.id into v_id;

  if v_id is not null then
    return query select v_id, true, 'sending'::public.outbound_delivery_status, null::text,
      v_template.name, v_template.language;
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
    return query select v_id, true, v_status, v_provider_message_id, v_template.name, v_template.language;
    return;
  end if;

  return query
    select m.id, false, m.outbound_status, m.provider_message_id, v_template.name, v_template.language
    from public.messages m where m.idempotency_key = v_key;
end;
$$;

revoke all on function reserve_human_template_outbound_message(uuid, text) from public, anon;
grant execute on function reserve_human_template_outbound_message(uuid, text) to authenticated;
