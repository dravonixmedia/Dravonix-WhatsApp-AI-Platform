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
