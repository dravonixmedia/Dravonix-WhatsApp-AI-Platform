-- Dravonix WhatsApp AI Platform
-- Meta/WhatsApp Batch 3, Slice A: Embedded Signup credential storage +
-- signup-attempt state machine + security primitives.
--
-- Scope, per the locked architecture (Revision 2.1): schema, encryption
-- provenance columns, and the signup-attempt replay-protection state machine
-- ONLY. No Meta JS SDK, no code exchange, no Graph API verification, no
-- phone registration, no app subscription, no tenant credential resolution
-- in the outbound send paths, no client-facing disconnect/reconnect RPC, and
-- no PIN handling of any kind are part of this migration -- all deferred to
-- later slices once the still-open Meta-behavior questions (see the Slice A
-- report) are resolved.
--
-- INVARIANT (binding on every future caller of the RPCs below, most
-- importantly the Slice C Server Action that does not exist yet): all three
-- RPCs in this migration are service_role-only. The future authenticated
-- Server Action MUST derive both company_id and initiated_by_user_id from
-- the authenticated dashboard session (getDashboardSession()) -- neither
-- value may ever be accepted from browser-controlled signup payload data.
-- complete_whatsapp_signup below does not trust its own p_company_id
-- parameter in isolation either: it re-derives authorization from the
-- signup attempt row itself (locked, re-verified company_id match) before
-- writing anything -- see that function's own comment.
--
-- CREDENTIAL MODEL (unchanged from Batch 1/2, extended not replaced):
-- whatsapp_accounts.connection_source distinguishes the two credential
-- architectures that now coexist:
--   'manual_admin'    -- Super-Admin-entered (migration 35, Batch 1).
--                         Outbound sends continue to use the single
--                         environment-scoped META_ACCESS_TOKEN, exactly as
--                         today. Existing rows get this by column default;
--                         zero behavioral change for them.
--   'embedded_signup' -- self-service Meta Embedded Signup (this batch).
--                         Outbound sends must use THIS row's own
--                         encrypted_access_token. There is no fallback to
--                         the global token for an embedded_signup row --
--                         that resolution logic is a Slice E concern, not
--                         built by this migration, but the schema exists so
--                         it can be built without another migration.

-- ---------------------------------------------------------------------------
-- 1. whatsapp_accounts: Embedded Signup credential + provenance columns.
-- ---------------------------------------------------------------------------

alter table whatsapp_accounts
  add column connection_source text not null default 'manual_admin'
    check (connection_source in ('manual_admin', 'embedded_signup')),
  add column meta_business_id text,
  add column encryption_key_version smallint,
  add column credential_error_code text,
  add column credential_failed_at timestamptz;

comment on column whatsapp_accounts.connection_source is
  'manual_admin: Super-Admin-entered (Batch 1, migration 35) -- outbound sends resolve to the global META_ACCESS_TOKEN, unchanged. embedded_signup: self-service Meta Embedded Signup (Batch 3) -- outbound sends must resolve to this row''s own encrypted_access_token, with NO fallback to the global token. This column is the single source of truth that decides which credential a future outbound-send credential-resolution helper (Slice E, not yet built) must use for a given row.';

comment on column whatsapp_accounts.encrypted_access_token is
  'Batch 1 (migration 3) column, redefined by Batch 3 Slice A: for connection_source = embedded_signup rows, holds a versioned AES-256-GCM JSON envelope produced by packages/core/src/tokenEncryption.ts (encryptWhatsAppAccessToken) -- never a raw token, never plaintext. NULL for connection_source = manual_admin rows (unchanged from Batch 1: this column has never been read or written by manual_admin code paths and is not populated for them by this migration).';

comment on column whatsapp_accounts.token_expires_at is
  'Batch 1 (migration 3) column, now populated by Batch 3 Slice C (not yet built) ONLY from an authoritative Meta-returned value (the code-exchange response''s own expires_in, or a subsequent /debug_token lookup) -- never a fabricated now() + N days. NULL means unknown or non-expiring, not "assume 60 days".';

comment on column whatsapp_accounts.meta_business_id is
  'The business_id Meta returns alongside waba_id/phone_number_id on Embedded Signup completion. Plain provenance metadata, not a security-critical identity check -- WABA and phone-number authorization (verified via Graph API in Slice C) remain the sole security-critical asset identities. NULL for manual_admin rows.';

comment on column whatsapp_accounts.encryption_key_version is
  'Redundant with the "kv" field already embedded in the encrypted_access_token envelope itself -- kept as a separate, directly queryable column so an operator can audit which rows need re-encryption during a future key rotation without decrypting anything. NULL for manual_admin rows (no token, no key).';

comment on column whatsapp_accounts.credential_error_code is
  'Small controlled vocabulary only (e.g. exchange_failed, decrypt_failed, graph_verification_failed, subscription_failed, expired) -- NEVER raw Graph/exception text, never a token, never an authorization code, never an App Secret. Cleared to NULL by complete_whatsapp_signup on a successful (re)connection.';

comment on column whatsapp_accounts.credential_failed_at is
  'Timestamp of the most recent credential/connection failure recorded via credential_error_code. Cleared to NULL alongside credential_error_code on a successful (re)connection.';

-- ---------------------------------------------------------------------------
-- 2. whatsapp_phone_numbers: parity error metadata (same sanitized-code
--    contract as whatsapp_accounts.credential_error_code above).
-- ---------------------------------------------------------------------------

alter table whatsapp_phone_numbers
  add column last_connection_error_code text,
  add column last_connection_error_at timestamptz;

comment on column whatsapp_phone_numbers.last_connection_error_code is
  'Small controlled vocabulary only -- NEVER raw Graph/exception text, never a token, never a PIN. Cleared to NULL by complete_whatsapp_signup on a successful (re)connection.';

comment on column whatsapp_phone_numbers.last_connection_error_at is
  'Timestamp of the most recent phone-level connection failure recorded via last_connection_error_code. Cleared to NULL alongside it on a successful (re)connection.';

-- ---------------------------------------------------------------------------
-- 3. whatsapp_signup_attempts: replay-protected signup-attempt state
--    machine. Server-only (no SELECT policy -- see the RLS section below):
--    no current client UI needs direct read access to this table, and the
--    nonce_hash column must never be browser-readable.
--
--    State machine: pending -> processing -> completed, with expired/failed
--    as terminal/cleanup states. A row transitions pending -> processing
--    only via claim_whatsapp_signup_attempt's single atomic compare-and-set
--    (below), and processing -> completed only via complete_whatsapp_signup
--    (below), inside the same transaction that writes the resulting
--    whatsapp_accounts/whatsapp_phone_numbers rows -- there is no path that
--    marks an attempt completed merely because a request was received.
--
--    Deliberately stores NO Meta-derived secret: no authorization code (it
--    is 30-seconds-lived and would be pointless -- and dangerous -- to
--    persist), no access token, no PIN. Its only job is replay/concurrency
--    protection for the signup flow itself.
-- ---------------------------------------------------------------------------

create table whatsapp_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  -- Same "who initiated this" convention already used by audit_logs.actor_user_id,
  -- billing's submitted_by_user_id, and support_requests' created_by_user_id:
  -- on delete set null (never cascade) so a later user deletion never
  -- destroys this audit-relevant row.
  initiated_by_user_id uuid references auth.users (id) on delete set null,
  nonce_hash text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'expired', 'failed')),
  failure_code text,
  resulting_whatsapp_account_id uuid references whatsapp_accounts (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  constraint whatsapp_signup_attempts_expiry_bounded
    check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);

comment on column whatsapp_signup_attempts.nonce_hash is
  'SHA-256 hex digest of a raw nonce generated server-side (future Slice C Server Action) and returned to the browser once, at attempt-creation time. The raw nonce itself is NEVER stored anywhere -- only its hash. Enforced as exactly 64 lowercase hex characters; a malformed value is rejected before insert, never silently truncated or coerced.';

comment on column whatsapp_signup_attempts.failure_code is
  'Small controlled vocabulary only, describing why a processing attempt was marked failed (e.g. exchange_failed, graph_verification_failed, subscription_failed, db_persistence_failed) -- NEVER raw Graph/exception text, never a token, never an authorization code.';

comment on column whatsapp_signup_attempts.resulting_whatsapp_account_id is
  'Populated atomically, in the same transaction, only when status transitions to completed -- a durable, queryable link from a signup attempt to the connection it produced, without needing to persist any Meta secret to establish that link.';

create index whatsapp_signup_attempts_company_id_idx on whatsapp_signup_attempts (company_id);

-- Supports a future stale-processing housekeeping sweep (not implemented by
-- this migration -- see the Slice A report's stale-processing recovery
-- rule): a processing row that has sat past a bounded recovery window is
-- swept to failed. This index makes that sweep's own query
-- (status = 'processing' order by claimed_at) cheap without requiring the
-- sweep itself to exist yet.
create index whatsapp_signup_attempts_processing_idx on whatsapp_signup_attempts (status, claimed_at)
  where status = 'processing';

alter table whatsapp_signup_attempts enable row level security;

-- Deliberately NO select/insert/update/delete policy for any role. This
-- table is server-only for Slice A: no current client UI needs to read it,
-- and nonce_hash must never be exposed to an authenticated browser session
-- even for the row's own owning company. All reads/writes happen through
-- the three SECURITY DEFINER, service_role-only functions below, or via the
-- service role directly (which bypasses RLS by design, same as every other
-- service-role-only table interaction elsewhere in this schema).

-- ---------------------------------------------------------------------------
-- 4. create_whatsapp_signup_attempt: inserts a new pending attempt.
--    service_role only -- the browser must never call this directly; the
--    future Slice C Server Action generates the raw nonce itself (Web
--    Crypto), hashes it, and calls this RPC only to persist the hash.
-- ---------------------------------------------------------------------------

create or replace function create_whatsapp_signup_attempt(
  p_company_id uuid,
  p_initiated_by_user_id uuid,
  p_nonce_hash text,
  p_expires_at timestamptz
)
returns table (id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.whatsapp_signup_attempts%rowtype;
begin
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  if not exists (select 1 from auth.users where auth.users.id = p_initiated_by_user_id) then
    raise exception 'initiating_user_not_found';
  end if;

  if p_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_nonce_hash';
  end if;

  if p_expires_at <= now() then
    raise exception 'invalid_expiry';
  end if;
  if p_expires_at > now() + interval '15 minutes' then
    raise exception 'invalid_expiry';
  end if;

  insert into public.whatsapp_signup_attempts
    (company_id, initiated_by_user_id, nonce_hash, expires_at)
    values (p_company_id, p_initiated_by_user_id, p_nonce_hash, p_expires_at)
    returning * into v_row;

  return query select v_row.id, v_row.expires_at;
end;
$$;

revoke all on function create_whatsapp_signup_attempt(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function create_whatsapp_signup_attempt(uuid, uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5. claim_whatsapp_signup_attempt: pending -> processing. Single atomic
--    compare-and-set: exactly one concurrent caller can succeed for a given
--    attempt, since only one UPDATE can see status = 'pending' before the
--    first commits. Never reveals which of {wrong id, wrong company, wrong
--    nonce, already claimed, expired} caused a failure -- all collapse into
--    the same generic exception, exactly like the encryption module's own
--    decryption-failure design (never an oracle for probing attempt state).
-- ---------------------------------------------------------------------------

create or replace function claim_whatsapp_signup_attempt(
  p_attempt_id uuid,
  p_company_id uuid,
  p_nonce_hash text
)
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.whatsapp_signup_attempts%rowtype;
begin
  update public.whatsapp_signup_attempts
    set status = 'processing', claimed_at = now()
    where public.whatsapp_signup_attempts.id = p_attempt_id
      and public.whatsapp_signup_attempts.company_id = p_company_id
      and public.whatsapp_signup_attempts.nonce_hash = p_nonce_hash
      and public.whatsapp_signup_attempts.status = 'pending'
      and public.whatsapp_signup_attempts.expires_at > now()
    returning * into v_row;

  if not found then
    raise exception 'signup_attempt_not_claimable';
  end if;

  return query select v_row.id;
end;
$$;

revoke all on function claim_whatsapp_signup_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function claim_whatsapp_signup_attempt(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. complete_whatsapp_signup: processing -> completed, atomic with the
--    whatsapp_accounts/whatsapp_phone_numbers write. service_role only.
--
--    Authorization note (binding invariant): this function does NOT trust
--    p_company_id in isolation. It locks the attempt row (`for update`) and
--    requires p_company_id to match that row's OWN company_id before doing
--    anything else -- so the only way to influence which company a
--    connection is written for is by controlling which attempt was
--    successfully claimed earlier (claim_whatsapp_signup_attempt already
--    required company_id + nonce_hash to match at that step). This is what
--    "internal consistency between attempt.company_id and the company_id
--    being written to whatsapp_accounts/whatsapp_phone_numbers" means in
--    practice: the write always uses the attempt's own company_id, proven
--    by the lock+match above, not the caller-supplied parameter in
--    isolation.
--
--    The `for update` row lock also closes the concurrent-completion race:
--    a second call for the same attempt blocks on the lock, then observes
--    status <> 'processing' once the first commits, and fails cleanly.
--
--    Cross-tenant WABA/phone rejection independently re-implements
--    migration 35's admin_connect_whatsapp_account/
--    admin_connect_whatsapp_phone_number logic (does not call those RPCs --
--    they require current_platform_role() = 'super_admin', which a company
--    user completing their own Embedded Signup will never have). Same-
--    company re-signup of an already-connected WABA/phone updates the
--    existing row rather than duplicating it, which is also how a prior
--    manual_admin connection is atomically upgraded to embedded_signup:
--    connection_source flips, the encrypted credential becomes
--    authoritative, and no duplicate row or history loss occurs.
--
--    The existing enforce_whatsapp_phone_number_company_match trigger
--    (migration 35) fires unchanged on the inserts/updates below -- free
--    defense-in-depth, independent of this function's own logic, exactly
--    as it already protects every other write path to this table.
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

  update public.whatsapp_signup_attempts
    set status = 'completed', completed_at = now(), resulting_whatsapp_account_id = v_account.id
    where public.whatsapp_signup_attempts.id = v_attempt.id;

  return query select v_account.id, v_phone.id;
end;
$$;

revoke all on function complete_whatsapp_signup(uuid, uuid, text, text, text, text, text, text, smallint, timestamptz) from public, anon, authenticated;
grant execute on function complete_whatsapp_signup(uuid, uuid, text, text, text, text, text, text, smallint, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Migration 35's four Super Admin RPCs (admin_connect_whatsapp_account,
--    admin_connect_whatsapp_phone_number, admin_set_whatsapp_account_status,
--    admin_set_whatsapp_phone_number_status) are entirely untouched by this
--    migration -- not referenced, not redefined, not re-granted. The
--    manual_admin onboarding path continues to work exactly as it did
--    before this migration, including for the existing manually-connected
--    staging test WABA (which keeps connection_source = 'manual_admin' via
--    this migration's column default, with zero backfill needed).
-- ---------------------------------------------------------------------------
