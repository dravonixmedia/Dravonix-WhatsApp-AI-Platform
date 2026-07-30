import type {
  RecordInboundMessageInput,
  RecordStatusEventInput,
  UpsertContactInput,
  WhatsAppIngestRepository,
} from "./whatsappIngestRepository.js";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** In-memory implementation used by apps/api tests and local development without Supabase. */
export class InMemoryWhatsAppIngestRepository implements WhatsAppIngestRepository {
  readonly phoneNumberToCompany = new Map<string, string>();
  readonly seenWebhookEventIds = new Set<string>();
  readonly seenMessageIds = new Set<string>();
  readonly recordedWebhookEvents: Array<{
    providerEventId: string;
    companyId: string | null;
    status: string;
    rawPayload: unknown;
  }> = [];
  readonly conversationsByContact = new Map<
    string,
    { contactId: string; conversationId: string }
  >();
  readonly recordedMessages: Array<RecordInboundMessageInput & { messageId: string }> = [];
  readonly recordedStatusEvents: RecordStatusEventInput[] = [];

  async resolveCompanyIdByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    return this.phoneNumberToCompany.get(phoneNumberId) ?? null;
  }

  async isDuplicateWebhookEvent(providerEventId: string): Promise<boolean> {
    return this.seenWebhookEventIds.has(providerEventId);
  }

  async recordWebhookEvent(input: {
    providerEventId: string;
    companyId: string | null;
    status: "received" | "processed" | "duplicate" | "unrouted";
    rawPayload: unknown;
  }): Promise<void> {
    this.seenWebhookEventIds.add(input.providerEventId);
    this.recordedWebhookEvents.push(input);
  }

  async isDuplicateMessage(providerMessageId: string): Promise<boolean> {
    return this.seenMessageIds.has(providerMessageId);
  }

  async upsertContactAndConversation(
    input: UpsertContactInput,
  ): Promise<{ contactId: string; conversationId: string }> {
    const key = `${input.companyId}:${input.waId}`;
    const existing = this.conversationsByContact.get(key);
    if (existing) return existing;

    const created = { contactId: nextId("contact"), conversationId: nextId("conversation") };
    this.conversationsByContact.set(key, created);
    return created;
  }

  async recordInboundMessage(input: RecordInboundMessageInput): Promise<{ messageId: string }> {
    this.seenMessageIds.add(input.providerMessageId);
    const messageId = nextId("message");
    this.recordedMessages.push({ ...input, messageId });
    return { messageId };
  }

  async recordMessageStatusEvent(input: RecordStatusEventInput): Promise<void> {
    this.recordedStatusEvents.push(input);
  }
}
