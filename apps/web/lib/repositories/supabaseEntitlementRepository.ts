import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EntitlementRepository,
  EntitlementSnapshot,
  FeatureEntitlement,
} from "@dravonix/billing";

/**
 * Mirrors apps/workers/message-consumer's SupabaseEntitlementRepository
 * (ADR-0006) so the dashboard's human-reply send path enforces the same
 * whatsapp_send entitlement check as the AI reply path, rather than
 * re-implementing or skipping it.
 */
export class SupabaseEntitlementRepository implements EntitlementRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getSnapshot(companyId: string): Promise<EntitlementSnapshot> {
    const [companyResult, subscriptionResult] = await Promise.all([
      this.client.from("companies").select("status").eq("id", companyId).single(),
      this.client
        .from("subscriptions")
        .select("state, plan_version_id, current_period_start")
        .eq("company_id", companyId)
        .maybeSingle(),
    ]);
    if (companyResult.error) throw companyResult.error;
    if (subscriptionResult.error) throw subscriptionResult.error;

    const subscription = subscriptionResult.data;
    if (!subscription) {
      return {
        companyStatus: companyResult.data.status,
        subscriptionState: "closed",
        features: {},
        usage: {},
      };
    }

    const [planEntitlementsResult, companyEntitlementsResult, usageResult] = await Promise.all([
      this.client
        .from("plan_entitlements")
        .select("feature_key, numeric_limit, is_enabled")
        .eq("plan_version_id", subscription.plan_version_id),
      this.client
        .from("company_entitlements")
        .select("feature_key, numeric_limit, is_enabled")
        .eq("company_id", companyId),
      subscription.current_period_start
        ? this.client
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .eq("direction", "outbound")
            .eq("sender_type", "ai")
            .gte("created_at", subscription.current_period_start)
        : Promise.resolve({ count: 0, error: null }),
    ]);
    if (planEntitlementsResult.error) throw planEntitlementsResult.error;
    if (companyEntitlementsResult.error) throw companyEntitlementsResult.error;
    if (usageResult.error) throw usageResult.error;

    const features: Record<string, FeatureEntitlement> = {};
    for (const row of planEntitlementsResult.data ?? []) {
      features[row.feature_key] = {
        isEnabled: row.is_enabled,
        numericLimit: row.numeric_limit === null ? null : Number(row.numeric_limit),
      };
    }
    for (const row of companyEntitlementsResult.data ?? []) {
      features[row.feature_key] = {
        isEnabled: row.is_enabled,
        numericLimit: row.numeric_limit === null ? null : Number(row.numeric_limit),
      };
    }

    return {
      companyStatus: companyResult.data.status,
      subscriptionState: subscription.state,
      features,
      usage: {
        monthly_messages: usageResult.count ?? 0,
      },
    };
  }
}
