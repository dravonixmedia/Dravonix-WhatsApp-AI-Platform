/**
 * Pure scroll-position decision logic for ConversationThread (Phase 3B).
 * Kept separate from the component and its DOM refs -- exactly like
 * threadPagination.ts's reducers -- so the actual arithmetic driving
 * observable scroll behavior is unit-testable without a DOM/rendering stack
 * (this repo has none; see threadPagination.test.ts for the established
 * convention this follows).
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How close to the bottom (in pixels of unscrolled content below the
 * viewport) still counts as "at the bottom" for auto-follow purposes.
 * Generous enough to absorb sub-pixel rounding and a partially-rendered
 * last message, small enough that a reader who has genuinely scrolled up
 * to read history is never mistaken for being at the bottom.
 */
export const BOTTOM_PROXIMITY_PX = 120;

/**
 * Whether the reader is close enough to the bottom of the thread that a
 * newly-arrived message should auto-scroll them to it. Used identically for
 * "was I at the bottom right before this realtime message arrived" (Section
 * 5) and needs no special case for the current user's own sent message --
 * a sender is, by definition, reading at/near the live edge of the
 * conversation when they compose a reply, so the same check already covers
 * it (Section 6).
 */
export function isNearBottom(
  metrics: ScrollMetrics,
  thresholdPx: number = BOTTOM_PROXIMITY_PX,
): boolean {
  const unscrolled = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return unscrolled <= thresholdPx;
}

/** The scrollTop value that puts the very bottom of the content flush with the viewport. */
export function bottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * The new scrollTop that keeps whatever the reader was looking at in the
 * same visual position after older messages are prepended above it
 * (Section 4) -- prepending grows scrollHeight from the top, so shifting
 * scrollTop by exactly that growth cancels out the visual jump.
 */
export function scrollTopAfterPrepend(
  scrollTopBefore: number,
  scrollHeightBefore: number,
  scrollHeightAfter: number,
): number {
  return scrollTopBefore + (scrollHeightAfter - scrollHeightBefore);
}
