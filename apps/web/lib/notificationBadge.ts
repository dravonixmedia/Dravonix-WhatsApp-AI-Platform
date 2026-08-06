/**
 * Shared badge-label formatting, pulled out of
 * lib/repositories/notificationsRepository.ts so client components (e.g.
 * NavLinks.tsx, NotificationBell.tsx) can format a count without bundling
 * that repository's Supabase-client-typed query code into client JS.
 */
export const NOTIFICATION_BADGE_DISPLAY_CAP = 99;

/** Caps the visible bell/nav badge label at "99+" without altering the real underlying count used anywhere else. */
export function formatBadgeCount(count: number): string {
  return count > NOTIFICATION_BADGE_DISPLAY_CAP
    ? `${NOTIFICATION_BADGE_DISPLAY_CAP}+`
    : String(count);
}
