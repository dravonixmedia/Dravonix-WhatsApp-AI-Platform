import { hmacSha256Hex } from "@dravonix/core";
import { createLogger } from "@dravonix/observability";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryWhatsAppIngestRepository } from "../src/repositories/inMemoryWhatsAppIngestRepository.js";
import { FakeQueueSender } from "./support/fakeQueue.js";
import type { MessageJobPayload, VoiceJobPayload } from "../src/queuePayloads.js";

const APP_SECRET = "test_app_secret";
const VERIFY_TOKEN = "test_verify_token";

function makeApp() {
  const repo = new InMemoryWhatsAppIngestRepository();
  repo.phoneNumberToCompany.set("TEST_PHONE_NUMBER_ID", "aaaaaaaa-0000-0000-0000-000000000001");
  const messageQueue = new FakeQueueSender<MessageJobPayload>();
  const voiceQueue = new FakeQueueSender<VoiceJobPayload>();

  const app = createApp({
    health: { checkDatabase: async () => true },
    whatsappWebhook: {
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      repo,
      messageQueue,
      voiceQueue,
      logger: createLogger({ environment: "test" }, { write: () => {} }),
    },
  });

  return { app, repo, messageQueue };
}

describe("GET /health", () => {
  it("returns 200 with the platform product name", async () => {
    const { app } = makeApp();
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.product).toBe("Dravonix WhatsApp AI Platform");
  });
});

describe("GET /ready", () => {
  it("returns 200 when the database check succeeds", async () => {
    const { app } = makeApp();
    const response = await app.request("/ready");
    expect(response.status).toBe(200);
  });
});

describe("GET /webhooks/whatsapp", () => {
  it("echoes the challenge for a valid verification request", async () => {
    const { app } = makeApp();
    const response = await app.request(
      `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=xyz`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("xyz");
  });

  it("returns 403 for an incorrect verify token", async () => {
    const { app } = makeApp();
    const response = await app.request(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=xyz",
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 when required hub.* query parameters are missing", async () => {
    const { app } = makeApp();
    const response = await app.request("/webhooks/whatsapp?hub.mode=subscribe");
    expect(response.status).toBe(400);
  });
});

describe("POST /webhooks/whatsapp", () => {
  it("accepts a signed text-message payload end to end through the Hono app", async () => {
    const { app, messageQueue } = makeApp();
    const payload = {
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
                contacts: [{ profile: { name: "Asha" }, wa_id: "919820000001" }],
                messages: [
                  {
                    from: "919820000001",
                    id: "wamid.APPTEST1",
                    timestamp: "1706601600",
                    type: "text",
                    text: { body: "Hello via Hono" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${await hmacSha256Hex(APP_SECRET, body)}`;

    const response = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(200);
    expect(messageQueue.sent).toHaveLength(1);
    expect(messageQueue.sent[0]?.body).toBe("Hello via Hono");
  });

  it("rejects a request with a missing signature header", async () => {
    const { app, messageQueue } = makeApp();
    const response = await app.request("/webhooks/whatsapp", {
      method: "POST",
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    });
    expect(response.status).toBe(401);
    expect(messageQueue.sent).toHaveLength(0);
  });

  it("rejects a request with an incorrect signature value", async () => {
    const { app, messageQueue } = makeApp();
    const response = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef", "content-type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    });
    expect(response.status).toBe(401);
    expect(messageQueue.sent).toHaveLength(0);
  });
});

describe("unknown routes", () => {
  it("returns 404 for a route that doesn't exist", async () => {
    const { app } = makeApp();
    const response = await app.request("/webhooks/meta");
    expect(response.status).toBe(404);
  });
});
