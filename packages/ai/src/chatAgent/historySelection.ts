import type { ChatAgentMessage } from "./types.js";

/**
 * Deterministic bounds on how much conversation history the Chat Agent ever
 * sends to Anthropic -- a staff copilot must never forward unlimited
 * history. Tuned generously enough for a real support conversation while
 * keeping prompt size predictable; not configurable per-request (the
 * browser has no way to raise these caps -- see apps/web/lib/actions/chatAgent.ts).
 */
export const CHAT_AGENT_MAX_HISTORY_MESSAGES = 40;
export const CHAT_AGENT_MAX_HISTORY_CHARS = 12_000;

export interface BoundedHistory {
  /** Chronological (oldest first), matching the order the dashboard already displays. */
  messages: ChatAgentMessage[];
  /** True when older messages existed but were dropped to satisfy the bounds above. */
  truncated: boolean;
}

/**
 * Selects the most recent window of messages within both a count cap and a
 * total-character cap, then restores chronological order. `messagesAscending`
 * is assumed oldest-first (the order packages/handover's getConversationThread
 * already returns and ConversationThread.tsx already displays) -- this
 * function never re-sorts by anything other than what was already there.
 *
 * The character budget is only enforced once at least one message has been
 * selected: a single very long message is still included on its own (so the
 * assistant never receives zero context for a real conversation), but every
 * message added after that respects the remaining budget.
 */
export function selectBoundedHistory(
  messagesAscending: ChatAgentMessage[],
  options: { maxMessages?: number; maxTotalChars?: number } = {},
): BoundedHistory {
  const maxMessages = options.maxMessages ?? CHAT_AGENT_MAX_HISTORY_MESSAGES;
  const maxTotalChars = options.maxTotalChars ?? CHAT_AGENT_MAX_HISTORY_CHARS;

  const selected: ChatAgentMessage[] = [];
  let totalChars = 0;
  for (let i = messagesAscending.length - 1; i >= 0; i -= 1) {
    const message = messagesAscending[i]!;
    if (selected.length >= maxMessages) break;
    const bodyLength = message.body.length;
    if (selected.length > 0 && totalChars + bodyLength > maxTotalChars) break;
    selected.push(message);
    totalChars += bodyLength;
  }
  selected.reverse();

  return { messages: selected, truncated: selected.length < messagesAscending.length };
}
