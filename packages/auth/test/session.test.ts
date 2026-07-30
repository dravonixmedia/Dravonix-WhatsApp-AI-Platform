import { UnauthorizedError } from "@dravonix/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { extractBearerToken, requireSession } from "../src/session.js";

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("returns null when the header is missing", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it("returns null when the header has no Bearer prefix", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull();
  });

  it("returns null when the token portion is empty", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

function fakeClient(getUserResult: { user: { id: string; email?: string } | null; error?: Error }) {
  return {
    auth: {
      async getUser(_token: string) {
        return {
          data: { user: getUserResult.user },
          error: getUserResult.error ?? null,
        };
      },
    },
  } as unknown as SupabaseClient;
}

describe("requireSession", () => {
  it("throws UnauthorizedError when no Authorization header is present", async () => {
    const client = fakeClient({ user: null });
    await expect(requireSession(client, undefined)).rejects.toThrow(UnauthorizedError);
  });

  it("throws UnauthorizedError when Supabase rejects the token", async () => {
    const client = fakeClient({ user: null, error: new Error("invalid token") });
    await expect(requireSession(client, "Bearer bad-token")).rejects.toThrow(UnauthorizedError);
  });

  it("returns the authenticated session for a valid token", async () => {
    const client = fakeClient({ user: { id: "user-1", email: "owner@example.test" } });
    const session = await requireSession(client, "Bearer good-token");
    expect(session).toEqual({ userId: "user-1", email: "owner@example.test" });
  });
});
