-- Dravonix WhatsApp AI Platform
-- Phase 3A.1: secure customer phone read layer (additive foundation only).
--
-- Read-only audit (Phase 3A) found that every existing application read
-- path fetches the raw customer WhatsApp identifier (contacts.whatsapp_wa_id
-- -- there is no separate "phone number" column; the wa_id IS the phone
-- number) via a direct PostgREST embed, then masks it in TypeScript
-- (maskPhoneNumber()) before rendering. Masking only in the application
-- layer is not an authorization boundary: any authenticated company member
-- holding conversations.view (every active role except company_accounts)
-- can already read the raw column directly today via a bare Supabase-JS
-- query, completely bypassing maskPhoneNumber(). This migration builds the
-- database-side authorization layer (permission, masking helper,
-- SECURITY DEFINER display/search RPCs) the application will be switched
-- onto in this same Phase 3A.1 pass -- it does NOT yet revoke the existing
-- direct column/table access that makes the bypass possible today. That
-- REVOKE is Phase 3A.2 / Migration 26, applied only after every read path
-- is proven switched over (see the Phase 3A.1 rollout report for the exact
-- planned scope).
--
-- Trusted backend paths (webhook ingest, message-consumer, human-reply
-- send) are untouched by this migration -- they continue reading
-- contacts.whatsapp_wa_id directly via the service_role client, which this
-- migration does not affect at all (service_role already bypasses RLS by
-- Postgres design, unrelated to the authenticated-role grants this
-- migration builds around).

-- ---------------------------------------------------------------------------
-- 1. New permission: contacts.phone.view_full. Company-wide, role-based
--    full-number visibility -- distinct from the Sales Person case, which
--    is never a static grant (see phone_is_full_for_caller below): a Sales
--    Person's full-number access is always computed live from
--    conversations/leads.assigned_member_id, per conversation/lead, never
--    from this permission.
-- ---------------------------------------------------------------------------

insert into permissions (key, description) values
  ('contacts.phone.view_full', 'View full (unmasked) customer WhatsApp numbers company-wide, not just for conversations assigned to the caller');

insert into role_permissions (role, permission_key) values
  ('company_owner', 'contacts.phone.view_full'),
  ('company_admin', 'contacts.phone.view_full'),
  ('manager', 'contacts.phone.view_full'),
  ('team_leader', 'contacts.phone.view_full');

-- sales_person and company_accounts deliberately receive no grant here.

-- ---------------------------------------------------------------------------
-- 2. mask_wa_id: SQL mirror of packages/handover/src/maskPhoneNumber.ts,
--    same effective output for the same input (strip non-digits, keep the
--    last 4, replace everything else with literal "*" characters -- not a
--    fixed-width mask, so a 12-digit and an 8-digit number produce
--    differently-lengthed masks, exactly like the TypeScript helper). Kept
--    as a pure, immutable function with no table access -- it only ever
--    transforms the text it's given, never decides on its own whether the
--    caller is authorized to see it (that's phone_is_full_for_caller below).
-- ---------------------------------------------------------------------------

create or replace function mask_wa_id(p_wa_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_wa_id is null then null
    when length(regexp_replace(p_wa_id, '\D', '', 'g')) <= 4
      then repeat('*', length(regexp_replace(p_wa_id, '\D', '', 'g')))
    else repeat('*', length(regexp_replace(p_wa_id, '\D', '', 'g')) - 4)
         || right(regexp_replace(p_wa_id, '\D', '', 'g'), 4)
  end;
$$;

comment on function mask_wa_id(text) is
  'SQL mirror of packages/handover/src/maskPhoneNumber.ts -- kept byte-for-byte behaviorally identical (same masking format) so the app-level helper and the database-level helper never visually diverge. The TypeScript helper remains the format reference/test oracle; this is the enforcement point.';

revoke all on function mask_wa_id(text) from public, anon;
grant execute on function mask_wa_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. phone_is_full_for_caller: the single, shared authorization decision --
--    every display/search RPC below calls this exact function so the
--    algorithm exists in exactly one place. p_assigned_member_id is always
--    the specific conversation's (or lead's) own assignment -- callers must
--    never pass a contact-wide or "any assignment this contact ever had"
--    value, which is what would let one old assigned conversation leak
--    permanent contact-wide full-number access (Phase 3A audit section 9).
--
--    Never trusts a browser-supplied company_id/member_id/role/assignment
--    -- auth.uid() and a live company_members lookup are the only identity
--    sources, exactly like every existing RPC in this codebase.
-- ---------------------------------------------------------------------------

create or replace function phone_is_full_for_caller(p_company_id uuid, p_assigned_member_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_member_id uuid;
begin
  if auth.uid() is null then return false; end if;

  if public.current_platform_role() is not distinct from 'super_admin' then
    return true;
  end if;

  if public.has_company_permission(p_company_id, 'contacts.phone.view_full') then
    return true;
  end if;

  if p_assigned_member_id is null then
    return false;
  end if;

  select cm.id into v_caller_member_id
    from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = auth.uid() and cm.is_active = true;

  return v_caller_member_id is not null and v_caller_member_id = p_assigned_member_id;
end;
$$;

comment on function phone_is_full_for_caller(uuid, uuid) is
  'The one place "does this caller get the full number" is decided: platform super_admin, or contacts.phone.view_full (company_owner/company_admin/manager/team_leader), or the caller is the specific conversation/lead''s own assigned_member_id (the Sales Person case) -- otherwise false (masked). Deliberately does not itself decide whether the caller may see the ROW at all -- callers of this function must apply their own conversations.view/leads.view (or is_platform_staff()) row-visibility gate first, exactly matching the existing contacts_select_member/conversations_select_member/leads_select_member RLS policies -- this migration does not widen or narrow that boundary (deferred: see the Phase 3A.1 report''s platform-staff note).';

revoke all on function phone_is_full_for_caller(uuid, uuid) from public, anon;
grant execute on function phone_is_full_for_caller(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_conversation_phone_displays: batch/set-based conversation-scoped
--    phone display -- the single source every conversation-keyed read path
--    (Live Conversations list/detail, Human Handover inbox/detail,
--    Notifications, DRAIVA contact-summary lookups) switches to in this
--    phase. One call per query, not one call per row -- callers pass every
--    conversation id they need in a single array. A single-conversation
--    caller passes a 1-element array; no separate scalar function exists
--    (avoids a second copy of the same authorization logic to keep in
--    sync).
--
--    Row-visibility gate mirrors conversations_select_member's existing
--    RLS shape exactly (conversations.view OR is_platform_staff()) --
--    unrelated to full-vs-masked, which phone_is_full_for_caller decides
--    independently per row using THAT row's own assigned_member_id.
-- ---------------------------------------------------------------------------

create or replace function get_conversation_phone_displays(p_conversation_ids uuid[])
returns table (conversation_id uuid, phone_display text, phone_visibility text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  return query
    select
      c.id,
      case when public.phone_is_full_for_caller(c.company_id, c.assigned_member_id)
        then ct.whatsapp_wa_id
        else public.mask_wa_id(ct.whatsapp_wa_id)
      end,
      case when public.phone_is_full_for_caller(c.company_id, c.assigned_member_id)
        then 'full' else 'masked'
      end
    from public.conversations c
    join public.contacts ct on ct.id = c.contact_id
    where c.id = any(p_conversation_ids)
      and (public.has_company_permission(c.company_id, 'conversations.view') or public.is_platform_staff());
end;
$$;

comment on function get_conversation_phone_displays(uuid[]) is
  'Returns one row per authorized conversation id (a conversation the caller has no legitimate access to, or that does not exist, is silently omitted -- never a masked placeholder row, matching this codebase''s established "missing/unauthorized looks like absent, not denied" convention for read paths). phone_visibility is always exactly ''full'' or ''masked'' -- a masked row NEVER also carries the raw value anywhere in the returned row.';

revoke all on function get_conversation_phone_displays(uuid[]) from public, anon;
grant execute on function get_conversation_phone_displays(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. get_lead_phone_displays: the leads equivalent. A lead's own
--    assigned_member_id (not its linked conversation's) is the assignment
--    signal -- this matches the Leads feature's own existing "assigned to
--    me" semantics (leadsRepository.ts's assignment filter already keys off
--    leads.assigned_member_id, independent of any conversation), so a lead
--    and its conversation can in principle be assigned to different people
--    without one silently overriding the other's phone visibility. The
--    displayed number itself mirrors leadsRepository.ts's existing
--    coalesce(leads.phone_number, contacts.whatsapp_wa_id) precedence (a
--    lead's self-reported number, falling back to its contact''s WhatsApp
--    number when none was captured).
-- ---------------------------------------------------------------------------

create or replace function get_lead_phone_displays(p_lead_ids uuid[])
returns table (lead_id uuid, phone_display text, phone_visibility text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  return query
    select
      l.id,
      case when public.phone_is_full_for_caller(l.company_id, l.assigned_member_id)
        then coalesce(l.phone_number, ct.whatsapp_wa_id)
        else public.mask_wa_id(coalesce(l.phone_number, ct.whatsapp_wa_id))
      end,
      case when public.phone_is_full_for_caller(l.company_id, l.assigned_member_id)
        then 'full' else 'masked'
      end
    from public.leads l
    join public.contacts ct on ct.id = l.contact_id
    where l.id = any(p_lead_ids)
      and (public.has_company_permission(l.company_id, 'leads.view') or public.is_platform_staff());
end;
$$;

revoke all on function get_lead_phone_displays(uuid[]) from public, anon;
grant execute on function get_lead_phone_displays(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. search_company_conversations / search_company_leads: authorized,
--    privacy-aware search. Replaces the client's raw
--    `contacts.whatsapp_wa_id ilike ...` filter used today by
--    conversationsRepository.ts/globalSearchRepository.ts/leadsRepository.ts
--    -- name-field matching is unrestricted (unchanged product behavior,
--    not a privacy concern), but a phone-digit match against a row the
--    caller is NOT authorized for full-number access on (per
--    phone_is_full_for_caller, evaluated for THAT specific row, never a
--    contact-wide check -- see section 3's note on why) is only honored
--    for a short (<=4 digit) suffix query, matched against the row's own
--    last 4 digits. A caller who is not full-authorized for a row can never
--    use a longer/full number to discover that row via phone at all -- it
--    simply won't match on the phone criterion (it may of course still
--    match on name, unaffected). This is what stops a Sales Person from
--    typing a company-wide customer's full number into search and learning
--    it exists (an information-oracle leak) while still letting them
--    legitimately search their OWN customers by full number, and letting
--    everyone do an approximate "I remember the last few digits" search
--    company-wide with only a masked result ever shown for a row they
--    aren't authorized for.
--
--    Returns bare ids only (never a phone value) -- callers fetch full rows
--    afterward through their normal RLS-scoped query, then resolve display
--    values via get_conversation_phone_displays/get_lead_phone_displays.
--    This keeps the search step and the authorization/display step fully
--    decoupled, so neither can accidentally leak a raw value the other
--    didn't intend to expose.
-- ---------------------------------------------------------------------------

create or replace function search_company_conversations(p_company_id uuid, p_term text, p_limit integer default 50)
returns table (conversation_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := trim(coalesce(p_term, ''));
  v_query_digits text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not (public.has_company_permission(p_company_id, 'conversations.view') or public.is_platform_staff()) then
    raise exception 'permission_denied';
  end if;
  if v_term = '' then return; end if;

  v_query_digits := regexp_replace(v_term, '\D', '', 'g');

  return query
    select c.id
    from public.conversations c
    join public.contacts ct on ct.id = c.contact_id
    where c.company_id = p_company_id
      and (
        ct.display_name ilike '%' || v_term || '%'
        or ct.profile_name ilike '%' || v_term || '%'
        or (
          v_query_digits <> '' and (
            (
              public.phone_is_full_for_caller(c.company_id, c.assigned_member_id)
              and regexp_replace(ct.whatsapp_wa_id, '\D', '', 'g') ilike '%' || v_query_digits || '%'
            )
            or (
              not public.phone_is_full_for_caller(c.company_id, c.assigned_member_id)
              and length(v_query_digits) <= 4
              and right(regexp_replace(ct.whatsapp_wa_id, '\D', '', 'g'), length(v_query_digits)) = v_query_digits
            )
          )
        )
      )
    order by c.last_message_at desc nulls last
    limit p_limit;
end;
$$;

revoke all on function search_company_conversations(uuid, text, integer) from public, anon;
grant execute on function search_company_conversations(uuid, text, integer) to authenticated;

create or replace function search_company_leads(p_company_id uuid, p_term text, p_limit integer default 50)
returns table (lead_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := trim(coalesce(p_term, ''));
  v_query_digits text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not (public.has_company_permission(p_company_id, 'leads.view') or public.is_platform_staff()) then
    raise exception 'permission_denied';
  end if;
  if v_term = '' then return; end if;

  v_query_digits := regexp_replace(v_term, '\D', '', 'g');

  return query
    select l.id
    from public.leads l
    join public.contacts ct on ct.id = l.contact_id
    where l.company_id = p_company_id
      and (
        l.customer_name ilike '%' || v_term || '%'
        or l.company_name ilike '%' || v_term || '%'
        or l.email ilike '%' || v_term || '%'
        or l.service_interest ilike '%' || v_term || '%'
        or (
          v_query_digits <> '' and (
            (
              public.phone_is_full_for_caller(l.company_id, l.assigned_member_id)
              and regexp_replace(coalesce(l.phone_number, ct.whatsapp_wa_id), '\D', '', 'g') ilike '%' || v_query_digits || '%'
            )
            or (
              not public.phone_is_full_for_caller(l.company_id, l.assigned_member_id)
              and length(v_query_digits) <= 4
              and right(regexp_replace(coalesce(l.phone_number, ct.whatsapp_wa_id), '\D', '', 'g'), length(v_query_digits)) = v_query_digits
            )
          )
        )
      )
    order by l.updated_at desc
    limit p_limit;
end;
$$;

revoke all on function search_company_leads(uuid, text, integer) from public, anon;
grant execute on function search_company_leads(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- NOTE (Phase 3A final security correction): an earlier draft of this
-- migration added a get_conversation_send_target(uuid) RPC here, granted to
-- `authenticated`, intended as a server-side-only outbound-routing lookup
-- for sendHumanReplyAction. It was removed before this migration was ever
-- applied anywhere: its authorization check (conversations.view OR
-- is_platform_staff(), company-wide, not assignment-scoped) meant ANY
-- authenticated caller with conversations.view -- including an unassigned
-- Sales Person, who this entire migration exists to keep masked -- could
-- call it directly via Supabase-JS/PostgREST for any conversation in their
-- company and receive the RAW whatsapp_wa_id in the response. Any function
-- granted to `authenticated` is a browser-callable RPC regardless of
-- "server-side-only" intent expressed only in a comment -- there is no way
-- to grant execute to `authenticated` while restricting the caller to
-- server-only code. sendHumanReplyAction now resolves the raw routing info
-- via apps/web/lib/supabase/serviceRole.ts's existing server-only
-- service_role client instead (never granted to `authenticated`, never
-- reachable from the browser) -- see that Server Action for the corrected
-- pattern. No replacement RPC is needed: service_role already has
-- unrestricted table-level SELECT on contacts (migration 26 only touches
-- the `authenticated`/`anon` grants), so no additional database object is
-- required for this lookup.
-- ---------------------------------------------------------------------------
