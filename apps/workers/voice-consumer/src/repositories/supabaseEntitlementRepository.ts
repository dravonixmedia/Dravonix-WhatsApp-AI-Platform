import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EntitlementRepository,
  EntitlementSnapshot,
  FeatureEntitlement,
} from "@dravonix/billing";

/**
 * Production implementation of EntitlementRepository (ADR-0006) for the voice
 * consumer: merges plan_entitlements + company_entitlements (company-level
 * taking precedence), and computes current-period usage for
 * monthly_voice_minutes from media_files.duration_seconds.
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
      // No subscription row yet -- treat as fully blocked rather than silently
      // allowing an unconfigured tenant to consume paid providers.
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
            .from("media_files")
            .select("duration_seconds")
            .eq("company_id", companyId)
            .in("kind", ["inbound_audio", "outbound_audio"])
            .gte("created_at", subscription.current_period_start)
        : Promise.resolve({ data: [], error: null }),
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
    // Company-level overrides take precedence over the plan (ADR-0006).
    for (const row of companyEntitlementsResult.data ?? []) {
      features[row.feature_key] = {
        isEnabled: row.is_enabled,
        numericLimit: row.numeric_limit === null ? null : Number(row.numeric_limit),
      };
    }

    const totalSeconds = (usageResult.data ?? []).reduce(
      (sum: number, row: { duration_seconds: number | null }) => sum + (row.duration_seconds ?? 0),
      0,
    );

    return {
      companyStatus: companyResult.data.status,
      subscriptionState: subscription.state,
      features,
      usage: {
        monthly_voice_minutes: totalSeconds / 60,
      },
    };
  }
}
