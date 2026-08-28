import "server-only";

import { loadEnv } from "@dravonix/config";
import {
  MockEmailProvider,
  renderNewSupportRequestEmail,
  renderSupportReplyEmail,
  ZeptoMailEmailProvider,
  type EmailProvider,
  type SupportReplyEmailInput,
  type SupportRequestTypeLabelInput,
} from "@dravonix/email";
import { logServerError } from "../serverLogging.js";

export interface SendSupportEmailResult {
  /** False when no email provider (or, for the new-request notification, no SUPPORT_NOTIFICATION_EMAIL) is configured. */
  attempted: boolean;
  success: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** `x***@domain.com` -- safe to write to audit_logs; never the full address. */
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
 * Notifies Dravonix staff (SUPPORT_NOTIFICATION_EMAIL) of a new client
 * support request. Never throws -- mirrors sendInvitationEmail.ts's exact
 * resilience shape: the support_requests row is already committed by
 * create_support_request before this is ever called, so a failure here can
 * only ever fail to notify, never roll back or invalidate the request
 * itself (final plan section 22).
 */
export async function sendNewSupportRequestNotification(
  input: SupportRequestTypeLabelInput,
): Promise<SendSupportEmailResult> {
  try {
    const env = loadEnv(process.env);
    if (!env.SUPPORT_NOTIFICATION_EMAIL) {
      return { attempted: false, success: false, errorCode: "not_configured" };
    }
    const { provider, configured } = getEmailProvider();
    if (!configured) {
      return { attempted: false, success: false, errorCode: "not_configured" };
    }

    const rendered = renderNewSupportRequestEmail(input);
    const result = await provider.send({
      to: env.SUPPORT_NOTIFICATION_EMAIL,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (result.success) {
      return { attempted: true, success: true, providerMessageId: result.providerMessageId };
    }
    logServerError(
      "Support-request notification email delivery failed",
      new Error(result.errorMessage ?? "unknown"),
      undefined,
      { operation: "sendNewSupportRequestNotification", providerErrorCode: result.errorCode },
    );
    return {
      attempted: true,
      success: false,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  } catch (error) {
    // Previously fully swallowed with zero diagnostic info -- fixed to log
    // it (sanitized, never the email body) while preserving the exact same
    // best-effort contract: this function still never throws.
    logServerError("Support-request notification email send threw unexpectedly", error, undefined, {
      operation: "sendNewSupportRequestNotification",
    });
    return { attempted: true, success: false, errorCode: "unexpected_error" };
  }
}

/**
 * Notifies the client that Dravonix posted a public reply/status update.
 * Never called for an internal-only note (see adminSupport.ts). Never
 * throws -- same resilience shape as above.
 */
export async function sendSupportReplyNotification(
  recipientEmail: string,
  input: SupportReplyEmailInput,
): Promise<SendSupportEmailResult> {
  try {
    const { provider, configured } = getEmailProvider();
    if (!configured) {
      return { attempted: false, success: false, errorCode: "not_configured" };
    }

    const rendered = renderSupportReplyEmail(input);
    const result = await provider.send({
      to: recipientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (result.success) {
      return { attempted: true, success: true, providerMessageId: result.providerMessageId };
    }
    // Never the recipient address or email body/subject -- maskEmail and the
    // provider's own already-sanitized errorCode/errorMessage only.
    logServerError(
      "Support-reply notification email delivery failed",
      new Error(result.errorMessage ?? "unknown"),
      undefined,
      {
        operation: "sendSupportReplyNotification",
        recipient: maskEmail(recipientEmail),
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
    // Previously fully swallowed with zero diagnostic info -- fixed to log
    // it (sanitized, never the recipient address or email body) while
    // preserving the exact same best-effort contract: this function still
    // never throws.
    logServerError("Support-reply notification email send threw unexpectedly", error, undefined, {
      operation: "sendSupportReplyNotification",
      recipient: maskEmail(recipientEmail),
    });
    return { attempted: true, success: false, errorCode: "unexpected_error" };
  }
}
