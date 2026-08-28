import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError } from "../lib/serverLogging.js";

/**
 * P1 correction: the final independent review found logServerError called
 * loadEnv(process.env) with no try/catch of its own -- loadEnv can throw
 * EnvValidationError (invalid APP_ENV, or a staging/production guard
 * violation), meaning a *logging* failure could escape logServerError and
 * alter the caller's control flow. This is most dangerous for
 * sendInvitationEmail/sendSupportEmails, which are documented and tested to
 * never throw solely because email delivery or its supporting environment
 * configuration failed (see sendInvitationEmail.test.ts/
 * sendSupportEmails.test.ts's CASE C/D for those specific regressions).
 *
 * This file proves the invariant directly against logServerError itself:
 * calling it must never throw, regardless of whether the environment is
 * valid, and normal logging behavior must be completely unaffected when the
 * environment IS valid.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("logServerError -- CASE A: normal logging with a valid environment", () => {
  it("produces the expected safe structured log line and includes the supplied context/extra fields", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logServerError(
      "Failed to do the thing",
      new Error("connection reset"),
      { companyId: "company-a" },
      { operation: "doTheThing", leadId: "lead-1" },
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({
      severity: "error",
      message: "Failed to do the thing",
      companyId: "company-a",
      operation: "doTheThing",
      leadId: "lead-1",
      errorType: "Error",
      errorMessage: "connection reset",
    });
  });

  it("still redacts a field whose key looks like a secret, exactly as before this correction", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logServerError("Failed", new Error("boom"), undefined, { apiKey: "sk-super-secret-value" });

    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(logged.apiKey).toBe("[REDACTED]");
    expect(JSON.stringify(logged)).not.toContain("sk-super-secret-value");
  });

  it("never includes the error's raw payload/cause/stack -- only name and message", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = new Error("visible message");
    (error as unknown as Record<string, unknown>).details = "row-level secret detail";

    logServerError("Failed", error);

    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(logged.errorMessage).toBe("visible message");
    expect(logged.details).toBeUndefined();
    expect(logged.stack).toBeUndefined();
  });
});

describe("logServerError -- CASE B: environment validation failure must never escape", () => {
  it("does not throw when loadEnv's schema validation fails (invalid APP_ENV)", () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");

    expect(() => logServerError("Failed to do the thing", new Error("boom"))).not.toThrow();
  });

  it("does not throw when loadEnv's staging/production guard rejects the environment (DEV_TENANT_SELECTOR_ENABLED in staging)", () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("DEV_TENANT_SELECTOR_ENABLED", "true");

    expect(() => logServerError("Failed to do the thing", new Error("boom"))).not.toThrow();
  });

  it("writes no log line at all when the environment is invalid -- nothing unsafe (including env validation details) escapes through a fallback", () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logServerError("Failed to do the thing", new Error("boom"), { companyId: "company-a" });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not throw even for a non-Error thrown value combined with an invalid environment", () => {
    vi.stubEnv("APP_ENV", "not-a-real-app-env");

    expect(() =>
      logServerError("Failed", { code: "53300", message: "too many connections" }),
    ).not.toThrow();
  });
});
