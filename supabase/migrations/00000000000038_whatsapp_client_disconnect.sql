-- Dravonix WhatsApp AI Platform
-- Meta/WhatsApp Batch 3, Slice C: client-initiated Embedded Signup
-- connect/disconnect for a company's OWN WhatsApp Business Account.
--
-- ---------------------------------------------------------------------------
-- 0. Re-grant whatsapp.manage to company_owner/company_admin.
--
-- IMPORTANT CONTEXT: migration 22 (Client Dashboard Permission Hardening)
-- deliberately REVOKED whatsapp.manage (among others) from company_owner/
-- company_admin, as part of "Dravonix now owns configuration exclusively"
-- -- at that time, the only thing whatsapp.manage could ever have gated was
-- a manual-credential-entry flow the client dashboard never actually
-- offered. This migration re-grants it, narrowly, for a genuinely new and
-- different purpose migration 22 could not have anticipated: this batch's
-- own self-service Meta Embedded Signup, where the client's browser never
-- sees or handles a credential at all (the flow is FB.login -> this app's
-- authenticated backend -> Graph API verification -> encrypted storage) --
-- it is not a re-opening of the manual credential-entry surface migration
-- 22 was built to close. This is the ONLY permission migration 22 revoked
-- that this migration restores; team.manage/settings.manage/
-- ai_settings.manage/knowledge.manage/billing.manage remain exactly as
-- migration 22 left them, untouched by this migration.
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission_key)
values
  ('company_owner', 'whatsapp.manage'),
  ('company_admin', 'whatsapp.manage')
on conflict (role, permission_key) do nothing;

-- Scope, otherwise deliberately narrow: this migration's only other change
-- is exactly one new RPC, client_disconnect_whatsapp_account. Reconnect does
-- NOT need a new RPC -- complete_whatsapp_signup (migration 37) already
-- upserts an existing connection_source = 'embedded_signup' row rather than
-- creating a duplicate, so re-running Embedded Signup for the same
-- WABA/phone IS the reconnect path (see
-- packages/whatsapp/src/embeddedSignupFlow.ts).
--
-- Why a SEPARATE RPC from migration 35's admin_set_whatsapp_account_status,
-- rather than just widening that one's grant to `authenticated`: that RPC
-- checks current_platform_role() = 'super_admin' and operates on ANY
-- company's account by company_id -- widening its grant would let any
-- authenticated user attempt to disconnect any company's connection (the
-- p_company_id check inside only narrows which ROW is touched, it is not an
-- authorization check against the CALLER's own membership). This RPC checks
-- has_company_permission(p_company_id, 'whatsapp.manage') instead, which is
-- true only for a caller with an active company_members row for that exact
-- company and a role granting whatsapp.manage (company_owner/company_admin,
-- re-granted by section 0 above) -- the correct authorization boundary for a
-- client-initiated action.
--
-- Why this RPC refuses to touch a connection_source = 'manual_admin' row: a
-- company user has no way to RECONNECT a manual_admin connection through the
-- client dashboard (that credential was entered by Dravonix staff via the
-- Super Admin console, migration 35, and the client dashboard has no
-- equivalent input for it) -- letting a client disconnect one here would
-- strand them with no self-service way back, worse than not offering the
-- control at all. A manual_admin row can only be disabled by a Super Admin,
-- exactly as before this migration.
--
-- Same "no hard delete, cascade disable to phone numbers, historical
-- messages/conversations fully preserved" lifecycle as
-- admin_set_whatsapp_account_status (migration 35) -- this migration
-- deliberately mirrors that function's body rather than introducing a new
-- disconnect lifecycle.

create or replace function client_disconnect_whatsapp_account(
  p_company_id uuid,
  p_whatsapp_account_id uuid
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
  if not public.has_company_permission(p_company_id, 'whatsapp.manage') then
    raise exception 'permission_denied';
  end if;

  select * into v_account
    from public.whatsapp_accounts
    where public.whatsapp_accounts.id = p_whatsapp_account_id
      and public.whatsapp_accounts.company_id = p_company_id;
  if not found then raise exception 'whatsapp_account_not_found'; end if;

  if v_account.connection_source <> 'embedded_signup' then
    -- Not this RPC's to touch -- see this migration's own header comment.
    raise exception 'whatsapp_account_not_client_managed';
  end if;

  update public.whatsapp_accounts
    set status = 'disabled',
        encrypted_access_token = null,
        encryption_key_version = null,
        token_expires_at = null,
        credential_error_code = null,
        credential_failed_at = null
    where public.whatsapp_accounts.id = v_account.id
    returning * into v_account;

  update public.whatsapp_phone_numbers
    set status = 'disabled'
    where public.whatsapp_phone_numbers.whatsapp_account_id = v_account.id
      and public.whatsapp_phone_numbers.status <> 'disabled';

  return query select v_account.id, v_account.status;
end;
$$;

revoke all on function client_disconnect_whatsapp_account(uuid, uuid) from public, anon;
grant execute on function client_disconnect_whatsapp_account(uuid, uuid) to authenticated;
