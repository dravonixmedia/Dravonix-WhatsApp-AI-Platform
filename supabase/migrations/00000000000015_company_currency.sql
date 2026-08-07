-- Dravonix WhatsApp AI Platform
-- Business Currency: safe, authenticated update path for the existing
-- companies.default_currency column (added in migration 2). That column
-- has always existed and has always been readable by any company member
-- via the companies_select_member RLS policy, but companies has no UPDATE
-- RLS policy at all and no prior RPC ever touched default_currency -- it
-- was display-only. This migration adds exactly one narrow, single-purpose
-- RPC to change it safely. No new column, no new table: the existing
-- authoritative field is reused unchanged.
--
-- Mirrors update_company_timezone (migration 14) exactly: SECURITY
-- DEFINER, empty search_path, fully-qualified object references, row
-- locked, active-membership + settings.manage checks, audit-logged,
-- signature-qualified revoke/grant so only authenticated callers can ever
-- invoke it.
--
-- Business timezone and business currency are independent settings: this
-- function never reads or writes companies.timezone, and
-- update_company_timezone never reads or writes companies.default_currency.
-- Neither infers, nor is ever intended to infer, one from the other.

create or replace function update_company_currency(p_company_id uuid, p_currency text)
returns table (id uuid, default_currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company public.companies%rowtype;
  v_currency text := upper(trim(coalesce(p_currency, '')));
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  -- Fixed, enumerated ISO 4217 support list -- there is no built-in Postgres
  -- currency catalog analogous to pg_timezone_names, so this list is the
  -- authoritative server-side check (kept in sync with
  -- apps/web/lib/currencyList.ts's application-layer list).
  if v_currency not in (
    'INR', 'AED', 'USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SAR', 'QAR', 'OMR', 'KWD', 'SGD'
  ) then
    raise exception 'invalid_currency';
  end if;

  select * into v_company from public.companies where public.companies.id = p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if not public.is_company_member(p_company_id) then raise exception 'not_a_member'; end if;
  if not public.has_company_permission(p_company_id, 'settings.manage') then
    raise exception 'permission_denied';
  end if;

  update public.companies set default_currency = v_currency, updated_at = now()
    where public.companies.id = p_company_id
    returning * into v_company;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id)
    values (p_company_id, auth.uid(), 'user', 'company.currency_updated', 'company', p_company_id::text);

  return query select v_company.id, v_company.default_currency;
end;
$$;

revoke all on function update_company_currency(uuid, text) from public, anon;
grant execute on function update_company_currency(uuid, text) to authenticated;
