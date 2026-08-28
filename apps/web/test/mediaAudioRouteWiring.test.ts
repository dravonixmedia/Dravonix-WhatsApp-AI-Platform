import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the secure audio playback route (P1
 * dashboard hygiene batch). This repo has no harness for a real Next.js
 * Route Handler request (no next-test-api-route-utils, and the route
 * depends on @opennextjs/cloudflare's getCloudflareContext, which only
 * resolves inside an actual deployed/dev Worker runtime) -- covered the
 * same way as every other session-adjacent file in this repo (see
 * navItems.test.ts's identical note): read the source and assert on it.
 * getPlayableAudioMediaFile's own authorization logic (the part that is
 * fully unit-testable) is covered behaviorally in
 * mediaFilesRepository.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const routeSource = readFileSync(
  join(webRoot, "app/api/media/audio/[mediaFileId]/route.ts"),
  "utf8",
);

describe("/api/media/audio/[mediaFileId] route wiring", () => {
  it("checks the authenticated session before anything else, and returns 401 when absent -- unauthenticated requests are denied (CASE 3)", () => {
    const sessionCheckIndex = routeSource.indexOf("getDashboardSession()");
    const unauthorizedIndex = routeSource.indexOf("status: 401");
    const supabaseClientIndex = routeSource.indexOf("createServerSupabaseClient()");
    expect(sessionCheckIndex).toBeGreaterThan(-1);
    expect(unauthorizedIndex).toBeGreaterThan(sessionCheckIndex);
    // The Supabase client (and therefore any media_files query) is only
    // ever constructed after the session check above.
    expect(supabaseClientIndex).toBeGreaterThan(sessionCheckIndex);
  });

  it("derives the company scope only from the authenticated session, never from a request parameter -- no companyId is ever read off params/searchParams", () => {
    expect(routeSource).toContain("session.activeCompanyId");
    expect(routeSource).not.toMatch(/companyId\s*=\s*.*params/);
    expect(routeSource).not.toMatch(/searchParams/);
  });

  it("only ever reads mediaFileId from the route param and passes it straight to the company-scoped repository lookup -- no separate raw-key/company-id oracle", () => {
    expect(routeSource).toContain("params: Promise<{ mediaFileId: string }>");
    expect(routeSource).toContain(
      "getPlayableAudioMediaFile(supabase, session.activeCompanyId, mediaFileId)",
    );
  });

  it("returns 404 for a missing/unauthorized media file rather than a distinguishing error", () => {
    const notFoundOccurrences = routeSource.match(/status: 404/g) ?? [];
    expect(notFoundOccurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("reuses the existing R2StorageProvider from @dravonix/storage -- introduces no new storage provider", () => {
    expect(routeSource).toContain(
      'import { R2StorageProvider, type R2BucketLike } from "@dravonix/storage"',
    );
    expect(routeSource).not.toMatch(/new\s+(?!R2StorageProvider)\w*StorageProvider/);
  });

  it("never logs the storage key, the audio bytes, or any raw error object -- no console.* call exists anywhere in this route", () => {
    expect(routeSource).not.toMatch(/console\.(log|error|warn|info)/);
  });

  it("is marked dynamic, matching this repo's convention for every session-dependent route", () => {
    expect(routeSource).toContain('export const dynamic = "force-dynamic"');
  });
});
