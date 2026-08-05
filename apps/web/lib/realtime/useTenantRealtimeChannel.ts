"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createBrowserSupabaseClient } from "../supabase/client.js";
import { buildTenantWatchConfig, tenantChannelName, type RealtimeWatch } from "./tenantChannel.js";

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

export interface UseTenantRealtimeChannelOptions {
  /** Namespace + scopeId together form a stable channel name (e.g. "company"/companyId, or "conversation"/conversationId). */
  namespace: string;
  scopeId: string;
  accessToken: string;
  watches: RealtimeWatch[];
  onChange: (
    table: string,
    payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
  ) => void;
  /**
   * Called once whenever the channel comes back up after having been
   * dropped (network blip, backgrounded tab, expired token) -- the signal to
   * discard any incrementally-patched local state and refetch an
   * authoritative snapshot, since events that occurred while disconnected
   * were missed.
   */
  onStaleReconnect: () => void;
  /** Disables the whole hook, e.g. while accessToken/scopeId aren't ready yet. */
  enabled?: boolean;
}

export type TenantRealtimeStatus = "connecting" | "connected" | "reconnecting";

/**
 * Opens one tenant-scoped Supabase Realtime channel and keeps it alive:
 * reconnects with bounded exponential backoff on error/close/timeout, and
 * proactively resyncs when the tab is foregrounded or the browser comes back
 * online (a dropped channel doesn't always fire its own error event
 * promptly when a laptop sleeps or a tab is backgrounded).
 *
 * Returns the channel's current status purely for UI purposes (e.g. showing
 * a "Reconnecting..." indicator) -- it never affects reconnect behavior
 * itself, which is unconditional regardless of whether anything reads it.
 */
export function useTenantRealtimeChannel({
  namespace,
  scopeId,
  accessToken,
  watches,
  onChange,
  onStaleReconnect,
  enabled = true,
}: UseTenantRealtimeChannelOptions): { status: TenantRealtimeStatus } {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onStaleReconnectRef = useRef(onStaleReconnect);
  onStaleReconnectRef.current = onStaleReconnect;
  const [status, setStatus] = useState<TenantRealtimeStatus>("connecting");

  useEffect(() => {
    if (!enabled || !accessToken || !scopeId || watches.length === 0) return;

    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let hasConnectedOnce = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any;

    const client = createBrowserSupabaseClient();

    function teardown() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (channel) client.removeChannel(channel);
    }

    function connect() {
      if (cancelled) return;
      client.realtime.setAuth(accessToken);

      channel = client.channel(tenantChannelName(namespace, scopeId));
      for (const watch of buildTenantWatchConfig(scopeId, watches)) {
        channel.on(
          "postgres_changes",
          { event: watch.event, schema: "public", table: watch.table, filter: watch.filter },
          (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) =>
            onChangeRef.current(watch.table, payload),
        );
      }

      channel.subscribe((channelStatus: string) => {
        if (cancelled) return;
        if (channelStatus === "SUBSCRIBED") {
          if (hasConnectedOnce) onStaleReconnectRef.current();
          hasConnectedOnce = true;
          attempt = 0;
          setStatus("connected");
          return;
        }
        if (
          channelStatus === "CHANNEL_ERROR" ||
          channelStatus === "TIMED_OUT" ||
          channelStatus === "CLOSED"
        ) {
          scheduleReconnect();
        }
      });
    }

    function scheduleReconnect() {
      if (cancelled) return;
      if (channel) client.removeChannel(channel);
      setStatus(hasConnectedOnce ? "reconnecting" : "connecting");
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    function handleVisibilityOrOnline() {
      if (document.visibilityState !== "visible") return;
      // Only force a reconnect if the channel isn't already healthy -- a
      // tab foregrounding/network-online event fires far more often than
      // the channel actually drops, and this must not cause a resync churn
      // on every routine tab switch.
      if (channel && channel.state === "joined") return;
      scheduleReconnect();
    }

    connect();
    window.addEventListener("online", handleVisibilityOrOnline);
    document.addEventListener("visibilitychange", handleVisibilityOrOnline);

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleVisibilityOrOnline);
      document.removeEventListener("visibilitychange", handleVisibilityOrOnline);
      teardown();
    };
  }, [namespace, scopeId, accessToken, enabled, JSON.stringify(watches)]);

  return { status };
}
