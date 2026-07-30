/**
 * Google Cloud OAuth2 service-account authentication (JWT bearer flow), built
 * on Web Crypto so it runs unmodified under Node.js and Cloudflare Workers --
 * no Google client library (which typically assumes a Node runtime) required.
 * See GOOGLE_SPEECH_SETUP.md.
 */

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseGoogleServiceAccountJson(json: string): GoogleServiceAccount {
  const parsed = JSON.parse(json) as Partial<GoogleServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_CLOUD_CREDENTIALS is missing client_email or private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri,
  };
}

function base64UrlEncode(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Builds and RS256-signs a Google OAuth2 service-account JWT assertion for the given scope. */
export async function createSignedGoogleJwt(
  account: GoogleServiceAccount,
  scope: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope,
    aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

export interface GoogleAccessTokenResponse {
  access_token: string;
  expires_in: number;
}

/** Exchanges a signed JWT assertion for a bearer access token via Google's OAuth2 token endpoint. */
export async function fetchGoogleAccessToken(
  account: GoogleServiceAccount,
  scope: string,
): Promise<GoogleAccessTokenResponse> {
  const assertion = await createSignedGoogleJwt(account, scope);
  const response = await fetch(account.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain Google access token: HTTP ${response.status}`);
  }

  return response.json();
}
