import type { MessageDeliveryStatus } from "@dravonix/whatsapp";

export interface UpsertContactInput {
  companyId: string;
  waId: string;
  profileName: string | null;
  phoneNumberId: string;
}

export interface RecordInboundMessageInput {
  companyId: string;
  conversationId: string;
  providerMessageId: string;
  body: string | null;
  channelType: "text" | "audio";
}

export interface RecordStatusEventInput {
  providerMessageId: string;
  status: MessageDeliveryStatus;
  failureReason: string | null;
}

/**
 * Everything the WhatsApp webhook route needs to persist and route an inbound
 * event, kept as one interface so apps/api can be tested against an in-memory
 * implementation and deployed against a Supabase-backed one without touching
 * route logic (see ADR-0002).
 */
export interface WhatsAppIngestRepository {
  resolveCompanyIdByPhoneNumberId(phoneNumberId: string): Promise<string | null>;
  isDuplicateWebhookEvent(providerEventId: string): Promise<boolean>;
  recordWebhookEvent(input: {
    providerEventId: string;
    companyId: string | null;
    status: "received" | "processed" | "duplicate" | "unrouted";
    rawPayload: unknown;
  }): Promise<void>;
  isDuplicateMessage(providerMessageId: string): Promise<boolean>;
  upsertContactAndConversation(
    input: UpsertContactInput,
  ): Promise<{ contactId: string; conversationId: string }>;
  recordInboundMessage(input: RecordInboundMessageInput): Promise<{ messageId: string }>;
  recordMessageStatusEvent(input: RecordStatusEventInput): Promise<void>;
}
