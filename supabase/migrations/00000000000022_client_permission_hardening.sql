-- Dravonix WhatsApp AI Platform
-- Client Dashboard Permission Hardening + Super Admin Company Management.
--
-- Read-only audit (prior turn) found that "AI Settings"/"Knowledge Base"
-- being view-only for clients was previously enforced only by disabling the
-- client's <form>/hiding buttons -- the underlying RLS policies still
-- granted ai_settings.manage/knowledge.manage to company_owner/company_admin
-- (and knowledge.manage to knowledge_editor), so a direct authenticated
-- Supabase client call could still write those tables. This migration makes
-- the database itself the authorization boundary: it revokes the specific
-- permission grants that allowed those writes, adds the narrower
-- view/display-name permissions the final client model needs, hardens
-- update_user_display_name (migration 21) to require the new
-- team.display_name.manage permission instead of an unconditional self-edit
-- bypass, and adds Super Admin-only RPCs so Dravonix can manage Company
-- Profile / AI Settings / Voice Settings / Knowledge Base per company from
-- /admin/companies/[id] without ever needing to act through the client
-- dashboard. Additive plus targeted revokes only -- no table is dropped, no
-- existing row is deleted, Migration 21 itself is not edited (this
-- redefines one of its functions via CREATE OR REPLACE, the same pattern
-- migration 21 itself used for pre-existing functions).
--
-- Explicitly NOT touched here: invitation token/acceptance flow, Supabase
-- email confirmation/resume flow, ZeptoMail, Cloudflare, Meta/WhatsApp
-- credentials, conversation-level Pause AI/Resume AI (handover_pause_ai/
-- handover_resume_ai/conversations.ai_mode -- already proven
-- conversation-scoped and gated on conversations.assign, unrelated to any
-- permission changed here), billing provider integration, production.

-- ---------------------------------------------------------------------------
-- 1. New permission keys.
-- ---------------------------------------------------------------------------

insert into permissions (key, description) values
  ('team.view', 'View company team members: display name, email, role, and status'),
  ('team.display_name.manage', 'Edit the display name of an existing member of the same company'),
  ('settings.view', 'View company profile, business preferences, and workspace configuration');

-- ---------------------------------------------------------------------------
-- 2. Revoke client-manage permissions. company_owner/company_admin keep
--    every operational permission (conversations.*, leads.*, usage.view,
--    audit.view) and every *.view permission unchanged; they lose the
--    permissions that let them write configuration Dravonix now owns
--    exclusively. knowledge_editor loses knowledge.manage (keeps
--    knowledge.view/ai_settings.view -- a pure view role going forward, per
--    the approved target model). No other role held any of these
--    permissions, so no other role is affected.
-- ---------------------------------------------------------------------------

delete from role_permissions
where role in ('company_owner', 'company_admin')
  and permission_key in (
    'team.manage', 'settings.manage', 'ai_settings.manage', 'knowledge.manage',
    'whatsapp.manage', 'billing.manage'
  );

delete from role_permissions
where role = 'knowledge_editor' and permission_key = 'knowledge.manage';

insert into role_permissions (role, permission_key)
values
  ('company_owner', 'team.view'),
  ('company_owner', 'team.display_name.manage'),
  ('company_owner', 'settings.view'),
  ('company_admin', 'team.view'),
  ('company_admin', 'team.display_name.manage'),
  ('company_admin', 'settings.view')
on conflict (role, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. notifications RLS: the company-wide (non-self) visibility branch
--    previously keyed on settings.manage (the permission that used to
--    identify "owner/admin of this company"). settings.manage no longer
--    exists for any client role after step 2 -- replaced here with
--    settings.view, which step 2 grants to exactly the same two roles
--    (company_owner/company_admin), so this is a like-for-like swap, not a
--    widening or narrowing of who sees company-wide notifications.
--    Notifications remains full client operational access, unchanged.
-- ---------------------------------------------------------------------------

alter policy notifications_select_recipient on notifications
  using (
    recipient_user_id = auth.uid()
    or (company_id is not null and has_company_permission(company_id, 'settings.view'))
    or is_platform_staff()
  );

-- ---------------------------------------------------------------------------
-- 4. update_user_display_name (migration 21) hardening: the unconditional
--    "any authenticated user may rename themselves" bypass is removed.
--    Authorization is now exactly one rule -- the caller must hold
--    team.display_name.manage in a company where the target is a *currently
--    active* member -- which naturally also covers self-edit for a
--    company_owner/company_admin (they are always an active member of
--    their own company and hold team.display_name.manage there), without a
--    special case: the join matches the caller's own membership row as
--    both "caller" and "target" when p_user_id = auth.uid(). A member with
--    no team.display_name.manage grant (every role except company_owner/
--    company_admin after step 2) can no longer rename anyone, including
--    themselves, through this RPC -- matching the approved model's
--    "no personal/account-profile display-name edit for normal clients."
--    admin_update_user_display_name (Super Admin-only) is untouched.
-- ---------------------------------------------------------------------------

create or replace function update_user_display_name(p_user_id uuid, p_display_name text)
returns table (updated_user_id uuid, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_normalized text;
  v_is_self boolean;
  v_shared_company_id uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then raise exception 'unauthorized'; end if;

  v_normalized := nullif(trim(p_display_name), '');
  if v_normalized is null then raise exception 'invalid_display_name'; end if;
  if length(v_normalized) > 150 then raise exception 'display_name_too_long'; end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'target_user_not_found';
  end if;

  v_is_self := (v_caller = p_user_id);

  select cm_caller.company_id into v_shared_company_id
    from public.company_members cm_caller
    join public.company_members cm_target
      on cm_target.company_id = cm_caller.company_id
     and cm_target.user_id = p_user_id
     and cm_target.is_active = true
    where cm_caller.user_id = v_caller
      and cm_caller.is_active = true
      and public.has_company_permission(cm_caller.company_id, 'team.display_name.manage')
    limit 1;

  if v_shared_company_id is null then
    raise exception 'permission_denied';
  end if;

  insert into public.user_profiles (user_id, display_name, created_at, updated_at)
    values (p_user_id, v_normalized, now(), now())
    on conflict (user_id) do update
      set display_name = excluded.display_name,
          updated_at = now();

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_shared_company_id, v_caller, 'user', 'user_display_name_changed', 'user_profile', p_user_id::text,
            jsonb_build_object('self_edit', v_is_self));

  return query select p_user_id, v_normalized;
end;
$$;

revoke all on function update_user_display_name(uuid, text) from public, anon;
grant execute on function update_user_display_name(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_update_company_profile: Super Admin-only write path for
--    companies.name/industry/country/timezone/default_currency, replacing
--    the client's now-unreachable update_company_profile/
--    update_company_timezone/update_company_currency (all three still
--    exist, unedited, and still correctly check settings.manage -- they are
--    simply never callable by any client role anymore per step 2; no
--    client-side authorization path to this data remains). Reuses the exact
--    same IANA-timezone and ISO-4217-currency validation those RPCs already
--    established. p_timezone/p_default_currency are optional (null leaves
--    the existing value unchanged) so Super Admin can edit just the profile
--    fields without being forced to resupply timezone/currency every time.
-- ---------------------------------------------------------------------------

create or replace function admin_update_company_profile(
  p_company_id uuid,
  p_name text,
  p_industry text,
  p_country text,
  p_timezone text default null,
  p_default_currency text default null
)
returns table (id uuid, name text, industry text, country text, timezone text, default_currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.companies%rowtype;
  v_currency text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'invalid_company_name'; end if;

  if p_timezone is not null then
    if length(trim(p_timezone)) = 0 or not exists (select 1 from pg_timezone_names where pg_timezone_names.name = p_timezone) then
      raise exception 'invalid_timezone';
    end if;
  end if;

  if p_default_currency is not null then
    v_currency := upper(trim(p_default_currency));
    if v_currency not in ('INR', 'AED', 'USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SAR', 'QAR', 'OMR', 'KWD', 'SGD') then
      raise exception 'invalid_currency';
    end if;
  end if;

  update public.companies
    set name = trim(p_name),
        industry = p_industry,
        country = p_country,
        timezone = coalesce(p_timezone, public.companies.timezone),
        default_currency = coalesce(v_currency, public.companies.default_currency),
        updated_at = now()
    where public.companies.id = p_company_id
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'platform_staff', 'company_profile_changed', 'company', p_company_id::text);

  return query select v_row.id, v_row.name, v_row.industry, v_row.country, v_row.timezone, v_row.default_currency;
end;
$$;

revoke all on function admin_update_company_profile(uuid, text, text, text, text, text) from public, anon;
grant execute on function admin_update_company_profile(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Super Admin AI/Voice Settings management -- reuses company_settings/
--    ai_settings/voice_settings unchanged (no duplicate configuration
--    model). No manual audit_logs insert here: company_settings/ai_settings/
--    voice_settings already carry AFTER INSERT OR UPDATE audit triggers
--    (migration 18's audit_company_settings_change/audit_ai_settings_change)
--    that fire automatically for this write exactly as they do for the
--    client's own -- adding a second explicit insert would double-log it.
-- ---------------------------------------------------------------------------

create or replace function admin_update_company_ai_settings(
  p_company_id uuid,
  p_bot_name text,
  p_welcome_message text,
  p_tone text,
  p_enabled_languages text[],
  p_default_reply_mode text,
  p_ai_active boolean,
  p_reply_length text,
  p_unknown_answer_behavior text
)
-- OUT columns are prefixed "updated_" (not company_id/bot_name/tone/
-- ai_active) to avoid the plpgsql bare-identifier ambiguity documented on
-- update_user_display_name's updated_user_id column above -- this
-- function's own "on conflict (company_id)" targets below would otherwise
-- be ambiguous against an OUT parameter of the same name.
returns table (updated_company_id uuid, updated_bot_name text, updated_tone text, updated_ai_active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.company_settings%rowtype;
  v_bot_name text := coalesce(nullif(trim(coalesce(p_bot_name, '')), ''), 'Assistant');
  v_languages text[] := case
    when p_enabled_languages is null or array_length(p_enabled_languages, 1) is null then array['en']
    else p_enabled_languages
  end;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  insert into public.company_settings (company_id, bot_name, welcome_message, tone, enabled_languages, default_reply_mode, ai_active)
    values (
      p_company_id, v_bot_name, nullif(trim(coalesce(p_welcome_message, '')), ''),
      coalesce(p_tone, 'friendly_professional'), v_languages, coalesce(p_default_reply_mode, 'auto'),
      coalesce(p_ai_active, true)
    )
    on conflict (company_id) do update
      set bot_name = excluded.bot_name,
          welcome_message = excluded.welcome_message,
          tone = excluded.tone,
          enabled_languages = excluded.enabled_languages,
          default_reply_mode = excluded.default_reply_mode,
          ai_active = excluded.ai_active
    returning * into v_settings;

  insert into public.ai_settings (company_id, reply_length, unknown_answer_behavior)
    values (p_company_id, coalesce(p_reply_length, 'medium'), coalesce(p_unknown_answer_behavior, 'escalate'))
    on conflict (company_id) do update
      set reply_length = excluded.reply_length,
          unknown_answer_behavior = excluded.unknown_answer_behavior;

  return query select v_settings.company_id, v_settings.bot_name, v_settings.tone, v_settings.ai_active;
end;
$$;
comment on function admin_update_company_ai_settings(uuid, text, text, text, text[], text, boolean, text, text) is
  'Returns updated_company_id/updated_bot_name/updated_tone/updated_ai_active (not company_id/bot_name/tone/ai_active) to avoid a plpgsql bare-identifier ambiguity against this function''s own ON CONFLICT (company_id) targets.';

revoke all on function admin_update_company_ai_settings(uuid, text, text, text, text[], text, boolean, text, text) from public, anon;
grant execute on function admin_update_company_ai_settings(uuid, text, text, text, text[], text, boolean, text, text) to authenticated;

create or replace function admin_update_company_voice_settings(
  p_company_id uuid,
  p_is_enabled boolean,
  p_reply_mode text
)
-- Same ON CONFLICT (company_id) bare-identifier ambiguity as
-- admin_update_company_ai_settings above -- OUT columns are prefixed
-- "updated_" for the same reason.
returns table (updated_company_id uuid, updated_is_enabled boolean, updated_reply_mode text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voice public.voice_settings%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  insert into public.voice_settings (company_id, is_enabled, reply_mode)
    values (p_company_id, coalesce(p_is_enabled, true), coalesce(p_reply_mode, 'auto'))
    on conflict (company_id) do update
      set is_enabled = excluded.is_enabled,
          reply_mode = excluded.reply_mode
    returning * into v_voice;

  return query select v_voice.company_id, v_voice.is_enabled, v_voice.reply_mode;
end;
$$;

revoke all on function admin_update_company_voice_settings(uuid, boolean, text) from public, anon;
grant execute on function admin_update_company_voice_settings(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Super Admin Knowledge Base management -- reuses knowledge_sources/
--    knowledge_chunks unchanged (no parallel knowledge system, no upload/
--    reindex/ingestion capability invented). This is also how the audit's
--    knowledge_chunks finding (SELECT-only RLS, no authenticated INSERT
--    policy) is resolved for the write path that now actually needs it:
--    these functions are SECURITY DEFINER, so they write knowledge_chunks
--    the same way every other privileged RPC in this codebase writes a
--    table with no direct authenticated grant -- knowledge_chunks' RLS is
--    NOT weakened; no INSERT policy is added to it. knowledge_sources
--    already has an AFTER INSERT OR UPDATE OR DELETE audit trigger
--    (audit_knowledge_source_change, migration 18) that fires automatically
--    here exactly as it does for the client's own writes -- no manual
--    audit_logs insert is added in these functions, to avoid double-logging.
-- ---------------------------------------------------------------------------

create or replace function admin_add_knowledge_source(
  p_company_id uuid,
  p_source_type knowledge_source_type,
  p_title text,
  p_content text default null
)
returns table (id uuid, title text, source_type knowledge_source_type)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.knowledge_sources%rowtype;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_content text := nullif(trim(coalesce(p_content, '')), '');
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if v_title is null then raise exception 'invalid_title'; end if;

  insert into public.knowledge_sources (company_id, source_type, title)
    values (p_company_id, p_source_type, v_title)
    returning * into v_source;

  if v_content is not null then
    insert into public.knowledge_chunks (company_id, knowledge_source_id, content, chunk_index)
      values (p_company_id, v_source.id, v_content, 0);
  end if;

  return query select v_source.id, v_source.title, v_source.source_type;
end;
$$;

revoke all on function admin_add_knowledge_source(uuid, knowledge_source_type, text, text) from public, anon;
grant execute on function admin_add_knowledge_source(uuid, knowledge_source_type, text, text) to authenticated;

create or replace function admin_toggle_knowledge_source(p_company_id uuid, p_source_id uuid, p_next_enabled boolean)
returns table (id uuid, is_enabled boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.knowledge_sources%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  update public.knowledge_sources
    set is_enabled = p_next_enabled
    where public.knowledge_sources.id = p_source_id and public.knowledge_sources.company_id = p_company_id
    returning * into v_source;
  if not found then raise exception 'knowledge_source_not_found'; end if;

  return query select v_source.id, v_source.is_enabled;
end;
$$;

revoke all on function admin_toggle_knowledge_source(uuid, uuid, boolean) from public, anon;
grant execute on function admin_toggle_knowledge_source(uuid, uuid, boolean) to authenticated;

create or replace function admin_remove_knowledge_source(p_company_id uuid, p_source_id uuid)
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  delete from public.knowledge_sources
    where public.knowledge_sources.id = p_source_id and public.knowledge_sources.company_id = p_company_id
    returning public.knowledge_sources.id into v_id;
  if v_id is null then raise exception 'knowledge_source_not_found'; end if;

  return query select v_id;
end;
$$;

revoke all on function admin_remove_knowledge_source(uuid, uuid) from public, anon;
grant execute on function admin_remove_knowledge_source(uuid, uuid) to authenticated;
