import { describe, expect, it } from "vitest";
import { mapRazorpayEventToSubscriptionEvent } from "../src/providers/razorpay/eventMapper.js";
import { verifyRazorpayWebhookSignature } from "../src/providers/razorpay/webhookSignature.js";
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
