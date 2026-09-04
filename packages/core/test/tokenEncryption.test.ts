import { describe, expect, it } from "vitest";
import {
  CredentialDecryptionError,
  CredentialEncryptionError,
  decryptWhatsAppAccessToken,
  encryptWhatsAppAccessToken,
  type WhatsAppTokenEncryptionKey,
} from "../src/tokenEncryption.js";

const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";

function randomKey(version = 1): WhatsAppTokenEncryptionKey {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return { version, keyBase64: btoa(binary) };
}

function resolverFor(key: WhatsAppTokenEncryptionKey) {
  return (version: number) => (version === key.version ? key.keyBase64 : undefined);
}

describe("encryptWhatsAppAccessToken / decryptWhatsAppAccessToken", () => {
  it("round-trips a plaintext token", async () => {
    const key = randomKey();
    const envelope = await encryptWhatsAppAccessToken("EAAG-real-token-value", ACCOUNT_ID, key);
    const plaintext = await decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, resolverFor(key));
    expect(plaintext).toBe("EAAG-real-token-value");
  });

  it("produces a well-formed v1 envelope with the expected fields", async () => {
    const key = randomKey();
    const envelope = await encryptWhatsAppAccessToken("some-token", ACCOUNT_ID, key);
    const parsed = JSON.parse(envelope);
    expect(parsed).toMatchObject({ v: 1, kv: 1 });
    expect(typeof parsed.iv).toBe("string");
    expect(typeof parsed.ct).toBe("string");
    expect(Object.keys(parsed).sort()).toEqual(["ct", "iv", "kv", "v"]);
  });

  it("produces a different IV and ciphertext each time, even for the identical plaintext and key", async () => {
    const key = randomKey();
    const a = JSON.parse(await encryptWhatsAppAccessToken("same-token", ACCOUNT_ID, key));
    const b = JSON.parse(await encryptWhatsAppAccessToken("same-token", ACCOUNT_ID, key));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = randomKey();
    const wrongKey = randomKey();
    const envelope = await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key);
    await expect(
      decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, resolverFor(wrongKey)),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt with the wrong AAD (whatsappAccountId mismatch)", async () => {
    const key = randomKey();
    const envelope = await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key);
    await expect(
      decryptWhatsAppAccessToken(envelope, OTHER_ACCOUNT_ID, resolverFor(key)),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt an unknown whatsappAccountId even against the correct key for a DIFFERENT real account", async () => {
    // Same scenario as above, phrased as the real-world case this AAD binding
    // exists to prevent: a ciphertext copied onto a different row's
    // whatsapp_account_id must not decrypt there.
    const key = randomKey();
    const envelopeForAccountOne = await encryptWhatsAppAccessToken("account-one-token", ACCOUNT_ID, key);
    await expect(
      decryptWhatsAppAccessToken(envelopeForAccountOne, OTHER_ACCOUNT_ID, resolverFor(key)),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt a tampered ciphertext", async () => {
    const key = randomKey();
    const envelope = JSON.parse(await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key));
    // Flip the envelope's last base64url character of ct -- corrupts the
    // trailing byte, which is part of the GCM authentication tag Web Crypto
    // appends to its own AES-GCM output.
    const tampered = { ...envelope, ct: envelope.ct.slice(0, -1) + (envelope.ct.at(-1) === "A" ? "B" : "A") };
    await expect(
      decryptWhatsAppAccessToken(JSON.stringify(tampered), ACCOUNT_ID, resolverFor(key)),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt a tampered IV", async () => {
    const key = randomKey();
    const envelope = JSON.parse(await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key));
    const tampered = { ...envelope, iv: envelope.iv.slice(0, -1) + (envelope.iv.at(-1) === "A" ? "B" : "A") };
    await expect(
      decryptWhatsAppAccessToken(JSON.stringify(tampered), ACCOUNT_ID, resolverFor(key)),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt malformed JSON", async () => {
    await expect(
      decryptWhatsAppAccessToken("{not valid json", ACCOUNT_ID, () => "irrelevant"),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt malformed base64url in iv/ct", async () => {
    const envelope = JSON.stringify({ v: 1, kv: 1, iv: "not-valid-base64url!!!", ct: "also-not-valid!!!" });
    await expect(
      decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, () => "irrelevant"),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt when required envelope fields are missing", async () => {
    const missingCt = JSON.stringify({ v: 1, kv: 1, iv: "AAAAAAAAAAAAAAAA" });
    await expect(
      decryptWhatsAppAccessToken(missingCt, ACCOUNT_ID, () => "irrelevant"),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);

    const missingKv = JSON.stringify({ v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" });
    await expect(
      decryptWhatsAppAccessToken(missingKv, ACCOUNT_ID, () => "irrelevant"),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt an unsupported envelope version", async () => {
    const key = randomKey();
    const envelope = JSON.parse(await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key));
    const wrongVersion = { ...envelope, v: 2 };
    await expect(
      decryptWhatsAppAccessToken(JSON.stringify(wrongVersion), ACCOUNT_ID, resolverFor(key)),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("fails to decrypt an unknown key version (resolver returns undefined)", async () => {
    const key = randomKey();
    const envelope = await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key);
    await expect(
      decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, () => undefined),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("rejects an invalid key length at encrypt time", async () => {
    const shortKey: WhatsAppTokenEncryptionKey = { version: 1, keyBase64: btoa("too-short") };
    await expect(
      encryptWhatsAppAccessToken("token", ACCOUNT_ID, shortKey),
    ).rejects.toBeInstanceOf(CredentialEncryptionError);
  });

  it("rejects an invalid key length at decrypt time (via the resolver)", async () => {
    const key = randomKey();
    const envelope = await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key);
    await expect(
      decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, () => btoa("too-short")),
    ).rejects.toBeInstanceOf(CredentialDecryptionError);
  });

  it("rejects encrypting an empty token", async () => {
    const key = randomKey();
    await expect(encryptWhatsAppAccessToken("", ACCOUNT_ID, key)).rejects.toBeInstanceOf(
      CredentialEncryptionError,
    );
  });

  it("rejects encrypting with an empty whatsappAccountId", async () => {
    const key = randomKey();
    await expect(encryptWhatsAppAccessToken("token", "", key)).rejects.toBeInstanceOf(
      CredentialEncryptionError,
    );
  });

  it("never includes the plaintext token in a thrown decryption error's message", async () => {
    const key = randomKey();
    const wrongKey = randomKey();
    const secretToken = "EAAG-super-secret-value-should-never-leak";
    const envelope = await encryptWhatsAppAccessToken(secretToken, ACCOUNT_ID, key);
    try {
      await decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, resolverFor(wrongKey));
      expect.unreachable("expected decryption to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialDecryptionError);
      expect(String(error)).not.toContain(secretToken);
      expect(JSON.stringify(error)).not.toContain(secretToken);
    }
  });

  it("never includes key material in a thrown error's message", async () => {
    const key = randomKey();
    const envelope = await encryptWhatsAppAccessToken("token", ACCOUNT_ID, key);
    try {
      await decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, () => undefined);
      expect.unreachable("expected decryption to throw");
    } catch (error) {
      expect(String(error)).not.toContain(key.keyBase64);
    }
  });

  it("decrypts correctly when the resolver is handed multiple key versions and must pick the right one", async () => {
    const keyV1 = randomKey(1);
    const keyV2: WhatsAppTokenEncryptionKey = { version: 2, keyBase64: randomKey().keyBase64 };
    const envelope = await encryptWhatsAppAccessToken("token-under-v1", ACCOUNT_ID, keyV1);

    const multiVersionResolver = (version: number) => {
      if (version === keyV1.version) return keyV1.keyBase64;
      if (version === keyV2.version) return keyV2.keyBase64;
      return undefined;
    };

    const plaintext = await decryptWhatsAppAccessToken(envelope, ACCOUNT_ID, multiVersionResolver);
    expect(plaintext).toBe("token-under-v1");
  });
});
