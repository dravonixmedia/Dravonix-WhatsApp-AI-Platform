import { hmacSha256Hex } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { verifyMetaWebhookChallenge, verifyMetaWebhookSignature } from "../src/signature.js";

describe("verifyMetaWebhookSignature", () => {
  const appSecret = "test_app_secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("accepts a correctly signed payload", async () => {
    const digest = await hmacSha256Hex(appSecret, body);
    await expect(verifyMetaWebhookSignature(body, `sha256=${digest}`, appSecret)).resolves.toBe(
      true,
    );
  });

  it("rejects a payload with an incorrect signature", async () => {
    await expect(
      verifyMetaWebhookSignature(body, `sha256=${"0".repeat(64)}`, appSecret),
    ).resolves.toBe(false);
  });

  it("rejects a tampered body even with a signature present", async () => {
    const digest = await hmacSha256Hex(appSecret, body);
    const tampered = body.replace("whatsapp_business_account", "something_else");
    await expect(verifyMetaWebhookSignature(tampered, `sha256=${digest}`, appSecret)).resolves.toBe(
      false,
    );
  });

  it("rejects a header missing the sha256= prefix", async () => {
    const digest = await hmacSha256Hex(appSecret, body);
    await expect(verifyMetaWebhookSignature(body, digest, appSecret)).resolves.toBe(false);
  });

  it("rejects when no signature header is present", async () => {
    await expect(verifyMetaWebhookSignature(body, undefined, appSecret)).resolves.toBe(false);
  });
});

describe("verifyMetaWebhookChallenge", () => {
  const verifyToken = "test_verify_token";

  it("returns the challenge for a correct subscribe request", () => {
    expect(
      verifyMetaWebhookChallenge(
        { mode: "subscribe", verifyToken, challenge: "challenge-123" },
        verifyToken,
      ),
    ).toBe("challenge-123");
  });

  it("returns null for an incorrect verify token", () => {
    expect(
      verifyMetaWebhookChallenge(
        { mode: "subscribe", verifyToken: "wrong-token", challenge: "challenge-123" },
        verifyToken,
      ),
    ).toBeNull();
  });

  it("returns null for a non-subscribe mode", () => {
    expect(
      verifyMetaWebhookChallenge({ mode: "unsubscribe", verifyToken, challenge: "x" }, verifyToken),
    ).toBeNull();
  });
});
