import { afterEach, describe, expect, it, vi } from "vitest";

// This file's module under test starts with `import "server-only"`, which
// throws when loaded outside Next.js's RSC bundler (see
// node_modules/server-only) -- harmless in the real app (Next.js strips it
// at build time), but it must be stubbed for a plain Vitest/Node run.
vi.mock("server-only", () => ({}));

import { maskEmail, sendInvitationEmail } from "../lib/email/sendInvitationEmail.js";

/**
 * P1 correction (CASE C): the final independent review's exact failure
 * scenario --
 *   1. sendInvitationEmail's getEmailProvider() calls loadEnv() -> throws
 *   2. the outer catch block calls logServerError()
 *   3. logServerError() itself calls loadEnv() again -> throws again
 *   4. (before the correction) that second throw escaped logServerError,
 *      which escaped the catch block, which broke sendInvitationEmail's
 *      documented "never throws" best-effort contract
 * This exercises the REAL sendInvitationEmail function (not a reimplemented
 * double) with an actually-invalid process.env, proving the correction
 * holds end-to-end, not just inside logServerError in isolation.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendInvitationEmail -- CASE C: never throws even when the environment fails twice", () => {
  it("resolves with a safe unexpected_error result instead of rejecting, when APP_ENV is invalid", async () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      sendInvitationEmail({
        email: "priya@example.com",
        companyName: "Acme Co",
        roleLabel: "Owner",
        acceptUrl: "https://app.example.com/invite/abc123",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ).resolves.toEqual({ attempted: true, success: false, errorCode: "unexpected_error" });

    // The internal logging failure (loadEnv throwing a second time inside
    // logServerError) was swallowed silently -- no log line escaped either.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("still never leaks the recipient address or acceptUrl even in this doubly-failing path", async () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendInvitationEmail({
      email: "priya@example.com",
      companyName: "Acme Co",
      roleLabel: "Owner",
      acceptUrl: "https://app.example.com/invite/abc123",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(JSON.stringify(result)).not.toContain("priya@example.com");
    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("maskEmail (regression baseline, unchanged by this correction)", () => {
  it("masks a normal address to first-letter + domain", () => {
    expect(maskEmail("priya@example.com")).toBe("p***@example.com");
  });

  it("never reveals the full local part even for a single-character local part", () => {
    expect(maskEmail("p@example.com")).toBe("p***@example.com");
  });

  it("falls back to a fully opaque placeholder for a malformed address", () => {
    expect(maskEmail("not-an-email")).toBe("***");
  });
});
