export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type EmailSendResult =
  | { success: true; providerMessageId: string }
  | { success: false; errorCode: string; errorMessage: string };

/**
 * Provider-agnostic transactional email interface, mirroring the
 * WhatsAppProvider/SpeechProvider pattern (packages/whatsapp/src/provider.ts,
 * packages/speech/src/provider.ts): `ResendEmailProvider` implements this
 * against Resend's HTTP API (no SMTP -- Cloudflare Workers/Next.js edge
 * runtimes have no raw TCP socket access, so an HTTPS-API provider is the
 * only workable choice here); `MockEmailProvider` implements it for tests
 * and any environment with no email provider configured yet.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
