"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatBadgeCount } from "../../lib/notificationBadge.js";
import { SparkleIcon } from "./Icons.js";

export interface NavLinkItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  badgeCount?: number;
  /**
   * When true, this entry is only active on an exact pathname match --
   * never on a sub-route. Needed for Company Settings (/dashboard/settings):
   * WhatsApp Connection (/dashboard/settings/whatsapp) is a distinct sidebar
   * destination nested one level below it, and without this flag the default
   * prefix-match behavior would highlight both entries simultaneously while
   * viewing WhatsApp Connection.
   */
  exact?: boolean;
}

/**
 * One ordered sidebar list mixes plain route links with one specially
 * rendered entry: "draiva" (the two-line DRAIVA AI card, section 5 of the
 * sidebar polish spec). Both Notifications and DRAIVA are now real,
 * server-rendered dashboard destinations (/dashboard/notifications,
 * /dashboard/draiva) -- the sidebar item is nothing more than a Link to
 * each, exactly like Overview or Leads. "draiva" only exists as its own
 * entry kind because it needs the two-line card layout, not because it
 * behaves differently as a navigation target.
 */
export type SidebarNavEntry = ({ kind: "link" } & NavLinkItem) | { kind: "draiva"; href: string };

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (href === "/dashboard" || exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Unchecks the existing checkbox-driven mobile drawer (see layout.tsx's
// #dvx-nav-toggle) after a sidebar navigation. A <Link> click is a
// same-instance client-side route change, so the checkbox's own DOM node
// (and therefore its checked state) survives the navigation unless cleared
// explicitly -- this is a no-op on desktop, where the checkbox is never
// checked in the first place.
function closeMobileDrawer(): void {
  const toggle = document.getElementById("dvx-nav-toggle");
  if (toggle instanceof HTMLInputElement && toggle.checked) {
    toggle.checked = false;
  }
}

/**
 * Client component so the sidebar can highlight the current route via
 * usePathname() -- the surrounding DashboardLayout stays a Server Component
 * (session/handover-badge data still loads server-side); only this small
 * nav slice needs client-side route awareness.
 */
export function NavLinks({ entries }: { entries: SidebarNavEntry[] }) {
  const pathname = usePathname();

  return (
    <nav className="dvx-nav-rail" aria-label="Dashboard">
      {entries.map((entry) => {
        if (entry.kind === "draiva") {
          const active = isActive(pathname, entry.href);
          return (
            <Link
              key="dvx-nav-draiva"
              href={entry.href}
              aria-current={active ? "page" : undefined}
              onClick={closeMobileDrawer}
              className={`dvx-nav-link dvx-nav-card dvx-draiva-nav-card${active ? " dvx-nav-link--active" : ""}`}
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
            </Link>
          );
        }

        const active = isActive(pathname, entry.href, entry.exact);
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={active ? "page" : undefined}
            onClick={closeMobileDrawer}
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
