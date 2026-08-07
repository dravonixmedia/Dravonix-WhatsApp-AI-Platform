"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { formatBadgeCount } from "../../lib/notificationBadge.js";
import { BellIcon } from "./Icons.js";
import { useNotificationPanel } from "./NotificationPanelContext.js";

export interface AttentionHandoverItem {
  conversationId: string;
  maskedPhoneNumber: string;
}

export interface AttentionUnreadItem {
  conversationId: string;
  displayName: string;
  unreadCount: number;
}

/**
 * Real, data-backed notification bell (Issue 1 -- see
 * lib/repositories/notificationsRepository.ts's loadNotificationSummary and
 * SupabaseHandoverRepository.countHandoverBadge for exactly where every
 * number below comes from). All data is loaded server-side in
 * DashboardLayout for the caller's own session-derived company -- this
 * component only renders it and toggles the panel open/closed; it never
 * fetches or polls on its own.
 *
 * There is deliberately no "mark as read" action here: handover_mark_read
 * exists for a single conversation (called when its detail page loads,
 * per final plan section 16) but there is no supported bulk/dismiss RPC,
 * so opening this panel intentionally does NOT change any of these counts.
 *
 * Open/closed state lives in NotificationPanelContext (not local useState)
 * so the sidebar's "Notifications" entry can open this same panel without
 * a second, duplicate notification UI -- see NotificationPanelContext.tsx.
 */
export function NotificationBell({
  totalUnreadCustomerMessages,
  unreadConversations,
  pendingHandoverRequests,
  unassignedHandovers,
}: {
  totalUnreadCustomerMessages: number;
  unreadConversations: AttentionUnreadItem[];
  pendingHandoverRequests: AttentionHandoverItem[];
  unassignedHandovers: AttentionHandoverItem[];
}) {
  const { open, toggle, close } = useNotificationPanel();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [close]);

  const hasAnything =
    unreadConversations.length > 0 ||
    pendingHandoverRequests.length > 0 ||
    unassignedHandovers.length > 0;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="dvx-icon-button"
        aria-label={`Notifications: ${totalUnreadCustomerMessages} unread customer message${totalUnreadCustomerMessages === 1 ? "" : "s"}`}
        aria-expanded={open}
        aria-controls="dvx-notification-panel"
        onClick={toggle}
      >
        <BellIcon />
        {totalUnreadCustomerMessages > 0 ? (
          <span className="dvx-icon-button-badge">
            {formatBadgeCount(totalUnreadCustomerMessages)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div id="dvx-notification-panel" className="dvx-search-panel" style={{ width: 340 }}>
          {!hasAnything ? (
            <div className="dvx-search-status">You&apos;re all caught up.</div>
          ) : (
            <>
              {unreadConversations.length > 0 ? (
                <div className="dvx-search-group">
                  <div className="dvx-search-group-label">Unread conversations</div>
                  {unreadConversations.slice(0, 5).map((item) => (
                    <Link
                      key={item.conversationId}
                      href={`/dashboard/conversations/${item.conversationId}`}
                      className="dvx-search-result"
                      onClick={close}
                    >
                      <span style={{ fontWeight: 600 }}>{item.displayName}</span>
                      <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                        {item.unreadCount} unread message{item.unreadCount === 1 ? "" : "s"}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : null}

              {pendingHandoverRequests.length > 0 ? (
                <div className="dvx-search-group">
                  <div className="dvx-search-group-label">Pending handover requests</div>
                  {pendingHandoverRequests.slice(0, 5).map((item) => (
                    <Link
                      key={item.conversationId}
                      href={`/dashboard/handover/${item.conversationId}`}
                      className="dvx-search-result"
                      onClick={close}
                    >
                      <span style={{ fontWeight: 600 }}>{item.maskedPhoneNumber}</span>
                      <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                        Awaiting a human response
                      </span>
                    </Link>
                  ))}
                </div>
              ) : null}

              {unassignedHandovers.length > 0 ? (
                <div className="dvx-search-group">
                  <div className="dvx-search-group-label">Unassigned handovers</div>
                  {unassignedHandovers.slice(0, 5).map((item) => (
                    <Link
                      key={item.conversationId}
                      href={`/dashboard/handover/${item.conversationId}`}
                      className="dvx-search-result"
                      onClick={close}
                    >
                      <span style={{ fontWeight: 600 }}>{item.maskedPhoneNumber}</span>
                      <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                        No team member assigned yet
                      </span>
                    </Link>
                  ))}
                </div>
              ) : null}

              <div className="dvx-search-group" style={{ textAlign: "center" }}>
                <Link
                  href="/dashboard/handover"
                  className="dvx-muted"
                  style={{ fontSize: "0.8rem", display: "inline-block", padding: "0.4rem" }}
                  onClick={close}
                >
                  Open Human Handover Inbox →
                </Link>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
