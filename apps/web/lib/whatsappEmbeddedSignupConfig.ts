import "server-only";
import { loadEnv } from "@dravonix/config";
import type { WhatsAppTokenEncryptionKey } from "@dravonix/core";
import type { MetaAppCredentials } from "@dravonix/whatsapp";

/** Thrown when a required piece of server-side Embedded Signup configuration is missing. Never includes the missing value itself (there isn't one). */
export class WhatsappEmbeddedSignupNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsappEmbeddedSignupNotConfiguredError";
  }
}

export interface WhatsappEmbeddedSignupServerConfig {
  metaCredentials: MetaAppCredentials;
  redirectUri: string;
  encryptionKey: WhatsAppTokenEncryptionKey;
}

/**
 * Resolves every server-only value the Embedded Signup complete route needs:
 * the Meta app credentials (never sent to the browser -- distinct from
 * NEXT_PUBLIC_META_APP_ID, which only identifies the app for FB.login),
 * the exact redirect_uri this app's Facebook Login configuration expects,
 * and the current WhatsApp token encryption key
 * (WHATSAPP_TOKEN_ENCRYPTION_KEY_V1, Batch 3 Slice A). Only key version 1
 * exists today -- a future V2 is its own separately reviewed configuration
 * change (see .env.example), not something this resolver anticipates.
 */
export function resolveWhatsappEmbeddedSignupServerConfig(): WhatsappEmbeddedSignupServerConfig {
  const env = loadEnv(process.env);

  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new WhatsappEmbeddedSignupNotConfiguredError(
      "META_APP_ID and META_APP_SECRET must be configured",
    );
  }
  if (!env.META_EMBEDDED_SIGNUP_REDIRECT_URI) {
    throw new WhatsappEmbeddedSignupNotConfiguredError(
      "META_EMBEDDED_SIGNUP_REDIRECT_URI must be configured",
    );
  }
  if (!env.WHATSAPP_TOKEN_ENCRYPTION_KEY_V1) {
    throw new WhatsappEmbeddedSignupNotConfiguredError(
      "WHATSAPP_TOKEN_ENCRYPTION_KEY_V1 must be configured",
    );
  }
  const currentVersion = Number(env.WHATSAPP_TOKEN_ENCRYPTION_CURRENT_VERSION ?? "1");
  if (currentVersion !== 1) {
    throw new WhatsappEmbeddedSignupNotConfiguredError(
      "Only WHATSAPP_TOKEN_ENCRYPTION_CURRENT_VERSION=1 is supported today",
    );
  }

  return {
    metaCredentials: {
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
      graphApiVersion: env.META_GRAPH_API_VERSION,
    },
    redirectUri: env.META_EMBEDDED_SIGNUP_REDIRECT_URI,
    encryptionKey: { version: currentVersion, keyBase64: env.WHATSAPP_TOKEN_ENCRYPTION_KEY_V1 },
  };
}
