import type { EmailMessage, EmailProvider, EmailSendResult } from "../provider.js";

/**
 * In-memory email provider used whenever no real provider is configured
 * (env.emailConfigured === false) and in tests. Records every "sent" message
 * so tests/callers can assert on what would have been sent, without any
 * network call or real email ever leaving the process.
 */
export class MockEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  private counter = 0;

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    this.counter += 1;
    return { success: true, providerMessageId: `mock-email-${this.counter}` };
  }
}
