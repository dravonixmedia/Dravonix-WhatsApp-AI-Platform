import { describe, expect, it } from "vitest";
import {
  canSendFreeFormWhatsAppMessage,
  WHATSAPP_SERVICE_WINDOW_MS,
} from "../src/serviceWindow.js";

describe("canSendFreeFormWhatsAppMessage", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("allows a free-form send when the customer messaged recently (item 1)", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    expect(canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, now)).toBe(true);
  });

  it("blocks a free-form send when the customer's last message is more than 24 hours old (item 2)", () => {
    const lastCustomerMessageAt = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
    expect(canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, now)).toBe(false);
  });

  it("blocks a free-form send when there has never been a qualifying inbound message (item 3)", () => {
    expect(canSendFreeFormWhatsAppMessage(null, now)).toBe(false);
  });

  it("accepts an ISO string timestamp exactly like a Date instance", () => {
    const iso = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(canSendFreeFormWhatsAppMessage(iso, now)).toBe(true);
  });

  describe("the 24-hour boundary (item 8)", () => {
    it("blocks when EXACTLY 24 hours have elapsed -- the boundary is treated as closed, never open", () => {
      const lastCustomerMessageAt = new Date(now.getTime() - WHATSAPP_SERVICE_WINDOW_MS);
      expect(canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, now)).toBe(false);
    });

    it("allows when 1 millisecond less than 24 hours have elapsed", () => {
      const lastCustomerMessageAt = new Date(now.getTime() - WHATSAPP_SERVICE_WINDOW_MS + 1);
      expect(canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, now)).toBe(true);
    });

    it("blocks when 1 millisecond more than 24 hours have elapsed", () => {
      const lastCustomerMessageAt = new Date(now.getTime() - WHATSAPP_SERVICE_WINDOW_MS - 1);
      expect(canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, now)).toBe(false);
    });
  });

  it("treats a last-customer-message timestamp in the future (clock skew) as well within the window", () => {
    const lastCustomerMessageAt = new Date(now.getTime() + 60 * 1000);
    expect(canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, now)).toBe(true);
  });
});
