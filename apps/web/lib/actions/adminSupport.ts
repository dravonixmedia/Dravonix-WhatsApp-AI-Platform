"use server";

/**
 * Phase 5: Client Support & Requests -- Super Admin/platform-staff Server
 * Actions. Every mutation is a thin wrapper around exactly one SECURITY
 * DEFINER RPC (migration 27), each of which independently re-checks
 * is_platform_staff() -- these actions add no authorization logic of their
 * own beyond requiring *some* platform-staff session before calling, the
 * same shape as apps/web/lib/actions/admin.ts's requireSuperAdminClient.
 *
 * The client-reply-notification email (final plan section 18) is
 * best-effort and never corrupts the reply record: the
 * support_request_messages row is already committed by
 * admin_reply_support_request before the email is attempted. Internal notes
 * never reach this email path at all -- see adminReplySupportRequestAction's
 * early return.
 */

import { loadEnv } from "@dravonix/config";
import { revalidatePath } from "next/cache";
import { sendSupportReplyNotification } from "../email/sendSupportEmails.js";
import { getPlatformSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";
import {
  SUPPORT_REQUEST_STATUS_LABELS,
  type SupportRequestPriority,
  type SupportRequestStatus,
} from "../repositories/supportRequestsRepository.js";

async function requirePlatformStaffClient() {
  const session = await getPlatformSession();
  if (!session || !session.platformRole) {
    throw new Error("Not authorized");
  }
  return createServerSupabaseClient();
}

function revalidateSupportPaths(requestId: string): void {
  revalidatePath("/admin/support-requests");
  revalidatePath(`/admin/support-requests/${requestId}`);
}

export async function adminReplySupportRequestAction(
  requestId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requirePlatformStaffClient();
  const message = String(formData.get("message") ?? "").trim();
  if (!message) throw new Error("Message is required");
  const isInternal = formData.get("is_internal") === "on";

  const { error } = await supabase.rpc("admin_reply_support_request", {
    p_request_id: requestId,
    p_message: message,
    p_is_internal: isInternal,
  });
  if (error) throw error;

  revalidateSupportPaths(requestId);

  if (isInternal) return;

  // Best-effort only -- never allowed to fail the reply above.
  try {
    const [{ data: recipientEmail }, { data: request }] = await Promise.all([
      supabase.rpc("admin_get_support_request_recipient_email", { p_request_id: requestId }),
      supabase
        .from("support_requests")
        .select("reference, subject, status")
        .eq("id", requestId)
        .maybeSingle(),
    ]);
    if (recipientEmail && request) {
      const env = loadEnv(process.env);
      const result = await sendSupportReplyNotification(recipientEmail as string, {
        reference: request.reference as string,
        subject: request.subject as string,
        statusLabel: SUPPORT_REQUEST_STATUS_LABELS[request.status as SupportRequestStatus],
        replyMessage: message,
        detailUrl: `${env.APP_URL}/dashboard/support/${requestId}`,
      });
      await supabase.rpc("record_support_email_event", {
        p_request_id: requestId,
        p_email_type: "client_reply_notification",
        p_event: result.success ? "sent" : "failed",
        p_provider_message_id: result.success ? (result.providerMessageId ?? null) : null,
        p_error_code: result.success ? null : (result.errorCode ?? null),
        p_error_message: result.success ? null : (result.errorMessage ?? null),
      });
    }
  } catch {
    // Never surface an email failure -- the reply itself is already committed.
  }
}

export async function adminUpdateSupportRequestStatusAction(
  requestId: string,
  status: SupportRequestStatus,
): Promise<void> {
  const supabase = await requirePlatformStaffClient();
  const { error } = await supabase.rpc("admin_update_support_request_status", {
    p_request_id: requestId,
    p_status: status,
  });
  if (error) throw error;
  revalidateSupportPaths(requestId);
}

export async function adminResolveSupportRequestAction(requestId: string): Promise<void> {
  const supabase = await requirePlatformStaffClient();
  const { error } = await supabase.rpc("admin_resolve_support_request", {
    p_request_id: requestId,
  });
  if (error) throw error;
  revalidateSupportPaths(requestId);
}

export async function adminReopenSupportRequestAction(requestId: string): Promise<void> {
  const supabase = await requirePlatformStaffClient();
  const { error } = await supabase.rpc("admin_reopen_support_request", { p_request_id: requestId });
  if (error) throw error;
  revalidateSupportPaths(requestId);
}

export async function adminUpdateSupportRequestPriorityAction(
  requestId: string,
  priority: SupportRequestPriority,
): Promise<void> {
  const supabase = await requirePlatformStaffClient();
  const { error } = await supabase.rpc("admin_update_support_request_priority", {
    p_request_id: requestId,
    p_priority: priority,
  });
  if (error) throw error;
  revalidateSupportPaths(requestId);
}

export async function adminAssignSupportRequestAction(
  requestId: string,
  platformUserId: string | null,
): Promise<void> {
  const supabase = await requirePlatformStaffClient();
  const { error } = await supabase.rpc("admin_assign_support_request", {
    p_request_id: requestId,
    p_platform_user_id: platformUserId,
  });
  if (error) throw error;
  revalidateSupportPaths(requestId);
}
