import { getCloudflareContext } from "@opennextjs/cloudflare";
import { R2StorageProvider, type R2BucketLike } from "@dravonix/storage";
import { NextResponse } from "next/server";
import { getPlayableAudioMediaFile } from "../../../../../lib/repositories/mediaFilesRepository.js";
import { logServerError } from "../../../../../lib/serverLogging.js";
import { getDashboardSession } from "../../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

/**
 * Streams one company-scoped voice-message audio file for the dashboard's
 * <audio> player (P1 dashboard hygiene batch). Reuses the existing R2
 * storage architecture (packages/storage's R2StorageProvider, the same
 * class apps/workers/voice-consumer already writes through) -- this is not
 * a new storage provider, only apps/web's first read path into the bucket
 * voice-consumer already populates.
 *
 * This is deliberately NOT a general-purpose media oracle:
 *  - the caller's company comes only from their authenticated session
 *    (getDashboardSession), never from a request parameter;
 *  - getPlayableAudioMediaFile only ever resolves inbound_audio/
 *    outbound_audio kind rows scoped to that company, excluding anything
 *    retention-deleted;
 *  - a missing, cross-tenant, wrong-kind, deleted, or malformed-UUID
 *    media_file_id all produce the same 404, never revealing which case
 *    applied.
 *
 * A genuine storage failure (the R2 read itself throwing) is reported as
 * 500, not 404 -- an operational failure must never be silently reported
 * as if the media simply doesn't exist, since that would hide real outages
 * from monitoring. It is logged (sanitized: never the storage key, never
 * the audio bytes, never the raw exception) before responding.
 *
 * No byte-range support: voice notes are short, and this keeps the
 * authorization/storage path simple. Native <audio controls> still works
 * fully against a plain 200 response, just without fine-grained seeking on
 * a still-downloading file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaFileId: string }> },
): Promise<Response> {
  const session = await getDashboardSession();
  if (!session) {
    return new NextResponse(null, { status: 401 });
  }

  const { mediaFileId } = await params;
  const supabase = await createServerSupabaseClient();
  const media = await getPlayableAudioMediaFile(supabase, session.activeCompanyId, mediaFileId);
  if (!media) {
    return new NextResponse(null, { status: 404 });
  }

  const { env } = getCloudflareContext();
  const bucket = (env as unknown as { AUDIO_BUCKET?: R2BucketLike }).AUDIO_BUCKET;
  if (!bucket) {
    // Binding not configured for this deploy target -- fail closed, never
    // fall back to any other access path.
    return new NextResponse(null, { status: 503 });
  }

  let bytes: ArrayBuffer | null;
  try {
    bytes = await new R2StorageProvider(bucket).get(media.storageKey);
  } catch (error) {
    // A genuine R2/provider failure (outage, transient error) -- logged
    // (never the storage key, never bytes, never the raw exception) and
    // reported as 500, distinct from the 404s above: this is an
    // operational failure, not an authorization/not-found outcome, and
    // must not be silently reported as if the media simply doesn't exist.
    logServerError(
      "Failed to read audio object from storage",
      error,
      {
        companyId: session.activeCompanyId,
      },
      { operation: "media_audio_route.r2_read", mediaFileId },
    );
    return new NextResponse(null, { status: 500 });
  }
  if (!bytes) {
    // Object missing from R2 (e.g. expired between the media_files check
    // above and this read) -- same 404 as "not found", no different signal.
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": media.mimeType,
      "Content-Length": String(bytes.byteLength),
      // Private: this is tenant customer audio, never suitable for a shared
      // cache. Short max-age only smooths out a user re-seeking/replaying
      // the same message in one sitting.
      "Cache-Control": "private, max-age=300",
    },
  });
}
