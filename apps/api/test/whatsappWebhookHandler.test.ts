import { hmacSha256Hex } from "@dravonix/core";
import { createLogger } from "@dravonix/observability";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleWhatsAppWebhookPost,
  handleWhatsAppWebhookVerification,
  type WhatsAppWebhookDeps,
} from "../src/whatsappWebhookHandler.js";
import { InMemoryWhatsAppIngestRepository } from "../src/repositories/inMemoryWhatsAppIngestRepository.js";
import { FakeQueueSender } from "./support/fakeQueue.js";
import type { MessageJobPayload, VoiceJobPayload } from "../src/queuePayloads.js";

const APP_SECRET = "test_app_secret";
const VERIFY_TOKEN = "test_verify_token";
const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const PHONE_NUMBER_ID = "TEST_PHONE_NUMBER_ID";

const silentLogger = createLogger({ environment: "test" }, { write: () => {} });

function makeDeps() {
  const repo = new InMemoryWhatsAppIngestRepository();
  repo.phoneNumberToCompany.set(PHONE_NUMBER_ID, COMPANY_A);
  const messageQueue = new FakeQueueSender<MessageJobPayload>();
  const voiceQueue = new FakeQueueSender<VoiceJobPayload>();
  const deps: WhatsAppWebhookDeps = {
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    repo,
    messageQueue,
    voiceQueue,
    logger: silentLogger,
  };
  return { deps, repo, messageQueue, voiceQueue };
}

function textMessagePayload(messageId = "wamid.TEXT1") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "TEST_WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Asha Menon" }, wa_id: "919820000001" }],
              messages: [
                {
                  from: "919820000001",
                  id: messageId,
                  timestamp: "1706601600",
                  type: "text",
                  text: { body: "Hi, what services do you offer?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function sign(body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(APP_SECRET, body)}`;
}

describe("handleWhatsAppWebhookVerification", () => {
  it("returns the challenge for a correct verification request", () => {
    const { deps } = makeDeps();
    const result = handleWhatsAppWebhookVerification(deps, {
      mode: "subscribe",
      verifyToken: VERIFY_TOKEN,
      challenge: "abc123",
    });
    expect(result).toEqual({ status: 200, body: "abc123" });
  });

  it("rejects an incorrect verify token", () => {
    const { deps } = makeDeps();
    const result = handleWhatsAppWebhookVerification(deps, {
      mode: "subscribe",
      verifyToken: "wrong",
      challenge: "abc123",
    });
    expect(result.status).toBe(403);
  });
});

describe("handleWhatsAppWebhookPost", () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it("rejects a POST with an invalid signature and does not enqueue anything", async () => {
    const body = JSON.stringify(textMessagePayload());
    const result = await handleWhatsAppWebhookPost(ctx.deps, body, "sha256=deadbeef");
    expect(result.status).toBe(401);
    expect(ctx.messageQueue.sent).toHaveLength(0);
  });

  it("processes a valid text message: persists it and enqueues a message job", async () => {
    const body = JSON.stringify(textMessagePayload());
    const signature = await sign(body);

    const result = await handleWhatsAppWebhookPost(ctx.deps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.recordedMessages).toHaveLength(1);
    expect(ctx.messageQueue.sent).toHaveLength(1);
    expect(ctx.messageQueue.sent[0]?.body).toBe("Hi, what services do you offer?");
    expect(ctx.messageQueue.sent[0]?.companyId).toBe(COMPANY_A);
  });

  it("does not enqueue a duplicate reply when the same webhook is delivered twice (Meta retry)", async () => {
    const body = JSON.stringify(textMessagePayload("wamid.DUPLICATE1"));
    const signature = await sign(body);

    await handleWhatsAppWebhookPost(ctx.deps, body, signature);
    await handleWhatsAppWebhookPost(ctx.deps, body, signature);

    expect(ctx.messageQueue.sent).toHaveLength(1);
    expect(ctx.repo.recordedMessages).toHaveLength(1);
  });

  it("stores an unrouted event and enqueues nothing for an unknown phone_number_id", async () => {
    const payload = textMessagePayload();
    payload.entry[0]!.changes[0]!.value.metadata.phone_number_id = "UNKNOWN_NUMBER";
    const body = JSON.stringify(payload);
    const signature = await sign(body);

    const result = await handleWhatsAppWebhookPost(ctx.deps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.messageQueue.sent).toHaveLength(0);
    expect(ctx.repo.recordedWebhookEvents.some((e) => e.status === "unrouted")).toBe(true);
  });

  it("processes an audio message by enqueueing a voice job", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "TEST_WABA_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [
                  {
                    from: "919820000001",
                    id: "wamid.AUDIO1",
                    timestamp: "1706601700",
                    type: "audio",
                    audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = await sign(body);

    await handleWhatsAppWebhookPost(ctx.deps, body, signature);

    expect(ctx.voiceQueue.sent).toHaveLength(1);
    expect(ctx.voiceQueue.sent[0]?.mediaId).toBe("MEDIA1");
    expect(ctx.messageQueue.sent).toHaveLength(0);
  });

  it("records a status update without enqueueing any job", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "TEST_WABA_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [
                  {
                    id: "wamid.TEXT1",
                    status: "delivered",
                    timestamp: "1706601650",
                    recipient_id: "919820000001",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = await sign(body);

    await handleWhatsAppWebhookPost(ctx.deps, body, signature);

    expect(ctx.repo.recordedStatusEvents).toHaveLength(1);
    expect(ctx.repo.recordedStatusEvents[0]?.status).toBe("delivered");
    expect(ctx.messageQueue.sent).toHaveLength(0);
    expect(ctx.voiceQueue.sent).toHaveLength(0);
  });

  it("acknowledges 200 for a verified-but-malformed JSON body instead of crashing", async () => {
    const body = "not valid json";
    const signature = await sign(body);
    const result = await handleWhatsAppWebhookPost(ctx.deps, body, signature);
    expect(result.status).toBe(200);
  });

  it("persists a message without crashing when the message queue is not configured yet", async () => {
    const degradedDeps: WhatsAppWebhookDeps = { ...ctx.deps, messageQueue: undefined };
    const body = JSON.stringify(textMessagePayload("wamid.NOQUEUE1"));
    const signature = await sign(body);

    const result = await handleWhatsAppWebhookPost(degradedDeps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.recordedMessages).toHaveLength(1);
    expect(ctx.repo.recordedWebhookEvents.some((e) => e.status === "processed")).toBe(true);
  });

  it("persists an audio message without crashing when the voice queue is not configured yet", async () => {
    const degradedDeps: WhatsAppWebhookDeps = { ...ctx.deps, voiceQueue: undefined };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "TEST_WABA_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [
                  {
                    from: "919820000001",
                    id: "wamid.NOQUEUE_AUDIO1",
                    timestamp: "1706601700",
                    type: "audio",
                    audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = await sign(body);

    const result = await handleWhatsAppWebhookPost(degradedDeps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.recordedMessages).toHaveLength(1);
  });
});
