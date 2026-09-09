import { encryptWhatsAppAccessToken, type WhatsAppTokenEncryptionKey } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import {
  OutboundCredentialResolutionError,
  resolveOutboundAccessToken,
  type WhatsappAccountCredentialRow,
} from "../src/outboundCredentialResolution.js";

/**
 * Meta/WhatsApp Batch 3 Slice E: this resolver is the single mechanism now
 * shared by BOTH the Settings test-message path (apps/web/lib/actions/
 * whatsappTestMessage.ts, already proven against real staging traffic) and
 * apps/workers/message-consumer's AI outbound send path (the fix for the
 * first real staging AI outbound failure, whose root cause was
 * message-consumer building its provider from a single global token instead
 * of calling this resolver at all). Had zero test coverage before this fix.
 */

const WABA_ID = "2257781855064934";
const OTHER_WABA_ID = "9999999999999999";

function randomKeyBase64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function testKey(version = 1): WhatsAppTokenEncryptionKey {
  return { version, keyBase64: randomKeyBase64() };
}

describe("resolveOutboundAccessToken", () => {
  it("manual_admin always resolves to the global access token, ignoring any stored credential fields", async () => {
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "manual_admin",
      wabaId: WABA_ID,
      encryptedAccessToken: null,
      encryptionKeyVersion: null,
    };

    const token = await resolveOutboundAccessToken(account, {
      globalAccessToken: "GLOBAL_TOKEN_VALUE",
      resolveEncryptionKey: () => undefined,
    });

    expect(token).toBe("GLOBAL_TOKEN_VALUE");
  });

  it("manual_admin fails closed with global_token_not_configured when no global token is configured -- never a silent empty/undefined token", async () => {
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "manual_admin",
      wabaId: WABA_ID,
      encryptedAccessToken: null,
      encryptionKeyVersion: null,
    };

    const error = await resolveOutboundAccessToken(account, {
      globalAccessToken: undefined,
      resolveEncryptionKey: () => undefined,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OutboundCredentialResolutionError);
    expect((error as OutboundCredentialResolutionError).code).toBe("global_token_not_configured");
  });

  it("embedded_signup decrypts and returns this account's own stored token, never the global token", async () => {
    const key = testKey();
    const plaintext = "EAAG-real-embedded-signup-token";
    const encrypted = await encryptWhatsAppAccessToken(plaintext, WABA_ID, key);
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "embedded_signup",
      wabaId: WABA_ID,
      encryptedAccessToken: encrypted,
      encryptionKeyVersion: key.version,
    };

    const token = await resolveOutboundAccessToken(account, {
      globalAccessToken: "GLOBAL_TOKEN_VALUE_SHOULD_NEVER_BE_RETURNED",
      resolveEncryptionKey: (version) => (version === key.version ? key.keyBase64 : undefined),
    });

    expect(token).toBe(plaintext);
  });

  it("embedded_signup with no stored credential fails closed with no_stored_credential -- never falls back to the global token", async () => {
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "embedded_signup",
      wabaId: WABA_ID,
      encryptedAccessToken: null,
      encryptionKeyVersion: null,
    };

    const error = await resolveOutboundAccessToken(account, {
      globalAccessToken: "GLOBAL_TOKEN_VALUE_SHOULD_NEVER_BE_RETURNED",
      resolveEncryptionKey: () => "irrelevant",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OutboundCredentialResolutionError);
    expect((error as OutboundCredentialResolutionError).code).toBe("no_stored_credential");
  });

  it("embedded_signup with an unresolvable key version fails closed with decryption_failed -- no Meta call can ever be attempted with no token", async () => {
    const key = testKey(1);
    const encrypted = await encryptWhatsAppAccessToken("token", WABA_ID, key);
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "embedded_signup",
      wabaId: WABA_ID,
      encryptedAccessToken: encrypted,
      encryptionKeyVersion: key.version,
    };

    const error = await resolveOutboundAccessToken(account, {
      globalAccessToken: undefined,
      resolveEncryptionKey: () => undefined, // simulates WHATSAPP_TOKEN_ENCRYPTION_KEY_V1 not provisioned
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OutboundCredentialResolutionError);
    expect((error as OutboundCredentialResolutionError).code).toBe("decryption_failed");
  });

  it("embedded_signup with a ciphertext bound to a different WABA (AAD mismatch) fails closed with decryption_failed -- never decrypts under the wrong account's identity", async () => {
    const key = testKey();
    const encryptedForOtherWaba = await encryptWhatsAppAccessToken("token", OTHER_WABA_ID, key);
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "embedded_signup",
      wabaId: WABA_ID, // mismatched on purpose
      encryptedAccessToken: encryptedForOtherWaba,
      encryptionKeyVersion: key.version,
    };

    const error = await resolveOutboundAccessToken(account, {
      globalAccessToken: undefined,
      resolveEncryptionKey: (version) => (version === key.version ? key.keyBase64 : undefined),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OutboundCredentialResolutionError);
    expect((error as OutboundCredentialResolutionError).code).toBe("decryption_failed");
  });

  it("never includes the plaintext token, ciphertext, or key material in a thrown error's message", async () => {
    const key = testKey();
    const secretPlaintext = "EAAG-super-secret-value-should-never-leak";
    const encrypted = await encryptWhatsAppAccessToken(secretPlaintext, WABA_ID, key);
    const account: WhatsappAccountCredentialRow = {
      connectionSource: "embedded_signup",
      wabaId: WABA_ID,
      encryptedAccessToken: encrypted,
      encryptionKeyVersion: key.version,
    };

    try {
      await resolveOutboundAccessToken(account, {
        globalAccessToken: undefined,
        resolveEncryptionKey: () => undefined, // wrong version -> forces a decryption_failed
      });
      expect.unreachable("expected resolution to throw");
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as Error).message,
        name: (error as Error).name,
      });
      expect(serialized).not.toContain(secretPlaintext);
      expect(serialized).not.toContain(encrypted);
      expect(serialized).not.toContain(key.keyBase64);
    }
  });
});
