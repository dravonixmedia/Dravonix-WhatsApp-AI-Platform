-- Dravonix WhatsApp AI Platform
-- Invitation email delivery observability: one narrow RPC recording that an
-- invitation email was attempted, so client-onboarding email delivery (built
-- entirely in apps/web's Server Action layer -- Postgres cannot make
-- outbound HTTP calls) still produces a normal audit_logs trail, matching
-- every other privileged action in this codebase.
--
-- No new table, no change to company_invitations or its token architecture.
-- Never stores the raw invitation token, the email provider API key, or a
-- full email body -- only a masked recipient, delivery outcome, and (on
-- success) the provider's own message id.

create or replace function record_invitation_email_event(
  p_invitation_id uuid,
  p_event text,
  p_masked_recipient text default null,
  p_provider_message_id text default null,
  p_error_code text default null
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
        'recipient', p_masked_recipient,
        'provider_message_id', p_provider_message_id,
        'error_code', p_error_code
      ))
    );
end;
$$;

revoke all on function record_invitation_email_event(uuid, text, text, text, text) from public, anon;
grant execute on function record_invitation_email_event(uuid, text, text, text, text) to authenticated;
