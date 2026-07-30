import { metaWebhookPayloadSchema, type MetaWebhookPayload } from "./webhookSchema.js";

export interface InboundTextMessageEvent {
  kind: "inbound_text";
  wabaId: string;
  phoneNumberId: string;
  waId: string;
  profileName: string | null;
  providerMessageId: string;
  timestamp: string;
  body: string;
}

export interface InboundAudioMessageEvent {
  kind: "inbound_audio";
  wabaId: string;
  phoneNumberId: string;
  waId: string;
  profileName: string | null;
  providerMessageId: string;
  timestamp: string;
  mediaId: string;
  mimeType: string | null;
}

export interface InboundUnsupportedMessageEvent {
  kind: "inbound_unsupported";
  wabaId: string;
  phoneNumberId: string;
  waId: string;
  providerMessageId: string;
  messageType: string;
}

export interface StatusUpdateEvent {
  kind: "status_update";
  wabaId: string;
  phoneNumberId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipientId: string;
  failureReason: string | null;
}

export type WhatsAppWebhookEvent =
  | InboundTextMessageEvent
  | InboundAudioMessageEvent
  | InboundUnsupportedMessageEvent
  | StatusUpdateEvent;

export class WebhookPayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadValidationError";
  }
}

/**
 * Parses and validates a raw Meta webhook JSON body into normalized, strongly
 * typed events. Throws WebhookPayloadValidationError for a payload that does not
 * match the expected shape at all (the caller should acknowledge with 200 but
 * log/store the raw payload for investigation -- a malformed payload from a
 * verified signature is unusual but should never crash the webhook handler).
 */
export function parseWhatsAppWebhookPayload(rawJson: unknown): WhatsAppWebhookEvent[] {
  const result = metaWebhookPayloadSchema.safeParse(rawJson);
  if (!result.success) {
    throw new WebhookPayloadValidationError(result.error.message);
  }
  return extractEvents(result.data);
}

function extractEvents(payload: MetaWebhookPayload): WhatsAppWebhookEvent[] {
  const events: WhatsAppWebhookEvent[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const { value } = change;
      const phoneNumberId = value.metadata.phone_number_id;
      const profileByWaId = new Map(
        (value.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name ?? null]),
      );

      for (const message of value.messages ?? []) {
        if (message.type === "text" && message.text) {
          events.push({
            kind: "inbound_text",
            wabaId: entry.id,
            phoneNumberId,
            waId: message.from,
            profileName: profileByWaId.get(message.from) ?? null,
            providerMessageId: message.id,
            timestamp: message.timestamp,
            body: message.text.body,
          });
        } else if (message.type === "audio" && message.audio) {
          events.push({
            kind: "inbound_audio",
            wabaId: entry.id,
            phoneNumberId,
            waId: message.from,
            profileName: profileByWaId.get(message.from) ?? null,
            providerMessageId: message.id,
            timestamp: message.timestamp,
            mediaId: message.audio.id,
            mimeType: message.audio.mime_type ?? null,
          });
        } else {
          events.push({
            kind: "inbound_unsupported",
            wabaId: entry.id,
            phoneNumberId,
            waId: message.from,
            providerMessageId: message.id,
            messageType: message.type,
          });
        }
      }

      for (const status of value.statuses ?? []) {
        events.push({
          kind: "status_update",
          wabaId: entry.id,
          phoneNumberId,
          providerMessageId: status.id,
          status: status.status,
          timestamp: status.timestamp,
          recipientId: status.recipient_id,
          failureReason: status.errors?.[0]?.title ?? null,
        });
      }
    }
  }

  return events;
}
