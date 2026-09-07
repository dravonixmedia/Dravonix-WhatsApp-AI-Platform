import { recordAuditLog } from "@dravonix/observability";
import { SupabaseAuditLogWriter } from "@dravonix/handover";
import { initiateEmbeddedSignup, SupabaseSignupAttemptRepository } from "@dravonix/whatsapp";
import { NextResponse } from "next/server";
import { isDomainError } from "../../../../../../../lib/domainError.js";
import { logServerError } from "../../../../../../../lib/serverLogging.js";
import {
  requireWhatsappManageContext,
  WhatsappSignupUnauthenticatedError,
} from "../../../../../../../lib/whatsappSignupAuth.js";

export const dynamic = "force-dynamic";

/**
 * Step 1 of Meta Embedded Signup (Batch 3, Slice C): creates a fresh
 * whatsapp_signup_attempts row (migration 37) and returns a one-time nonce
 * the browser must hold in memory and echo back, alongside the FB.login
 * result, to POST .../signup/complete. Requires an authenticated dashboard
 * session with whatsapp.manage for the caller's own active company --
 * re-derived server-side on every call (requireWhatsappManageContext),
 * never accepted from the request body (this route accepts no body at all).
 */
export async function POST(): Promise<Response> {
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
      "Failed to authorize WhatsApp signup initiation",
      error,
      {},
      {
        operation: "whatsapp_signup_initiate.auth",
      },
    );
    return NextResponse.json({ error: "Unable to start WhatsApp connection" }, { status: 500 });
  }

  const { session, serviceRoleClient } = auth;

  try {
    const attempt = await initiateEmbeddedSignup(
      new SupabaseSignupAttemptRepository(serviceRoleClient),
      {
        companyId: session.activeCompanyId,
        initiatedByUserId: session.userId,
      },
    );

    await recordAuditLog(new SupabaseAuditLogWriter(serviceRoleClient), {
      companyId: session.activeCompanyId,
      actorUserId: session.userId,
      actorType: "user",
      action: "whatsapp.signup_initiated",
      targetType: "whatsapp_signup_attempt",
      targetId: attempt.attemptId,
    });

    return NextResponse.json({
      attemptId: attempt.attemptId,
      nonce: attempt.nonce,
      expiresAt: attempt.expiresAt,
    });
  } catch (error) {
    logServerError(
      "Failed to initiate WhatsApp Embedded Signup",
      error,
      {
        companyId: session.activeCompanyId,
      },
      { operation: "whatsapp_signup_initiate.create_attempt" },
    );
    return NextResponse.json({ error: "Unable to start WhatsApp connection" }, { status: 500 });
  }
}
