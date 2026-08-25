import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRazorpayEventToSubscriptionEvent } from "../src/providers/razorpay/eventMapper.js";
import { createRazorpayOrder, RazorpayApiError } from "../src/providers/razorpay/ordersApi.js";
import { parseRazorpayPaymentWebhookEvent } from "../src/providers/razorpay/paymentWebhookEvent.js";
import {
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from "../src/providers/razorpay/webhookSignature.js";
import { applySubscriptionEvent } from "../src/stateMachine.js";
import { hmacSha256Hex } from "@dravonix/core";

describe("mapRazorpayEventToSubscriptionEvent", () => {
  it("maps subscription.activated and subscription.authenticated to activate", () => {
    expect(mapRazorpayEventToSubscriptionEvent("subscription.authenticated")).toBe("activate");
    expect(mapRazorpayEventToSubscriptionEvent("subscription.activated")).toBe("activate");
  });

  it("maps subscription.charged to payment_recovered", () => {
    expect(mapRazorpayEventToSubscriptionEvent("subscription.charged")).toBe("payment_recovered");
  });

  it("maps payment.failed and subscription.pending to payment_failed", () => {
    expect(mapRazorpayEventToSubscriptionEvent("payment.failed")).toBe("payment_failed");
    expect(mapRazorpayEventToSubscriptionEvent("subscription.pending")).toBe("payment_failed");
  });

  it("maps subscription.cancelled to cancelled_immediately", () => {
    expect(mapRazorpayEventToSubscriptionEvent("subscription.cancelled")).toBe(
      "cancelled_immediately",
    );
  });

  it("returns null for an unrecognized event rather than guessing", () => {
    expect(mapRazorpayEventToSubscriptionEvent("subscription.some_future_event")).toBeNull();
  });

  it("produces events that are all valid against the internal state machine from active", () => {
    const chargedEvent = mapRazorpayEventToSubscriptionEvent("subscription.charged")!;
    expect(applySubscriptionEvent("active", chargedEvent)).toBe("active");

    const failedEvent = mapRazorpayEventToSubscriptionEvent("payment.failed")!;
    expect(applySubscriptionEvent("active", failedEvent)).toBe("payment_due");
  });
});

describe("verifyRazorpayWebhookSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ event: "subscription.charged", payload: { id: "sub_test123" } });

  it("accepts a correctly signed payload", async () => {
    const signature = await hmacSha256Hex(secret, body);
    await expect(verifyRazorpayWebhookSignature(body, signature, secret)).resolves.toBe(true);
  });

  it("rejects a payload with an incorrect signature", async () => {
    await expect(verifyRazorpayWebhookSignature(body, "0".repeat(64), secret)).resolves.toBe(false);
  });

  it("rejects a payload with a tampered body even if a signature is present", async () => {
    const signature = await hmacSha256Hex(secret, body);
    const tamperedBody = body.replace("subscription.charged", "subscription.cancelled");
    await expect(verifyRazorpayWebhookSignature(tamperedBody, signature, secret)).resolves.toBe(
      false,
    );
  });

  it("rejects when no signature header is present", async () => {
    await expect(verifyRazorpayWebhookSignature(body, undefined, secret)).resolves.toBe(false);
  });
});

describe("verifyRazorpayPaymentSignature", () => {
  const keySecret = "key_secret_test";
  const orderId = "order_TESTORDER0001";
  const paymentId = "pay_TEST0001";

  it("accepts a correctly signed checkout callback", async () => {
    const signature = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
    await expect(
      verifyRazorpayPaymentSignature(orderId, paymentId, signature, keySecret),
    ).resolves.toBe(true);
  });

  it("rejects a tampered order id", async () => {
    const signature = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
    await expect(
      verifyRazorpayPaymentSignature("order_TAMPERED", paymentId, signature, keySecret),
    ).resolves.toBe(false);
  });

  it("rejects a tampered payment id", async () => {
    const signature = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
    await expect(
      verifyRazorpayPaymentSignature(orderId, "pay_TAMPERED", signature, keySecret),
    ).resolves.toBe(false);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const signature = await hmacSha256Hex("wrong_secret", `${orderId}|${paymentId}`);
    await expect(
      verifyRazorpayPaymentSignature(orderId, paymentId, signature, keySecret),
    ).resolves.toBe(false);
  });

  it("rejects a missing signature", async () => {
    await expect(
      verifyRazorpayPaymentSignature(orderId, paymentId, undefined, keySecret),
    ).resolves.toBe(false);
    await expect(verifyRazorpayPaymentSignature(orderId, paymentId, null, keySecret)).resolves.toBe(
      false,
    );
  });
});

describe("parseRazorpayPaymentWebhookEvent", () => {
  function capturedPayload(paymentId: string, orderId: string) {
    return {
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
    };
  }

  it("parses a payment.captured event", () => {
    const result = parseRazorpayPaymentWebhookEvent(
      capturedPayload("pay_TEST0001", "order_TESTORDER0001"),
    );
    expect(result).toEqual({
      eventId: "payment.captured:pay_TEST0001",
      status: "captured",
      orderId: "order_TESTORDER0001",
      paymentId: "pay_TEST0001",
    });
  });

  it("parses a payment.failed event", () => {
    const payload = {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_TEST0002", order_id: "order_TESTORDER0002" } } },
    };
    const result = parseRazorpayPaymentWebhookEvent(payload);
    expect(result).toEqual({
      eventId: "payment.failed:pay_TEST0002",
      status: "failed",
      orderId: "order_TESTORDER0002",
      paymentId: "pay_TEST0002",
    });
  });

  it("returns null for an unrelated event (e.g. order.paid or a subscription.* event)", () => {
    expect(parseRazorpayPaymentWebhookEvent({ event: "order.paid", payload: {} })).toBeNull();
    expect(
      parseRazorpayPaymentWebhookEvent({ event: "subscription.charged", payload: {} }),
    ).toBeNull();
  });

  it("returns null for a malformed payload missing the payment entity", () => {
    expect(parseRazorpayPaymentWebhookEvent({ event: "payment.captured", payload: {} })).toBeNull();
    expect(parseRazorpayPaymentWebhookEvent({})).toBeNull();
    expect(parseRazorpayPaymentWebhookEvent(null)).toBeNull();
    expect(parseRazorpayPaymentWebhookEvent("not an object")).toBeNull();
  });

  it("returns null when the payment entity is missing an id or order_id", () => {
    const missingOrderId = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_TEST0003" } } },
    };
    expect(parseRazorpayPaymentWebhookEvent(missingOrderId)).toBeNull();
  });
});

describe("createRazorpayOrder", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to the Razorpay Orders endpoint with HTTP Basic Auth and the server-derived amount/currency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "order_TESTORDER0001",
          amount: 100000,
          currency: "INR",
          receipt: "pay_internal_1",
          status: "created",
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const order = await createRazorpayOrder(
      { amountInSmallestUnit: 100000, currency: "INR", receipt: "pay_internal_1" },
      "rzp_test_key_id",
      "rzp_test_key_secret",
    );

    expect(order.id).toBe("order_TESTORDER0001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("rzp_test_key_id:rzp_test_key_secret")}`);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      amount: 100000,
      currency: "INR",
      receipt: "pay_internal_1",
      notes: {},
    });
  });

  it("throws RazorpayApiError on a non-2xx response without echoing the response body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { description: "sensitive detail" } }), {
        status: 401,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await createRazorpayOrder(
        { amountInSmallestUnit: 100000, currency: "INR", receipt: "pay_internal_1" },
        "rzp_test_key_id",
        "rzp_test_key_secret",
      );
      throw new Error("expected createRazorpayOrder to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RazorpayApiError);
      expect((err as RazorpayApiError).status).toBe(401);
      expect((err as RazorpayApiError).message).not.toContain("sensitive detail");
    }
  });

  it("never logs the key secret", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "order_TESTORDER0001",
          amount: 100000,
          currency: "INR",
          receipt: "pay_internal_1",
          status: "created",
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createRazorpayOrder(
      { amountInSmallestUnit: 100000, currency: "INR", receipt: "pay_internal_1" },
      "rzp_test_key_id",
      "rzp_test_key_secret_SENSITIVE",
    );

    const allLoggedText = [...consoleSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((v) => String(v))
      .join(" ");
    expect(allLoggedText).not.toContain("rzp_test_key_secret_SENSITIVE");
  });
});
