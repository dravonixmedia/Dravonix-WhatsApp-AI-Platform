-- Dravonix WhatsApp AI Platform
-- Meta/WhatsApp Batch 1: secure Super-Admin-assisted WABA + phone-number
-- connection foundation. See the read-only production-readiness audit (this
-- session) for the full evidence trail: whatsapp_accounts/whatsapp_phone_
-- numbers (migration 3) have carried zero writers and zero write RLS
-- policies since their creation -- the only way to populate them has ever
-- been direct, out-of-band database access. This migration adds the first
-- real, authorized write path, without inventing Embedded Signup yet.
--
-- Explicitly NOT in scope (per the audit's Batch 1 slice and this task's own
-- rules): no Meta OAuth/Embedded Signup, no Facebook JS SDK, no per-tenant
-- access-token storage/encryption, no template messaging, no 24-hour-window
-- handling. encrypted_access_token/token_expires_at are untouched and
-- unused by this migration -- reserved for a future token-storage decision,
-- not removed (see the migration's own closing comment).
--
-- BEFORE this migration:
--   - whatsapp_accounts/whatsapp_phone_numbers had SELECT-only RLS policies
--     and no INSERT/UPDATE/DELETE policy for any role -- not even Super
--     Admin could write through the app.
--   - Inbound routing (packages/whatsapp/src/routing.ts via
--     SupabaseWhatsAppIngestRepository.resolveCompanyIdByPhoneNumberId)
--     matched on phone_number_id alone, with no status check -- a
--     'disabled'/'not_connected' number would still route.
--   - The three outbound paths (message-consumer, voice-consumer, human
--     handover) selected a company's phone_number_id with no status check
--     either.
--
-- AFTER this migration:
--   - Four narrowly-scoped, Super-Admin-gated SECURITY DEFINER RPCs are the
--     only way to create or change a WhatsApp connection mapping:
--     admin_connect_whatsapp_account, admin_connect_whatsapp_phone_number,
--     admin_set_whatsapp_account_status, admin_set_whatsapp_phone_number_status.
--   - A BEFORE INSERT OR UPDATE trigger on whatsapp_phone_numbers enforces,
--     at the schema level (independent of any RPC logic), that a phone
--     number's company_id always matches its parent whatsapp_account's
--     company_id -- defense-in-depth against the exact cross-tenant-takeover
--     class this batch is built to prevent.
--   - waba_id/phone_number_id remain globally unique (migration 3, unchanged)
--     -- the new RPCs turn a raw unique-violation into a safe, deterministic
--     application error instead of letting the low-level constraint error
--     leak through.
--   - Disabling a WhatsApp account (status = 'disabled') cascades to disable
--     every phone number under it, so a single admin action reliably closes
--     off both inbound routing and outbound sending for the whole account --
--     see the lifecycle comment on admin_set_whatsapp_account_status below.
--   - The TypeScript inbound-routing and all three outbound send paths are
--     updated (same commit, not this migration) to require
--     status = 'connected' before routing/sending.

-- ---------------------------------------------------------------------------
-- 1. Defense-in-depth: a phone number can never be attached to a WhatsApp
--    account belonging to a different company than the phone number's own
--    company_id, enforced independently of application code. This fires on
--    every insert/update regardless of which RPC (or future code path) wrote
--    the row, so a bug in the RPCs below could never silently produce a
--    cross-tenant-linked row.
-- ---------------------------------------------------------------------------

create or replace function enforce_whatsapp_phone_number_company_match()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_account_company_id uuid;
begin
  select company_id into v_account_company_id
    from public.whatsapp_accounts
    where id = new.whatsapp_account_id;

  if v_account_company_id is null then
    raise exception 'whatsapp_account_not_found';
  end if;

  if v_account_company_id <> new.company_id then
    raise exception 'whatsapp_phone_number_company_mismatch';
  end if;

  return new;
end;
$$;

create trigger whatsapp_phone_numbers_enforce_company_match
  before insert or update on whatsapp_phone_numbers
  for each row execute function enforce_whatsapp_phone_number_company_match();

-- ---------------------------------------------------------------------------
-- 2. admin_connect_whatsapp_account: create or (for the same company only)
--    update a WhatsApp Business Account mapping. Super Admin only.
--
-- A second call with the same waba_id from the SAME company is treated as a
-- legitimate correction (e.g. fixing a typo'd business_name) and updates the
-- existing row rather than failing -- the same "safe to re-run" convention
-- used by ingest_knowledge_source (migration 34). A waba_id already owned by
-- a DIFFERENT company is rejected with a safe, deterministic error instead
-- of a raw unique-violation, and never reveals which company currently owns
-- it.
-- ---------------------------------------------------------------------------

create or replace function admin_connect_whatsapp_account(
  p_company_id uuid,
  p_waba_id text,
  p_business_name text default null,
  p_is_test_account boolean default false,
  p_status whatsapp_connection_status default 'connected'
)
returns table (
  id uuid,
  waba_id text,
  business_name text,
  status whatsapp_connection_status,
  is_test_account boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_waba_id text := nullif(btrim(coalesce(p_waba_id, '')), '');
  v_business_name text := nullif(btrim(coalesce(p_business_name, '')), '');
  v_existing public.whatsapp_accounts%rowtype;
  v_account public.whatsapp_accounts%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if v_waba_id is null then raise exception 'invalid_waba_id'; end if;

  select * into v_existing from public.whatsapp_accounts where public.whatsapp_accounts.waba_id = v_waba_id;

  if found and v_existing.company_id <> p_company_id then
    raise exception 'waba_already_connected_to_another_company';
  end if;

  if found then
    update public.whatsapp_accounts
      set business_name = v_business_name,
          is_test_account = p_is_test_account,
          status = p_status
      where public.whatsapp_accounts.id = v_existing.id
      returning * into v_account;
  else
    insert into public.whatsapp_accounts (company_id, waba_id, business_name, is_test_account, status)
      values (p_company_id, v_waba_id, v_business_name, p_is_test_account, p_status)
      returning * into v_account;
  end if;

  return query select v_account.id, v_account.waba_id, v_account.business_name, v_account.status, v_account.is_test_account;
end;
$$;

revoke all on function admin_connect_whatsapp_account(uuid, text, text, boolean, whatsapp_connection_status) from public, anon;
grant execute on function admin_connect_whatsapp_account(uuid, text, text, boolean, whatsapp_connection_status) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_connect_whatsapp_phone_number: create or (for the same company
--    only) update a phone-number mapping under an existing WhatsApp account
--    owned by the same company. Super Admin only.
--
-- p_whatsapp_account_id must belong to p_company_id -- looked up with both
-- conditions in the same query, so a real account id belonging to a
-- different company resolves as "not found" here (never distinguished from
-- a nonexistent id), exactly like ingest_knowledge_source's own
-- knowledge_source_id + company_id pairing check.
--
-- Connecting (or re-registering) a phone number as p_status = 'connected'
-- while its parent WABA is currently 'disabled' is rejected the same way
-- admin_set_whatsapp_phone_number_status already rejects an explicit
-- reconnect -- otherwise this RPC would be a second, unguarded path to
-- silently reopen inbound routing/outbound sending for an account an admin
-- deliberately disabled.
-- ---------------------------------------------------------------------------

create or replace function admin_connect_whatsapp_phone_number(
  p_company_id uuid,
  p_whatsapp_account_id uuid,
  p_phone_number_id text,
  p_display_phone_number text default null,
  p_status whatsapp_connection_status default 'connected'
)
returns table (
  id uuid,
  whatsapp_account_id uuid,
  phone_number_id text,
  display_phone_number text,
  status whatsapp_connection_status
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone_number_id text := nullif(btrim(coalesce(p_phone_number_id, '')), '');
  v_display_phone_number text := nullif(btrim(coalesce(p_display_phone_number, '')), '');
  v_account public.whatsapp_accounts%rowtype;
  v_existing public.whatsapp_phone_numbers%rowtype;
  v_phone public.whatsapp_phone_numbers%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if v_phone_number_id is null then raise exception 'invalid_phone_number_id'; end if;

  select * into v_account
    from public.whatsapp_accounts
    where public.whatsapp_accounts.id = p_whatsapp_account_id
      and public.whatsapp_accounts.company_id = p_company_id;
  if not found then raise exception 'whatsapp_account_not_found'; end if;

  if p_status = 'connected' and v_account.status = 'disabled' then
    raise exception 'whatsapp_account_disabled';
  end if;

  select * into v_existing
    from public.whatsapp_phone_numbers
    where public.whatsapp_phone_numbers.phone_number_id = v_phone_number_id;

  if found and v_existing.company_id <> p_company_id then
    raise exception 'phone_number_already_connected_to_another_company';
  end if;

  if found then
    update public.whatsapp_phone_numbers
      set whatsapp_account_id = v_account.id,
          display_phone_number = v_display_phone_number,
          status = p_status
      where public.whatsapp_phone_numbers.id = v_existing.id
      returning * into v_phone;
  else
    insert into public.whatsapp_phone_numbers (company_id, whatsapp_account_id, phone_number_id, display_phone_number, status)
      values (p_company_id, v_account.id, v_phone_number_id, v_display_phone_number, p_status)
      returning * into v_phone;
  end if;

  return query select v_phone.id, v_phone.whatsapp_account_id, v_phone.phone_number_id, v_phone.display_phone_number, v_phone.status;
end;
$$;

revoke all on function admin_connect_whatsapp_phone_number(uuid, uuid, text, text, whatsapp_connection_status) from public, anon;
grant execute on function admin_connect_whatsapp_phone_number(uuid, uuid, text, text, whatsapp_connection_status) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. admin_set_whatsapp_account_status: legitimate status transitions for an
--    existing WhatsApp account, including disconnect (status = 'disabled')
--    and reconnect (status = 'connected'). Super Admin only.
--
-- Lifecycle: disabling an account cascades to disable every one of its
-- currently-non-disabled phone numbers in the same statement, so a single
-- admin action reliably removes both inbound routing and outbound sending
-- for the whole account (see the routing/outbound status checks added
-- alongside this migration). Re-enabling an account does NOT cascade back
-- to its phone numbers -- an admin must deliberately reconnect each phone
-- number that should actually resume traffic, since a multi-number account
-- may only want some of its numbers active again. No row is ever
-- hard-deleted, so historical conversations/messages referencing this
-- account's phone numbers remain fully intact regardless of status.
-- ---------------------------------------------------------------------------

create or replace function admin_set_whatsapp_account_status(
  p_company_id uuid,
  p_whatsapp_account_id uuid,
  p_status whatsapp_connection_status
)
returns table (id uuid, status whatsapp_connection_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.whatsapp_accounts%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_account
    from public.whatsapp_accounts
    where public.whatsapp_accounts.id = p_whatsapp_account_id
      and public.whatsapp_accounts.company_id = p_company_id;
  if not found then raise exception 'whatsapp_account_not_found'; end if;

  update public.whatsapp_accounts
    set status = p_status
    where public.whatsapp_accounts.id = v_account.id
    returning * into v_account;

  if p_status = 'disabled' then
    update public.whatsapp_phone_numbers
      set status = 'disabled'
      where public.whatsapp_phone_numbers.whatsapp_account_id = v_account.id
        and public.whatsapp_phone_numbers.status <> 'disabled';
  end if;

  return query select v_account.id, v_account.status;
end;
$$;

revoke all on function admin_set_whatsapp_account_status(uuid, uuid, whatsapp_connection_status) from public, anon;
grant execute on function admin_set_whatsapp_account_status(uuid, uuid, whatsapp_connection_status) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_set_whatsapp_phone_number_status: legitimate status transitions
--    for a single phone number, including disconnect and reconnect. Super
--    Admin only.
--
-- A phone number cannot be reconnected (status set to 'connected') while its
-- parent account is currently 'disabled' -- that would leave an
-- individually-"connected" number under a disabled account, silently
-- undermining the account-level disconnect above. The admin must reconnect
-- the account first.
-- ---------------------------------------------------------------------------

create or replace function admin_set_whatsapp_phone_number_status(
  p_company_id uuid,
  p_phone_number_row_id uuid,
  p_status whatsapp_connection_status
)
returns table (id uuid, status whatsapp_connection_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone public.whatsapp_phone_numbers%rowtype;
  v_account_status public.whatsapp_connection_status;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_phone
    from public.whatsapp_phone_numbers
    where public.whatsapp_phone_numbers.id = p_phone_number_row_id
      and public.whatsapp_phone_numbers.company_id = p_company_id;
  if not found then raise exception 'whatsapp_phone_number_not_found'; end if;

  if p_status = 'connected' then
    select public.whatsapp_accounts.status into v_account_status
      from public.whatsapp_accounts
      where public.whatsapp_accounts.id = v_phone.whatsapp_account_id;
    if v_account_status = 'disabled' then
      raise exception 'whatsapp_account_disabled';
    end if;
  end if;

  update public.whatsapp_phone_numbers
    set status = p_status
    where public.whatsapp_phone_numbers.id = v_phone.id
    returning * into v_phone;

  return query select v_phone.id, v_phone.status;
end;
$$;

revoke all on function admin_set_whatsapp_phone_number_status(uuid, uuid, whatsapp_connection_status) from public, anon;
grant execute on function admin_set_whatsapp_phone_number_status(uuid, uuid, whatsapp_connection_status) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. encrypted_access_token / token_expires_at (migration 3) are
--    deliberately left untouched by this batch. The read-only audit
--    confirmed neither column has ever been read or written by any code
--    path, and no encryption helper for it exists in packages/core -- the
--    column's own comment describes an aspirational design, not an
--    implemented one. This batch does not invent a per-tenant credential
--    architecture: the platform continues to send every outbound message
--    using the single environment-scoped META_ACCESS_TOKEN secret
--    (unchanged). These two columns are reserved, not removed, for a
--    dedicated future decision once real Embedded Signup needs a per-tenant
--    (or per-shared-WABA) credential model -- do not populate them casually
--    or store a plaintext token in either one before that decision is made.
-- ---------------------------------------------------------------------------
