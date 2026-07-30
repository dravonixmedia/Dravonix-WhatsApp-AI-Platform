import { Hono } from "hono";
import type { HealthDeps } from "./routes/health.js";
import { healthRoutes } from "./routes/health.js";
import type { WhatsAppWebhookDeps } from "./whatsappWebhookHandler.js";
import { whatsappWebhookRoutes } from "./routes/whatsappWebhook.js";

export interface AppDeps {
  health: HealthDeps;
  whatsappWebhook: WhatsAppWebhookDeps;
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
  return app;
}
