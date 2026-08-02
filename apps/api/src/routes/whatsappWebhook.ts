import { Hono } from "hono";
import {
  handleWhatsAppWebhookPost,
  handleWhatsAppWebhookVerification,
  type WhatsAppWebhookDeps,
} from "../whatsappWebhookHandler.js";

export function whatsappWebhookRoutes(deps: WhatsAppWebhookDeps): Hono {
  const app = new Hono();

  app.get("/webhooks/whatsapp", (c) => {
    const result = handleWhatsAppWebhookVerification(deps, {
      mode: c.req.query("hub.mode") ?? null,
      verifyToken: c.req.query("hub.verify_token") ?? null,
      challenge: c.req.query("hub.challenge") ?? null,
    });
    return c.text(result.body, result.status as 200 | 400 | 403);
  });

  app.post("/webhooks/whatsapp", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    const result = await handleWhatsAppWebhookPost(deps, rawBody, signature ?? null);
    return c.text(result.body, result.status as 200 | 401);
  });

  return app;
}
