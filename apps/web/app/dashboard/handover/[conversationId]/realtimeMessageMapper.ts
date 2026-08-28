import type { ConversationThreadMessage } from "@dravonix/handover";

/**
 * Maps a raw `messages` table row (snake_case, as delivered by a Realtime
 * postgres_changes payload) into the same shape the server loader already
 * produces (ConversationThreadMessage). Only the columns the thread UI
 * actually renders are read; unknown/extra columns are ignored.
 */
export function mapRealtimeMessageRow(row: Record<string, unknown>): ConversationThreadMessage {
  return {
    id: row.id as string,
    direction: row.direction as ConversationThreadMessage["direction"],
    channelType: row.channel_type as ConversationThreadMessage["channelType"],
    senderType: row.sender_type as ConversationThreadMessage["senderType"],
    senderMemberId: (row.sender_member_id as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    outboundStatus: (row.outbound_status as ConversationThreadMessage["outboundStatus"]) ?? null,
    providerMessageId: (row.provider_message_id as string | null) ?? null,
    createdAt: row.created_at as string,
    // A realtime postgres_changes payload is the raw `messages` row only --
    // no media_files join is possible here, so a voice message that just
    // arrived shows no player until the next full reload (router.refresh()
    // on reconnect, or navigating back to the conversation) picks up its
    // media_files row via the server loader's query above. The existing
    // placeholder text (messageBodyDisplay.ts) already covers this gap for
    // the message body in exactly the same way.
    mediaFileId: null,
    mediaMimeType: null,
    mediaDurationSeconds: null,
  };
}

/**
 * Converts a realtime UPDATE payload into a safe patch for
 * applyRealtimeMessagePatch (P1 dashboard hygiene correction pass).
 *
 * Deliberately omits mediaFileId/mediaMimeType/mediaDurationSeconds from the
 * returned object -- mapRealtimeMessageRow always sets these to null (a
 * realtime payload can never know them, see its own doc comment above), and
 * applyRealtimeMessagePatch merges via Object.assign, which overwrites any
 * key actually present on the patch. Passing the full mapped object as an
 * UPDATE patch would therefore wipe an already-hydrated audio player (loaded
 * from the initial server query, which DOES join media_files) back to "no
 * player" on every subsequent UPDATE to that message -- e.g. an outbound
 * voice reply's delivery-status transition (sending -> sent), which fires
 * exactly this UPDATE event. Omitting the keys entirely (not setting them to
 * null) is what makes Object.assign leave the existing hydrated values
 * untouched; every other field (outboundStatus, body, providerMessageId,
 * etc.) still refreshes normally.
 */
export function toRealtimeUpdatePatch(
  row: Record<string, unknown>,
): Partial<ConversationThreadMessage> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentionally discarded via rest destructuring, see doc comment above
  const { mediaFileId, mediaMimeType, mediaDurationSeconds, ...patch } = mapRealtimeMessageRow(row);
  return patch;
}
