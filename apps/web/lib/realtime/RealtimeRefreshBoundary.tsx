"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useTenantRealtimeChannel } from "./useTenantRealtimeChannel.js";
import type { RealtimeWatch } from "./tenantChannel.js";

const REFRESH_DEBOUNCE_MS = 500;

export interface RealtimeRefreshBoundaryProps {
  namespace: string;
  scopeId: string;
  accessToken: string;
  watches: RealtimeWatch[];
}

/**
 * Renders nothing -- mounted on a Server Component page to keep its already
 * server-rendered data live. Any change on a watched table triggers a
 * debounced router.refresh(), which re-runs the page's own server data
 * loader (already tenant-scoped, permission-checked, and correctly shaped)
 * rather than duplicating that query logic client-side. Used for
 * list/inbox-style pages (Live Conversations, Human Handover Inbox) where a
 * full authoritative re-render is the simplest correct behavior; the
 * message-thread page instead patches state in place for a smoother feel
 * (see ConversationThread.tsx's own realtime wiring).
 */
export function RealtimeRefreshBoundary({
  namespace,
  scopeId,
  accessToken,
  watches,
}: RealtimeRefreshBoundaryProps) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  function refreshSoon() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
  }

  useTenantRealtimeChannel({
    namespace,
    scopeId,
    accessToken,
    watches,
    onChange: refreshSoon,
    onStaleReconnect: refreshSoon,
  });

  return null;
}
