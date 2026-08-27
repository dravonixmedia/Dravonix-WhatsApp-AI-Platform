import "server-only";

import { loadEnv } from "@dravonix/config";
import {
  MockEmailProvider,
  renderInvitationEmail,
  ZeptoMailEmailProvider,
  type EmailProvider,
} from "@dravonix/email";
import { logServerError } from "../serverLogging.js";

export interface SendInvitationEmailInput {
  email: string;
  companyName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
}

export interface SendInvitationEmailResult {
  /** False when no email provider is configured -- the caller falls back to the manual-copy flow, never a silent "delivered" claim. */
  attempted: boolean;
  success: boolean;
  providerMessageId?: string;
  errorCode?: string;
  /** The provider's own sanitized error message (e.g. "Bad Syntax") -- safe to persist alongside errorCode; never the raw request/response body or any credential. */
  errorMessage?: string;
}

/** `x***@domain.com` -- safe to write to audit_logs; never the full address or the raw invitation token. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***@${domain}`;
}

function getEmailProvider(): { provider: EmailProvider; configured: boolean } {
  const env = loadEnv(process.env);
  if (env.emailConfigured) {
    return {
      provider: new ZeptoMailEmailProvider({
        apiToken: env.emailApiToken!,
        fromAddress: env.EMAIL_FROM_ADDRESS!,
        fromName: env.EMAIL_FROM_NAME,
      }),
      configured: true,
    };
  }
  return { provider: new MockEmailProvider(), configured: false };
}

/**
 * Shared invitation-email sender used by both the Super Admin and client
 * Team invite paths (both already funnel through the single
 * createCompanyInvitationAction/resendCompanyInvitationAction pair in
 * lib/actions/invitations.ts, so there is only ever one call site each --
 * no duplicate email implementation to keep in sync). Never throws: a
 * misconfigured or unreachable provider returns a typed failure result so
 * the caller can report it plainly, without ever corrupting the
 * already-committed company_invitations row.
 */
export async function sendInvitationEmail(
  input: SendInvitationEmailInput,
): Promise<SendInvitationEmailResult> {
  try {
    const { provider, configured } = getEmailProvider();
    if (!configured) {
      return { attempted: false, success: false, errorCode: "not_configured" };
    }

    const rendered = renderInvitationEmail({
      companyName: input.companyName,
      roleLabel: input.roleLabel,
      acceptUrl: input.acceptUrl,
      expiresAt: input.expiresAt,
    });

    const result = await provider.send({
      to: input.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (result.success) {
      return { attempted: true, success: true, providerMessageId: result.providerMessageId };
    }
    // Never the recipient address or email body/subject -- maskEmail and the
    // provider's own already-sanitized errorCode/errorMessage only (see
    // SendInvitationEmailResult.errorMessage's doc comment).
    logServerError(
      "Invitation email delivery failed",
      new Error(result.errorMessage ?? "unknown"),
      undefined,
      {
        operation: "sendInvitationEmail",
        recipient: maskEmail(input.email),
        providerErrorCode: result.errorCode,
      },
    );
    return {
      attempted: true,
      success: false,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  } catch (error) {
    // The audit found this path fully swallowed the exception with zero
    // diagnostic info -- fixed to log it (sanitized, never the recipient
    // address or email body) while preserving the exact same best-effort
    // contract: this function still never throws, callers still never
    // block the invitation flow on email delivery.
    logServerError("Invitation email send threw unexpectedly", error, undefined, {
      operation: "sendInvitationEmail",
      recipient: maskEmail(input.email),
    });
    return { attempted: true, success: false, errorCode: "unexpected_error" };
  }
}
