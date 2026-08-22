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
 * No email is ever sent from here: create/resend return the raw invite
 * token/URL to the caller (Super Admin or company admin), who is responsible
 * for delivering it out of band until a transactional email provider is
 * wired up -- see the final report's "remaining email-delivery dependency."
 */

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "../supabase/server.js";

export interface CreatedInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptUrl: string;
}

function buildAcceptUrl(rawToken: string): string {
  const base = process.env.APP_URL ?? "";
  return `${base}/invite/${rawToken}`;
}

export async function createCompanyInvitationAction(
  companyId: string,
  formData: FormData,
): Promise<CreatedInvitation> {
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  if (!email || !role) throw new Error("Email and role are required");

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

  revalidatePath("/dashboard/team");
  revalidatePath(`/admin/companies/${companyId}`);

  return {
    id: row.id,
    email: row.invitation_email,
    role: row.role,
    expiresAt: row.expires_at,
    acceptUrl: buildAcceptUrl(row.raw_token),
  };
}

export async function resendCompanyInvitationAction(invitationId: string): Promise<{
  acceptUrl: string;
  expiresAt: string;
}> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("admin_resend_company_invitation", { p_invitation_id: invitationId })
    .single();
  if (error) throw error;

  const row = data as { id: string; expires_at: string; raw_token: string };
  revalidatePath("/dashboard/team");
  return { acceptUrl: buildAcceptUrl(row.raw_token), expiresAt: row.expires_at };
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
