-- Dravonix WhatsApp AI Platform
-- Phase 5: Client Support & Requests. Lets any of the six active company
-- roles (company_owner, company_admin, manager, team_leader, sales_person,
-- company_accounts) submit a support request (complaint, service request,
-- technical issue, feature/change request, general support), track its
-- status/priority, hold a client-visible + internal-only conversation, and
-- gives Dravonix Super Admin/platform staff a queue to manage every
-- company's requests. Entirely new domain -- no existing ticket/request
-- table exists anywhere in this schema (confirmed by repo-wide audit before
-- writing this migration).
--
-- Explicitly NOT touched here: Phase 3A phone privacy, Phase 3B scroll
-- behavior, Phase 2 role/team permissions (only additive grants of the new
-- support_requests.view key), Phase 4 DRAIVA workspace, invitation/auth,
-- ZeptoMail credentials, Meta/WABA, Cloudflare config, payments,
-- Research/Settings, sidebar structure, and production.

-- ---------------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------------

create type support_request_type as enum (
  'complaint',
  'service_request',
  'technical_issue',
  'feature_request',
  'general_support'
);

create type support_request_status as enum (
  'open',
  'in_progress',
  'waiting_on_client',
  'resolved',
  'closed'
);

create type support_request_priority as enum ('low', 'normal', 'high', 'urgent');

-- ---------------------------------------------------------------------------
-- 2. Reference number: a dedicated sequence + zero-padded prefix (SUP-000123)
--    -- nextval() is atomic and race-free, unlike the collision-retry-with-
--    random-suffix pattern companies.slug uses (that pattern produces
--    unpredictable, non-sequential identifiers, which a support ticket
--    reference should not be). The raw uuid stays the real primary key;
--    `reference` is purely the human-facing identifier.
-- ---------------------------------------------------------------------------

create sequence support_request_reference_seq;

-- ---------------------------------------------------------------------------
-- 3. Tables.
--
-- company_id is nullable with ON DELETE SET NULL (not CASCADE) -- matching
-- audit_logs' own FK behavior exactly -- so a company's support history is
-- never destroyed by a company deletion; an orphaned row simply becomes
-- invisible to every company-scoped RLS check (has_company_permission
-- requires a non-null company_id match) while remaining fully visible to
-- Super Admin/platform staff for historical reference.
--
-- assigned_platform_user_id references platform_members, which has no
-- display-name column (confirmed by audit) -- exactly the same limitation
-- support_access_sessions.platform_user_id already ships with (masked
-- display, e.g. "User ••1234"), so this is a deliberate, precedented
-- decision, not an oversight.
-- ---------------------------------------------------------------------------

create table support_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  company_id uuid references companies (id) on delete set null,
  created_by_user_id uuid references auth.users (id) on delete set null,
  type support_request_type not null,
  subject text not null check (char_length(subject) between 1 and 200),
  description text not null check (char_length(description) between 1 and 5000),
  status support_request_status not null default 'open',
  priority support_request_priority not null default 'normal',
  assigned_platform_user_id uuid references platform_members (user_id) on delete set null,
  last_replied_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_requests_company_id_idx on support_requests (company_id);
create index support_requests_status_idx on support_requests (status);

comment on table support_requests is
  'Phase 5: client-submitted support/complaint/feature-request tickets. company_id is SET NULL (never CASCADE) on company deletion so support history is never accidentally destroyed -- see audit_logs for the identical precedent.';

-- Discussion/reply history -- deliberately never folded into a single
-- mutable `description` field (final plan section 8). `is_internal` rows are
-- Dravonix-only notes, filtered out entirely by RLS for any non-platform-
-- staff caller (see the SELECT policy below) rather than merely hidden by
-- the UI.
create table support_request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references support_requests (id) on delete cascade,
  author_type text not null check (author_type in ('client', 'platform', 'system')),
  author_user_id uuid references auth.users (id) on delete set null,
  message text not null check (char_length(message) between 1 and 5000),
  is_internal boolean not null default false,
  created_at timestamptz not null default now()
);

create index support_request_messages_request_id_idx on support_request_messages (request_id, created_at);

comment on table support_request_messages is
  'Phase 5 conversation/history model. is_internal=true rows are Dravonix-only notes -- never selectable by a non-platform-staff caller (support_request_messages_select RLS policy), never emailed to the client.';

create trigger support_requests_set_updated_at
  before update on support_requests
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Permission grant: one new key, support_requests.view, granted
--    identically to all six active company roles (including
--    company_accounts, which is explicitly allowed to submit finance/
--    billing-related requests despite lacking every other operational
--    permission) -- final plan section 2. No separate "manage" key exists:
--    a client's only writes are creating their own request and adding a
--    client-visible reply to it (both re-verify this same permission
--    server-side inside the RPCs below), never a status/priority/assignment
--    change, which only ever happens through the is_platform_staff()-gated
--    admin_* RPCs further down.
-- ---------------------------------------------------------------------------

insert into permissions (key, description) values
  ('support_requests.view', 'Submit and view the company''s support requests, and reply to them');

insert into role_permissions (role, permission_key) values
  ('company_owner', 'support_requests.view'),
  ('company_admin', 'support_requests.view'),
  ('manager', 'support_requests.view'),
  ('team_leader', 'support_requests.view'),
  ('sales_person', 'support_requests.view'),
  ('company_accounts', 'support_requests.view');

-- ---------------------------------------------------------------------------
-- 5. RLS. SELECT-only policies -- every write (create, reply, status,
--    priority, assignment, resolve, reopen) goes exclusively through the
--    SECURITY DEFINER RPCs below, matching the established Super Admin
--    mutation convention (confirmed by audit: no admin surface in this
--    codebase updates a table directly, always through a named RPC that
--    re-checks authorization itself) -- so no INSERT/UPDATE/DELETE policy
--    is defined for `authenticated` at all; RPCs run as their owner and
--    bypass RLS the same way every other SECURITY DEFINER function here
--    already does.
-- ---------------------------------------------------------------------------

alter table support_requests enable row level security;
alter table support_request_messages enable row level security;

create policy support_requests_select on support_requests
  for select
  using (
    is_platform_staff()
    or (company_id is not null and has_company_permission(company_id, 'support_requests.view'))
  );

-- Client-visible rows: everything for platform staff; for an ordinary
-- company member, only non-internal messages on a request belonging to a
-- company they hold support_requests.view on. This is the actual
-- enforcement mechanism behind "internal notes never visible to client" --
-- not a UI-layer filter.
create policy support_request_messages_select on support_request_messages
  for select
  using (
    is_platform_staff()
    or (
      not is_internal
      and exists (
        select 1 from support_requests sr
        where sr.id = support_request_messages.request_id
          and sr.company_id is not null
          and has_company_permission(sr.company_id, 'support_requests.view')
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Shared notification helper. Free-text `category` column (notifications
--    table, migration 8) needs no schema change to accept new values --
--    confirmed by audit. Best-effort by construction: called from inside
--    the same transaction as the triggering mutation, so a notification row
--    always exists for every client-visible reply/status change; whether
--    the dashboard bell renders generic `notifications` rows today is a
--    separate, pre-existing UI question this migration does not change
--    (see the Phase 5 rollout report's "known limitations" section).
-- ---------------------------------------------------------------------------

create or replace function notify_support_request_client(
  p_request public.support_requests,
  p_category text,
  p_subject text,
  p_body text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_request.company_id is null or p_request.created_by_user_id is null then
    return;
  end if;

  insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body)
    values (p_request.company_id, 'company_admin', 'in_app', p_request.created_by_user_id,
            p_category, p_subject, p_body);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Client RPCs.
-- ---------------------------------------------------------------------------

create or replace function create_support_request(
  p_company_id uuid,
  p_type support_request_type,
  p_subject text,
  p_description text,
  p_priority support_request_priority default 'normal'
)
returns table (id uuid, reference text, status support_request_status, priority support_request_priority, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject text;
  v_description text;
  v_reference text;
  v_row public.support_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.has_company_permission(p_company_id, 'support_requests.view') then
    raise exception 'permission_denied';
  end if;

  -- Client-supplied priority is deliberately restricted to normal/high
  -- (final plan section 7) -- urgent/low are Dravonix-only, set later via
  -- admin_update_support_request_priority.
  if p_priority not in ('normal', 'high') then
    raise exception 'invalid_priority_for_client';
  end if;

  v_subject := trim(p_subject);
  v_description := trim(p_description);
  if v_subject = '' or char_length(v_subject) > 200 then raise exception 'invalid_subject'; end if;
  if v_description = '' or char_length(v_description) > 5000 then raise exception 'invalid_description'; end if;

  v_reference := 'SUP-' || lpad(nextval('public.support_request_reference_seq')::text, 6, '0');

  insert into public.support_requests (reference, company_id, created_by_user_id, type, subject, description, priority)
    values (v_reference, p_company_id, auth.uid(), p_type, v_subject, v_description, p_priority)
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'support_request_created', 'support_request', v_row.id::text,
            jsonb_build_object('reference', v_reference, 'type', p_type, 'priority', p_priority));

  return query select v_row.id, v_row.reference, v_row.status, v_row.priority, v_row.created_at;
end;
$$;

comment on function create_support_request(uuid, support_request_type, text, text, support_request_priority) is
  'Phase 5: the sole way a support_requests row is ever created. p_company_id is re-verified via has_company_permission (never trusted as-is) -- a caller who is not an active, permitted member of that exact company fails permission_denied regardless of what it sends.';

revoke all on function create_support_request(uuid, support_request_type, text, text, support_request_priority) from public, anon;
grant execute on function create_support_request(uuid, support_request_type, text, text, support_request_priority) to authenticated;

create or replace function reply_support_request(p_request_id uuid, p_message text)
returns table (id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
  v_message text;
  v_row public.support_request_messages%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.company_id is null or not public.has_company_permission(v_request.company_id, 'support_requests.view') then
    raise exception 'permission_denied';
  end if;

  v_message := trim(p_message);
  if v_message = '' or char_length(v_message) > 5000 then raise exception 'invalid_message'; end if;

  insert into public.support_request_messages (request_id, author_type, author_user_id, message, is_internal)
    values (p_request_id, 'client', auth.uid(), v_message, false)
    returning * into v_row;

  -- A client reply is the one system-driven (not client-chosen) status
  -- transition allowed here: it only ever moves a request OUT of
  -- waiting_on_client (back into Dravonix's active queue), never sets any
  -- other status -- the client still never directly manipulates status.
  update public.support_requests
    set last_replied_at = now(),
        status = case when status = 'waiting_on_client' then 'open' else status end
    where public.support_requests.id = p_request_id;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_request.company_id, auth.uid(), 'user', 'support_request_replied', 'support_request', p_request_id::text,
            jsonb_build_object('author_type', 'client'));

  return query select v_row.id, v_row.created_at;
end;
$$;

comment on function reply_support_request(uuid, text) is
  'Phase 5: client-visible reply, author_type always ''client'', is_internal always false -- a client can never write an internal note (there is no parameter for it).';

revoke all on function reply_support_request(uuid, text) from public, anon;
grant execute on function reply_support_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Super Admin / platform-staff RPCs. Gated on is_platform_staff() (any
--    active platform_members row -- super_admin, platform_support, or
--    platform_billing_admin), matching admin_start_support_access's own
--    precedent for staff-level operational actions, not the stricter
--    current_platform_role() = 'super_admin' check company-lifecycle RPCs
--    use (creating/suspending a company, changing entitlements). Handling
--    support tickets is exactly the kind of day-to-day operational task the
--    platform_support role name describes.
-- ---------------------------------------------------------------------------

create or replace function admin_reply_support_request(
  p_request_id uuid,
  p_message text,
  p_is_internal boolean default false
)
returns table (id uuid, created_at timestamptz, is_internal boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
  v_message text;
  v_row public.support_request_messages%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;

  v_message := trim(p_message);
  if v_message = '' or char_length(v_message) > 5000 then raise exception 'invalid_message'; end if;

  insert into public.support_request_messages (request_id, author_type, author_user_id, message, is_internal)
    values (p_request_id, 'platform', auth.uid(), v_message, coalesce(p_is_internal, false))
    returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_request.company_id, auth.uid(), 'platform_staff',
            case when coalesce(p_is_internal, false) then 'support_request_internal_note_added' else 'support_request_replied' end,
            'support_request', p_request_id::text, jsonb_build_object('author_type', 'platform', 'is_internal', coalesce(p_is_internal, false)));

  if not coalesce(p_is_internal, false) then
    update public.support_requests set last_replied_at = now() where public.support_requests.id = p_request_id;
    perform public.notify_support_request_client(
      v_request, 'support_request_replied', 'New reply on ' || v_request.reference, v_message
    );
  end if;

  return query select v_row.id, v_row.created_at, v_row.is_internal;
end;
$$;

comment on function admin_reply_support_request(uuid, text, boolean) is
  'Phase 5: is_internal=true rows are never counted as last_replied_at and never trigger a client notification/email -- both are gated on `not coalesce(p_is_internal, false)`.';

revoke all on function admin_reply_support_request(uuid, text, boolean) from public, anon;
grant execute on function admin_reply_support_request(uuid, text, boolean) to authenticated;

-- Ordinary (non-terminal) status cycling: open / in_progress /
-- waiting_on_client / closed. 'resolved' is deliberately excluded from this
-- generic RPC -- it is only ever set by admin_resolve_support_request,
-- which also stamps resolved_at, keeping "resolved" a distinct, deliberate
-- act rather than one option among five in a plain dropdown.
create or replace function admin_update_support_request_status(p_request_id uuid, p_status support_request_status)
returns table (id uuid, status support_request_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
  v_old_status public.support_request_status;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;

  if p_status = 'resolved' then raise exception 'use_resolve_action'; end if;
  if v_request.status = 'closed' then raise exception 'invalid_state_transition'; end if;
  if v_request.status = 'resolved' and p_status <> 'closed' then raise exception 'invalid_state_transition'; end if;

  v_old_status := v_request.status;
  update public.support_requests set status = p_status where public.support_requests.id = p_request_id returning * into v_request;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_request.company_id, auth.uid(), 'platform_staff', 'support_request_status_changed', 'support_request', p_request_id::text,
            jsonb_build_object('old_status', v_old_status, 'new_status', p_status));

  perform public.notify_support_request_client(
    v_request, 'support_request_status_changed', v_request.reference || ' status updated', 'Status changed to ' || p_status
  );

  return query select v_request.id, v_request.status;
end;
$$;

comment on function admin_update_support_request_status(uuid, support_request_status) is
  'Phase 5 allowed transitions: from open/in_progress/waiting_on_client -> any of open/in_progress/waiting_on_client/closed; from resolved -> closed only; from closed -> nothing (use admin_reopen_support_request first). p_status=''resolved'' is always rejected here (use_resolve_action) -- only admin_resolve_support_request may set it.';

revoke all on function admin_update_support_request_status(uuid, support_request_status) from public, anon;
grant execute on function admin_update_support_request_status(uuid, support_request_status) to authenticated;

create or replace function admin_resolve_support_request(p_request_id uuid)
returns table (id uuid, status support_request_status, resolved_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.status in ('resolved', 'closed') then raise exception 'invalid_state_transition'; end if;

  update public.support_requests set status = 'resolved', resolved_at = now()
    where public.support_requests.id = p_request_id returning * into v_request;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_request.company_id, auth.uid(), 'platform_staff', 'support_request_resolved', 'support_request', p_request_id::text);

  perform public.notify_support_request_client(
    v_request, 'support_request_resolved', v_request.reference || ' resolved', 'Your request has been marked resolved.'
  );

  return query select v_request.id, v_request.status, v_request.resolved_at;
end;
$$;

revoke all on function admin_resolve_support_request(uuid) from public, anon;
grant execute on function admin_resolve_support_request(uuid) to authenticated;

create or replace function admin_reopen_support_request(p_request_id uuid)
returns table (id uuid, status support_request_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.status not in ('resolved', 'closed') then raise exception 'invalid_state_transition'; end if;

  update public.support_requests set status = 'in_progress', resolved_at = null
    where public.support_requests.id = p_request_id returning * into v_request;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_request.company_id, auth.uid(), 'platform_staff', 'support_request_reopened', 'support_request', p_request_id::text);

  perform public.notify_support_request_client(
    v_request, 'support_request_reopened', v_request.reference || ' reopened', 'Your request has been reopened.'
  );

  return query select v_request.id, v_request.status;
end;
$$;

revoke all on function admin_reopen_support_request(uuid) from public, anon;
grant execute on function admin_reopen_support_request(uuid) to authenticated;

create or replace function admin_update_support_request_priority(p_request_id uuid, p_priority support_request_priority)
returns table (id uuid, priority support_request_priority)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
  v_old_priority public.support_request_priority;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;

  v_old_priority := v_request.priority;
  update public.support_requests set priority = p_priority where public.support_requests.id = p_request_id returning * into v_request;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_request.company_id, auth.uid(), 'platform_staff', 'support_request_priority_changed', 'support_request', p_request_id::text,
            jsonb_build_object('old_priority', v_old_priority, 'new_priority', p_priority));

  return query select v_request.id, v_request.priority;
end;
$$;

revoke all on function admin_update_support_request_priority(uuid, support_request_priority) from public, anon;
grant execute on function admin_update_support_request_priority(uuid, support_request_priority) to authenticated;

create or replace function admin_assign_support_request(p_request_id uuid, p_platform_user_id uuid)
returns table (id uuid, assigned_platform_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;

  if p_platform_user_id is not null and not exists (
    select 1 from public.platform_members where public.platform_members.user_id = p_platform_user_id and is_active = true
  ) then
    raise exception 'invalid_assignee';
  end if;

  update public.support_requests set assigned_platform_user_id = p_platform_user_id
    where public.support_requests.id = p_request_id returning * into v_request;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_request.company_id, auth.uid(), 'platform_staff', 'support_request_assigned', 'support_request', p_request_id::text,
            jsonb_build_object('assigned_platform_user_id', p_platform_user_id));

  return query select v_request.id, v_request.assigned_platform_user_id;
end;
$$;

revoke all on function admin_assign_support_request(uuid, uuid) from public, anon;
grant execute on function admin_assign_support_request(uuid, uuid) to authenticated;

-- auth.users is not exposed to an ordinary authenticated client (no
-- PostgREST/RLS access) -- this narrow, read-only lookup is the same
-- pattern admin_invite_company_member (migration 17) already uses to query
-- auth.users directly from inside a SECURITY DEFINER function. Returns null
-- (never raises) for a request with no creator on record, so the caller can
-- simply skip the client-reply-notification email rather than handling a
-- special error case.
create or replace function admin_get_support_request_recipient_email(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.is_platform_staff() then raise exception 'permission_denied'; end if;

  select au.email into v_email
    from public.support_requests sr
    join auth.users au on au.id = sr.created_by_user_id
    where sr.id = p_request_id;

  return v_email;
end;
$$;

revoke all on function admin_get_support_request_recipient_email(uuid) from public, anon;
grant execute on function admin_get_support_request_recipient_email(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Email delivery diagnostics -- mirrors record_invitation_email_event
--    (migration 20) exactly: sanitized error recording inside audit_logs,
--    never the raw provider response/credentials. Callable by the request's
--    own company member (recording the "new request" notification-to-
--    Dravonix outcome, triggered synchronously from their own create flow)
--    or by platform staff (recording a client-reply-notification outcome).
-- ---------------------------------------------------------------------------

create or replace function record_support_email_event(
  p_request_id uuid,
  p_email_type text,
  p_event text,
  p_masked_recipient text default null,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.support_requests%rowtype;
  v_action text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_event not in ('sent', 'failed') then raise exception 'invalid_event'; end if;
  if p_email_type not in ('new_request_notification', 'client_reply_notification') then
    raise exception 'invalid_email_type';
  end if;

  select * into v_request from public.support_requests where public.support_requests.id = p_request_id;
  if not found then raise exception 'request_not_found'; end if;

  if not public.is_platform_staff()
     and (v_request.company_id is null or not public.has_company_permission(v_request.company_id, 'support_requests.view'))
  then
    raise exception 'permission_denied';
  end if;

  v_action := case when p_event = 'sent' then 'support_email_sent' else 'support_email_failed' end;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (
      v_request.company_id, auth.uid(), 'user', v_action, 'support_request', p_request_id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'provider', 'zeptomail',
        'email_type', p_email_type,
        'recipient', p_masked_recipient,
        'provider_message_id', p_provider_message_id,
        'error_code', p_error_code,
        'error_message', p_error_message
      ))
    );
end;
$$;

revoke all on function record_support_email_event(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function record_support_email_event(uuid, text, text, text, text, text, text) to authenticated;
