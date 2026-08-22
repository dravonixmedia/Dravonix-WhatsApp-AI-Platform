import type { EmailMessage, EmailProvider, EmailSendResult } from "../provider.js";

export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
  fromName: string;
  /** Overridable for tests; defaults to the real Resend API host. */
  baseUrl?: string;
}

/**
 * Real transactional email adapter, calling Resend's HTTP API directly
 * (https://api.resend.com/emails) -- never SMTP, since Cloudflare Workers and
 * the Next.js edge runtime have no raw TCP socket access. Used whenever
 * `env.emailConfigured` is true (packages/config). Never throws and never
 * logs `apiKey`; every failure is returned as a typed result so callers can
 * report it plainly rather than assuming success.
 */
export class ResendEmailProvider implements EmailProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ResendConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.resend.com";
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${this.config.fromName} <${this.config.fromAddress}>`,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
    } catch {
      return {
        success: false,
        errorCode: "network_error",
        errorMessage: "Request to Resend failed",
      };
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string; name?: string };
      return {
        success: false,
        errorCode: body.name ?? `http_${response.status}`,
        errorMessage: body.message ?? `Resend request failed with status ${response.status}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    if (!data.id) {
      return {
        success: false,
        errorCode: "missing_provider_message_id",
        errorMessage: "Resend response had no message id",
      };
    }

    return { success: true, providerMessageId: data.id };
  }
}
