import { Hono } from "hono";
import { handleRazorpayWebhookPost, type RazorpayWebhookDeps } from "../razorpayWebhookHandler.js";

export function razorpayWebhookRoutes(deps: RazorpayWebhookDeps): Hono {
  const app = new Hono();

  app.post("/webhooks/razorpay", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-razorpay-signature");
    const result = await handleRazorpayWebhookPost(deps, rawBody, signature ?? null);
    return c.text(result.body, result.status as 200 | 401);
  });

  return app;
}
