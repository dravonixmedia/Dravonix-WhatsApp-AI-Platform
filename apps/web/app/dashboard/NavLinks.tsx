"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { formatBadgeCount } from "../../lib/notificationBadge.js";
import { SparkleIcon } from "./Icons.js";
import { useNotificationPanel } from "./NotificationPanelContext.js";

export interface NavLinkItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  badgeCount?: number;
}

/**
 * One ordered sidebar list mixes plain route links with two specially
 * rendered entries: "notifications" (a button that opens the existing
 * NotificationBell dropdown via shared context, not a route of its own) and
 * "draiva" (the two-line DRAIVA AI card, section 5 of the sidebar polish
 * spec). Both are excluded from Link/active-route styling on purpose --
 * neither is a navigable page.
 */
export type SidebarNavEntry =
  | ({ kind: "link" } & NavLinkItem)
  | { kind: "notifications"; label: string; icon: React.ReactNode; badgeCount: number }
  | { kind: "draiva" };

function isActive(pathname: string, href: string): boolean {
  const path = href.split("#")[0] ?? href;
  if (path === "/dashboard") return pathname === "/dashboard";
  return pathname === path || pathname.startsWith(`${path}/`);
}

// Matches only a single conversation's detail route -- /dashboard/conversations/<id>
// or /dashboard/handover/<id> -- which is exactly where
// ConversationComposerWithAssistant (and therefore ChatAgentPanel) is
// mounted. List pages (/dashboard/conversations, /dashboard/handover) and
// any deeper subpath deliberately do not match.
const CONVERSATION_DETAIL_ROUTE = /^\/dashboard\/(?:conversations|handover)\/[^/]+\/?$/;

/**
 * Client component so the sidebar can highlight the current route via
 * usePathname() -- the surrounding DashboardLayout stays a Server Component
 * (session/handover-badge data still loads server-side); only this small
 * nav slice needs client-side route awareness.
 */
export function NavLinks({ entries }: { entries: SidebarNavEntry[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const { toggle: toggleNotifications } = useNotificationPanel();

  function handleDraivaClick() {
    // Existing DRAIVA panel is owned by ConversationComposerWithAssistant on
    // a conversation's own detail page -- reuse it via a plain DOM event
    // rather than lifting its state or duplicating ChatAgentPanel here (see
    // that component's own listener for "dvx:open-draiva"). Off a detail
    // page, there's nothing to open yet, so route the user there to pick one.
    if (CONVERSATION_DETAIL_ROUTE.test(pathname)) {
      window.dispatchEvent(new Event("dvx:open-draiva"));
      return;
    }
    router.push("/dashboard/conversations");
  }

  return (
    <nav className="dvx-nav-rail" aria-label="Dashboard">
      {entries.map((entry) => {
        if (entry.kind === "notifications") {
          return (
            <button
              key="dvx-nav-notifications"
              type="button"
              className="dvx-nav-link dvx-nav-card"
              onClick={toggleNotifications}
              aria-haspopup="true"
              aria-controls="dvx-notification-panel"
            >
              {entry.icon}
              <span className="dvx-nav-card-label">{entry.label}</span>
              {entry.badgeCount > 0 ? (
                <span className="dvx-nav-badge">{formatBadgeCount(entry.badgeCount)}</span>
              ) : null}
            </button>
          );
        }

        if (entry.kind === "draiva") {
          return (
            <button
              key="dvx-nav-draiva"
              type="button"
              className="dvx-nav-link dvx-nav-card dvx-draiva-nav-card"
              onClick={handleDraivaClick}
              aria-label="DRAIVA AI Conversation Assistant by Dravonix"
            >
              <SparkleIcon size={16} />
              <span className="dvx-draiva-nav-text">
                <span className="dvx-draiva-nav-title">DRAIVA AI</span>
                <span className="dvx-draiva-nav-subtitle">
                  Conversation Assistant by
                  <span className="dvx-draiva-brand"> Dravonix</span>
                </span>
              </span>
            </button>
          );
        }

        const active = isActive(pathname, entry.href);
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={active ? "page" : undefined}
            className={`dvx-nav-link dvx-nav-card${active ? " dvx-nav-link--active" : ""}`}
          >
            {entry.icon}
            <span className="dvx-nav-card-label">{entry.label}</span>
            {entry.badgeCount && entry.badgeCount > 0 ? (
              <span className="dvx-nav-badge">{formatBadgeCount(entry.badgeCount)}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
