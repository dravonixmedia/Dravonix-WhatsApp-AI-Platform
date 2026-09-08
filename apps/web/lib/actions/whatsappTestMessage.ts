"use server";

import { loadEnv } from "@dravonix/config";
import { SupabaseAuditLogWriter } from "@dravonix/handover";
import { recordAuditLog } from "@dravonix/observability";
import {
  GraphApiWhatsAppProvider,
  OutboundCredentialResolutionError,
  resolveOutboundAccessToken,
  WhatsAppProviderError,
} from "@dravonix/whatsapp";
import { logServerError } from "../serverLogging.js";
import { requireWhatsappManageContext } from "../whatsappSignupAuth.js";

export interface SendWhatsappTestMessageResult {
  success: boolean;
  error?: string;
}

/**
 * Normalizes a user-entered recipient WhatsApp ID before it ever reaches
 * Meta: trims whitespace and strips one optional leading "+" (the dashboard
 * placeholder shows the digits-only form, but a caller pasting an E.164
 * number with a "+" should not silently fail). Validates strictly against
 * a sensible E.164 digit-length range (ITU-T E.164 caps a full international
 * number at 15 digits; 8 is a practical floor for a real WhatsApp-registered
 * MSISDN) -- anything else is rejected here, before any database lookup or
 * Meta call, rather than sent through and left to Meta to reject blindly.
 * This is scoped to this test-send action only; it does not touch the
 * AI/outbound message pipeline's own recipient handling.
 */
function normalizeTestRecipient(raw: string): string | null {
  const trimmed = raw.trim();
  const withoutLeadingPlus = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  return /^\d{8,15}$/.test(withoutLeadingPlus) ? withoutLeadingPlus : null;
}

/**
 * Sanitized, non-secret diagnostic detail captured ONLY from
 * WhatsAppProviderError's own already-sanitized fields (packages/whatsapp/
 * src/providers/graphApiProvider.ts) -- never a raw response body, never the
 * access token/Authorization header. Reuses the same "spread diagnostics
 * into the log's extra fields" convention already established for Embedded
 * Signup (see EmbeddedSignupFlowErrorDiagnostics and its use in
 * apps/web/app/api/integrations/meta/whatsapp/signup/complete/route.ts)
 * rather than inventing a second, incompatible shape.
 */
function captureProviderDiagnostics(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof WhatsAppProviderError)) return undefined;
  return {
    providerStatus: error.status,
    providerErrorCode: error.errorCode,
    providerErrorSubcode: error.errorSubcode,
    providerErrorType: error.errorType,
    providerErrorDetail: error.errorDetail,
    providerFbtraceId: error.fbtraceId,
  };
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

  const normalizedRecipient = normalizeTestRecipient(toWaId);
  if (!normalizedRecipient) {
    return {
      success: false,
      error: "Enter a valid recipient number (digits only, with an optional leading +).",
    };
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
    await provider.sendText({
      phoneNumberId: phone.phone_number_id,
      toWaId: normalizedRecipient,
      body,
    });
  } catch (error) {
    logServerError(
      "Failed to send WhatsApp test message",
      error,
      { companyId: session.activeCompanyId },
      { operation: "whatsapp_test_message.send", ...(captureProviderDiagnostics(error) ?? {}) },
    );
    return {
      success: false,
      error:
        "Meta rejected the test message. Confirm that this number is an approved test recipient and try again.",
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
