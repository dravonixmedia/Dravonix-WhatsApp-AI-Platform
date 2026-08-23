"use server";

/**
 * Editable display-name Server Actions (migration 21). Two call sites, two
 * RPCs, matching this codebase's existing split between a company-scoped
 * write and a dedicated admin_* write for the same kind of action (see
 * company_change_member_role vs. admin_change_company_member_role in
 * lib/actions/invitations.ts / admin.ts) -- neither RPC trusts anything
 * about the caller's authorization beyond auth.uid() itself; both
 * re-verify server-side.
 */

import { revalidatePath } from "next/cache";
import { getPlatformSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

export interface UpdateDisplayNameResult {
  success: boolean;
  displayName?: string;
  error?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "You must be signed in to do that.",
  invalid_display_name: "Please enter a name.",
  display_name_too_long: "That name is too long (150 characters max).",
  target_user_not_found: "That user could not be found.",
  permission_denied: "You don't have permission to rename this member.",
};

function friendlyError(message: string): string {
  return ERROR_MESSAGES[message] ?? "Could not update the display name. Please try again.";
}

/**
 * Client Team page / self-edit surface write path. update_user_display_name
 * itself re-authorizes the caller (editing their own name, or holding
 * team.manage in a company the target is currently an active member of) --
 * never trusts a client-supplied company_id or role.
 */
export async function updateMemberDisplayNameAction(
  userId: string,
  formData: FormData,
): Promise<UpdateDisplayNameResult> {
  const displayName = String(formData.get("display_name") ?? "");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("update_user_display_name", { p_user_id: userId, p_display_name: displayName })
    .single();
  if (error) return { success: false, error: friendlyError(error.message) };

  const row = data as { updated_user_id: string; display_name: string };
  revalidatePath("/dashboard/team");
  return { success: true, displayName: row.display_name };
}

/**
 * Super Admin "Users & Roles" card write path. Requires the session's own
 * platformRole === "super_admin" before even attempting the RPC (same guard
 * as requireSuperAdminClient() in lib/actions/admin.ts), and the RPC itself
 * (admin_update_user_display_name) re-checks current_platform_role() again
 * server-side -- a company role can never reach this path regardless of
 * what the browser sends.
 */
export async function adminUpdateMemberDisplayNameAction(
  companyId: string,
  userId: string,
  formData: FormData,
): Promise<UpdateDisplayNameResult> {
  const session = await getPlatformSession();
  if (!session || session.platformRole !== "super_admin") {
    return { success: false, error: "Not authorized" };
  }

  const displayName = String(formData.get("display_name") ?? "");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("admin_update_user_display_name", { p_user_id: userId, p_display_name: displayName })
    .single();
  if (error) return { success: false, error: friendlyError(error.message) };

  const row = data as { updated_user_id: string; display_name: string };
  revalidatePath(`/admin/companies/${companyId}`);
  return { success: true, displayName: row.display_name };
}
