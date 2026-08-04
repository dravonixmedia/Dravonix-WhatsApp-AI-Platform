/**
 * DELETE is deliberately not a representable value here. Per Supabase's
 * documented Postgres Changes behavior: Row Level Security is evaluated for
 * INSERT/UPDATE (Realtime re-checks visibility of the row), but RLS is NOT
 * applied to DELETE events at all -- every client subscribed to a table's
 * DELETE events receives every DELETE on that table, regardless of their
 * own RLS visibility, and regardless of any client-supplied `filter`
 * parameter (the filter can only be evaluated against columns Realtime
 * actually has for the row; for a multi-tenant table this is not a safe
 * substitute for RLS). None of conversations/messages/conversation_
 * assignments/handover_events has any DELETE code path anywhere in this
 * repo today, so there is nothing to subscribe to and no reason to accept
 * the risk of ever adding it "just in case". "*" is excluded for the same
 * reason -- it silently includes DELETE.
 */
export type SafeRealtimeEvent = "INSERT" | "UPDATE";

const ALLOWED_EVENTS: ReadonlySet<SafeRealtimeEvent> = new Set(["INSERT", "UPDATE"]);

export interface RealtimeWatch {
  table: string;
  /** Postgres column the filter equality applies to, e.g. "company_id" or "conversation_id". */
  filterColumn: string;
  event: SafeRealtimeEvent;
}

export interface RealtimeWatchConfig {
  table: string;
  event: SafeRealtimeEvent;
  filter: string;
}

/**
 * Builds the postgres_changes subscription config for one tenant's realtime
 * channel. There is deliberately no parameter for "which company" other than
 * the caller's own `scopeId` -- every filter is always `<filterColumn>=eq.
 * <scopeId>` for the exact value passed in, so this function has no way to
 * construct a filter for any tenant other than the one the caller supplies.
 * Callers must always pass the current session's own activeCompanyId (or,
 * for a single-conversation/single-lead channel, the id already authorized
 * by the page's own RLS-backed server load) -- never a value read from
 * client-controlled input.
 *
 * The filter string is a convenience scope for INSERT/UPDATE, not the sole
 * security boundary: the real boundary is that the Realtime server
 * evaluates each table's SELECT RLS policy using the connecting user's own
 * JWT (set via supabase.realtime.setAuth(accessToken) before subscribing)
 * -- a client could in principle open a channel with a different filter,
 * but would still only receive INSERT/UPDATE rows its own RLS policies
 * already allow it to see. This does not extend to DELETE, which is why
 * `event` can never be "DELETE" or "*" here (see SafeRealtimeEvent above).
 *
 * The runtime check below is defense-in-depth, not the primary guarantee --
 * TypeScript already makes `event: "DELETE"` a compile error for any caller
 * using RealtimeWatch's real type. It exists for the case where a value
 * reaches this function without having gone through that type (e.g. a
 * future refactor that reads `event` from an untyped source).
 */
export function buildTenantWatchConfig(
  scopeId: string,
  watches: RealtimeWatch[],
): RealtimeWatchConfig[] {
  return watches.map((watch) => {
    if (!ALLOWED_EVENTS.has(watch.event)) {
      throw new Error(
        `Realtime watch for table "${watch.table}" requested forbidden event "${watch.event}" -- ` +
          "only INSERT/UPDATE are allowed. DELETE is not RLS-filtered by Supabase Realtime and must " +
          "never be subscribed to for a multi-tenant table.",
      );
    }
    return {
      table: watch.table,
      event: watch.event,
      filter: `${watch.filterColumn}=eq.${scopeId}`,
    };
  });
}

/** Stable channel name so re-subscribing after a reconnect reuses the same channel identity. */
export function tenantChannelName(namespace: string, scopeId: string): string {
  return `dvx:${namespace}:${scopeId}`;
}
