import { Hono } from "hono";
import type { RazorpayWebhookDeps } from "./razorpayWebhookHandler.js";
import { razorpayWebhookRoutes } from "./routes/razorpayWebhook.js";
import type { HealthDeps } from "./routes/health.js";
import { healthRoutes } from "./routes/health.js";
import type { WhatsAppWebhookDeps } from "./whatsappWebhookHandler.js";
import { whatsappWebhookRoutes } from "./routes/whatsappWebhook.js";

export interface AppDeps {
  health: HealthDeps;
  whatsappWebhook: WhatsAppWebhookDeps;
  /** null when RAZORPAY_WEBHOOK_SECRET isn't configured yet -- /webhooks/razorpay is simply not mounted, mirroring MESSAGE_QUEUE/VOICE_QUEUE's existing optional-degradation pattern rather than failing the whole Worker. */
  razorpayWebhook: RazorpayWebhookDeps | null;
}

/**
 * Composition root for the Hono API. Route handlers are thin (parse input,
 * delegate to a domain function, return a response); business logic lives in
 * the imported handler modules and packages/* so it is reachable and testable
 * outside the HTTP layer too.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route("/", healthRoutes(deps.health));
  app.route("/", whatsappWebhookRoutes(deps.whatsappWebhook));
  if (deps.razorpayWebhook) {
    app.route("/", razorpayWebhookRoutes(deps.razorpayWebhook));
  }
  return app;
}
