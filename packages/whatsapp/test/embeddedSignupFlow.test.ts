import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeEmbeddedSignup,
  initiateEmbeddedSignup,
  type EmbeddedSignupFlowError,
  type SignupAttemptRepository,
} from "../src/embeddedSignupFlow.js";
import * as embeddedSignupProvider from "../src/providers/embeddedSignupProvider.js";

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
        redirectUri: "https://example.test/callback",
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
      },
      BASE_INPUT,
    );

    expect(repo.claimAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      companyId: "company-1",
      nonceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(graphClient.verifyPhoneBelongsToWaba).toHaveBeenCalledWith("waba-1", "phone-real-1");
    expect(graphClient.registerPhoneNumber).toHaveBeenCalledWith("phone-real-1");
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
        redirectUri: "https://example.test/callback",
        encryptionKey: KEY,
        graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "exchange_failed" });

    expect(repo.completeAttempt).not.toHaveBeenCalled();
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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

    await expect(
      completeEmbeddedSignup(
        {
          repo,
          metaCredentials: CREDS,
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "registration_failed" });
    expect(repo.completeAttempt).not.toHaveBeenCalled();
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
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
          redirectUri: "https://example.test/callback",
          encryptionKey: KEY,
          graphManagementClientFactory: () => graphClient as never,
        },
        BASE_INPUT,
      ),
    ).rejects.toMatchObject({ code: "persistence_failed" });
  });
});
