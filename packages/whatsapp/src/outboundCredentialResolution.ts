import { decryptWhatsAppAccessToken } from "@dravonix/core";

/**
 * Batch 3, Slice C (narrow slice only -- see this module's own scope note
 * below): resolves which access token an outbound WhatsApp send should use
 * for a given whatsapp_accounts row, based on connection_source (migration
 * 37). This is the "Slice E" resolution logic migration 37's own comments
 * deferred -- built here only far enough to power the client-facing
 * send-a-test-message action (apps/web/lib/actions/whatsappTestMessage.ts);
 * apps/workers/message-consumer and apps/workers/voice-consumer still send
 * unconditionally via the single global META_ACCESS_TOKEN and are
 * deliberately NOT rewired to call this in this batch -- that is real AI/
 * conversation-pipeline surface, out of scope for "the WhatsApp connection
 * foundation."
 */

export type WhatsappConnectionSource = "manual_admin" | "embedded_signup";

export interface WhatsappAccountCredentialRow {
  connectionSource: WhatsappConnectionSource;
  /** Must be the same identifier the token was encrypted against (see embeddedSignupFlow.ts's own AAD comment) -- the WABA id, never whatsapp_accounts.id. */
  wabaId: string;
  encryptedAccessToken: string | null;
  encryptionKeyVersion: number | null;
}

export interface ResolveOutboundAccessTokenDeps {
  /** The existing global META_ACCESS_TOKEN -- used only for connection_source = 'manual_admin' rows, unchanged from Batch 1/2. */
  globalAccessToken: string | undefined;
  /** Looks up key material for a given encryption_key_version -- callers typically resolve this from WHATSAPP_TOKEN_ENCRYPTION_KEY_V<n> env vars. */
  resolveEncryptionKey: (keyVersion: number) => string | undefined;
}

export type OutboundCredentialResolutionErrorCode =
  "global_token_not_configured" | "no_stored_credential" | "decryption_failed";

/** Sanitized -- never includes a token, ciphertext, or key material. */
export class OutboundCredentialResolutionError extends Error {
  constructor(readonly code: OutboundCredentialResolutionErrorCode) {
    super(`Unable to resolve an outbound WhatsApp access token (${code})`);
    this.name = "OutboundCredentialResolutionError";
  }
}

/**
 * Returns the plaintext access token to use for an outbound send against
 * this specific whatsapp_accounts row -- manual_admin rows always use the
 * global token (identical to the send path's pre-Batch-3 behavior);
 * embedded_signup rows always decrypt their own row's credential, with NO
 * fallback to the global token (migration 37's own binding rule).
 */
export async function resolveOutboundAccessToken(
  account: WhatsappAccountCredentialRow,
  deps: ResolveOutboundAccessTokenDeps,
): Promise<string> {
  if (account.connectionSource === "manual_admin") {
    if (!deps.globalAccessToken) {
      throw new OutboundCredentialResolutionError("global_token_not_configured");
    }
    return deps.globalAccessToken;
  }

  if (account.encryptedAccessToken === null || account.encryptionKeyVersion === null) {
    throw new OutboundCredentialResolutionError("no_stored_credential");
  }

  try {
    return await decryptWhatsAppAccessToken(
      account.encryptedAccessToken,
      account.wabaId,
      deps.resolveEncryptionKey,
    );
  } catch {
    throw new OutboundCredentialResolutionError("decryption_failed");
  }
}
