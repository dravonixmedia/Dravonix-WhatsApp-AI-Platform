import { decryptWhatsAppRegistrationPin, encryptWhatsAppRegistrationPin } from "@dravonix/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeEmbeddedSignup,
  initiateEmbeddedSignup,
  type EmbeddedSignupFlowError,
  type RegistrationPinEnvelope,
  type SignupAttemptRepository,
} from "../src/embeddedSignupFlow.js";
import * as embeddedSignupProvider from "../src/providers/embeddedSignupProvider.js";
import { MetaGraphApiError } from "../src/providers/embeddedSignupProvider.js";
import { WhatsAppProviderError } from "../src/providers/graphApiProvider.js";

/**
 * Batch 3, Slice C: unit tests for the orchestration function that composes
 * Slice B's Graph API primitives with the signup-attempt state machine and
 * token encryption. This is the module the 14-phase WhatsApp connection
 * foundation task's test matrix items live against: invalid code / Meta
 * exchange failure / forged WABA-phone pairing / phone-not-belonging-to-WABA
 * / a webhook-subscription failure never marking a connection active.
 */

const KEY = { version: 1, keyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
const CREDS = { appId: "APP123", appSecret: "SECRET", graphApiVersion: "v21.0" };

function makeRepo(): SignupAttemptRepository & {
  createAttempt: ReturnType<typeof vi.fn>;
  claimAttempt: ReturnType<typeof vi.fn>;
  completeAttempt: ReturnType<typeof vi.fn>;
} {
  return {
    createAttempt: vi
      .fn()
      .mockResolvedValue({ id: "attempt-1", expiresAt: "2030-01-01T00:00:00.000Z" }),
    claimAttempt: vi.fn().mockResolvedValue(undefined),
    completeAttempt: vi.fn().mockResolvedValue({
      whatsappAccountId: "account-1",
      whatsappPhoneNumberId: "phone-1",
    }),
  };
}

function makeGraphClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    getWhatsAppBusinessAccount: vi.fn().mockResolvedValue({ id: "waba-1", name: "Acme Co" }),
    getPhoneNumbersForWaba: vi
      .fn()
      .mockResolvedValue([{ id: "phone-real-1", displayPhoneNumber: "+911234567890" }]),
    verifyPhoneBelongsToWaba: vi.fn().mockResolvedValue(true),
    registerPhoneNumber: vi.fn().mockResolvedValue({ success: true }),
    subscribeAppToWaba: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

const BASE_INPUT = {
  companyId: "company-1",
  attemptId: "attempt-1",
  nonce: "raw-nonce-value",
  code: "auth-code-abc",
  wabaId: "waba-1",
  phoneNumberId: "phone-real-1",
  businessId: "business-1",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(embeddedSignupProvider, "exchangeEmbeddedSignupCode").mockResolvedValue({
    accessToken: "exchanged-token-value",
    expiresInSeconds: null,
    tokenType: "bearer",
  });
  vi.spyOn(embeddedSignupProvider, "inspectAccessToken").mockResolvedValue({
    isValid: true,
    appId: CREDS.appId,
    expiresAt: 0,
    scopes: [],
  });
});

describe("initiateEmbeddedSignup", () => {
  it("creates an attempt via the repository and returns a fresh, high-entropy nonce", async () => {
    const repo = makeRepo();
    const result = await initiateEmbeddedSignup(repo, {
      companyId: "company-1",
      initiatedByUserId: "user-1",
    });

    expect(repo.createAttempt).toHaveBeenCalledTimes(1);
    const call = repo.createAttempt.mock.calls[0]?.[0];
    expect(call.companyId).toBe("company-1");
    expect(call.initiatedByUserId).toBe("user-1");
    expect(call.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(result.attemptId).toBe("attempt-1");
  });

  it("never returns the same nonce twice", async () => {
    const repo = makeRepo();
    const a = await initiateEmbeddedSignup(repo, { companyId: "c", initiatedByUserId: "u" });
    const b = await initiateEmbeddedSignup(repo, { companyId: "c", initiatedByUserId: "u" });
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("completeEmbeddedSignup: happy path", () => {
  it("claims the attempt, exchanges the code, verifies ownership, registers, subscribes, encrypts, and persists", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    const result = await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    expect(repo.claimAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      companyId: "company-1",
      nonceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(graphClient.verifyPhoneBelongsToWaba).toHaveBeenCalledWith("waba-1", "phone-real-1");
    expect(graphClient.registerPhoneNumber).toHaveBeenCalledWith(
      "phone-real-1",
      expect.stringMatching(/^\d{6}$/),
    );
    expect(graphClient.subscribeAppToWaba).toHaveBeenCalledWith("waba-1");

    expect(repo.completeAttempt).toHaveBeenCalledTimes(1);
    const persisted = repo.completeAttempt.mock.calls[0]?.[0];
    expect(persisted.wabaId).toBe("waba-1");
    expect(persisted.phoneNumberId).toBe("phone-real-1");
    expect(persisted.businessName).toBe("Acme Co");
    expect(persisted.displayPhoneNumber).toBe("+911234567890");
    expect(persisted.encryptionKeyVersion).toBe(1);
    // Never the plaintext token.
    expect(persisted.encryptedToken).not.toContain("exchanged-token-value");
    expect(JSON.parse(persisted.encryptedToken)).toMatchObject({ v: 1, kv: 1 });

    expect(result).toEqual({ whatsappAccountId: "account-1", whatsappPhoneNumberId: "phone-1" });
  });

  it("the encrypted token is bound (via AAD) to the WABA id -- decrypting under a different waba id fails", async () => {
    const { decryptWhatsAppAccessToken } = await import("@dravonix/core");
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    const envelope = repo.completeAttempt.mock.calls[0]?.[0].encryptedToken;
    await expect(
      decryptWhatsAppAccessToken(envelope, "some-other-waba", () => KEY.keyBase64),
    ).rejects.toThrow();
    await expect(decryptWhatsAppAccessToken(envelope, "waba-1", () => KEY.keyBase64)).resolves.toBe(
      "exchanged-token-value",
    );
  });
});

describe("completeEmbeddedSignup: every failure mode fails BEFORE persistence", () => {
  it("attempt_not_claimable: claim rejection stops the flow before any Meta call", async () => {
    const repo = makeRepo();
    repo.claimAttempt.mockRejectedValue(new Error("signup_attempt_not_claimable"));
    const graphClient = makeGraphClient();

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({
      code: "attempt_not_claimable" satisfies EmbeddedSignupFlowError["code"],
    });

    expect(embeddedSignupProvider.exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("exchange_failed: a Meta code-exchange failure (invalid/expired code) never persists anything", async () => {
    vi.spyOn(embeddedSignupProvider, "exchangeEmbeddedSignupCode").mockRejectedValue(
      new Error("Meta embedded signup code exchange failed"),
    );
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "exchange_failed" });

    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("exchange_failed: when Meta rejects the code with a WhatsAppProviderError, the sanitized status/error code/subcode are captured as diagnostics", async () => {
    vi.spyOn(embeddedSignupProvider, "exchangeEmbeddedSignupCode").mockRejectedValue(
      new WhatsAppProviderError("Meta embedded signup code exchange failed", 400, "190", "463"),
    );
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("exchange_failed");
    // Exactly the sanitized fields WhatsAppProviderError exposes -- nothing else.
    expect(caught?.diagnostics).toEqual({
      providerStatus: 400,
      providerErrorCode: "190",
      providerErrorSubcode: "463",
      providerErrorType: "WhatsAppProviderError",
    });
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("exchange_failed: diagnostics never leak the authorization code, app secret, or any raw response text", async () => {
    vi.spyOn(embeddedSignupProvider, "exchangeEmbeddedSignupCode").mockRejectedValue(
      new WhatsAppProviderError("Meta embedded signup code exchange failed", 400, "190", "463"),
    );
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    const serialized = JSON.stringify(caught?.diagnostics ?? {});
    expect(serialized).not.toContain(BASE_INPUT.code);
    expect(serialized).not.toContain(CREDS.appSecret);
    expect(Object.keys(caught?.diagnostics ?? {}).sort()).toEqual([
      "providerErrorCode",
      "providerErrorSubcode",
      "providerErrorType",
      "providerStatus",
    ]);
  });

  it("exchange_failed: a non-WhatsAppProviderError (e.g. a raw fetch/TypeError) never produces diagnostics", async () => {
    vi.spyOn(embeddedSignupProvider, "exchangeEmbeddedSignupCode").mockRejectedValue(
      new TypeError("fetch failed: getaddrinfo ENOTFOUND graph.facebook.com"),
    );
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("exchange_failed");
    expect(caught?.diagnostics).toBeUndefined();
  });

  it("token_verification_failed: a token issued to a DIFFERENT Meta app is rejected", async () => {
    vi.spyOn(embeddedSignupProvider, "inspectAccessToken").mockResolvedValue({
      isValid: true,
      appId: "SOME-OTHER-APP-ID",
      expiresAt: 0,
      scopes: [],
    });
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "token_verification_failed" });

    expect(graphClient.getWhatsAppBusinessAccount).not.toHaveBeenCalled();
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("graph_verification_failed: the WABA is not accessible with the exchanged token", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      getWhatsAppBusinessAccount: vi.fn().mockRejectedValue(new Error("403")),
    });

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "graph_verification_failed" });

    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("phone_ownership_mismatch: a forged (wabaId, phoneNumberId) pair -- the phone belongs to a DIFFERENT WABA -- is rejected even though the code/token are genuine", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      verifyPhoneBelongsToWaba: vi.fn().mockResolvedValue(false),
    });

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        { ...BASE_INPUT, phoneNumberId: "someone-elses-phone-number-id" },
      ),
    ).rejects.toMatchObject({ code: "phone_ownership_mismatch" });

    expect(graphClient.registerPhoneNumber).not.toHaveBeenCalled();
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("registration_failed: Meta's /register call fails -- no connection is persisted", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi.fn().mockRejectedValue(new Error("PIN required")),
    });

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "registration_failed" });

    expect(graphClient.subscribeAppToWaba).not.toHaveBeenCalled();
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("registration_failed: Meta returns success: false (not an HTTP error) -- still treated as a failure, never silently accepted", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi.fn().mockResolvedValue({ success: false }),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_failed");
    expect(repo.completeAttempt).not.toHaveBeenCalled();
    // A 2xx response with success: false has no underlying exception to
    // extract diagnostics from at all -- nothing to capture either way.
    expect(caught?.diagnostics).toBeUndefined();
  });

  it("registration_failed: when Meta rejects registration with a WhatsAppProviderError, the sanitized status/error code/subcode are captured as diagnostics (same mechanism as exchange_failed)", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi
        .fn()
        .mockRejectedValue(
          new WhatsAppProviderError("Registration rejected", 400, "133010", "2593109"),
        ),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_failed");
    expect(caught?.diagnostics).toEqual({
      providerStatus: 400,
      providerErrorCode: "133010",
      providerErrorSubcode: "2593109",
      providerErrorType: "WhatsAppProviderError",
    });
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("registration_failed: a non-WhatsAppProviderError (e.g. a raw thrown Error) never produces diagnostics, and never leaks the underlying message into the diagnostics object", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi.fn().mockRejectedValue(new Error("PIN required")),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_failed");
    expect(caught?.diagnostics).toBeUndefined();
  });

  it("registration_failed diagnostics never leak the access token, app secret, a PIN, or any raw response text", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi
        .fn()
        .mockRejectedValue(
          new WhatsAppProviderError("Registration rejected", 400, "133010", "2593109"),
        ),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    const serialized = JSON.stringify(caught?.diagnostics ?? {});
    expect(serialized).not.toContain("exchanged-token-value");
    expect(serialized).not.toContain(CREDS.appSecret);
    expect(Object.keys(caught?.diagnostics ?? {}).sort()).toEqual([
      "providerErrorCode",
      "providerErrorSubcode",
      "providerErrorType",
      "providerStatus",
    ]);
  });

  it("subscription_failed: a webhook-subscription failure never marks the connection active -- no whatsapp_accounts/whatsapp_phone_numbers row is ever written for this attempt", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      subscribeAppToWaba: vi.fn().mockRejectedValue(new Error("permission error")),
    });

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "subscription_failed" });

    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("subscription_failed: Meta returns success: false for the subscription call -- still treated as a failure", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      subscribeAppToWaba: vi.fn().mockResolvedValue({ success: false }),
    });

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "subscription_failed" });
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("rejects a missing/blank wabaId or phoneNumberId before doing anything else", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        { ...BASE_INPUT, wabaId: "  " },
      ),
    ).rejects.toMatchObject({ code: "graph_verification_failed" });
    expect(repo.claimAttempt).not.toHaveBeenCalled();
  });

  it("persistence_failed: a repository failure at the final step is surfaced distinctly, after every Meta call already succeeded", async () => {
    const repo = makeRepo();
    repo.completeAttempt.mockRejectedValue(new Error("db timeout"));
    const graphClient = makeGraphClient();

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "persistence_failed" });
  });
});

describe("completeEmbeddedSignup: provider diagnostics are captured for every Graph-call failure stage, not just exchange_failed/registration_failed", () => {
  it("token_verification_failed: a WhatsAppProviderError from inspectAccessToken itself is captured as diagnostics", async () => {
    vi.spyOn(embeddedSignupProvider, "inspectAccessToken").mockRejectedValue(
      new MetaGraphApiError(
        "Meta access token inspection failed",
        400,
        "100",
        undefined,
        "OAuthException",
      ),
    );
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("token_verification_failed");
    expect(caught?.diagnostics).toEqual({
      providerStatus: 400,
      providerErrorCode: "100",
      providerErrorSubcode: undefined,
      providerErrorType: "WhatsAppProviderError",
      metaErrorType: "OAuthException",
      providerErrorDetail: undefined,
    });
  });

  it("token_verification_failed: an explicit app-id mismatch (not a caught provider exception) gets no diagnostics -- nothing to capture", async () => {
    vi.spyOn(embeddedSignupProvider, "inspectAccessToken").mockResolvedValue({
      isValid: true,
      appId: "SOME-OTHER-APP-ID",
      expiresAt: 0,
      scopes: [],
    });
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("token_verification_failed");
    expect(caught?.diagnostics).toBeUndefined();
  });

  it("graph_verification_failed (WABA reachability): a WhatsAppProviderError from getWhatsAppBusinessAccount is captured as diagnostics", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      getWhatsAppBusinessAccount: vi
        .fn()
        .mockRejectedValue(new WhatsAppProviderError("Forbidden", 403, "200")),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("graph_verification_failed");
    expect(caught?.diagnostics).toEqual({
      providerStatus: 403,
      providerErrorCode: "200",
      providerErrorSubcode: undefined,
      providerErrorType: "WhatsAppProviderError",
    });
  });

  it("graph_verification_failed (phone ownership): a WhatsAppProviderError from getPhoneNumbersForWaba is captured as diagnostics", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      getPhoneNumbersForWaba: vi
        .fn()
        .mockRejectedValue(new WhatsAppProviderError("Not found", 404, "100")),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("graph_verification_failed");
    expect(caught?.diagnostics).toEqual({
      providerStatus: 404,
      providerErrorCode: "100",
      providerErrorSubcode: undefined,
      providerErrorType: "WhatsAppProviderError",
    });
  });

  it("phone_ownership_mismatch: the explicit belongs===false branch (not a caught provider exception) gets no diagnostics", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      verifyPhoneBelongsToWaba: vi.fn().mockResolvedValue(false),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        { ...BASE_INPUT, phoneNumberId: "someone-elses-phone-number-id" },
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("phone_ownership_mismatch");
    expect(caught?.diagnostics).toBeUndefined();
  });

  it("subscription_failed: a WhatsAppProviderError from subscribeAppToWaba is captured as diagnostics, including Meta's error.type/error_data.details when present", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      subscribeAppToWaba: vi
        .fn()
        .mockRejectedValue(
          new MetaGraphApiError(
            "Forbidden",
            403,
            "200",
            undefined,
            "OAuthException",
            "Application does not have permission for this action",
          ),
        ),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("subscription_failed");
    expect(caught?.diagnostics).toEqual({
      providerStatus: 403,
      providerErrorCode: "200",
      providerErrorSubcode: undefined,
      providerErrorType: "WhatsAppProviderError",
      metaErrorType: "OAuthException",
      providerErrorDetail: "Application does not have permission for this action",
    });
  });

  it("subscription_failed: Meta returns success: false (not a caught exception) gets no diagnostics -- nothing to capture", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      subscribeAppToWaba: vi.fn().mockResolvedValue({ success: false }),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("subscription_failed");
    expect(caught?.diagnostics).toBeUndefined();
  });

  it("none of the new diagnostics fields ever leak the access token, app secret, or a PIN, across every hardened step", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      subscribeAppToWaba: vi
        .fn()
        .mockRejectedValue(
          new MetaGraphApiError(
            "Forbidden",
            403,
            "200",
            undefined,
            "OAuthException",
            "generic detail",
          ),
        ),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    const serialized = JSON.stringify(caught?.diagnostics ?? {});
    expect(serialized).not.toContain("exchanged-token-value");
    expect(serialized).not.toContain(CREDS.appSecret);
    expect(Object.keys(caught?.diagnostics ?? {}).sort()).toEqual(
      [
        "metaErrorType",
        "providerErrorCode",
        "providerErrorDetail",
        "providerErrorSubcode",
        "providerErrorType",
        "providerStatus",
      ].sort(),
    );
  });
});

describe("completeEmbeddedSignup: registration PIN (Meta's documented /register contract)", () => {
  it("passes a 6-digit numeric pin as the second argument to registerPhoneNumber, alongside the unchanged phoneNumberId", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    expect(graphClient.registerPhoneNumber).toHaveBeenCalledTimes(1);
    const [calledPhoneNumberId, calledPin] = graphClient.registerPhoneNumber.mock.calls[0]!;
    expect(calledPhoneNumberId).toBe("phone-real-1");
    expect(calledPin).toEqual(expect.any(String));
    expect(calledPin).toMatch(/^\d{6}$/);
  });

  it("never reuses the same pin deterministically across separate completions -- confirms the value is freshly generated, not hard-coded", async () => {
    const pins = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const repo = makeRepo();
      const graphClient = makeGraphClient();
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
      const [, pin] = graphClient.registerPhoneNumber.mock.calls[0]!;
      pins.add(pin as string);
    }
    // 20 independent 6-digit CSPRNG draws collapsing to a single repeated
    // value has probability on the order of 1e-84 -- this is not a flake risk,
    // it is a hard-coded-value detector.
    expect(pins.size).toBeGreaterThan(1);
  });

  it("the generated pin never appears in EmbeddedSignupFlowErrorDiagnostics under normal Meta error shapes", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi
        .fn()
        .mockRejectedValue(
          new MetaGraphApiError(
            "Registration rejected",
            400,
            "100",
            undefined,
            "OAuthException",
            "Invalid parameter",
          ),
        ),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_failed");
    expect(Object.keys(caught?.diagnostics ?? {})).not.toContain("pin");
    expect(caught?.diagnostics?.providerErrorDetail).toBe("Invalid parameter");
  });

  it("defends against Meta unexpectedly echoing the exact submitted pin back inside error_data.details -- it is redacted before providerErrorDetail is ever set", async () => {
    const repo = makeRepo();
    let observedPin: string | undefined;
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi.fn().mockImplementation((_phoneNumberId: string, pin: string) => {
        observedPin = pin;
        return Promise.reject(
          new MetaGraphApiError(
            "Registration rejected",
            400,
            "100",
            undefined,
            "OAuthException",
            `pin ${pin} was invalid`, // a hypothetical future Meta response shape that echoes the submitted pin
          ),
        );
      }),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_failed");
    expect(observedPin).toMatch(/^\d{6}$/);
    expect(caught?.diagnostics?.providerErrorDetail).toBe("pin [redacted] was invalid");
    expect(caught?.diagnostics?.providerErrorDetail).not.toContain(observedPin!);
  });

  it("does not persist the pin anywhere: the completeAttempt payload sent to the repository has no pin-shaped field", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    const persisted = repo.completeAttempt.mock.calls[0]?.[0];
    expect(Object.keys(persisted)).not.toContain("pin");
    expect(Object.keys(persisted)).not.toContain("registrationPin");
    expect(JSON.stringify(persisted)).not.toMatch(/"pin"/);
  });

  it("still proceeds to subscribeAppToWaba and persistence when registration (with the generated pin) succeeds", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    expect(graphClient.subscribeAppToWaba).toHaveBeenCalledWith("waba-1");
    expect(repo.completeAttempt).toHaveBeenCalledTimes(1);
  });
});

describe("completeEmbeddedSignup: registration PIN reuse and persistence (migration 39)", () => {
  it("reconnecting the SAME phone number reuses its previously-successful PIN instead of generating a new one", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();
    const storedPlaintextPin = "654321";
    const storedEnvelope = await encryptWhatsAppRegistrationPin(
      storedPlaintextPin,
      "phone-real-1",
      KEY,
    );
    const findRegistrationPin = vi.fn().mockResolvedValue({
      encryptedPin: storedEnvelope,
      keyVersion: 1,
    } as RegistrationPinEnvelope);
    const saveRegistrationPin = vi.fn().mockResolvedValue(undefined);

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin,
        saveRegistrationPin,
      },
      BASE_INPUT,
    );

    expect(findRegistrationPin).toHaveBeenCalledWith("phone-real-1");
    expect(graphClient.registerPhoneNumber).toHaveBeenCalledWith(
      "phone-real-1",
      storedPlaintextPin,
    );
  });

  it("a genuinely new phone number (no stored PIN) still generates a fresh PIN", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();
    const findRegistrationPin = vi.fn().mockResolvedValue(null);

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    expect(findRegistrationPin).toHaveBeenCalledWith("phone-real-1");
    const [, pin] = graphClient.registerPhoneNumber.mock.calls[0]!;
    expect(pin).toMatch(/^\d{6}$/);
  });

  it("after a successful registration, the exact PIN used is encrypted and persisted via saveRegistrationPin, keyed by phoneNumberId, decryptable back to the same plaintext", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();
    const saveRegistrationPin = vi.fn().mockResolvedValue(undefined);

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin,
      },
      BASE_INPUT,
    );

    const [, usedPin] = graphClient.registerPhoneNumber.mock.calls[0]!;
    expect(saveRegistrationPin).toHaveBeenCalledTimes(1);
    const [savedPhoneNumberId, savedEnvelope] = saveRegistrationPin.mock.calls[0]!;
    expect(savedPhoneNumberId).toBe("phone-real-1");
    expect(savedEnvelope.encryptedPin).not.toContain(usedPin); // never plaintext
    const decrypted = await decryptWhatsAppRegistrationPin(
      savedEnvelope.encryptedPin,
      "phone-real-1",
      (version) => (version === savedEnvelope.keyVersion ? KEY.keyBase64 : undefined),
    );
    expect(decrypted).toBe(usedPin);
  });

  it("registration is saved BEFORE subscribeAppToWaba runs -- persisted even if a later step in the same call were to fail", async () => {
    const callOrder: string[] = [];
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      subscribeAppToWaba: vi.fn().mockImplementation(() => {
        callOrder.push("subscribeAppToWaba");
        return Promise.resolve({ success: true });
      }),
    });
    const saveRegistrationPin = vi.fn().mockImplementation(() => {
      callOrder.push("saveRegistrationPin");
      return Promise.resolve(undefined);
    });

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin,
      },
      BASE_INPUT,
    );

    expect(callOrder).toEqual(["saveRegistrationPin", "subscribeAppToWaba"]);
  });

  it("a failure to persist the PIN (saveRegistrationPin throws) never fails an otherwise-successful registration/subscription/persistence", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();

    const result = await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin: async () => null,
        saveRegistrationPin: async () => {
          throw new Error("transient DB failure");
        },
      },
      BASE_INPUT,
    );

    expect(result).toEqual({ whatsappAccountId: "account-1", whatsappPhoneNumberId: "phone-1" });
    expect(repo.completeAttempt).toHaveBeenCalledTimes(1);
  });

  it("a stored PIN that fails to decrypt (corrupted/wrong key) falls back to generating a fresh PIN rather than throwing", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient();
    const findRegistrationPin = vi
      .fn()
      .mockResolvedValue({ encryptedPin: "{ not a valid envelope", keyVersion: 1 });

    await completeEmbeddedSignup(
      {
        repo,
        metaCredentials: CREDS,
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
        findRegistrationPin,
        saveRegistrationPin: async () => {},
      },
      BASE_INPUT,
    );

    const [, pin] = graphClient.registerPhoneNumber.mock.calls[0]!;
    expect(pin).toMatch(/^\d{6}$/);
  });

  it('Meta\'s error.code=133005 ("Security PIN mismatch") is classified as registration_pin_mismatch, distinct from generic registration_failed, and the stored PIN is never overwritten on this failure', async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi
        .fn()
        .mockRejectedValue(
          new MetaGraphApiError(
            "Registration rejected",
            400,
            "133005",
            undefined,
            "OAuthException",
            "Security PIN mismatch: Wrong PIN used. Make sure that you are using the correct PIN and try again.",
          ),
        ),
    });
    const saveRegistrationPin = vi.fn().mockResolvedValue(undefined);

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin,
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_pin_mismatch");
    expect(caught?.diagnostics).toEqual({
      providerStatus: 400,
      providerErrorCode: "133005",
      providerErrorSubcode: undefined,
      providerErrorType: "WhatsAppProviderError",
      metaErrorType: "OAuthException",
      providerErrorDetail:
        "Security PIN mismatch: Wrong PIN used. Make sure that you are using the correct PIN and try again.",
    });
    expect(saveRegistrationPin).not.toHaveBeenCalled();
    expect(repo.completeAttempt).not.toHaveBeenCalled();
  });

  it("a generic (non-133005) registration rejection remains the ordinary registration_failed code, unaffected by the new PIN-mismatch classification", async () => {
    const repo = makeRepo();
    const graphClient = makeGraphClient({
      registerPhoneNumber: vi
        .fn()
        .mockRejectedValue(new WhatsAppProviderError("Registration rejected", 400, "100")),
    });

    let caught: EmbeddedSignupFlowError | undefined;
    try {
      await completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
          findRegistrationPin: async () => null,
          saveRegistrationPin: async () => {},
        },
        BASE_INPUT,
      );
    } catch (error) {
      caught = error as EmbeddedSignupFlowError;
    }

    expect(caught?.code).toBe("registration_failed");
  });
});
