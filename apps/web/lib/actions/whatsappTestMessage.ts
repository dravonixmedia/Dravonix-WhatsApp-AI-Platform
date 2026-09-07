"use server";

import { loadEnv } from "@dravonix/config";
import { SupabaseAuditLogWriter } from "@dravonix/handover";
import { recordAuditLog } from "@dravonix/observability";
import {
  GraphApiWhatsAppProvider,
  OutboundCredentialResolutionError,
  resolveOutboundAccessToken,
} from "@dravonix/whatsapp";
import { logServerError } from "../serverLogging.js";
import { requireWhatsappManageContext } from "../whatsappSignupAuth.js";

export interface SendWhatsappTestMessageResult {
  success: boolean;
  error?: string;
}

/**
 * Protected outgoing-test-message path (WhatsApp connection foundation,
 * final item): lets a company admin/owner confirm their own connection
 * actually works by sending one message. The company/credential are ALWAYS
 * resolved from the caller's own authenticated session --
 * `phoneNumberRowId` is looked up scoped to `session.activeCompanyId`, so a
 * caller can never send using a phone number or credential belonging to a
 * different company, regardless of what id they pass in.
 */
export async function sendWhatsappTestMessageAction(
  phoneNumberRowId: string,
  toWaId: string,
  body: string,
): Promise<SendWhatsappTestMessageResult> {
  const { session, serviceRoleClient } = await requireWhatsappManageContext();

  if (!toWaId.trim() || !body.trim()) {
    return { success: false, error: "A recipient and message body are required." };
  }

  const { data: phone, error: phoneError } = await serviceRoleClient
    .from("whatsapp_phone_numbers")
    .select("id, phone_number_id, status, whatsapp_account_id")
    .eq("id", phoneNumberRowId)
    .eq("company_id", session.activeCompanyId)
    .maybeSingle();
  if (phoneError) throw phoneError;
  if (!phone) {
    return { success: false, error: "That phone number was not found for your company." };
  }
  if (phone.status !== "connected") {
    return { success: false, error: "This phone number is not currently connected." };
  }

  const { data: account, error: accountError } = await serviceRoleClient
    .from("whatsapp_accounts")
    .select("waba_id, connection_source, encrypted_access_token, encryption_key_version")
    .eq("id", phone.whatsapp_account_id)
    .eq("company_id", session.activeCompanyId)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account) {
    return { success: false, error: "The WhatsApp account for this number was not found." };
  }

  const env = loadEnv(process.env);

  let accessToken: string;
  try {
    accessToken = await resolveOutboundAccessToken(
      {
        connectionSource: account.connection_source,
        wabaId: account.waba_id,
        encryptedAccessToken: account.encrypted_access_token,
        encryptionKeyVersion: account.encryption_key_version,
      },
      {
        globalAccessToken: env.META_ACCESS_TOKEN,
        resolveEncryptionKey: (version) =>
          version === 1 ? env.WHATSAPP_TOKEN_ENCRYPTION_KEY_V1 : undefined,
      },
    );
  } catch (error) {
    logServerError(
      "Failed to resolve outbound WhatsApp credential for test message",
      error,
      { companyId: session.activeCompanyId },
      {
        operation: "whatsapp_test_message.resolve_credential",
        code: error instanceof OutboundCredentialResolutionError ? error.code : "unknown",
      },
    );
    return { success: false, error: "This connection's credentials are not available right now." };
  }

  const provider = new GraphApiWhatsAppProvider({
    accessToken,
    graphApiVersion: env.META_GRAPH_API_VERSION,
  });

  try {
    await provider.sendText({ phoneNumberId: phone.phone_number_id, toWaId, body });
  } catch (error) {
    logServerError(
      "Failed to send WhatsApp test message",
      error,
      { companyId: session.activeCompanyId },
      { operation: "whatsapp_test_message.send" },
    );
    return {
      success: false,
      error: "Meta rejected the test message. Please check the number and try again.",
    };
  }

  await recordAuditLog(new SupabaseAuditLogWriter(serviceRoleClient), {
    companyId: session.activeCompanyId,
    actorUserId: session.userId,
    actorType: "user",
    action: "whatsapp.test_message_sent",
    targetType: "whatsapp_phone_number",
    targetId: phone.id,
  });

  return { success: true };
}
