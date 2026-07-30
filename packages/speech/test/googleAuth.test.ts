import { beforeAll, describe, expect, it } from "vitest";
import { createSignedGoogleJwt, parseGoogleServiceAccountJson } from "../src/googleAuth.js";

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pemWrap(base64Der: string): string {
  const lines = base64Der.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function base64UrlToArrayBuffer(base64Url: string): ArrayBuffer {
  const base64 = base64Url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let keyPair: CryptoKeyPair;
let privateKeyPem: string;

beforeAll(async () => {
  keyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  privateKeyPem = pemWrap(toBase64(exported));
});

describe("parseGoogleServiceAccountJson", () => {
  it("parses a valid service account JSON", () => {
    const account = parseGoogleServiceAccountJson(
      JSON.stringify({ client_email: "svc@project.iam.gserviceaccount.com", private_key: "key" }),
    );
    expect(account.client_email).toBe("svc@project.iam.gserviceaccount.com");
  });

  it("throws when client_email is missing", () => {
    expect(() => parseGoogleServiceAccountJson(JSON.stringify({ private_key: "key" }))).toThrow();
  });

  it("throws when private_key is missing", () => {
    expect(() =>
      parseGoogleServiceAccountJson(
        JSON.stringify({ client_email: "svc@project.iam.gserviceaccount.com" }),
      ),
    ).toThrow();
  });
});

describe("createSignedGoogleJwt", () => {
  it("produces a three-segment JWT with the expected header and claims", async () => {
    const jwt = await createSignedGoogleJwt(
      { client_email: "svc@project.iam.gserviceaccount.com", private_key: privateKeyPem },
      "https://www.googleapis.com/auth/cloud-platform",
      1_700_000_000,
    );

    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);

    const header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(segments[0]!)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const claims = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(segments[1]!)));
    expect(claims.iss).toBe("svc@project.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_003_600);
  });

  it("produces a signature that verifies against the corresponding public key", async () => {
    const jwt = await createSignedGoogleJwt(
      { client_email: "svc@project.iam.gserviceaccount.com", private_key: privateKeyPem },
      "https://www.googleapis.com/auth/cloud-platform",
      1_700_000_000,
    );

    const [headerB64, payloadB64, signatureB64] = jwt.split(".");
    const signedContent = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToArrayBuffer(signatureB64!);

    const isValid = await globalThis.crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      signature,
      signedContent,
    );
    expect(isValid).toBe(true);
  });
});
