-- Dravonix WhatsApp AI Platform
-- Global Timezone + Daypart Awareness: customer-local timezone support.
--
-- companies.timezone already existed (migration 2) and is reused unchanged
-- here -- no duplicate company timezone column is introduced. This
-- migration only adds the missing half: a per-contact (customer) timezone,
-- plus two narrow, single-purpose RPCs to update timezones safely.
--
-- Additive only: one nullable column, two new functions, two new
-- permission-independent RPC grants. No existing column, constraint, RLS
-- policy, or row is modified. contacts.timezone starts NULL for every
-- existing row -- "unknown" -- and is never bulk-backfilled or inferred
-- from phone number, company timezone, or any other heuristic.

alter table contacts add column timezone text;

comment on column contacts.timezone is
  'IANA timezone identifier for this WhatsApp customer, when explicitly known (e.g. staff-provided via the dashboard). Null means unknown -- never inferred from phone number, company timezone, browser locale, or any other heuristic (Global Timezone + Daypart Awareness spec, section 9).';

-- ---------------------------------------------------------------------------
-- update_company_timezone -- authenticated staff with settings.manage only.
-- Updates exactly one column on exactly the caller's own active company.
-- ---------------------------------------------------------------------------
create or replace function update_company_timezone(p_company_id uuid, p_timezone text)
returns table (id uuid, timezone text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company public.companies%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_timezone is null or length(trim(p_timezone)) = 0 then
    raise exception 'invalid_timezone';
  end if;
  -- Real, currently-known IANA identifier (Postgres ships its own tzdata) --
  -- rejects bare numeric offsets and nonsense strings server-side, as
  -- defense in depth alongside the application-layer Intl-based check.
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'invalid_timezone';
  end if;

  select * into v_company from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if not public.is_company_member(p_company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(p_company_id, 'settings.manage') then
    raise exception 'permission_denied';
  end if;

  update public.companies set timezone = p_timezone, updated_at = now()
    where public.companies.id = p_company_id
    returning * into v_company;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'user', 'company.timezone_updated', 'company', p_company_id::text);

  return query select v_company.id, v_company.timezone;
end;
$$;

revoke all on function update_company_timezone(uuid, text) from public, anon;
grant execute on function update_company_timezone(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- update_contact_timezone -- authenticated staff with conversations.reply
-- (the same permission that already gates sending a manual reply, i.e.
-- "can actively handle this company's conversations"). company_id is
-- derived from the contact row itself, never accepted as a parameter, so a
-- caller can never point this at a different company's contact by
-- supplying a mismatched id. p_timezone may be null to explicitly restore
-- "unknown".
-- ---------------------------------------------------------------------------
create or replace function update_contact_timezone(p_contact_id uuid, p_timezone text)
returns table (id uuid, timezone text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.contacts%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_timezone is not null then
    if length(trim(p_timezone)) = 0 then raise exception 'invalid_timezone'; end if;
    if not exists (select 1 from pg_timezone_names where name = p_timezone) then
      raise exception 'invalid_timezone';
    end if;
  end if;

  select * into v_contact from public.contacts where public.contacts.id = p_contact_id for update;
  if not found then raise exception 'contact_not_found'; end if;
  if not public.is_company_member(v_contact.company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(v_contact.company_id, 'conversations.reply') then
    raise exception 'permission_denied';
  end if;

  update public.contacts set timezone = p_timezone, updated_at = now()
    where public.contacts.id = p_contact_id
    returning * into v_contact;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (v_contact.company_id, auth.uid(), 'user', 'contact.timezone_updated', 'contact', p_contact_id::text);

  return query select v_contact.id, v_contact.timezone;
end;
$$;

revoke all on function update_contact_timezone(uuid, text) from public, anon;
grant execute on function update_contact_timezone(uuid, text) to authenticated;
