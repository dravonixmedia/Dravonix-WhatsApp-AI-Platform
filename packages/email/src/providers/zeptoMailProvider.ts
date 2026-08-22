import type { EmailMessage, EmailProvider, EmailSendResult } from "../provider.js";

export interface ZeptoMailConfig {
  apiToken: string;
  fromAddress: string;
  fromName: string;
  /** Overridable for tests; defaults to the real ZeptoMail API host. */
  baseUrl?: string;
}

interface ZeptoMailSuccessBody {
  data?: Array<{ code?: string; message?: string }>;
  request_id?: string;
}

interface ZeptoMailErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Array<{ code?: string; message?: string; target?: string }>;
  };
}

/**
 * Real transactional email adapter, calling Zoho ZeptoMail's HTTPS Send Mail
 * API directly (https://api.zeptomail.com/v1.1/email) -- never SMTP, since
 * Cloudflare Workers and the Next.js edge runtime have no raw TCP socket
 * access. Used whenever `env.emailConfigured` is true (packages/config).
 * Never throws and never logs `apiToken`; every failure is returned as a
 * typed result so callers can report it plainly rather than assuming
 * success.
 *
 * Auth header format and request/response shapes are ZeptoMail's documented
 * contract (https://www.zoho.com/zeptomail/help/api/email-sending.html):
 * `Authorization: Zoho-enczapikey <token>`, a `{ from, to, subject, htmlbody,
 * textbody }` body, a success body containing `request_id`, and an error
 * body shaped `{ error: { code, message, details } }`.
 */
export class ZeptoMailEmailProvider implements EmailProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ZeptoMailConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.zeptomail.com";
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1.1/email`, {
        method: "POST",
        headers: {
          Authorization: `Zoho-enczapikey ${this.config.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { address: this.config.fromAddress, name: this.config.fromName },
          to: [{ email_address: { address: message.to } }],
          subject: message.subject,
          htmlbody: message.html,
          textbody: message.text,
        }),
      });
    } catch {
      return {
        success: false,
        errorCode: "network_error",
        errorMessage: "Request to ZeptoMail failed",
      };
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ZeptoMailErrorBody;
      return {
        success: false,
        errorCode: body.error?.code ?? `http_${response.status}`,
        errorMessage:
          body.error?.message ?? `ZeptoMail request failed with status ${response.status}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as ZeptoMailSuccessBody;
    if (!data.request_id) {
      return {
        success: false,
        errorCode: "missing_provider_message_id",
        errorMessage: "ZeptoMail response had no request id",
      };
    }

    return { success: true, providerMessageId: data.request_id };
  }
}
