import type { ConversationThreadMessage } from "@dravonix/handover";

export interface ThreadPageState {
  messages: ConversationThreadMessage[];
  hasMore: boolean;
}

/**
 * Prepends an older page of messages (ascending order, as returned by
 * getConversationThreadForDashboard) onto the currently loaded thread state.
 * De-duplicates by message id defensively -- the `before` cursor passed to
 * that next request is always derived from the oldest currently-loaded
 * message's createdAt (see oldestCursor below), so an overlap should never
 * occur by construction, but this guards a boundary tie (two messages
 * sharing the exact same created_at) from ever producing a visible
 * duplicate row.
 */
export function prependOlderPage(
  current: ThreadPageState,
  olderPage: { messages: ConversationThreadMessage[]; hasMore: boolean },
): ThreadPageState {
  const existingIds = new Set(current.messages.map((m) => m.id));
  const newMessages = olderPage.messages.filter((m) => !existingIds.has(m.id));
  return {
    messages: [...newMessages, ...current.messages],
    hasMore: olderPage.hasMore,
  };
}

/**
 * The `before` cursor for the next "load older messages" request: the
 * oldest currently-loaded message's createdAt, or null if there is nothing
 * loaded yet (nothing older can be meaningfully requested).
 */
export function oldestCursor(state: ThreadPageState): string | null {
  return state.messages[0]?.createdAt ?? null;
}

/** The initial state a freshly mounted/remounted thread component starts from. */
export function initialThreadState(
  messages: ConversationThreadMessage[],
  hasMore: boolean,
): ThreadPageState {
  return { messages, hasMore };
}
