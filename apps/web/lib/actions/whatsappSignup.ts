"use server";

import { SupabaseAuditLogWriter } from "@dravonix/handover";
import { recordAuditLog } from "@dravonix/observability";
import { revalidatePath } from "next/cache";
import { requireWhatsappManageContext } from "../whatsappSignupAuth.js";

/**
 * Meta/WhatsApp Batch 3, Slice C: client-initiated disconnect for a
 * company's own Embedded-Signup-connected WhatsApp Business Account. Thin
 * wrapper around migration 38's client_disconnect_whatsapp_account RPC --
 * that RPC, not this layer, is the real authorization/tenant-ownership
 * boundary (requireWhatsappManageContext's own check is an early, friendly
 * rejection, same convention as adminCompanyConfig.ts's
 * requireSuperAdminClient). Accepts no company id at all -- the caller's own
 * active company is the only one this action can ever touch.
 */
export async function disconnectWhatsappAccountAction(whatsappAccountId: string): Promise<void> {
  const { session, serviceRoleClient } = await requireWhatsappManageContext();

  const { error } = await serviceRoleClient.rpc("client_disconnect_whatsapp_account", {
    p_company_id: session.activeCompanyId,
    p_whatsapp_account_id: whatsappAccountId,
  });
  if (error) throw error;

  await recordAuditLog(new SupabaseAuditLogWriter(serviceRoleClient), {
    companyId: session.activeCompanyId,
    actorUserId: session.userId,
    actorType: "user",
    action: "whatsapp.disconnected",
    targetType: "whatsapp_account",
    targetId: whatsappAccountId,
  });

  revalidatePath("/dashboard/settings/whatsapp");
}
