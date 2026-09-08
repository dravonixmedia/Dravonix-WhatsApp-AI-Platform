import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaGraphApiError,
  MetaGraphManagementClient,
  exchangeEmbeddedSignupCode,
  inspectAccessToken,
} from "../src/providers/embeddedSignupProvider.js";
import { WhatsAppProviderError } from "../src/providers/graphApiProvider.js";

const APP_CREDS = { appId: "APP123", appSecret: "SUPER_SECRET_VALUE", graphApiVersion: "v21.0" };

function mockFetchOnce(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("exchangeEmbeddedSignupCode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("success: returns the access token, expiry, and token type Meta actually sent", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        access_token: "EAAG...REAL",
        expires_in: 5183944,
        token_type: "bearer",
      }),
    });

    const result = await exchangeEmbeddedSignupCode({
      ...APP_CREDS,
      code: "AQD_valid_code",
    });

    expect(result).toEqual({
      accessToken: "EAAG...REAL",
      expiresInSeconds: 5183944,
      tokenType: "bearer",
    });
  });

  it("success: never fabricates expiresInSeconds/tokenType when Meta's response omits them", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ access_token: "EAAG...NOEXP" }) });

    const result = await exchangeEmbeddedSignupCode({
      ...APP_CREDS,
      code: "AQD_valid_code",
    });

    expect(result).toEqual({
      accessToken: "EAAG...NOEXP",
      expiresInSeconds: null,
      tokenType: null,
    });
  });

  it("uses POST with a JSON body containing exactly client_id/client_secret/grant_type/code -- no redirect_uri", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ access_token: "EAAG..." }) });

    await exchangeEmbeddedSignupCode({
      ...APP_CREDS,
      code: "AQD_code",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/oauth/access_token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      client_id: "APP123",
      client_secret: "SUPER_SECRET_VALUE",
      grant_type: "authorization_code",
      code: "AQD_code",
    });
    expect(body).not.toHaveProperty("redirect_uri");
  });

  it("never sends redirect_uri even if a caller passes an extra unexpected field with that name", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ access_token: "EAAG..." }) });

    await exchangeEmbeddedSignupCode({
      ...APP_CREDS,
      code: "AQD_code",
      // @ts-expect-error -- redirectUri is intentionally not part of ExchangeEmbeddedSignupCodeInput anymore.
      redirectUri: "https://should-be-ignored.example.test/callback",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("redirect_uri");
    expect(Object.keys(body).sort()).toEqual(["client_id", "client_secret", "code", "grant_type"]);
  });

  it("invalid/expired code: surfaces Meta's error code/subcode via WhatsAppProviderError", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: "This authorization code has been used.",
          code: 100,
          error_subcode: 36007,
        },
      }),
    });

    await expect(
      exchangeEmbeddedSignupCode({
        ...APP_CREDS,
        code: "AQD_expired_code",
      }),
    ).rejects.toMatchObject({
      name: "WhatsAppProviderError",
      status: 400,
      errorCode: "100",
      errorSubcode: "36007",
    });
  });

  it("redirect_uri mismatch (error 100/36008, the real staging incident this fix addresses): surfaces via WhatsAppProviderError", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: "Invalid verification code format.",
          code: 100,
          error_subcode: 36008,
        },
      }),
    });

    await expect(
      exchangeEmbeddedSignupCode({
        ...APP_CREDS,
        code: "AQD_code",
      }),
    ).rejects.toMatchObject({
      name: "WhatsAppProviderError",
      status: 400,
      errorCode: "100",
      errorSubcode: "36008",
    });
  });

  it("also captures Meta's error.type and error.error_data.details (via MetaGraphApiError) -- the fields needed to disambiguate a bare error.code=100 with no subcode", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: "Invalid parameter",
          type: "OAuthException",
          code: 100,
          error_data: {
            details: "A two-step verification PIN is required to register this phone number.",
          },
        },
      }),
    });

    let caught: MetaGraphApiError | undefined;
    try {
      await exchangeEmbeddedSignupCode({ ...APP_CREDS, code: "AQD_code" });
    } catch (error) {
      caught = error as MetaGraphApiError;
    }

    expect(caught).toBeInstanceOf(MetaGraphApiError);
    expect(caught?.name).toBe("WhatsAppProviderError");
    expect(caught?.status).toBe(400);
    expect(caught?.errorCode).toBe("100");
    expect(caught?.errorSubcode).toBeUndefined();
    expect(caught?.metaErrorType).toBe("OAuthException");
    expect(caught?.errorDetail).toBe(
      "A two-step verification PIN is required to register this phone number.",
    );
  });

  it("Meta API failure (network error): throws a generic 502 WhatsAppProviderError, never leaking the underlying cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND graph.facebook.com")),
    );

    await expect(
      exchangeEmbeddedSignupCode({ ...APP_CREDS, code: "AQD_code" }),
    ).rejects.toMatchObject({
      name: "WhatsAppProviderError",
      status: 502,
    });
  });

  it("malformed success response: throws when access_token is missing from a 2xx response", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ token_type: "bearer" }) });

    await expect(exchangeEmbeddedSignupCode({ ...APP_CREDS, code: "AQD_code" })).rejects.toThrow(
      WhatsAppProviderError,
    );
  });

  it("secret-safe error handling: the code and app secret never appear in a thrown error's message", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "generic failure", code: 1 } }),
    });

    try {
      await exchangeEmbeddedSignupCode({
        ...APP_CREDS,
        code: "AQD_TOP_SECRET_CODE_VALUE",
      });
      throw new Error("expected exchangeEmbeddedSignupCode to throw");
    } catch (err) {
      const serialized = JSON.stringify(
        err instanceof Error ? { message: err.message, ...err } : err,
      );
      expect(serialized).not.toContain("AQD_TOP_SECRET_CODE_VALUE");
      expect(serialized).not.toContain(APP_CREDS.appSecret);
    }
  });

  it("never includes the code, app secret, or full request body in a thrown error's message", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "generic failure", code: 1 } }),
    });

    try {
      await exchangeEmbeddedSignupCode({
        ...APP_CREDS,
        code: "AQD_TOP_SECRET_CODE_VALUE",
      });
    } catch (err) {
      expect((err as Error).message).not.toContain("AQD_TOP_SECRET_CODE_VALUE");
      expect((err as Error).message).not.toContain(APP_CREDS.appSecret);
      expect((err as Error).message).toBe("Meta embedded signup code exchange failed");
    }
  });
});

describe("inspectAccessToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("valid token with expiry present: returns isValid/appId/expiresAt/scopes verbatim", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: {
          is_valid: true,
          app_id: "APP123",
          expires_at: 1798000000,
          scopes: ["whatsapp_business_management"],
        },
      }),
    });

    const result = await inspectAccessToken(APP_CREDS, "token-to-inspect");

    expect(result).toEqual({
      isValid: true,
      appId: "APP123",
      expiresAt: 1798000000,
      scopes: ["whatsapp_business_management"],
    });
  });

  it("expiry absent: returns expiresAt: null rather than fabricating a value", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ data: { is_valid: true, app_id: "APP123", scopes: [] } }),
    });

    const result = await inspectAccessToken(APP_CREDS, "token-to-inspect");

    expect(result.expiresAt).toBeNull();
  });

  it("invalid token: reports isValid: false without throwing", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ data: { is_valid: false, app_id: "APP123", scopes: [] } }),
    });

    const result = await inspectAccessToken(APP_CREDS, "revoked-token");

    expect(result.isValid).toBe(false);
  });

  it("wrong app id: the caller receives the token's actual app_id for comparison rather than this function silently rejecting it", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ data: { is_valid: true, app_id: "SOME_OTHER_APP", scopes: [] } }),
    });

    const result = await inspectAccessToken(APP_CREDS, "wrong-app-token");

    expect(result.appId).toBe("SOME_OTHER_APP");
    expect(result.appId).not.toBe(APP_CREDS.appId);
  });

  it("malformed response: throws when data.is_valid is missing", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ data: {} }) });

    await expect(inspectAccessToken(APP_CREDS, "token")).rejects.toThrow(WhatsAppProviderError);
  });

  it("secret-safe error handling: the inspected token and app secret never appear in a thrown error", async () => {
    mockFetchOnce({ ok: false, status: 400, json: async () => ({ error: { code: 190 } }) });

    try {
      await inspectAccessToken(APP_CREDS, "TOP_SECRET_TOKEN_VALUE");
      throw new Error("expected inspectAccessToken to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("TOP_SECRET_TOKEN_VALUE");
      expect((err as Error).message).not.toContain(APP_CREDS.appSecret);
    }
  });
});

describe("MetaGraphManagementClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new MetaGraphManagementClient({ accessToken: "bearer-token", graphApiVersion: "v21.0" });

  describe("getWhatsAppBusinessAccount", () => {
    it("valid metadata: returns typed WABA fields", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          id: "WABA1",
          name: "Acme Co",
          currency: "USD",
          timezone_id: "1",
          message_template_namespace: "abc123",
        }),
      });

      const result = await client().getWhatsAppBusinessAccount("WABA1");

      expect(result).toEqual({
        id: "WABA1",
        name: "Acme Co",
        currency: "USD",
        timezoneId: "1",
        messageTemplateNamespace: "abc123",
      });
    });

    it("inaccessible WABA: surfaces Meta's error code via WhatsAppProviderError", async () => {
      mockFetchOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: { message: "Unsupported request", code: 100, error_subcode: 33 },
        }),
      });

      await expect(client().getWhatsAppBusinessAccount("WABA_NO_ACCESS")).rejects.toMatchObject({
        status: 403,
        errorCode: "100",
      });
    });

    it("malformed response: throws when id is missing", async () => {
      mockFetchOnce({ ok: true, json: async () => ({ name: "Acme Co" }) });

      await expect(client().getWhatsAppBusinessAccount("WABA1")).rejects.toThrow(
        WhatsAppProviderError,
      );
    });
  });

  describe("getPhoneNumbersForWaba / verifyPhoneBelongsToWaba", () => {
    it("valid phone: returns typed phone metadata", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "PHONE1",
              display_phone_number: "+1 555 000 1111",
              verified_name: "Acme Co",
              quality_rating: "GREEN",
            },
          ],
        }),
      });

      const result = await client().getPhoneNumbersForWaba("WABA1");

      expect(result).toEqual([
        {
          id: "PHONE1",
          displayPhoneNumber: "+1 555 000 1111",
          verifiedName: "Acme Co",
          qualityRating: "GREEN",
        },
      ]);
    });

    it("phone belongs to expected WABA: verifyPhoneBelongsToWaba returns true using Meta's own relationship, not a trusted ID", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ data: [{ id: "PHONE1", display_phone_number: "+1 555 000 1111" }] }),
      });

      const belongs = await client().verifyPhoneBelongsToWaba("WABA1", "PHONE1");

      expect(belongs).toBe(true);
    });

    it("phone does NOT belong to expected WABA: verifyPhoneBelongsToWaba returns false even though the phone ID exists elsewhere", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "SOME_OTHER_PHONE", display_phone_number: "+1 555 999 9999" }],
        }),
      });

      const belongs = await client().verifyPhoneBelongsToWaba("WABA1", "PHONE_ATTACKER_CLAIMS");

      expect(belongs).toBe(false);
    });

    it("inaccessible phone list: propagates the Meta error rather than treating it as 'does not belong'", async () => {
      mockFetchOnce({ ok: false, status: 403, json: async () => ({ error: { code: 100 } }) });

      await expect(client().verifyPhoneBelongsToWaba("WABA1", "PHONE1")).rejects.toThrow(
        WhatsAppProviderError,
      );
    });

    it("malformed response: throws when the phone list is not an array", async () => {
      mockFetchOnce({ ok: true, json: async () => ({ notData: [] }) });

      await expect(client().getPhoneNumbersForWaba("WABA1")).rejects.toThrow(WhatsAppProviderError);
    });
  });

  describe("registerPhoneNumber", () => {
    it("success without a pin: sends messaging_product only when no pin is supplied", async () => {
      const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ success: true }) });

      const result = await client().registerPhoneNumber("PHONE1");

      expect(result).toEqual({ success: true });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ messaging_product: "whatsapp" });
    });

    it("success with a pin: passes the caller-supplied pin through verbatim, never inventing one", async () => {
      const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ success: true }) });

      await client().registerPhoneNumber("PHONE1", "123456");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        messaging_product: "whatsapp",
        pin: "123456",
      });
    });

    it("already-registered / PIN-required error: the caller receives Meta's own error code rather than this function guessing", async () => {
      mockFetchOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: "two step verification pin required", code: 133010 },
        }),
      });

      await expect(client().registerPhoneNumber("PHONE1")).rejects.toMatchObject({
        status: 400,
        errorCode: "133010",
      });
    });

    it("idempotent retry: calling register again after a success is not special-cased -- it simply reflects Meta's response", async () => {
      mockFetchOnce({ ok: true, json: async () => ({ success: true }) });

      const first = await client().registerPhoneNumber("PHONE1", "123456");
      const second = await client().registerPhoneNumber("PHONE1", "123456");

      expect(first).toEqual({ success: true });
      expect(second).toEqual({ success: true });
    });

    it("the pin is never logged/thrown in an error message", async () => {
      mockFetchOnce({ ok: false, status: 400, json: async () => ({ error: { code: 1 } }) });

      try {
        await client().registerPhoneNumber("PHONE1", "999999");
      } catch (err) {
        expect((err as Error).message).not.toContain("999999");
      }
    });

    it("captures Meta's error.type and error.error_data.details as MetaGraphApiError fields -- the detail needed to disambiguate a bare code=100 (e.g. whether a PIN is actually required)", async () => {
      mockFetchOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Invalid parameter",
            type: "OAuthException",
            code: 100,
            error_data: {
              messaging_product: "whatsapp",
              details: "A two-step verification PIN is required to register this phone number.",
            },
          },
        }),
      });

      let caught: MetaGraphApiError | undefined;
      try {
        await client().registerPhoneNumber("PHONE1");
      } catch (error) {
        caught = error as MetaGraphApiError;
      }

      expect(caught).toBeInstanceOf(MetaGraphApiError);
      expect(caught?.errorCode).toBe("100");
      expect(caught?.metaErrorType).toBe("OAuthException");
      expect(caught?.errorDetail).toBe(
        "A two-step verification PIN is required to register this phone number.",
      );
      // Only `details` is read out of error_data -- no other sub-field is captured or logged.
      expect(Object.keys(caught ?? {})).not.toContain("messaging_product");
    });
  });

  describe("subscribeAppToWaba / verifyAppSubscription", () => {
    it("success: reports Meta's success field", async () => {
      mockFetchOnce({ ok: true, json: async () => ({ success: true }) });

      const result = await client().subscribeAppToWaba("WABA1");

      expect(result).toEqual({ success: true });
    });

    it("already-subscribed behavior: a repeat subscribe call is not special-cased -- it simply reflects Meta's (documented no-op-safe) response", async () => {
      mockFetchOnce({ ok: true, json: async () => ({ success: true }) });

      const first = await client().subscribeAppToWaba("WABA1");
      const second = await client().subscribeAppToWaba("WABA1");

      expect(first).toEqual({ success: true });
      expect(second).toEqual({ success: true });
    });

    it("verification success: verifyAppSubscription finds the expected app id in the subscribed list", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({
          data: [{ whatsapp_business_api_data: { id: "APP123", name: "Dravonix" } }],
        }),
      });

      const result = await client().verifyAppSubscription("WABA1", "APP123");

      expect(result).toEqual({ subscribed: true, subscribedAppIds: ["APP123"] });
    });

    it("verification failure: reports subscribed: false when the expected app id is absent", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ data: [{ whatsapp_business_api_data: { id: "SOME_OTHER_APP" } }] }),
      });

      const result = await client().verifyAppSubscription("WABA1", "APP123");

      expect(result).toEqual({ subscribed: false, subscribedAppIds: ["SOME_OTHER_APP"] });
    });

    it("relevant Meta error: subscribing propagates a permission error rather than reporting false success", async () => {
      mockFetchOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "Missing permission", code: 200 } }),
      });

      await expect(client().subscribeAppToWaba("WABA1")).rejects.toMatchObject({
        status: 403,
        errorCode: "200",
      });
    });
  });

  describe("security: raw Graph error payloads never escape through a sanitized error", () => {
    it("a Meta error body containing extra fields never surfaces beyond code/subcode", async () => {
      mockFetchOnce({
        ok: false,
        status: 401,
        json: async () => ({
          error: {
            message:
              "Invalid OAuth access token - Cannot parse access token EAAG_LEAKED_TOKEN_VALUE",
            code: 190,
            error_subcode: 463,
            fbtrace_id: "AbCdEfGhIjK",
          },
        }),
      });

      try {
        await client().getWhatsAppBusinessAccount("WABA1");
        throw new Error("expected getWhatsAppBusinessAccount to throw");
      } catch (err) {
        const error = err as InstanceType<typeof WhatsAppProviderError>;
        expect(error.errorCode).toBe("190");
        expect(error.errorSubcode).toBe("463");
        expect(error.message).not.toContain("EAAG_LEAKED_TOKEN_VALUE");
        expect(error.message).not.toContain("fbtrace_id");
        expect(Object.keys(error)).not.toContain("fbtrace_id");
      }
    });

    it("the configured bearer access token is never present in any thrown error", async () => {
      mockFetchOnce({ ok: false, status: 401, json: async () => ({ error: { code: 190 } }) });

      const config = { accessToken: "TOP_SECRET_BEARER_TOKEN", graphApiVersion: "v21.0" };
      try {
        await new MetaGraphManagementClient(config).getWhatsAppBusinessAccount("WABA1");
      } catch (err) {
        expect((err as Error).message).not.toContain("TOP_SECRET_BEARER_TOKEN");
      }
    });
  });
});
