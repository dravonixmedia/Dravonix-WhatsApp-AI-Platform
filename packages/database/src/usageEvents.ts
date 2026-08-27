import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsageEventInsert } from "./types.js";

/**
 * Writes one or more raw usage_events rows idempotently. Backend/service-role
 * use only (usage_events has no INSERT policy for authenticated/anon --
 * see migration 8 -- so this must always run with a service-role client).
 *
 * Idempotency is enforced by the database itself, not by this function:
 * usage_events.idempotency_key carries a `unique` constraint (migration 8),
 * and this issues an upsert with `ignoreDuplicates: true` on that column, so
 * a queue retry that recomputes and re-submits the exact same idempotency
 * key for an already-recorded event is a silent no-op rather than a
 * duplicate row or a thrown error -- the caller never needs its own
 * check-then-insert logic.
 *
 * A no-op input array is a no-op call (no request is made).
 */
export async function recordUsageEvents(
  client: SupabaseClient,
  events: UsageEventInsert[],
): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map((event) => ({
    company_id: event.companyId,
    metric: event.metric,
    quantity: event.quantity,
    idempotency_key: event.idempotencyKey,
    conversation_id: event.conversationId ?? null,
    is_billable: event.isBillable ?? true,
    provider_request_id: event.providerRequestId ?? null,
  }));

  const { error } = await client
    .from("usage_events")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}
