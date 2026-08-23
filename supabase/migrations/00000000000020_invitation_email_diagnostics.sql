-- Dravonix WhatsApp AI Platform
-- Invitation email delivery diagnostics: adds a sanitized error message and
-- a fixed 'zeptomail' provider tag to the audit trail migration 19 already
-- established, so a real delivery failure can be triaged from audit_logs
-- alone instead of only ever seeing a bare error_code.
--
-- Diagnosed need: a real staging failure recorded error_code = "http_500"
-- with no further detail, because record_invitation_email_event never had a
-- parameter for the provider's own error message (packages/email's
-- ZeptoMailEmailProvider already computes one; it was simply discarded
-- before reaching this RPC). Never stores the raw invitation token, the
-- email provider API key/token, or a full email body/request/response --
-- only a masked recipient, delivery outcome, sanitized error message, and
-- (on success) the provider's own message id, exactly as migration 19
-- already established.

-- Postgres identifies a function by name + parameter *type* signature --
-- appending a new parameter changes that signature, so `create or replace`
-- alone would create a second, overloaded 6-arg function alongside the
-- original 5-arg one from migration 19 rather than actually replacing it.
-- The old signature is dropped explicitly first so exactly one version of
-- this RPC exists afterwards.
drop function if exists record_invitation_email_event(uuid, text, text, text, text);

create or replace function record_invitation_email_event(
  p_invitation_id uuid,
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
  v_invitation public.company_invitations%rowtype;
  v_action text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_event not in ('sent', 'failed') then raise exception 'invalid_event'; end if;

  select * into v_invitation from public.company_invitations where public.company_invitations.id = p_invitation_id;
  if not found then raise exception 'invitation_not_found'; end if;

  if public.current_platform_role() is distinct from 'super_admin' and not public.has_company_permission(v_invitation.company_id, 'team.manage') then
    raise exception 'permission_denied';
  end if;

  v_action := case when p_event = 'sent' then 'invitation_email_sent' else 'invitation_email_failed' end;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (
      v_invitation.company_id, auth.uid(), 'user', v_action, 'company_invitation', p_invitation_id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'provider', 'zeptomail',
        'recipient', p_masked_recipient,
        'provider_message_id', p_provider_message_id,
        'error_code', p_error_code,
        'error_message', p_error_message
      ))
    );
end;
$$;

revoke all on function record_invitation_email_event(uuid, text, text, text, text, text) from public, anon;
grant execute on function record_invitation_email_event(uuid, text, text, text, text, text) to authenticated;
