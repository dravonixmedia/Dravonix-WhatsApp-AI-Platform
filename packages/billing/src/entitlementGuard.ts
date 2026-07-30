import { EntitlementDeniedError } from "@dravonix/core";
import { isServiceBlocked, type SubscriptionState } from "./stateMachine.js";

export type CompanyStatus = "onboarding" | "active" | "suspended" | "manually_suspended" | "closed";

export interface FeatureEntitlement {
  isEnabled: boolean;
  numericLimit: number | null;
}

export interface EntitlementSnapshot {
  companyStatus: CompanyStatus;
  subscriptionState: SubscriptionState;
  /** Merged plan_entitlements + company_entitlements, company-level taking precedence. */
  features: Record<string, FeatureEntitlement>;
  /** Current billing-period usage, keyed the same as the relevant feature's usage metric. */
  usage: Record<string, number>;
}

export interface EntitlementRepository {
  getSnapshot(companyId: string): Promise<EntitlementSnapshot>;
}

/**
 * Every chargeable operation in the platform (Claude, STT, TTS, WhatsApp send,
 * knowledge ingestion) maps to one of these capabilities. Adding a new
 * chargeable operation means adding one entry here, not scattering ad-hoc checks
 * across the codebase.
 */
export type ChargeableCapability =
  "claude_response" | "speech_to_text" | "text_to_speech" | "whatsapp_send" | "knowledge_ingestion";

interface CapabilityRequirement {
  featureKey?: string;
  usageMetric?: string;
}

const CAPABILITY_REQUIREMENTS: Record<ChargeableCapability, CapabilityRequirement> = {
  claude_response: { usageMetric: "monthly_messages" },
  speech_to_text: { featureKey: "voice_enabled", usageMetric: "monthly_voice_minutes" },
  text_to_speech: { featureKey: "voice_enabled", usageMetric: "monthly_voice_minutes" },
  whatsapp_send: {},
  knowledge_ingestion: { featureKey: "document_knowledge_base" },
};

/**
 * Throws EntitlementDeniedError unless `companyId` may currently use
 * `capability`. This is the single required call site for every paid-provider
 * invocation in the platform (ADR-0006) -- callers must not re-implement any of
 * these checks themselves.
 *
 * Check order: company status -> subscription state -> plan/company feature
 * flag -> usage headroom. The first failing check determines the reason.
 */
export async function assertCompanyMayUseProvider(
  repo: EntitlementRepository,
  companyId: string,
  capability: ChargeableCapability,
): Promise<void> {
  const snapshot = await repo.getSnapshot(companyId);

  if (snapshot.companyStatus === "manually_suspended") {
    throw new EntitlementDeniedError(companyId, capability, "company_manually_suspended");
  }
  if (snapshot.companyStatus === "suspended" || snapshot.companyStatus === "closed") {
    throw new EntitlementDeniedError(companyId, capability, "company_suspended");
  }
  if (isServiceBlocked(snapshot.subscriptionState)) {
    throw new EntitlementDeniedError(companyId, capability, "subscription_not_active");
  }

  const requirement = CAPABILITY_REQUIREMENTS[capability];

  if (requirement.featureKey) {
    const feature = snapshot.features[requirement.featureKey];
    if (!feature?.isEnabled) {
      throw new EntitlementDeniedError(companyId, capability, "plan_missing_feature");
    }
  }

  if (requirement.usageMetric) {
    const feature = requirement.featureKey ? snapshot.features[requirement.featureKey] : undefined;
    const limit =
      feature?.numericLimit ?? snapshot.features[requirement.usageMetric]?.numericLimit ?? null;
    const used = snapshot.usage[requirement.usageMetric] ?? 0;
    if (limit !== null && used >= limit) {
      throw new EntitlementDeniedError(companyId, capability, "usage_limit_reached");
    }
  }
}
