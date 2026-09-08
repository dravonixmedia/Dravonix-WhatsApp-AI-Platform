-- Dravonix WhatsApp AI Platform
-- Meta/WhatsApp Batch 3, Slice D (post-success hardening): two real
-- production defects surfaced by the first genuine end-to-end Embedded
-- Signup success on staging.
--
-- DEFECT 1 -- registration PIN lifecycle. Meta's /register call
-- (registerPhoneNumber) both registers a phone number AND sets its
-- two-step-verification PIN going forward. This project's prior design
-- (see embeddedSignupFlow.ts's generateRegistrationPin, PR #74) generated a
-- fresh random PIN on every call and never persisted it, reasoning that a
-- future re-registration could simply set a new PIN. That reasoning was
-- WRONG: a real staging attempt proved Meta rejects re-registration of an
-- already-registered number with a DIFFERENT PIN than the one already set
-- (HTTP 400, error.code=133005, error.type=OAuthException, "Security PIN
-- mismatch: Wrong PIN used"). The PIN must be persisted and reused for the
-- SAME phone_number_id, not regenerated blindly.
--
-- DEFECT 2 -- one-active-WABA-per-company. complete_whatsapp_signup
-- (migration 37) only ever inserts/updates the ONE row matching the
-- signed-up waba_id; a company that already has a whatsapp_accounts row for
-- a DIFFERENT waba_id (e.g. Batch 1's manual_admin connection) ends up with
-- TWO simultaneously status='connected' rows. This actually happened on
-- staging. apps/web's dashboard queries (`.eq("company_id",
-- companyId).maybeSingle()`) assume at most one row per company; with two
-- rows, PostgREST's "multiple rows returned" error surfaces from
-- .maybeSingle() as `{data: null, error: {...}}`, and the page discarded
-- `error` -- so a real, connected, credentialed account rendered as
-- "WhatsApp connection not yet set up".
--
-- ---------------------------------------------------------------------------
-- 1. whatsapp_registration_pins -- durable, phone_number_id-keyed encrypted
--    PIN storage, INDEPENDENT of whatsapp_accounts/whatsapp_phone_numbers/
--    whatsapp_signup_attempts. Why a dedicated table rather than a column on
--    one of those:
--
--    - whatsapp_signup_attempts (migration 37) deliberately stores no
--      Meta-derived secret at all, and -- more importantly -- a failed
--      attempt's row is never reused by a later retry (a fresh attempt_id is
--      always created instead, per that migration's own documented,
--      accepted "stuck in processing" gap). A PIN column there would be
--      write-only and unreadable by the very retry that needs it.
--    - whatsapp_phone_numbers only gets its row written by
--      complete_whatsapp_signup, i.e. AFTER registration, subscription, AND
--      persistence all succeed. The exact failure boundary this migration
--      must survive (Meta /register succeeds, then DRAIVA fails before
--      persistence -- network failure, worker crash, subscription failure,
--      DB failure) is precisely the case where that row is never written.
--      A PIN column there cannot record a PIN that was set on Meta's side
--      but never reached DRAIVA's persistence step.
--    - phone_number_id is Meta's own globally-unique identifier for the
--      number (already relied on as globally unique via
--      whatsapp_phone_numbers' own `unique (phone_number_id)` constraint,
--      migration 3) -- a PIN is a property of the NUMBER on Meta's system,
--      not of any one DRAIVA company/account/attempt row. Keying this table
--      by phone_number_id alone (no company_id) mirrors that reality and
--      lets a PIN be found and reused by a brand-new signup_attempt row,
--      regardless of which attempt or account row (if any) ends up
--      persisted.
--
--    Written by embeddedSignupFlow.ts immediately after a successful
--    /register call (before subscribeAppToWaba), independent of whether the
--    rest of the flow succeeds -- this is what makes the PIN recoverable
--    across the partial-failure boundary above. Read before every
--    /register call to decide whether to reuse an existing PIN or generate
--    a fresh one (see generateRegistrationPin/findExistingRegistrationPin
--    in embeddedSignupFlow.ts).
--
--    Same encrypted-at-rest contract as whatsapp_accounts.encrypted_access_token
--    (AES-256-GCM envelope, packages/core/src/tokenEncryption.ts) using the
--    SAME existing WHATSAPP_TOKEN_ENCRYPTION_KEY_V<n> key material, but a
--    DISTINCT AAD purpose string bound to phone_number_id (not waba_id / not
--    the access-token purpose) -- see encryptWhatsAppRegistrationPin /
--    decryptWhatsAppRegistrationPin. This is deliberately not a new
--    cryptographic primitive: same cipher, same envelope shape, same key,
--    only the AAD differs, which is exactly what AAD purpose-binding is for.
--
--    Deliberately NO select/insert/update/delete policy for any role --
--    same pattern as whatsapp_signup_attempts (migration 37): server-only,
--    read/written exclusively via the service-role client from
--    embeddedSignupFlow.ts's injected dependencies, never through an
--    RLS-scoped client, never exposed to a browser.
-- ---------------------------------------------------------------------------

create table whatsapp_registration_pins (
  phone_number_id text primary key,
  registration_pin_encrypted text not null,
  registration_pin_key_version smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table whatsapp_registration_pins is
  'Durable, Meta-phone-number-scoped storage for the six-digit PIN last used to successfully register a phone number via POST /{phone-number-id}/register. Never plaintext -- registration_pin_encrypted is a versioned AES-256-GCM envelope (same shape/key material as whatsapp_accounts.encrypted_access_token, distinct AAD purpose). Keyed by phone_number_id alone (not company_id) because a PIN is a property of the Meta asset, not of any one DRAIVA row -- see this migration''s own header comment for why this could not live on whatsapp_accounts/whatsapp_phone_numbers/whatsapp_signup_attempts instead. No RLS policy for any role: service-role access only, identical convention to whatsapp_signup_attempts.';

comment on column whatsapp_registration_pins.registration_pin_encrypted is
  'AES-256-GCM JSON envelope from encryptWhatsAppRegistrationPin (packages/core/src/tokenEncryption.ts). NEVER plaintext, NEVER logged, NEVER included in audit metadata, diagnostics, or any API/dashboard response.';

alter table whatsapp_registration_pins enable row level security;

-- Deliberately no explicit `revoke all on table ...` here either -- exactly
-- mirroring whatsapp_signup_attempts (migration 37): RLS-enabled with zero
-- policies for any role is already sufficient (a role with the schema's
-- normal default table grants sees zero rows via RLS on SELECT, and any
-- direct INSERT/UPDATE/DELETE is rejected with Postgres's own standard "new
-- row violates row-level security policy" error), and matching the existing
-- table's exact idiom keeps the two server-only tables behaving
-- identically for anyone auditing this schema later.

-- ---------------------------------------------------------------------------
-- 2. complete_whatsapp_signup: enforce one-active-WABA-per-company.
--    Signature is UNCHANGED from migration 37 (CREATE OR REPLACE preserves
--    the existing grants) -- the PIN itself is never passed as a parameter
--    here at all; it is read/written directly against
--    whatsapp_registration_pins by embeddedSignupFlow.ts, entirely outside
--    this RPC's transaction, before this RPC is ever called (see this
--    migration's header comment on the partial-failure boundary this is
--    designed around).
--
--    New behavior, appended AFTER the existing insert/update logic and
--    BEFORE marking the attempt completed: every OTHER whatsapp_accounts row
--    for this SAME company (v_attempt.company_id, the same
--    already-authorized scope this function's pre-existing logic uses --
--    see migration 37's own authorization-note comment) that is not already
--    'disabled' is superseded -- flipped to 'disabled', with its
--    embedded_signup credential fields cleared (mirrors
--    client_disconnect_whatsapp_account's exact clearing behavior,
--    migration 38; a manual_admin row has no credential fields to clear, so
--    the CASE below is a no-op for it). Its phone numbers are disabled the
--    same way. This is what makes a newly-completed Embedded Signup
--    connection to a DIFFERENT waba_id become the company's sole active
--    connection: 'disabled' is not a new concept -- it is the exact status
--    the existing inbound-webhook-routing query
--    (apps/api/src/repositories/supabaseWhatsAppIngestRepository.ts,
--    `.eq("status", "connected")`) and the existing send-path status checks
--    already treat as "do not use this row", so superseding a connection
--    this way is immediately correct everywhere in the app with zero
--    further code change required for routing/sending.
--
--    Never touches another company's rows (scoped to v_attempt.company_id,
--    the same locked, re-verified value every other statement in this
--    function already uses). Never deletes a row -- history and every
--    linked conversation/message is preserved untouched. Never runs unless
--    this call's own insert/update of v_account/v_phone already succeeded,
--    so a failed signup never deactivates the company's current working
--    connection (this whole function runs inside one transaction; any
--    exception before this point already rolls back the whole call, per
--    normal PL/pgSQL/Postgres function semantics).
-- ---------------------------------------------------------------------------

create or replace function complete_whatsapp_signup(
  p_attempt_id uuid,
  p_company_id uuid,
  p_waba_id text,
  p_phone_number_id text,
  p_meta_business_id text,
  p_business_name text,
  p_display_phone_number text,
  p_encrypted_token text,
  p_encryption_key_version smallint,
  p_token_expires_at timestamptz
)
returns table (
  whatsapp_account_id uuid,
  whatsapp_phone_number_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.whatsapp_signup_attempts%rowtype;
  v_existing_account public.whatsapp_accounts%rowtype;
  v_account public.whatsapp_accounts%rowtype;
  v_existing_phone public.whatsapp_phone_numbers%rowtype;
  v_phone public.whatsapp_phone_numbers%rowtype;
  v_waba_id text := nullif(btrim(coalesce(p_waba_id, '')), '');
  v_phone_number_id text := nullif(btrim(coalesce(p_phone_number_id, '')), '');
begin
  select * into v_attempt
    from public.whatsapp_signup_attempts
    where public.whatsapp_signup_attempts.id = p_attempt_id
      and public.whatsapp_signup_attempts.company_id = p_company_id
      and public.whatsapp_signup_attempts.status = 'processing'
    for update;

  if not found then
    raise exception 'signup_attempt_not_processing';
  end if;

  if v_waba_id is null then raise exception 'invalid_waba_id'; end if;
  if v_phone_number_id is null then raise exception 'invalid_phone_number_id'; end if;

  -- Cross-tenant WABA rejection, identical shape to migration 35's
  -- admin_connect_whatsapp_account:
  select * into v_existing_account from public.whatsapp_accounts where public.whatsapp_accounts.waba_id = v_waba_id;
  if found and v_existing_account.company_id <> v_attempt.company_id then
    raise exception 'waba_already_connected_to_another_company';
  end if;

  if found then
    update public.whatsapp_accounts
      set business_name = coalesce(p_business_name, business_name),
          meta_business_id = p_meta_business_id,
          connection_source = 'embedded_signup',
          encrypted_access_token = p_encrypted_token,
          encryption_key_version = p_encryption_key_version,
          token_expires_at = p_token_expires_at,
          status = 'connected',
          credential_error_code = null,
          credential_failed_at = null
      where public.whatsapp_accounts.id = v_existing_account.id
      returning * into v_account;
  else
    insert into public.whatsapp_accounts
      (company_id, waba_id, business_name, meta_business_id, connection_source,
       encrypted_access_token, encryption_key_version, token_expires_at, status)
      values (v_attempt.company_id, v_waba_id, p_business_name, p_meta_business_id, 'embedded_signup',
              p_encrypted_token, p_encryption_key_version, p_token_expires_at, 'connected')
      returning * into v_account;
  end if;

  -- Cross-tenant phone rejection, identical shape to migration 35's
  -- admin_connect_whatsapp_phone_number:
  select * into v_existing_phone from public.whatsapp_phone_numbers where public.whatsapp_phone_numbers.phone_number_id = v_phone_number_id;
  if found and v_existing_phone.company_id <> v_attempt.company_id then
    raise exception 'phone_number_already_connected_to_another_company';
  end if;

  if found then
    update public.whatsapp_phone_numbers
      set whatsapp_account_id = v_account.id,
          display_phone_number = coalesce(p_display_phone_number, display_phone_number),
          status = 'connected',
          last_connection_error_code = null,
          last_connection_error_at = null
      where public.whatsapp_phone_numbers.id = v_existing_phone.id
      returning * into v_phone;
  else
    insert into public.whatsapp_phone_numbers
      (company_id, whatsapp_account_id, phone_number_id, display_phone_number, status)
      values (v_attempt.company_id, v_account.id, v_phone_number_id, p_display_phone_number, 'connected')
      returning * into v_phone;
  end if;

  -- One-active-WABA-per-company: supersede every other non-disabled account
  -- (and its phone numbers) for this company now that v_account is the
  -- successfully (re)connected one. See this migration's own header comment.
  update public.whatsapp_accounts
    set status = 'disabled',
        encrypted_access_token = case when connection_source = 'embedded_signup' then null else encrypted_access_token end,
        encryption_key_version = case when connection_source = 'embedded_signup' then null else encryption_key_version end,
        token_expires_at = case when connection_source = 'embedded_signup' then null else token_expires_at end,
        credential_error_code = null,
        credential_failed_at = null
    where public.whatsapp_accounts.company_id = v_attempt.company_id
      and public.whatsapp_accounts.id <> v_account.id
      and public.whatsapp_accounts.status <> 'disabled';

  update public.whatsapp_phone_numbers
    set status = 'disabled'
    where public.whatsapp_phone_numbers.company_id = v_attempt.company_id
      and public.whatsapp_phone_numbers.whatsapp_account_id <> v_account.id
      and public.whatsapp_phone_numbers.status <> 'disabled';

  update public.whatsapp_signup_attempts
    set status = 'completed', completed_at = now(), resulting_whatsapp_account_id = v_account.id
    where public.whatsapp_signup_attempts.id = v_attempt.id;

  return query select v_account.id, v_phone.id;
end;
$$;

-- Grants unchanged (CREATE OR REPLACE with an identical signature preserves
-- them), restated here only for readers, not because they need to be
-- reapplied:
-- revoke all on function complete_whatsapp_signup(uuid, uuid, text, text, text, text, text, text, smallint, timestamptz) from public, anon, authenticated;
-- grant execute on function complete_whatsapp_signup(uuid, uuid, text, text, text, text, text, text, smallint, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Deliberately NOT included in this migration (see the accompanying PR
--    description for the full reasoning):
--
--    - A partial unique index enforcing "at most one non-disabled
--      whatsapp_accounts row per company_id" at the database level. This
--      would be the strongest possible guarantee, but the CURRENT staging
--      company already has two simultaneously non-disabled rows (the exact
--      bug this migration fixes going forward) -- adding that constraint
--      now would fail to apply until that pre-existing data is repaired,
--      and this batch's explicit instruction is to fix the code/schema
--      first and defer any staging data repair to a separate, approved
--      step. Adding the constraint is a natural, low-risk follow-up once
--      that repair has happened.
--    - Any change to migration 35's admin_connect_whatsapp_account /
--      admin_set_whatsapp_account_status (the Super-Admin manual_admin
--      path) -- out of scope; this batch only touches the Embedded Signup
--      completion path.
-- ---------------------------------------------------------------------------
