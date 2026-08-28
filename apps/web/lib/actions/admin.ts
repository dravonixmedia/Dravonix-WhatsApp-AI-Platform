"use server";

/**
 * Super Admin Server Actions. Each function is a thin wrapper around exactly
 * one migration-17 SECURITY DEFINER RPC (supabase/migrations/00000000000017_super_admin_foundation.sql)
 * -- there is no generic "admin update" action here, matching the RPC layer
 * it calls. getPlatformSession()'s super_admin check is re-verified here as
 * an early, friendly rejection; the RPC itself re-checks current_platform_role()
 * independently and is the actual security boundary (this file's own check
 * is defense-in-depth, not a substitute for it).
 *
 * Company-scoped actions take companyId as their first argument so a page
 * can bind it via `action={someAction.bind(null, companyId)}` and pass a
 * plain <form>'s FormData for the rest -- the standard Next.js pattern for a
 * Server Action invoked directly from a <form>.
 */

import { revalidatePath } from "next/cache";
import { isActiveCompanyRole } from "../companyRoles.js";
import { logServerError } from "../serverLogging.js";
import { getPlatformSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

async function requireSuperAdminClient() {
  const session = await getPlatformSession();
  if (!session || session.platformRole !== "super_admin") {
    throw new Error("Not authorized");
  }
  return createServerSupabaseClient();
}

function str(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function revalidateAdminCompanyPaths(companyId?: string): void {
  revalidatePath("/admin/companies");
  if (companyId) revalidatePath(`/admin/companies/${companyId}`);
}

export async function createCompanyAction(formData: FormData): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const name = str(formData, "name");
  if (!name) throw new Error("Company name is required");

  const { error } = await supabase.rpc("admin_create_company", {
    p_name: name,
    p_industry: str(formData, "industry"),
    p_country: str(formData, "country"),
    p_timezone: str(formData, "timezone") ?? "Asia/Kolkata",
    p_currency: str(formData, "currency") ?? "INR",
    p_is_demo: formData.get("is_demo") === "on",
  });
  if (error) {
    logServerError("Admin action failed", error, undefined, { action: "createCompanyAction" });
    throw error;
  }
  revalidateAdminCompanyPaths();
}

export async function suspendCompanyAction(companyId: string, formData: FormData): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const { error } = await supabase.rpc("admin_suspend_company", {
    p_company_id: companyId,
    p_reason: str(formData, "reason"),
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "suspendCompanyAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
}

export async function reactivateCompanyAction(companyId: string): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const { error } = await supabase.rpc("admin_reactivate_company", { p_company_id: companyId });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "reactivateCompanyAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
}

export async function closeCompanyAction(companyId: string, formData: FormData): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const { error } = await supabase.rpc("admin_close_company", {
    p_company_id: companyId,
    p_reason: str(formData, "reason"),
  });
  if (error) {
    logServerError("Admin action failed", error, { companyId }, { action: "closeCompanyAction" });
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
}

export async function inviteCompanyMemberAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const email = str(formData, "email");
  const role = str(formData, "role");
  if (!email || !role) throw new Error("Email and role are required");
  if (!isActiveCompanyRole(role)) throw new Error("Unsupported role");

  const { error } = await supabase.rpc("admin_invite_company_member", {
    p_company_id: companyId,
    p_email: email,
    p_role: role,
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "inviteCompanyMemberAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
}

export async function changeCompanyMemberRoleAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const memberId = str(formData, "member_id");
  const newRole = str(formData, "new_role");
  if (!memberId || !newRole) throw new Error("Member and role are required");
  if (!isActiveCompanyRole(newRole)) throw new Error("Unsupported role");

  const { error } = await supabase.rpc("admin_change_company_member_role", {
    p_company_id: companyId,
    p_member_id: memberId,
    p_new_role: newRole,
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "changeCompanyMemberRoleAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
}

export async function deactivateCompanyMemberAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const memberId = str(formData, "member_id");
  if (!memberId) throw new Error("Member is required");

  const { error } = await supabase.rpc("admin_deactivate_company_member", {
    p_company_id: companyId,
    p_member_id: memberId,
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "deactivateCompanyMemberAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
}

export async function assignPlanAction(companyId: string, formData: FormData): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const planKey = str(formData, "plan_key");
  if (!planKey) throw new Error("Plan is required");

  const { error } = await supabase.rpc("admin_assign_plan", {
    p_company_id: companyId,
    p_plan_key: planKey,
  });
  if (error) {
    logServerError("Admin action failed", error, { companyId }, { action: "assignPlanAction" });
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
  revalidatePath("/admin/subscriptions");
}

export async function changeSubscriptionStateAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const newState = str(formData, "new_state");
  if (!newState) throw new Error("Target state is required");

  const { error } = await supabase.rpc("admin_change_subscription_state", {
    p_company_id: companyId,
    p_new_state: newState,
    p_reason: str(formData, "reason"),
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "changeSubscriptionStateAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
  revalidatePath("/admin/subscriptions");
}

export async function setCompanyEntitlementAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const featureKey = str(formData, "feature_key");
  if (!featureKey) throw new Error("Feature key is required");
  const numericLimitRaw = str(formData, "numeric_limit");

  const { error } = await supabase.rpc("admin_set_company_entitlement", {
    p_company_id: companyId,
    p_feature_key: featureKey,
    p_is_enabled: formData.get("is_enabled") === "on",
    p_numeric_limit: numericLimitRaw ? Number(numericLimitRaw) : null,
    p_reason: str(formData, "reason"),
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "setCompanyEntitlementAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
  revalidatePath("/admin/entitlements");
}

export async function resetCompanyEntitlementAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const featureKey = str(formData, "feature_key");
  if (!featureKey) throw new Error("Feature key is required");

  const { error } = await supabase.rpc("admin_reset_company_entitlement", {
    p_company_id: companyId,
    p_feature_key: featureKey,
    p_reason: str(formData, "reason"),
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "resetCompanyEntitlementAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
  revalidatePath("/admin/entitlements");
}

export async function startSupportAccessAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const reason = str(formData, "reason");
  if (!reason) throw new Error("A reason is required to start support access");
  const durationRaw = str(formData, "duration_minutes");

  const { error } = await supabase.rpc("admin_start_support_access", {
    p_company_id: companyId,
    p_reason: reason,
    p_duration_minutes: durationRaw ? Number(durationRaw) : 60,
  });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "startSupportAccessAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
  revalidatePath("/admin/support-access");
}

export async function endSupportAccessAction(companyId: string, formData: FormData): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const sessionId = str(formData, "session_id");
  if (!sessionId) throw new Error("Session is required");

  const { error } = await supabase.rpc("admin_end_support_access", { p_session_id: sessionId });
  if (error) {
    logServerError(
      "Admin action failed",
      error,
      { companyId },
      {
        action: "endSupportAccessAction",
      },
    );
    throw error;
  }
  revalidateAdminCompanyPaths(companyId);
  revalidatePath("/admin/support-access");
}
