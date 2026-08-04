export interface RealtimeWatch {
  table: string;
  /** Postgres column the filter equality applies to, e.g. "company_id" or "conversation_id". */
  filterColumn: string;
  event?: "INSERT" | "UPDATE" | "DELETE" | "*";
}

export interface RealtimeWatchConfig {
  table: string;
  event: "INSERT" | "UPDATE" | "DELETE" | "*";
  filter: string;
}

/**
 * Builds the postgres_changes subscription config for one tenant's realtime
 * channel. There is deliberately no parameter for "which company" other than
 * the caller's own `scopeId` -- every filter is always `<filterColumn>=eq.
 * <scopeId>` for the exact value passed in, so this function has no way to
 * construct a filter for any tenant other than the one the caller supplies.
 * Callers must always pass the current session's own activeCompanyId (or,
 * for a single-conversation channel, the conversationId already authorized
 * by the page's own RLS-backed server load) -- never a value read from
 * client-controlled input.
 *
 * The filter string is a convenience scope, not the security boundary: the
 * real boundary is that the Realtime server evaluates each table's SELECT
 * RLS policy using the connecting user's own JWT (set via
 * supabase.realtime.setAuth(accessToken) before subscribing) -- a client
 * could in principle open a channel with a different filter, but would still
 * only receive rows its own RLS policies already allow it to see.
 */
export function buildTenantWatchConfig(
  scopeId: string,
  watches: RealtimeWatch[],
): RealtimeWatchConfig[] {
  return watches.map((watch) => ({
    table: watch.table,
    event: watch.event ?? "*",
    filter: `${watch.filterColumn}=eq.${scopeId}`,
  }));
}

/** Stable channel name so re-subscribing after a reconnect reuses the same channel identity. */
export function tenantChannelName(namespace: string, scopeId: string): string {
  return `dvx:${namespace}:${scopeId}`;
}
