/**
 * Pure derivation of the client onboarding checklist from already-fetched
 * database facts -- no DB access here, so this is trivially unit-testable
 * and shared between the client dashboard's checklist page and the Super
 * Admin company detail page. Never writes anything; company.status is never
 * changed as a side effect of these steps being complete (Phase 12:
 * activation stays a separate, explicit Super Admin action).
 */

export interface OnboardingFacts {
  hasIndustry: boolean;
  hasCountry: boolean;
  aiSettingsConfigured: boolean;
  enabledKnowledgeSourceCount: number;
  activeOwnerOrAdminCount: number;
  hasSubscription: boolean;
  whatsappConnected: boolean;
}

export interface OnboardingStep {
  key: "company_profile" | "ai_settings" | "knowledge_base" | "team" | "plan" | "whatsapp";
  label: string;
  complete: boolean;
  detail: string;
}

export interface OnboardingChecklist {
  steps: OnboardingStep[];
  readyToActivate: boolean;
}

export function computeOnboardingChecklist(facts: OnboardingFacts): OnboardingChecklist {
  const companyProfileComplete = facts.hasIndustry && facts.hasCountry;
  const teamComplete = facts.activeOwnerOrAdminCount > 0;
  const knowledgeComplete = facts.enabledKnowledgeSourceCount > 0;

  const steps: OnboardingStep[] = [
    {
      key: "company_profile",
      label: "Company Profile",
      complete: companyProfileComplete,
      detail: companyProfileComplete
        ? "Industry and country are set."
        : "Add your industry and country in Company Settings.",
    },
    {
      key: "ai_settings",
      label: "AI Settings",
      complete: facts.aiSettingsConfigured,
      detail: facts.aiSettingsConfigured
        ? "Assistant identity and behavior are configured."
        : "Set your assistant's name and welcome message in AI Settings.",
    },
    {
      key: "knowledge_base",
      label: "Knowledge Base",
      complete: knowledgeComplete,
      detail: knowledgeComplete
        ? `${facts.enabledKnowledgeSourceCount} enabled knowledge source${facts.enabledKnowledgeSourceCount === 1 ? "" : "s"}.`
        : "Add at least one enabled knowledge source.",
    },
    {
      key: "team",
      label: "Team",
      complete: teamComplete,
      detail: teamComplete
        ? `${facts.activeOwnerOrAdminCount} active owner/admin.`
        : "Invite at least one active owner or admin.",
    },
    {
      key: "plan",
      label: "Plan / Entitlements",
      complete: facts.hasSubscription,
      detail: facts.hasSubscription
        ? "A plan is assigned."
        : "Waiting for Dravonix to assign a plan.",
    },
    {
      key: "whatsapp",
      label: "WhatsApp Connection",
      complete: facts.whatsappConnected,
      detail: facts.whatsappConnected
        ? "WhatsApp is connected."
        : "Meta App Review in progress — WhatsApp connection will be enabled after approval.",
    },
  ];

  // WhatsApp may remain pending while Meta review is in progress -- every
  // other step must be complete for "ready to activate."
  const readyToActivate = steps
    .filter((step) => step.key !== "whatsapp")
    .every((step) => step.complete);

  return { steps, readyToActivate };
}
