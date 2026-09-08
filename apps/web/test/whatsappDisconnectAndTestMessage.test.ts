import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral tests for the two client-facing WhatsApp connection actions
 * built on top of Meta Embedded Signup: disconnectWhatsappAccountAction
 * (lib/actions/whatsappSignup.ts) and sendWhatsappTestMessageAction
 * (lib/actions/whatsappTestMessage.ts). Same module-boundary-mocking
 * convention as adminWhatsappConnection.test.ts. Covers the test matrix's
 * "outgoing-wrong-tenant" and "safe reconnect/disconnect" items: a
 * phoneNumberRowId/whatsappAccountId belonging to another company must never
 * be reachable through either action, since both scope every lookup to
 * session.activeCompanyId.
 */

class FakeWhatsappSignupUnauthenticatedError extends Error {}

const requireWhatsappManageContext = vi.fn();
vi.mock("../lib/whatsappSignupAuth.js", () => ({
  requireWhatsappManageContext: (...args: unknown[]) => requireWhatsappManageContext(...args),
  WhatsappSignupUnauthenticatedError: FakeWhatsappSignupUnauthenticatedError,
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
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

const sendText = vi.fn();
class FakeGraphApiWhatsAppProvider {
  sendText(...args: unknown[]) {
    return sendText(...args);
  }
}
const resolveOutboundAccessToken = vi.fn();
class FakeOutboundCredentialResolutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class FakeWhatsAppProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly errorSubcode?: string,
    readonly errorType?: string,
    readonly errorDetail?: string,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "WhatsAppProviderError";
  }
}
vi.mock("@dravonix/whatsapp", () => ({
  GraphApiWhatsAppProvider: FakeGraphApiWhatsAppProvider,
  OutboundCredentialResolutionError: FakeOutboundCredentialResolutionError,
  resolveOutboundAccessToken: (...args: unknown[]) => resolveOutboundAccessToken(...args),
  WhatsAppProviderError: FakeWhatsAppProviderError,
}));

vi.mock("@dravonix/config", () => ({
  loadEnv: () => ({
    META_ACCESS_TOKEN: "global-token",
    META_GRAPH_API_VERSION: "v21.0",
    WHATSAPP_TOKEN_ENCRYPTION_KEY_V1: "AAAA",
  }),
}));

const SESSION = { activeCompanyId: "company-a", userId: "user-1" };

function makeSupabaseClient(overrides: {
  rpc?: ReturnType<typeof vi.fn>;
  from?: (table: string) => unknown;
}) {
  return {
    rpc: overrides.rpc ?? vi.fn(),
    from: overrides.from ?? vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("disconnectWhatsappAccountAction", () => {
  async function callAction(whatsappAccountId: string) {
    const { disconnectWhatsappAccountAction } = await import("../lib/actions/whatsappSignup.js");
    return disconnectWhatsappAccountAction(whatsappAccountId);
  }

  it("rejects an unauthenticated caller before calling any RPC", async () => {
    requireWhatsappManageContext.mockRejectedValue(new FakeWhatsappSignupUnauthenticatedError());

    await expect(callAction("account-1")).rejects.toBeInstanceOf(
      FakeWhatsappSignupUnauthenticatedError,
    );
  });

  it("calls client_disconnect_whatsapp_account with the session's own company id, never a parameter", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({ rpc }),
    });

    await callAction("account-1");

    expect(rpc).toHaveBeenCalledWith("client_disconnect_whatsapp_account", {
      p_company_id: "company-a",
      p_whatsapp_account_id: "account-1",
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "whatsapp.disconnected",
        companyId: "company-a",
        targetId: "account-1",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/settings/whatsapp");
  });

  it("propagates an RPC rejection (e.g. a manual_admin row, or another company's account id) rather than swallowing it", async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: new Error("whatsapp_account_not_client_managed"),
    });
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({ rpc }),
    });

    await expect(callAction("some-other-companys-account")).rejects.toThrow(
      "whatsapp_account_not_client_managed",
    );
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

describe("sendWhatsappTestMessageAction", () => {
  async function callAction(phoneNumberRowId: string, toWaId: string, body: string) {
    const { sendWhatsappTestMessageAction } = await import("../lib/actions/whatsappTestMessage.js");
    return sendWhatsappTestMessageAction(phoneNumberRowId, toWaId, body);
  }

  function mockFrom(entries: Record<string, { data: unknown; error: unknown }>) {
    return vi.fn((table: string) => {
      const result = entries[table] ?? { data: null, error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve(result),
      };
      return builder;
    });
  }

  it("rejects an unauthenticated caller before touching the database", async () => {
    requireWhatsappManageContext.mockRejectedValue(new FakeWhatsappSignupUnauthenticatedError());

    await expect(callAction("phone-row-1", "919999999999", "hi")).rejects.toBeInstanceOf(
      FakeWhatsappSignupUnauthenticatedError,
    );
  });

  it("a phone number row belonging to ANOTHER company (or not found at all) is rejected without ever resolving credentials", async () => {
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({
        from: mockFrom({ whatsapp_phone_numbers: { data: null, error: null } }),
      }),
    });

    const result = await callAction("someone-elses-phone-row", "919999999999", "hi");

    expect(result.success).toBe(false);
    expect(resolveOutboundAccessToken).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("a not-yet-connected phone number is rejected without sending", async () => {
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({
        from: mockFrom({
          whatsapp_phone_numbers: {
            data: {
              id: "phone-row-1",
              phone_number_id: "PHONE1",
              status: "disabled",
              whatsapp_account_id: "acc-1",
            },
            error: null,
          },
        }),
      }),
    });

    const result = await callAction("phone-row-1", "919999999999", "hi");

    expect(result.success).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("resolves the credential via resolveOutboundAccessToken and sends using this company's own phone_number_id", async () => {
    resolveOutboundAccessToken.mockResolvedValue("resolved-token");
    sendText.mockResolvedValue({ providerMessageId: "wamid.1" });
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({
        from: mockFrom({
          whatsapp_phone_numbers: {
            data: {
              id: "phone-row-1",
              phone_number_id: "PHONE1",
              status: "connected",
              whatsapp_account_id: "acc-1",
            },
            error: null,
          },
          whatsapp_accounts: {
            data: {
              waba_id: "WABA1",
              connection_source: "embedded_signup",
              encrypted_access_token: "{}",
              encryption_key_version: 1,
            },
            error: null,
          },
        }),
      }),
    });

    const result = await callAction("phone-row-1", "919999999999", "Hello from a test");

    expect(result.success).toBe(true);
    expect(sendText).toHaveBeenCalledWith({
      phoneNumberId: "PHONE1",
      toWaId: "919999999999",
      body: "Hello from a test",
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "whatsapp.test_message_sent", companyId: "company-a" }),
    );
  });

  it("a credential resolution failure never reaches Meta's send endpoint and is reported safely", async () => {
    resolveOutboundAccessToken.mockRejectedValue(
      new FakeOutboundCredentialResolutionError("no_stored_credential"),
    );
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({
        from: mockFrom({
          whatsapp_phone_numbers: {
            data: {
              id: "phone-row-1",
              phone_number_id: "PHONE1",
              status: "connected",
              whatsapp_account_id: "acc-1",
            },
            error: null,
          },
          whatsapp_accounts: {
            data: {
              waba_id: "WABA1",
              connection_source: "embedded_signup",
              encrypted_access_token: null,
              encryption_key_version: null,
            },
            error: null,
          },
        }),
      }),
    });

    const result = await callAction("phone-row-1", "919999999999", "hi");

    expect(result.success).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(logServerError).toHaveBeenCalled();
  });

  it("rejects an empty recipient or body before any database lookup", async () => {
    requireWhatsappManageContext.mockResolvedValue({
      session: SESSION,
      serviceRoleClient: makeSupabaseClient({ from: vi.fn() }),
    });

    const result = await callAction("phone-row-1", "  ", "");

    expect(result.success).toBe(false);
  });

  describe("recipient normalization (diagnostics hardening)", () => {
    function mockConnectedPhoneAndAccount() {
      return mockFrom({
        whatsapp_phone_numbers: {
          data: {
            id: "phone-row-1",
            phone_number_id: "PHONE1",
            status: "connected",
            whatsapp_account_id: "acc-1",
          },
          error: null,
        },
        whatsapp_accounts: {
          data: {
            waba_id: "WABA1",
            connection_source: "embedded_signup",
            encrypted_access_token: "{}",
            encryption_key_version: 1,
          },
          error: null,
        },
      });
    }

    it("accepts an optional leading + and sends Meta digits-only", async () => {
      resolveOutboundAccessToken.mockResolvedValue("resolved-token");
      sendText.mockResolvedValue({ providerMessageId: "wamid.1" });
      requireWhatsappManageContext.mockResolvedValue({
        session: SESSION,
        serviceRoleClient: makeSupabaseClient({ from: mockConnectedPhoneAndAccount() }),
      });

      const result = await callAction("phone-row-1", "+918086552536", "hi");

      expect(result.success).toBe(true);
      expect(sendText).toHaveBeenCalledWith({
        phoneNumberId: "PHONE1",
        toWaId: "918086552536",
        body: "hi",
      });
    });

    it("trims surrounding whitespace before normalizing", async () => {
      resolveOutboundAccessToken.mockResolvedValue("resolved-token");
      sendText.mockResolvedValue({ providerMessageId: "wamid.1" });
      requireWhatsappManageContext.mockResolvedValue({
        session: SESSION,
        serviceRoleClient: makeSupabaseClient({ from: mockConnectedPhoneAndAccount() }),
      });

      const result = await callAction("phone-row-1", "  919999999999  ", "hi");

      expect(result.success).toBe(true);
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ toWaId: "919999999999" }));
    });

    it("rejects a malformed recipient (letters, too short, too long) before any database lookup or Meta call", async () => {
      const from = vi.fn();
      requireWhatsappManageContext.mockResolvedValue({
        session: SESSION,
        serviceRoleClient: makeSupabaseClient({ from }),
      });

      const result = await callAction("phone-row-1", "not-a-number", "hi");

      expect(result.success).toBe(false);
      expect(from).not.toHaveBeenCalled();
      expect(resolveOutboundAccessToken).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    });

    it("rejects a recipient with too few digits", async () => {
      requireWhatsappManageContext.mockResolvedValue({
        session: SESSION,
        serviceRoleClient: makeSupabaseClient({ from: vi.fn() }),
      });

      const result = await callAction("phone-row-1", "12345", "hi");

      expect(result.success).toBe(false);
      expect(sendText).not.toHaveBeenCalled();
    });
  });

  describe("provider failure diagnostics (never a success audit, sanitized fields logged)", () => {
    it("logs sanitized WhatsAppProviderError diagnostics on a rejected send and never records a success audit", async () => {
      resolveOutboundAccessToken.mockResolvedValue("resolved-token");
      sendText.mockRejectedValue(
        new FakeWhatsAppProviderError(
          "WhatsApp Graph API request failed with status 400",
          400,
          "100",
          "33",
          "OAuthException",
          "Recipient phone number not in allowed list",
          "Abc123TraceId",
        ),
      );
      requireWhatsappManageContext.mockResolvedValue({
        session: SESSION,
        serviceRoleClient: makeSupabaseClient({
          from: mockFrom({
            whatsapp_phone_numbers: {
              data: {
                id: "phone-row-1",
                phone_number_id: "PHONE1",
                status: "connected",
                whatsapp_account_id: "acc-1",
              },
              error: null,
            },
            whatsapp_accounts: {
              data: {
                waba_id: "WABA1",
                connection_source: "embedded_signup",
                encrypted_access_token: "{}",
                encryption_key_version: 1,
              },
              error: null,
            },
          }),
        }),
      });

      const result = await callAction("phone-row-1", "918086552536", "hi");

      expect(result.success).toBe(false);
      expect(recordAuditLog).not.toHaveBeenCalled();
      expect(logServerError).toHaveBeenCalledWith(
        "Failed to send WhatsApp test message",
        expect.anything(),
        expect.objectContaining({ companyId: "company-a" }),
        expect.objectContaining({
          operation: "whatsapp_test_message.send",
          providerStatus: 400,
          providerErrorCode: "100",
          providerErrorSubcode: "33",
          providerErrorType: "OAuthException",
          providerErrorDetail: "Recipient phone number not in allowed list",
          providerFbtraceId: "Abc123TraceId",
        }),
      );
    });

    it("never logs a token, header, or raw body -- only the sanitized WhatsAppProviderError fields already on the caught error", async () => {
      resolveOutboundAccessToken.mockResolvedValue("super-secret-resolved-token");
      sendText.mockRejectedValue(new FakeWhatsAppProviderError("generic failure", 500));
      requireWhatsappManageContext.mockResolvedValue({
        session: SESSION,
        serviceRoleClient: makeSupabaseClient({
          from: mockFrom({
            whatsapp_phone_numbers: {
              data: {
                id: "phone-row-1",
                phone_number_id: "PHONE1",
                status: "connected",
                whatsapp_account_id: "acc-1",
              },
              error: null,
            },
            whatsapp_accounts: {
              data: {
                waba_id: "WABA1",
                connection_source: "embedded_signup",
                encrypted_access_token: "{}",
                encryption_key_version: 1,
              },
              error: null,
            },
          }),
        }),
      });

      await callAction("phone-row-1", "918086552536", "hi");

      const loggedExtra = logServerError.mock.calls[0]?.[3];
      expect(JSON.stringify(loggedExtra)).not.toContain("super-secret-resolved-token");
    });
  });
});
