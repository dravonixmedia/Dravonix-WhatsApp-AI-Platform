import { SupabaseAuditLogWriter } from "@dravonix/handover";
import { recordAuditLog } from "@dravonix/observability";
import {
  completeEmbeddedSignup,
  EmbeddedSignupFlowError,
  MetaGraphManagementClient,
  SupabaseSignupAttemptRepository,
} from "@dravonix/whatsapp";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { isDomainError } from "../../../../../../../lib/domainError.js";
import { logServerError } from "../../../../../../../lib/serverLogging.js";
import {
  resolveWhatsappEmbeddedSignupServerConfig,
  WhatsappEmbeddedSignupNotConfiguredError,
} from "../../../../../../../lib/whatsappEmbeddedSignupConfig.js";
import {
  requireWhatsappManageContext,
  WhatsappSignupUnauthenticatedError,
} from "../../../../../../../lib/whatsappSignupAuth.js";

export const dynamic = "force-dynamic";

interface CompleteSignupRequestBody {
  attemptId: string;
  nonce: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
}

/**
 * Strict, structural validation only -- everything here is untrusted browser
 * input, including wabaId/phoneNumberId (reported by Meta's postMessage
 * payload but relayed through the browser, so not authoritative until
 * completeEmbeddedSignup independently re-verifies them against the Graph
 * API using the just-exchanged token).
 */
function parseBody(raw: unknown): CompleteSignupRequestBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const { attemptId, nonce, code, wabaId, phoneNumberId, businessId } = body;
  if (
    typeof attemptId !== "string" ||
    attemptId.length === 0 ||
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof code !== "string" ||
    code.length === 0 ||
    typeof wabaId !== "string" ||
    wabaId.length === 0 ||
    typeof phoneNumberId !== "string" ||
    phoneNumberId.length === 0 ||
    (businessId !== null && businessId !== undefined && typeof businessId !== "string")
  ) {
    return null;
  }
  return {
    attemptId,
    nonce,
    code,
    wabaId,
    phoneNumberId,
    businessId: typeof businessId === "string" ? businessId : null,
  };
}

/** Maps EmbeddedSignupFlowError's small controlled vocabulary to a client-safe message -- never Meta's raw error text, never a token, never a code. */
function messageForFlowError(code: EmbeddedSignupFlowError["code"]): string {
  switch (code) {
    case "attempt_not_claimable":
      return "This connection attempt has expired or was already used. Please try connecting again.";
    case "phone_ownership_mismatch":
      return "The phone number reported by Meta does not belong to the selected WhatsApp Business Account.";
    default:
      return "We couldn't complete the WhatsApp connection. Please try again.";
  }
}

function statusForFlowError(code: EmbeddedSignupFlowError["code"]): number {
  return code === "exchange_failed" || code === "graph_verification_failed" ? 502 : 400;
}

/**
 * Step 2 of Meta Embedded Signup (Batch 3, Slice C): the browser calls this
 * after FB.login's popup finishes and the WA_EMBEDDED_SIGNUP/FINISH
 * postMessage has been received, sending the authorization code plus the
 * reported waba_id/phone_number_id/business_id. This route never trusts
 * those identifiers by themselves -- completeEmbeddedSignup independently
 * re-verifies phone->WABA ownership via the Graph API using the token this
 * route exchanges server-side; the browser never sees or handles the access
 * token at any point.
 */
export async function POST(request: Request): Promise<Response> {
  let auth;
  try {
    auth = await requireWhatsappManageContext();
  } catch (error) {
    if (error instanceof WhatsappSignupUnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (
      isDomainError(error, "permission_denied") ||
      isDomainError(error, "tenant_isolation_violation")
    ) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    logServerError(
      "Failed to authorize WhatsApp signup completion",
      error,
      {},
      {
        operation: "whatsapp_signup_complete.auth",
      },
    );
    return NextResponse.json({ error: "Unable to complete WhatsApp connection" }, { status: 500 });
  }
  const { session, serviceRoleClient } = auth;

  const rawBody = await request.json().catch(() => null);
  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let config;
  try {
    config = resolveWhatsappEmbeddedSignupServerConfig();
  } catch (error) {
    if (error instanceof WhatsappEmbeddedSignupNotConfiguredError) {
      logServerError(
        "WhatsApp Embedded Signup is not configured",
        error,
        { companyId: session.activeCompanyId },
        { operation: "whatsapp_signup_complete.config" },
      );
      return NextResponse.json(
        { error: "WhatsApp connection is not available right now" },
        { status: 503 },
      );
    }
    throw error;
  }

  const auditWriter = new SupabaseAuditLogWriter(serviceRoleClient);

  try {
    const result = await completeEmbeddedSignup(
      {
        repo: new SupabaseSignupAttemptRepository(serviceRoleClient),
        metaCredentials: config.metaCredentials,
        redirectUri: config.redirectUri,
        encryptionKey: config.encryptionKey,
        graphManagementClientFactory: (accessToken) =>
          new MetaGraphManagementClient({
            accessToken,
            graphApiVersion: config.metaCredentials.graphApiVersion,
          }),
      },
      {
        companyId: session.activeCompanyId,
        attemptId: body.attemptId,
        nonce: body.nonce,
        code: body.code,
        wabaId: body.wabaId,
        phoneNumberId: body.phoneNumberId,
        businessId: body.businessId,
      },
    );

    await recordAuditLog(auditWriter, {
      companyId: session.activeCompanyId,
      actorUserId: session.userId,
      actorType: "user",
      action: "whatsapp.connected",
      targetType: "whatsapp_account",
      targetId: result.whatsappAccountId,
      metadata: { source: "embedded_signup" },
    });

    revalidatePath("/dashboard/settings/whatsapp");

    return NextResponse.json({
      whatsappAccountId: result.whatsappAccountId,
      whatsappPhoneNumberId: result.whatsappPhoneNumberId,
    });
  } catch (error) {
    if (error instanceof EmbeddedSignupFlowError) {
      // `error.diagnostics` (currently populated only for exchange_failed)
      // is already sanitized to a small set of non-secret fields -- see
      // EmbeddedSignupFlowErrorDiagnostics's own doc comment -- so it's safe
      // to both audit (durable, queryable) and log (Cloudflare Worker
      // console, same path as every other logServerError call site) here.
      // Neither of these is ever sent to the browser: the response below is
      // unchanged, still just the sanitized message + failure code.
      if (error.diagnostics) {
        logServerError(
          "WhatsApp Embedded Signup: Meta code exchange failed",
          error,
          { companyId: session.activeCompanyId },
          { operation: "whatsapp_signup_complete.exchange_failed", ...error.diagnostics },
        );
      }

      await recordAuditLog(auditWriter, {
        companyId: session.activeCompanyId,
        actorUserId: session.userId,
        actorType: "user",
        action: "whatsapp.connect_failed",
        targetType: "whatsapp_signup_attempt",
        targetId: body.attemptId,
        metadata: { failureCode: error.code, ...(error.diagnostics ?? {}) },
      }).catch(() => {
        // An audit-write failure here must never mask the already-sanitized
        // error being returned to the caller below.
      });

      return NextResponse.json(
        { error: messageForFlowError(error.code), code: error.code },
        { status: statusForFlowError(error.code) },
      );
    }

    logServerError(
      "Unexpected failure completing WhatsApp Embedded Signup",
      error,
      { companyId: session.activeCompanyId },
      { operation: "whatsapp_signup_complete.unexpected" },
    );
    return NextResponse.json({ error: "Unable to complete WhatsApp connection" }, { status: 500 });
  }
}
