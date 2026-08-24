"use server";

/**
 * Company invitation Server Actions (migration 18). Thin wrappers around the
 * create_company_invitation/admin_resend_company_invitation/
 * admin_revoke_company_invitation/accept_company_invitation RPCs -- each RPC
 * re-verifies authorization itself (super_admin OR the caller's own
 * team.manage permission on the target company), so these actions add no
 * authorization logic of their own beyond requiring *some* authenticated
 * session before making the call.
 *
 * Invitation email delivery (migration 19's record_invitation_email_event +
 * lib/email/sendInvitationEmail.ts, shared by both this Super Admin path and
 * the client-side Team page -- there is only ever this one call site for
 * each RPC) is best-effort and never corrupts the invitation record: the
 * company_invitations row is already committed by the RPC before the email
 * is attempted, so an email failure can only ever fail to notify, never
 * roll back or invalidate the invitation itself. When no email provider is
 * configured (env.emailConfigured === false), acceptUrl is still returned so
 * the existing manual-copy fallback keeps working -- this only happens
 * outside of a fully configured production deploy.
 */

import { loadEnv } from "@dravonix/config";
import { revalidatePath } from "next/cache";
import { companyRoleLabel, isActiveCompanyRole, isClientAssignableRole } from "../companyRoles.js";
import { maskEmail, sendInvitationEmail } from "../email/sendInvitationEmail.js";
import { createServerSupabaseClient } from "../supabase/server.js";

export interface CreatedInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  emailSent: boolean;
  /** Only ever populated when email delivery didn't happen (not configured, or failed) -- never shown by default once a real provider is configured. */
  acceptUrl?: string;
}

function buildAcceptUrl(rawToken: string): string {
  const env = loadEnv(process.env);
  return `${env.APP_URL}/invite/${rawToken}`;
}

async function deliverInvitationEmail(params: {
  invitationId: string;
  companyId: string;
  email: string;
  role: string;
  acceptUrl: string;
  expiresAt: string;
}): Promise<{ emailSent: boolean; acceptUrl?: string }> {
  const supabase = await createServerSupabaseClient();

  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", params.companyId)
    .maybeSingle();

  const result = await sendInvitationEmail({
    email: params.email,
    companyName: company?.name ?? "your workspace",
    roleLabel: companyRoleLabel(params.role),
    acceptUrl: params.acceptUrl,
    expiresAt: new Date(params.expiresAt),
  });

  const masked = maskEmail(params.email);
  await supabase.rpc("record_invitation_email_event", {
    p_invitation_id: params.invitationId,
    p_event: result.success ? "sent" : "failed",
    p_masked_recipient: masked,
    p_provider_message_id: result.success ? (result.providerMessageId ?? null) : null,
    p_error_code: result.success ? null : (result.errorCode ?? null),
    p_error_message: result.success ? null : (result.errorMessage ?? null),
  });

  // acceptUrl is only ever surfaced back to the caller when email delivery
  // didn't happen AND the environment is not production -- a production
  // failure must never leak the raw invite link into the UI; it surfaces as
  // a plain delivery-failure message instead (see the UI layer). Outside
  // production (no provider configured yet, or a staging debugging need),
  // the existing manual-copy fallback keeps working.
  if (result.success) return { emailSent: true };
  const isProduction = loadEnv(process.env).isProduction;
  return { emailSent: false, acceptUrl: isProduction ? undefined : params.acceptUrl };
}

export async function createCompanyInvitationAction(
  companyId: string,
  formData: FormData,
): Promise<CreatedInvitation> {
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  if (!email || !role) throw new Error("Email and role are required");
  // This action is shared by the client Team page (team.manage) and the
  // Super Admin company page -- only the RPC itself knows which caller it
  // is, so this only rejects a role outside the active six-role model
  // (never assigns semantics to which caller may invite company_owner --
  // create_company_invitation enforces that distinction server-side).
  if (!isActiveCompanyRole(role)) throw new Error("Unsupported role");

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("create_company_invitation", { p_company_id: companyId, p_email: email, p_role: role })
    .single();
  if (error) throw error;

  const row = data as {
    id: string;
    invitation_email: string;
    role: string;
    expires_at: string;
    raw_token: string;
  };

  const acceptUrl = buildAcceptUrl(row.raw_token);
  const delivery = await deliverInvitationEmail({
    invitationId: row.id,
    companyId,
    email: row.invitation_email,
    role: row.role,
    acceptUrl,
    expiresAt: row.expires_at,
  });

  revalidatePath("/dashboard/team");
  revalidatePath(`/admin/companies/${companyId}`);

  return {
    id: row.id,
    email: row.invitation_email,
    role: row.role,
    expiresAt: row.expires_at,
    emailSent: delivery.emailSent,
    acceptUrl: delivery.acceptUrl,
  };
}

export async function resendCompanyInvitationAction(invitationId: string): Promise<{
  emailSent: boolean;
  acceptUrl?: string;
  expiresAt: string;
}> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("admin_resend_company_invitation", { p_invitation_id: invitationId })
    .single();
  if (error) throw error;

  const row = data as { id: string; expires_at: string; raw_token: string };

  const { data: invitation } = await supabase
    .from("company_invitations")
    .select("company_id, email, role")
    .eq("id", invitationId)
    .maybeSingle();

  const acceptUrl = buildAcceptUrl(row.raw_token);
  const delivery = invitation
    ? await deliverInvitationEmail({
        invitationId: row.id,
        companyId: invitation.company_id,
        email: invitation.email,
        role: invitation.role,
        acceptUrl,
        expiresAt: row.expires_at,
      })
    : { emailSent: false, acceptUrl };

  revalidatePath("/dashboard/team");
  return {
    emailSent: delivery.emailSent,
    acceptUrl: delivery.acceptUrl,
    expiresAt: row.expires_at,
  };
}

export async function revokeCompanyInvitationAction(invitationId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("admin_revoke_company_invitation", {
    p_invitation_id: invitationId,
  });
  if (error) throw error;
  revalidatePath("/dashboard/team");
}

export async function companyChangeMemberRoleAction(formData: FormData): Promise<void> {
  const memberId = String(formData.get("member_id") ?? "");
  const newRole = String(formData.get("new_role") ?? "");
  if (!memberId || !newRole) throw new Error("Member and role are required");
  // company_change_member_role is the client-only role-change RPC (Super
  // Admin uses admin_change_company_member_role instead, in admin.ts) --
  // company_owner is never a valid target here, matching the RPC's own
  // cannot_change_owner/invalid_target_role rejections.
  if (!isClientAssignableRole(newRole)) throw new Error("Unsupported role");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("company_change_member_role", {
    p_member_id: memberId,
    p_new_role: newRole,
  });
  if (error) throw error;
  revalidatePath("/dashboard/team");
}

export async function companyDeactivateMemberAction(formData: FormData): Promise<void> {
  const memberId = String(formData.get("member_id") ?? "");
  if (!memberId) throw new Error("Member is required");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("company_deactivate_member", { p_member_id: memberId });
  if (error) throw error;
  revalidatePath("/dashboard/team");
}

export async function companyReactivateMemberAction(formData: FormData): Promise<void> {
  const memberId = String(formData.get("member_id") ?? "");
  if (!memberId) throw new Error("Member is required");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("company_reactivate_member", { p_member_id: memberId });
  if (error) throw error;
  revalidatePath("/dashboard/team");
}

/**
 * Accepts a pending invitation for the *currently signed-in* user (never a
 * client-supplied user id) -- the RPC itself re-checks that this session's
 * own auth.users.email matches the invitation before creating/reactivating
 * any membership.
 */
export async function acceptCompanyInvitationAction(token: string): Promise<{ companyId: string }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .rpc("accept_company_invitation", { p_token: token })
    .single();
  if (error) throw error;

  const row = data as { company_id: string; role: string };
  revalidatePath("/dashboard");
  return { companyId: row.company_id };
}
