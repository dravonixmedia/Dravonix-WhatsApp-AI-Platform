import { hmacSha256Hex } from "@dravonix/core";
import { createLogger } from "@dravonix/observability";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleRazorpayWebhookPost,
  type RazorpayWebhookDeps,
} from "../src/razorpayWebhookHandler.js";
import type {
  ReconcileRazorpayPaymentInput,
  RazorpayPaymentRepository,
} from "../src/repositories/razorpayPaymentRepository.js";

const WEBHOOK_SECRET = "whsec_test_secret";

const silentLogger = createLogger({ environment: "test" }, { write: () => {} });

class FakeRazorpayPaymentRepository implements RazorpayPaymentRepository {
  calls: ReconcileRazorpayPaymentInput[] = [];

  async reconcilePayment(input: ReconcileRazorpayPaymentInput): Promise<void> {
    this.calls.push(input);
  }
}

function makeDeps() {
  const repo = new FakeRazorpayPaymentRepository();
  const deps: RazorpayWebhookDeps = {
    webhookSecret: WEBHOOK_SECRET,
    repo,
    logger: silentLogger,
  };
  return { deps, repo };
}

async function sign(body: string): Promise<string> {
  return hmacSha256Hex(WEBHOOK_SECRET, body);
}

function capturedPayload(paymentId: string, orderId: string, amount = 100000, currency = "INR") {
  return JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency } } },
  });
}

function failedPayload(paymentId: string, orderId: string, amount = 100000, currency = "INR") {
  return JSON.stringify({
    event: "payment.failed",
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency } } },
  });
}

describe("handleRazorpayWebhookPost", () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it("rejects a request with an invalid signature and never calls reconcile", async () => {
    const body = capturedPayload("pay_TEST0001", "order_TESTORDER0001");
    const result = await handleRazorpayWebhookPost(ctx.deps, body, "deadbeef".repeat(8));
    expect(result.status).toBe(401);
    expect(ctx.repo.calls).toHaveLength(0);
  });

  it("rejects a request with a missing signature header", async () => {
    const body = capturedPayload("pay_TEST0001", "order_TESTORDER0001");
    const result = await handleRazorpayWebhookPost(ctx.deps, body, null);
    expect(result.status).toBe(401);
    expect(ctx.repo.calls).toHaveLength(0);
  });

  it("rejects a request whose raw body was modified after signing", async () => {
    const body = capturedPayload("pay_TEST0001", "order_TESTORDER0001");
    const signature = await sign(body);
    const tamperedBody = capturedPayload("pay_TEST0001", "order_TAMPERED");
    const result = await handleRazorpayWebhookPost(ctx.deps, tamperedBody, signature);
    expect(result.status).toBe(401);
    expect(ctx.repo.calls).toHaveLength(0);
  });

  it("verifies the signature before parsing JSON: an invalid signature on malformed JSON is still 401, not a parse error", async () => {
    const body = "not valid json";
    const result = await handleRazorpayWebhookPost(ctx.deps, body, "deadbeef".repeat(8));
    expect(result.status).toBe(401);
    expect(ctx.repo.calls).toHaveLength(0);
  });

  it("acknowledges 200 for a verified-but-malformed JSON body instead of crashing", async () => {
    const body = "not valid json";
    const signature = await sign(body);
    const result = await handleRazorpayWebhookPost(ctx.deps, body, signature);
    expect(result.status).toBe(200);
    expect(ctx.repo.calls).toHaveLength(0);
  });

  it("processes a valid payment.captured event and calls reconcile with the correct args", async () => {
    const body = capturedPayload("pay_TEST0001", "order_TESTORDER0001");
    const signature = await sign(body);

    const result = await handleRazorpayWebhookPost(ctx.deps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.calls).toHaveLength(1);
    expect(ctx.repo.calls[0]).toEqual({
      providerEventId: "payment.captured:pay_TEST0001",
      eventStatus: "captured",
      razorpayOrderId: "order_TESTORDER0001",
      razorpayPaymentId: "pay_TEST0001",
      amountInSmallestUnit: 100000,
      currency: "INR",
      rawPayload: JSON.parse(body),
    });
  });

  it("processes a valid payment.failed event and calls reconcile with the correct args", async () => {
    const body = failedPayload("pay_TEST0002", "order_TESTORDER0002");
    const signature = await sign(body);

    const result = await handleRazorpayWebhookPost(ctx.deps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.calls).toHaveLength(1);
    expect(ctx.repo.calls[0]?.eventStatus).toBe("failed");
  });

  it("returns 200 without calling reconcile for a validly-signed but unrecognized event", async () => {
    const body = JSON.stringify({ event: "order.paid", payload: {} });
    const signature = await sign(body);

    const result = await handleRazorpayWebhookPost(ctx.deps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.calls).toHaveLength(0);
  });

  it("does not double-reconcile when the exact same webhook delivery is processed twice (Razorpay retry) -- the route itself is stateless, idempotency is enforced downstream in the RPC, so this only verifies the route calls reconcile once per delivery with identical args", async () => {
    const body = capturedPayload("pay_TEST0003", "order_TESTORDER0003");
    const signature = await sign(body);

    await handleRazorpayWebhookPost(ctx.deps, body, signature);
    await handleRazorpayWebhookPost(ctx.deps, body, signature);

    expect(ctx.repo.calls).toHaveLength(2);
    expect(ctx.repo.calls[0]).toEqual(ctx.repo.calls[1]);
  });

  it("passes the webhook's own reported amount/currency through to reconcile untouched", async () => {
    const body = capturedPayload("pay_TEST0006", "order_TESTORDER0006", 250050, "inr");
    const signature = await sign(body);

    await handleRazorpayWebhookPost(ctx.deps, body, signature);

    expect(ctx.repo.calls[0]?.amountInSmallestUnit).toBe(250050);
    expect(ctx.repo.calls[0]?.currency).toBe("inr");
  });

  it("returns 200 without calling reconcile for a validly-signed event whose payment entity is missing an amount (rejected by the parser before it ever reaches the repository)", async () => {
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_TEST0007", order_id: "order_TESTORDER0007" } } },
    });
    const signature = await sign(body);

    const result = await handleRazorpayWebhookPost(ctx.deps, body, signature);

    expect(result.status).toBe(200);
    expect(ctx.repo.calls).toHaveLength(0);
  });
});
