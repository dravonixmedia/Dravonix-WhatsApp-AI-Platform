import { afterEach, describe, expect, it, vi } from "vitest";

// See sendInvitationEmail.test.ts's identical note: this module starts with
// `import "server-only"`, which must be stubbed to load outside Next.js's
// RSC bundler in a plain Vitest/Node run.
vi.mock("server-only", () => ({}));

import {
  sendNewSupportRequestNotification,
  sendSupportReplyNotification,
} from "../lib/email/sendSupportEmails.js";

/**
 * P1 correction (CASE D): mirrors sendInvitationEmail.test.ts's CASE C for
 * this file's two email functions. Both call loadEnv(process.env) on their
 * own (sendNewSupportRequestNotification directly; sendSupportReplyNotification
 * via getEmailProvider()) before ever reaching logServerError, so an invalid
 * environment reproduces the exact same double-loadEnv-failure scenario the
 * independent review found. These are the REAL production functions, not a
 * reimplemented double.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendNewSupportRequestNotification -- CASE D: never throws when the environment fails twice", () => {
  it("resolves with a safe unexpected_error result instead of rejecting, when APP_ENV is invalid", async () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      sendNewSupportRequestNotification({
        reference: "SR-1001",
        companyName: "Acme Co",
        submittedByLabel: "Priya (Owner)",
        typeLabel: "Billing",
        subject: "Cannot access invoices",
        description: "I can't see my last invoice.",
        detailUrl: "https://app.example.com/admin/support/request-1",
      }),
    ).resolves.toEqual({ attempted: true, success: false, errorCode: "unexpected_error" });

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("sendSupportReplyNotification -- CASE D: never throws when the environment fails twice", () => {
  it("resolves with a safe unexpected_error result instead of rejecting, when APP_ENV is invalid", async () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      sendSupportReplyNotification("customer@example.com", {
        reference: "SR-1001",
        subject: "Cannot access invoices",
        statusLabel: "Resolved",
        replyMessage: "We've looked into this and issued a refund.",
        detailUrl: "https://app.example.com/dashboard/support/request-1",
      }),
    ).resolves.toEqual({ attempted: true, success: false, errorCode: "unexpected_error" });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("never leaks the recipient address or reply body in this doubly-failing path", async () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendSupportReplyNotification("customer@example.com", {
      reference: "SR-1001",
      subject: "Cannot access invoices",
      statusLabel: "Resolved",
      replyMessage: "We've looked into this and issued a refund.",
      detailUrl: "https://app.example.com/dashboard/support/request-1",
    });

    expect(JSON.stringify(result)).not.toContain("customer@example.com");
    expect(JSON.stringify(result)).not.toContain("issued a refund");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
