"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface NotificationPanelContextValue {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const NotificationPanelContext = createContext<NotificationPanelContextValue | null>(null);

/**
 * Lets the sidebar's "Notifications" entry and the topbar bell icon share
 * one open/closed boolean for the same NotificationBell dropdown, without
 * either component duplicating the other's data-loading or rendering logic
 * (Human Handover Inbox final plan section 15's "no new state management
 * duplication" rule, applied to the sidebar polish pass).
 */
export function NotificationPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo<NotificationPanelContextValue>(
    () => ({
      open,
      toggle: () => setOpen((v) => !v),
      close: () => setOpen(false),
    }),
    [open],
  );

  return (
    <NotificationPanelContext.Provider value={value}>{children}</NotificationPanelContext.Provider>
  );
}

export function useNotificationPanel(): NotificationPanelContextValue {
  const ctx = useContext(NotificationPanelContext);
  if (!ctx) {
    throw new Error("useNotificationPanel must be used within a NotificationPanelProvider");
  }
  return ctx;
}
