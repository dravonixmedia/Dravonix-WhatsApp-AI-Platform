import type { SupabaseClient } from "@supabase/supabase-js";
import { keyBelongsToCompany } from "@dravonix/storage";
import { logServerError } from "../serverLogging.js";

export interface PlayableAudioMediaFile {
  storageKey: string;
  mimeType: string;
}

/** The only media_files.kind values this ever serves -- never knowledge_document. */
const PLAYABLE_AUDIO_KINDS = ["inbound_audio", "outbound_audio"] as const;

/**
 * Falls back to the same default the voice pipeline itself uses when a
 * media_files row somehow has no mime_type recorded (see
 * apps/workers/voice-consumer/src/processVoiceJob.ts), rather than a new,
 * possibly-inconsistent default.
 */
const DEFAULT_AUDIO_MIME_TYPE = "audio/ogg";

/**
 * Resolves a company-scoped, playable voice-message audio file for secure
 * browser playback (P1 dashboard hygiene batch). companyId MUST come from
 * the caller's own authenticated session -- never a browser-supplied value
 * -- matching leadsRepository.ts's getLead() convention.
 *
 * Returns null uniformly for a missing, cross-tenant, RLS-hidden, non-audio
 * (e.g. a knowledge_document media_files row), retention-deleted, or
 * malformed-UUID mediaFileId -- the caller (the /api/media/audio route)
 * responds the same way (404) to all of these, never revealing which case
 * applied.
 */
export async function getPlayableAudioMediaFile(
  client: SupabaseClient,
  companyId: string,
  mediaFileId: string,
): Promise<PlayableAudioMediaFile | null> {
  const { data, error } = await client
    .from("media_files")
    .select("storage_key, mime_type, kind, deleted_at")
    .eq("company_id", companyId)
    .eq("id", mediaFileId)
    .in("kind", PLAYABLE_AUDIO_KINDS)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    // 22P02 = invalid_text_representation (a malformed, non-UUID
    // mediaFileId) -- same established handling as
    // packages/handover/src/repositories/supabaseHandoverRepository.ts's
    // getConversationForThread: indistinguishable from "not found" as far
    // as the caller/route should ever reveal, so the route's uniform 404
    // covers this case too instead of a generic 500.
    if (error.code === "22P02") return null;
    logServerError(
      "Failed to resolve playable audio media file",
      error,
      { companyId },
      { operation: "getPlayableAudioMediaFile", mediaFileId },
    );
    throw error;
  }
  if (!data) return null;

  // Defense-in-depth, mirroring packages/storage's own keyBelongsToCompany
  // access-control convention: the stored key must fall under this exact
  // caller's company prefix before this ever reaches an R2 read, even
  // though company_id was already filtered above.
  if (!keyBelongsToCompany(data.storage_key, companyId)) return null;

  return {
    storageKey: data.storage_key,
    mimeType: data.mime_type ?? DEFAULT_AUDIO_MIME_TYPE,
  };
}
