import { UnauthorizedError } from "@dravonix/core";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthenticatedSession {
  userId: string;
  email: string | null;
}

const BEARER_PREFIX = "Bearer ";

/** Extracts the raw access token from an `Authorization: Bearer <token>` header value. */
export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return null;
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies a Supabase access token server-side (never trust a client-supplied
 * user ID) and returns the authenticated session, or throws UnauthorizedError.
 * `client` must be created with the anon key (verification does not require the
 * service role -- see packages/database/src/client.ts).
 */
export async function requireSession(
  client: SupabaseClient,
  authorizationHeader: string | null | undefined,
): Promise<AuthenticatedSession> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new UnauthorizedError("Missing bearer token");
  }

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    throw new UnauthorizedError("Invalid or expired session");
  }

  return { userId: data.user.id, email: data.user.email ?? null };
}
