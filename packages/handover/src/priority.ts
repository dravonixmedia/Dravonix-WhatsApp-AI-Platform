import type { ConversationState, HandoverInboxItem, HandoverPriority } from "./types.js";

const HIGH_PRIORITY_MINUTES = 30;
const MEDIUM_PRIORITY_MINUTES = 10;

/**
 * Priority is a function of how long a conversation has been waiting for a
 * human to pick it up (state_changed_at), for states where nobody is
 * actively staffing it yet. A conversation already being worked
 * (human_active) or otherwise out of the queue (paused/closed/ai_active) is
 * never "waiting" in this sense, so it's always "low" regardless of age.
 */
export function derivePriority(
  state: ConversationState,
  stateChangedAt: string,
  now: Date = new Date(),
): HandoverPriority {
  if (state !== "handover_requested" && state !== "queued_for_agent") return "low";

  const waitingMinutes = (now.getTime() - new Date(stateChangedAt).getTime()) / 60_000;
  if (waitingMinutes >= HIGH_PRIORITY_MINUTES) return "high";
  if (waitingMinutes >= MEDIUM_PRIORITY_MINUTES) return "medium";
  return "low";
}

/**
 * Unread count basis (final plan section 3): every inbound message when the
 * conversation has never been read, else every inbound message strictly
 * after the last read timestamp.
 */
export function deriveUnreadCount(
  inboundMessageTimestamps: string[],
  lastReadAt: string | null,
): number {
  if (lastReadAt === null) return inboundMessageTimestamps.length;
  const lastRead = new Date(lastReadAt).getTime();
  return inboundMessageTimestamps.filter((ts) => new Date(ts).getTime() > lastRead).length;
}

/**
 * Single, shared definition of "this handover-inbox item needs attention"
 * -- true when it's still pending (handover_requested/queued_for_agent,
 * regardless of assignment), or it's human_active but somehow unassigned
 * (shouldn't normally happen given the lifecycle contract, but not
 * excluded defensively), or it has unread inbound customer messages.
 *
 * This is the exact predicate behind both the Human Handover nav badge
 * (SupabaseHandoverRepository.countHandoverBadge) and the notification
 * bell's handover-attention panel (apps/web/app/dashboard/layout.tsx) --
 * kept as one function so the two can never silently diverge. Before this
 * existed, the nav/bell badge only checked `state in (handover_requested,
 * queued_for_agent)`, which structurally excluded an assigned human_active
 * conversation with new unread messages -- the root cause of a 2026-08-05
 * staging incident where a human_active conversation with 3 unread
 * messages showed a badge of 0 everywhere.
 */
export function handoverItemNeedsAttention(
  item: Pick<HandoverInboxItem, "state" | "assignedMemberId" | "unreadCount">,
): boolean {
  return item.state !== "human_active" || item.assignedMemberId === null || item.unreadCount > 0;
}

/**
 * Best-effort "AI is likely still working on a reply" heuristic (final plan
 * sections 16, 22) -- not a guarantee of an in-flight job, since no live
 * job-status signal exists in this codebase.
 */
export function deriveAiLikelyProcessing(input: {
  aiMode: "active" | "paused";
  latestInboundAt: string | null;
  latestAiOutboundAt: string | null;
}): boolean {
  if (input.aiMode !== "active") return false;
  if (!input.latestInboundAt) return false;
  if (!input.latestAiOutboundAt) return true;
  return new Date(input.latestInboundAt).getTime() > new Date(input.latestAiOutboundAt).getTime();
}
