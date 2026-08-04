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

/**
 * Appends a message received over a live Realtime subscription.
 * De-duplicates by id: a message this component already has (its own
 * optimistic row, or a redelivered/duplicate INSERT event after a
 * reconnect) is left exactly where it is rather than appended a second
 * time. Assumes new realtime rows are always the newest -- true for this
 * thread, since "Load older messages" only ever prepends to the front.
 */
export function appendRealtimeMessage(
  state: ThreadPageState,
  message: ConversationThreadMessage,
): ThreadPageState {
  if (state.messages.some((m) => m.id === message.id)) return state;
  return { ...state, messages: [...state.messages, message] };
}

/**
 * Patches an already-loaded message in place (e.g. outbound_status flipping
 * from "sending" to "sent"/"delivery_unknown" after a live UPDATE event).
 * A no-op if the id isn't currently loaded (an update for a message outside
 * the currently-loaded window, or one that arrived before its own INSERT
 * was processed -- the next reconnect/resync will pick up the latest row).
 */
export function applyRealtimeMessagePatch(
  state: ThreadPageState,
  messageId: string,
  patch: Partial<ConversationThreadMessage>,
): ThreadPageState {
  const index = state.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return state;
  const messages = state.messages.slice();
  messages[index] = Object.assign({}, messages[index], patch);
  return { ...state, messages };
}
