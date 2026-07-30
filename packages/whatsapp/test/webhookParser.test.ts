import { describe, expect, it } from "vitest";
import audioMessage from "./fixtures/audioMessage.json" with { type: "json" };
import failedStatusUpdate from "./fixtures/failedStatusUpdate.json" with { type: "json" };
import statusUpdate from "./fixtures/statusUpdate.json" with { type: "json" };
import textMessage from "./fixtures/textMessage.json" with { type: "json" };
import {
  parseWhatsAppWebhookPayload,
  WebhookPayloadValidationError,
  type InboundAudioMessageEvent,
  type InboundTextMessageEvent,
  type StatusUpdateEvent,
} from "../src/webhookParser.js";

describe("parseWhatsAppWebhookPayload", () => {
  it("parses a text message webhook into an inbound_text event", () => {
    const events = parseWhatsAppWebhookPayload(textMessage);
    expect(events).toHaveLength(1);
    const event = events[0] as InboundTextMessageEvent;
    expect(event.kind).toBe("inbound_text");
    expect(event.phoneNumberId).toBe("TEST_PHONE_NUMBER_ID");
    expect(event.waId).toBe("919820000001");
    expect(event.profileName).toBe("Asha Menon");
    expect(event.body).toBe("Hi, what services do you offer?");
    expect(event.providerMessageId).toBe("wamid.HBgLTEST_TEXT_0001");
  });

  it("parses an audio message webhook into an inbound_audio event", () => {
    const events = parseWhatsAppWebhookPayload(audioMessage);
    expect(events).toHaveLength(1);
    const event = events[0] as InboundAudioMessageEvent;
    expect(event.kind).toBe("inbound_audio");
    expect(event.mediaId).toBe("MEDIA_ID_0001");
    expect(event.mimeType).toBe("audio/ogg; codecs=opus");
  });

  it("parses a delivered status update", () => {
    const events = parseWhatsAppWebhookPayload(statusUpdate);
    expect(events).toHaveLength(1);
    const event = events[0] as StatusUpdateEvent;
    expect(event.kind).toBe("status_update");
    expect(event.status).toBe("delivered");
    expect(event.providerMessageId).toBe("wamid.HBgLTEST_TEXT_0001");
  });

  it("parses a failed status update with a failure reason", () => {
    const events = parseWhatsAppWebhookPayload(failedStatusUpdate);
    const event = events[0] as StatusUpdateEvent;
    expect(event.status).toBe("failed");
    expect(event.failureReason).toBe("Message undeliverable");
  });

  it("throws WebhookPayloadValidationError for a payload missing required fields", () => {
    expect(() => parseWhatsAppWebhookPayload({ object: "whatsapp_business_account" })).toThrow(
      WebhookPayloadValidationError,
    );
  });

  it("throws WebhookPayloadValidationError for a completely unrelated payload shape", () => {
    expect(() => parseWhatsAppWebhookPayload({ hello: "world" })).toThrow(
      WebhookPayloadValidationError,
    );
  });

  it("classifies an unsupported message type (e.g. sticker) without dropping the event", () => {
    const events = parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "TEST_WABA_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "TEST_PHONE_NUMBER_ID" },
                messages: [
                  {
                    from: "919820000001",
                    id: "wamid.STICKER1",
                    timestamp: "1706601800",
                    type: "sticker",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("inbound_unsupported");
  });
});
