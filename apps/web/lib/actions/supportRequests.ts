"use server";

/**
 * Phase 5: Client Support & Requests -- client-facing Server Actions. Both
 * mutations go through create_support_request/reply_support_request
 * (SECURITY DEFINER RPCs, migration 27), which independently re-verify
 * has_company_permission(company_id, 'support_requests.view') -- these
 * actions add no authorization logic of their own beyond requiring *some*
 * authenticated session before making the call, exactly like every other
 * RPC-backed action in this codebase.
 *
 * The new-request notification email (final plan section 16) is
 * best-effort and never corrupts the request record: the support_requests
 * row is already committed by the RPC before the email is attempted, so an
 * email failure can only ever fail to notify Dravonix, never roll back or
 * invalidate the request itself (section 22) -- the Super Admin queue still
 * contains the request either way.
 */

import { loadEnv } from "@dravonix/config";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sendNewSupportRequestNotification } from "../email/sendSupportEmails.js";
import { resolveMemberIdentity } from "../memberIdentity.js";
import { getDashboardCapabilities } from "../permissions.js";
import {
  CLIENT_SELECTABLE_PRIORITIES,
  SUPPORT_REQUEST_TYPE_LABELS,
  type SupportRequestPriority,
  type SupportRequestType,
} from "../repositories/supportRequestsRepository.js";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

const VALID_TYPES: ReadonlySet<SupportRequestType> = new Set(
  Object.keys(SUPPORT_REQUEST_TYPE_LABELS) as SupportRequestType[],
);

async function requireSupportRequestsAccess() {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");
  if (!getDashboardCapabilities(session.activeRole).canViewSupportRequests) {
    throw new Error("Your role does not have permission to use Support & Requests");
  }
  return session;
}

export async function createSupportRequestAction(formData: FormData): Promise<void> {
  const session = await requireSupportRequestsAccess();

  const type = String(formData.get("type") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const priorityRaw = String(formData.get("priority") ?? "normal") as SupportRequestPriority;

  if (!VALID_TYPES.has(type as SupportRequestType)) throw new Error("Invalid request type");
  if (!subject || !description) throw new Error("Subject and description are required");
  const priority = CLIENT_SELECTABLE_PRIORITIES.includes(priorityRaw) ? priorityRaw : "normal";

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("create_support_request", {
      p_company_id: session.activeCompanyId,
      p_type: type,
      p_subject: subject,
      p_description: description,
      p_priority: priority,
    })
    .single();
  if (error) throw error;

  const row = data as { id: string; reference: string };

  // Best-effort only -- never allowed to fail the request creation above.
  try {
    const [{ data: company }] = await Promise.all([
      supabase.from("companies").select("name").eq("id", session.activeCompanyId).maybeSingle(),
    ]);
    const env = loadEnv(process.env);
    const submittedByLabel = resolveMemberIdentity({
      name: session.displayName,
      email: session.email,
      userId: session.userId,
    }).primary;

    const result = await sendNewSupportRequestNotification({
      reference: row.reference,
      companyName: company?.name ?? "Unknown company",
      submittedByLabel,
      typeLabel: SUPPORT_REQUEST_TYPE_LABELS[type as SupportRequestType],
      subject,
      description,
      detailUrl: `${env.APP_URL}/admin/support-requests/${row.id}`,
    });

    await supabase.rpc("record_support_email_event", {
      p_request_id: row.id,
      p_email_type: "new_request_notification",
      p_event: result.success ? "sent" : "failed",
      p_provider_message_id: result.success ? (result.providerMessageId ?? null) : null,
      p_error_code: result.success ? null : (result.errorCode ?? null),
      p_error_message: result.success ? null : (result.errorMessage ?? null),
    });
  } catch {
    // Never surface an email/notification failure to the client -- the
    // request itself is already committed.
  }

  revalidatePath("/dashboard/support");
  redirect(`/dashboard/support/${row.id}`);
}

export async function replySupportRequestAction(
  requestId: string,
  formData: FormData,
): Promise<void> {
  await requireSupportRequestsAccess();
  const message = String(formData.get("message") ?? "").trim();
  if (!message) throw new Error("Message is required");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("reply_support_request", {
    p_request_id: requestId,
    p_message: message,
  });
  if (error) throw error;

  revalidatePath("/dashboard/support");
  revalidatePath(`/dashboard/support/${requestId}`);
}
