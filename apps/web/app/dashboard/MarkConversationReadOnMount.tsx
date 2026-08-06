"use client";

import { useEffect } from "react";
import { markConversationReadAction } from "../../lib/actions/handover.js";

/**
 * Marks a conversation read exactly once per navigation to it -- in a client
 * effect keyed by conversationId, never on every server render of the page.
 *
 * handover_mark_read unconditionally bumps conversations.handover_last_read_at
 * on every call, and that column change is itself covered by this same
 * page's own Realtime watch (CONVERSATION_DETAIL_WATCHES, plus the broader
 * company-wide watches mounted elsewhere). Calling it from the page's
 * unconditional server-side render created a self-sustaining loop: mark
 * read -> conversations UPDATE -> Realtime event -> router.refresh() ->
 * page re-renders -> mark read again -> ... -- observed in staging as
 * continuous GET/RSC traffic every few seconds while idle. A client effect
 * runs once when conversationId first appears (or changes) and is
 * untouched by a same-route router.refresh(), since the component instance
 * and its effect's only dependency are unchanged across a refresh.
 */
export function MarkConversationReadOnMount({ conversationId }: { conversationId: string }) {
  useEffect(() => {
    void markConversationReadAction(conversationId);
  }, [conversationId]);

  return null;
}
