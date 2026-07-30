import { describe, expect, it } from "vitest";
import {
  InvalidNotificationAudienceError,
  sendNotification,
  type NotificationInput,
} from "../src/notification.js";
import { MockNotificationProvider } from "../src/providers/mockProvider.js";

function baseInput(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    companyId: "aaaaaaaa-0000-0000-0000-000000000001",
    audience: "company_admin",
    channel: "email",
    category: "payment_failed",
    body: "Your payment failed.",
    ...overrides,
  };
}

describe("sendNotification", () => {
  it("delivers a billing notification to a company admin", async () => {
    const provider = new MockNotificationProvider();
    const result = await sendNotification(provider, baseInput());
    expect(result.sent).toBe(true);
    expect(provider.sent).toHaveLength(1);
  });

  it("refuses to send a billing notification to a customer contact", async () => {
    const provider = new MockNotificationProvider();
    await expect(
      sendNotification(
        provider,
        baseInput({ audience: "customer_contact", category: "account_suspended" }),
      ),
    ).rejects.toThrow(InvalidNotificationAudienceError);
    expect(provider.sent).toHaveLength(0);
  });

  it("refuses to send a billing notification to platform_staff instead of company_admin", async () => {
    const provider = new MockNotificationProvider();
    await expect(
      sendNotification(
        provider,
        baseInput({ audience: "platform_staff", category: "grace_period_started" }),
      ),
    ).rejects.toThrow(InvalidNotificationAudienceError);
  });

  it("allows an operational notification to be sent to a customer contact (e.g. static fallback)", async () => {
    const provider = new MockNotificationProvider();
    const result = await sendNotification(
      provider,
      baseInput({ audience: "customer_contact", category: "message_processing_failed" }),
    );
    expect(result.sent).toBe(true);
  });

  it("allows an operational notification to be sent to platform staff", async () => {
    const provider = new MockNotificationProvider();
    const result = await sendNotification(
      provider,
      baseInput({ audience: "platform_staff", category: "whatsapp_disconnected" }),
    );
    expect(result.sent).toBe(true);
  });
});
