import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral tests for the Meta Embedded Signup connect routes
 * (apps/web/app/api/integrations/meta/whatsapp/signup/{initiate,complete}/route.ts),
 * same module-boundary-mocking convention as mediaAudioRoute.test.ts. Proves
 * the actual runtime control flow -- status codes, which errors map to 401
 * vs 403 vs 500, that a client-supplied companyId can never override the
 * session's own, and that a signup failure is audited without leaking the
 * sanitized detail into a 500.
 */

class FakeWhatsappSignupUnauthenticatedError extends Error {}
class FakePermissionDeniedError extends Error {
  code = "permission_denied";
}
class FakeEmbeddedSignupFlowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const requireWhatsappManageContext = vi.fn();
vi.mock("../lib/whatsappSignupAuth.js", () => ({
  requireWhatsappManageContext: (...args: unknown[]) => requireWhatsappManageContext(...args),
  WhatsappSignupUnauthenticatedError: FakeWhatsappSignupUnauthenticatedError,
}));

const initiateEmbeddedSignup = vi.fn();
const completeEmbeddedSignup = vi.fn();
class FakeSupabaseSignupAttemptRepository {}
class FakeMetaGraphManagementClient {}
vi.mock("@dravonix/whatsapp", () => ({
  initiateEmbeddedSignup: (...args: unknown[]) => initiateEmbeddedSignup(...args),
  completeEmbeddedSignup: (...args: unknown[]) => completeEmbeddedSignup(...args),
  EmbeddedSignupFlowError: FakeEmbeddedSignupFlowError,
  SupabaseSignupAttemptRepository: FakeSupabaseSignupAttemptRepository,
  MetaGraphManagementClient: FakeMetaGraphManagementClient,
}));

const recordAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@dravonix/observability", () => ({
  recordAuditLog: (...args: unknown[]) => recordAuditLog(...args),
}));

class FakeSupabaseAuditLogWriter {}
vi.mock("@dravonix/handover", () => ({
  SupabaseAuditLogWriter: FakeSupabaseAuditLogWriter,
}));

const logServerError = vi.fn();
vi.mock("../lib/serverLogging.js", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

const resolveWhatsappEmbeddedSignupServerConfig = vi.fn();
class FakeWhatsappEmbeddedSignupNotConfiguredError extends Error {}
vi.mock("../lib/whatsappEmbeddedSignupConfig.js", () => ({
  resolveWhatsappEmbeddedSignupServerConfig: (...args: unknown[]) =>
    resolveWhatsappEmbeddedSignupServerConfig(...args),
  WhatsappEmbeddedSignupNotConfiguredError: FakeWhatsappEmbeddedSignupNotConfiguredError,
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const SESSION = { activeCompanyId: "company-a", userId: "user-1" };
const SERVICE_ROLE_CLIENT = { marker: "service-role" };

beforeEach(() => {
  vi.clearAllMocks();
  requireWhatsappManageContext.mockResolvedValue({
    session: SESSION,
    serviceRoleClient: SERVICE_ROLE_CLIENT,
    tenantContext: {},
  });
  resolveWhatsappEmbeddedSignupServerConfig.mockReturnValue({
    metaCredentials: { appId: "APP", appSecret: "SECRET", graphApiVersion: "v21.0" },
    encryptionKey: { version: 1, keyBase64: "AAAA" },
  });
});

describe("POST /api/integrations/meta/whatsapp/signup/initiate", () => {
  async function callRoute() {
    const { POST } = await import("../app/api/integrations/meta/whatsapp/signup/initiate/route.js");
    return POST();
  }

  it("returns 401 and never creates an attempt when unauthenticated", async () => {
    requireWhatsappManageContext.mockRejectedValue(new FakeWhatsappSignupUnauthenticatedError());

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(initiateEmbeddedSignup).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks whatsapp.manage for their own company", async () => {
    requireWhatsappManageContext.mockRejectedValue(new FakePermissionDeniedError("nope"));

    const response = await callRoute();

    expect(response.status).toBe(403);
    expect(initiateEmbeddedSignup).not.toHaveBeenCalled();
  });

  it("initiates using the session's own company/user, and returns the attempt id/nonce", async () => {
    initiateEmbeddedSignup.mockResolvedValue({
      attemptId: "attempt-1",
      nonce: "nonce-value",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const response = await callRoute();
    const body = (await response.json()) as { attemptId: string; nonce: string };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      attemptId: "attempt-1",
      nonce: "nonce-value",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const [, input] = initiateEmbeddedSignup.mock.calls[0] ?? [];
    expect(input).toEqual({ companyId: "company-a", initiatedByUserId: "user-1" });
    expect(recordAuditLog).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and logs (never throws raw) when attempt creation fails", async () => {
    initiateEmbeddedSignup.mockRejectedValue(new Error("db unreachable"));

    const response = await callRoute();

    expect(response.status).toBe(500);
    expect(logServerError).toHaveBeenCalled();
  });
});

describe("POST /api/integrations/meta/whatsapp/signup/complete", () => {
  async function callRoute(body: unknown) {
    const { POST } = await import("../app/api/integrations/meta/whatsapp/signup/complete/route.js");
    return POST(
      new Request("http://localhost/api/integrations/meta/whatsapp/signup/complete", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  }

  const VALID_BODY = {
    attemptId: "attempt-1",
    nonce: "nonce-value",
    code: "auth-code",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    businessId: "business-1",
  };

  it("returns 401 before ever parsing the body when unauthenticated", async () => {
    requireWhatsappManageContext.mockRejectedValue(new FakeWhatsappSignupUnauthenticatedError());

    const response = await callRoute(VALID_BODY);

    expect(response.status).toBe(401);
    expect(completeEmbeddedSignup).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed body without ever calling completeEmbeddedSignup", async () => {
    const response = await callRoute({ attemptId: "attempt-1" });

    expect(response.status).toBe(400);
    expect(completeEmbeddedSignup).not.toHaveBeenCalled();
  });

  it("always uses the session's own company id, never a client-supplied one", async () => {
    completeEmbeddedSignup.mockResolvedValue({
      whatsappAccountId: "account-1",
      whatsappPhoneNumberId: "phone-1",
    });

    await callRoute({
      ...VALID_BODY,
      companyId: "attacker-company",
      company_id: "attacker-company",
    });

    const [, input] = completeEmbeddedSignup.mock.calls[0] ?? [];
    expect(input.companyId).toBe("company-a");
  });

  it("never passes a redirectUri dependency to completeEmbeddedSignup (removed: FB.login()'s popup flow never associates one with the authorization request)", async () => {
    completeEmbeddedSignup.mockResolvedValue({
      whatsappAccountId: "account-1",
      whatsappPhoneNumberId: "phone-1",
    });

    await callRoute(VALID_BODY);

    const [deps] = completeEmbeddedSignup.mock.calls[0] ?? [];
    expect(deps).not.toHaveProperty("redirectUri");
  });

  it("returns 503 without ever exchanging a code when Embedded Signup is not configured", async () => {
    resolveWhatsappEmbeddedSignupServerConfig.mockImplementation(() => {
      throw new FakeWhatsappEmbeddedSignupNotConfiguredError("not configured");
    });

    const response = await callRoute(VALID_BODY);

    expect(response.status).toBe(503);
    expect(completeEmbeddedSignup).not.toHaveBeenCalled();
  });

  it("on success: records an audit log, revalidates the settings page, and returns the new ids -- never a token", async () => {
    completeEmbeddedSignup.mockResolvedValue({
      whatsappAccountId: "account-1",
      whatsappPhoneNumberId: "phone-1",
    });

    const response = await callRoute(VALID_BODY);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("access");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/settings/whatsapp");
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "whatsapp.connected", companyId: "company-a" }),
    );
  });

  it.each([
    ["attempt_not_claimable", 400],
    ["exchange_failed", 502],
    ["token_verification_failed", 400],
    ["graph_verification_failed", 502],
    ["phone_ownership_mismatch", 400],
    ["registration_failed", 400],
    ["subscription_failed", 400],
    ["persistence_failed", 400],
  ])(
    "maps EmbeddedSignupFlowError code %s to HTTP %i, sanitized, and audits the failure",
    async (code, expectedStatus) => {
      completeEmbeddedSignup.mockRejectedValue(
        new FakeEmbeddedSignupFlowError(
          "Meta's raw internal detail, never shown to the user",
          code,
        ),
      );

      const response = await callRoute(VALID_BODY);
      const responseBody = (await response.json()) as { error: string; code: string };

      expect(response.status).toBe(expectedStatus);
      expect(responseBody.code).toBe(code);
      expect(responseBody.error).not.toContain("Meta's raw internal detail");
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "whatsapp.connect_failed",
          metadata: { failureCode: code },
        }),
      );
    },
  );

  it("exchange_failed with provider diagnostics: audits and logs the sanitized detail, but never sends it to the browser", async () => {
    const diagnostics = {
      providerStatus: 400,
      providerErrorCode: "190",
      providerErrorSubcode: "463",
      providerErrorType: "WhatsAppProviderError",
    };
    completeEmbeddedSignup.mockRejectedValue(
      new FakeEmbeddedSignupFlowError(
        "Meta's raw internal detail, never shown to the user",
        "exchange_failed",
        diagnostics,
      ),
    );

    const response = await callRoute(VALID_BODY);
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(responseText).not.toContain("Meta's raw internal detail");
    expect(responseText).not.toContain("providerErrorCode");
    expect(responseText).not.toContain("190");

    expect(logServerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      { companyId: "company-a" },
      expect.objectContaining({
        operation: "whatsapp_signup_complete.exchange_failed",
        ...diagnostics,
      }),
    );

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "whatsapp.connect_failed",
        metadata: { failureCode: "exchange_failed", ...diagnostics },
      }),
    );
  });

  it("exchange_failed without provider diagnostics (e.g. a plain network failure): never calls logServerError for it, and audits failureCode only", async () => {
    completeEmbeddedSignup.mockRejectedValue(
      new FakeEmbeddedSignupFlowError(
        "Meta's raw internal detail, never shown to the user",
        "exchange_failed",
      ),
    );

    await callRoute(VALID_BODY);

    expect(logServerError).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "whatsapp.connect_failed",
        metadata: { failureCode: "exchange_failed" },
      }),
    );
  });

  it("registration_failed with provider diagnostics: audits and logs the sanitized detail (same mechanism as exchange_failed), but never sends it to the browser", async () => {
    const diagnostics = {
      providerStatus: 400,
      providerErrorCode: "133010",
      providerErrorSubcode: "2593109",
      providerErrorType: "WhatsAppProviderError",
    };
    completeEmbeddedSignup.mockRejectedValue(
      new FakeEmbeddedSignupFlowError(
        "Meta's raw internal registration detail, never shown to the user",
        "registration_failed",
        diagnostics,
      ),
    );

    const response = await callRoute(VALID_BODY);
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(responseText).not.toContain("Meta's raw internal registration detail");
    expect(responseText).not.toContain("providerErrorCode");
    expect(responseText).not.toContain("133010");

    expect(logServerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      { companyId: "company-a" },
      expect.objectContaining({
        operation: "whatsapp_signup_complete.registration_failed",
        ...diagnostics,
      }),
    );

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "whatsapp.connect_failed",
        metadata: { failureCode: "registration_failed", ...diagnostics },
      }),
    );
  });

  it("registration_failed without provider diagnostics (e.g. registered.success === false, a 2xx with no error body): never calls logServerError, audits failureCode only", async () => {
    completeEmbeddedSignup.mockRejectedValue(
      new FakeEmbeddedSignupFlowError(
        "Meta's raw internal registration detail, never shown to the user",
        "registration_failed",
      ),
    );

    await callRoute(VALID_BODY);

    expect(logServerError).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "whatsapp.connect_failed",
        metadata: { failureCode: "registration_failed" },
      }),
    );
  });

  it("an unexpected (non-flow) error is logged and returns a generic 500, never the raw exception text", async () => {
    completeEmbeddedSignup.mockRejectedValue(new Error("unexpected database explosion"));

    const response = await callRoute(VALID_BODY);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("unexpected database explosion");
    expect(logServerError).toHaveBeenCalled();
  });
});
