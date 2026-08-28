import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral tests for the /api/media/audio/[mediaFileId] Route Handler
 * (P1 dashboard hygiene correction pass). Unlike mediaAudioRouteWiring.test.ts
 * (pure source-grep, since this repo has no dynamic Next.js Route Handler
 * test harness), this file dynamically imports and invokes the REAL `GET`
 * function, mocking only its external boundaries (session, Supabase client,
 * the media repository, the R2 provider, and the Cloudflare context) --
 * the same module-boundary-mocking convention already established by
 * conversationWorkspaceData.test.ts for a session-adjacent file in this
 * exact codebase. This proves the actual runtime control flow (status
 * codes, logging-before-responding, no raw exception leaking) rather than
 * only asserting on source text.
 */

const getDashboardSession = vi.fn();
vi.mock("../lib/session.js", () => ({
  getDashboardSession: (...args: unknown[]) => getDashboardSession(...args),
}));

const createServerSupabaseClient = vi.fn(async (..._args: unknown[]) => ({
  marker: "supabase-client",
}));
vi.mock("../lib/supabase/server.js", () => ({
  createServerSupabaseClient: (...args: unknown[]) => createServerSupabaseClient(...args),
}));

const getPlayableAudioMediaFile = vi.fn();
vi.mock("../lib/repositories/mediaFilesRepository.js", () => ({
  getPlayableAudioMediaFile: (...args: unknown[]) => getPlayableAudioMediaFile(...args),
}));

const logServerError = vi.fn();
vi.mock("../lib/serverLogging.js", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

const r2Get = vi.fn();
vi.mock("@dravonix/storage", () => ({
  R2StorageProvider: vi.fn().mockImplementation(() => ({
    get: (...args: unknown[]) => r2Get(...args),
  })),
}));

interface FakeCloudflareContext {
  env: { AUDIO_BUCKET?: object };
  cf: undefined;
  ctx: object;
}

const getCloudflareContext = vi.fn((..._args: unknown[]): FakeCloudflareContext => ({
  env: { AUDIO_BUCKET: {} },
  cf: undefined,
  ctx: {},
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...args: unknown[]) => getCloudflareContext(...args),
}));

const SESSION = { activeCompanyId: "company-a", activeMemberId: "member-1" };
const MEDIA = { storageKey: "companies/company-a/audio/inbound/msg-1", mimeType: "audio/ogg" };

async function callRoute(mediaFileId = "media-1") {
  const { GET } = await import("../app/api/media/audio/[mediaFileId]/route.js");
  return GET(new Request(`http://localhost/api/media/audio/${mediaFileId}`), {
    params: Promise.resolve({ mediaFileId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getDashboardSession.mockResolvedValue(SESSION);
  getPlayableAudioMediaFile.mockResolvedValue(MEDIA);
  getCloudflareContext.mockReturnValue({ env: { AUDIO_BUCKET: {} }, cf: undefined, ctx: {} });
  r2Get.mockResolvedValue(new ArrayBuffer(8));
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/media/audio/[mediaFileId]", () => {
  it("returns 401 and never touches Supabase/R2 when unauthenticated", async () => {
    getDashboardSession.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    expect(getPlayableAudioMediaFile).not.toHaveBeenCalled();
    expect(r2Get).not.toHaveBeenCalled();
  });

  it("returns 404 without touching R2 when the media file cannot be resolved (missing/cross-tenant/deleted/wrong-kind/malformed)", async () => {
    getPlayableAudioMediaFile.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(r2Get).not.toHaveBeenCalled();
  });

  it("streams the real audio bytes with the correct headers on the happy path", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/ogg");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("R2 CORRECTION: a genuine storage read failure logs safely (never the storage key, never the raw exception) and returns 500, not 404 -- an operational failure must not be reported as if the media simply doesn't exist", async () => {
    const storageError = new Error("R2 bucket unreachable: connection reset");
    r2Get.mockRejectedValue(storageError);

    const response = await callRoute("media-1");

    expect(response.status).toBe(500);
    expect(logServerError).toHaveBeenCalledTimes(1);
    const [message, loggedError, context, extra] = logServerError.mock.calls[0] ?? [];
    expect(message).toBe("Failed to read audio object from storage");
    expect(loggedError).toBe(storageError);
    expect(context).toEqual({ companyId: "company-a" });
    expect(extra).toMatchObject({ operation: "media_audio_route.r2_read", mediaFileId: "media-1" });
    // The storage key must never reach the logger, even indirectly.
    expect(JSON.stringify(logServerError.mock.calls[0])).not.toContain(MEDIA.storageKey);
  });

  it("does not serialize the raw exception message into the HTTP response body on an R2 failure", async () => {
    r2Get.mockRejectedValue(new Error("R2 bucket unreachable: connection reset"));

    const response = await callRoute();
    const body = await response.text();

    expect(body).not.toContain("connection reset");
    expect(body).not.toContain("R2 bucket unreachable");
  });

  it("returns 503 (never a crash) when the R2 binding itself is absent for this deploy target", async () => {
    getCloudflareContext.mockReturnValue({ env: {}, cf: undefined, ctx: {} });

    const response = await callRoute();

    expect(response.status).toBe(503);
    expect(r2Get).not.toHaveBeenCalled();
  });

  it("returns 404 (not 500) when R2 resolves with no object -- distinct from a genuine provider failure", async () => {
    r2Get.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(logServerError).not.toHaveBeenCalled();
  });
});
