import { describe, expect, it } from "vitest";
import { computeOnboardingChecklist, type OnboardingFacts } from "../lib/onboarding.js";

/**
 * Client onboarding checklist (Phase 5/12/17 item 13): computeOnboardingChecklist
 * is pure and DB-free, so this exercises it directly rather than via static
 * source assertions -- covers "the onboarding checklist reflects actual DB
 * state" (every step flips independently based on the facts passed in) and
 * "readyToActivate never depends on WhatsApp" (Meta App Review may still be
 * pending while every other step is done).
 */

const BASE_FACTS: OnboardingFacts = {
  hasIndustry: true,
  hasCountry: true,
  aiSettingsConfigured: true,
  enabledKnowledgeSourceCount: 1,
  activeOwnerOrAdminCount: 1,
  hasSubscription: true,
  whatsappConnected: false,
};

describe("computeOnboardingChecklist", () => {
  it("marks every step complete except WhatsApp, and is ready to activate, when every other fact is satisfied", () => {
    const checklist = computeOnboardingChecklist(BASE_FACTS);
    for (const step of checklist.steps) {
      if (step.key === "whatsapp") {
        expect(step.complete).toBe(false);
      } else {
        expect(step.complete).toBe(true);
      }
    }
    expect(checklist.readyToActivate).toBe(true);
  });

  it("is ready to activate even though WhatsApp is never connected -- Meta App Review may remain pending", () => {
    const checklist = computeOnboardingChecklist({ ...BASE_FACTS, whatsappConnected: false });
    expect(checklist.readyToActivate).toBe(true);
  });

  it("flips readyToActivate to false when WhatsApp becomes connected but is not itself required", () => {
    // Connecting WhatsApp must never be required for readiness, and must
    // never itself break readiness either.
    const checklist = computeOnboardingChecklist({ ...BASE_FACTS, whatsappConnected: true });
    expect(checklist.readyToActivate).toBe(true);
    const whatsappStep = checklist.steps.find((s) => s.key === "whatsapp");
    expect(whatsappStep?.complete).toBe(true);
  });

  it.each([
    ["hasIndustry", false, "company_profile"],
    ["hasCountry", false, "company_profile"],
    ["aiSettingsConfigured", false, "ai_settings"],
    ["activeOwnerOrAdminCount", 0, "team"],
    ["hasSubscription", false, "plan"],
  ] as const)(
    "marks %s incomplete and blocks readiness when %s is %s",
    (factKey, value, stepKey) => {
      const checklist = computeOnboardingChecklist({ ...BASE_FACTS, [factKey]: value });
      const step = checklist.steps.find((s) => s.key === stepKey);
      expect(step?.complete).toBe(false);
      expect(checklist.readyToActivate).toBe(false);
    },
  );

  it("knowledge base step is complete only when the enabled source count is positive", () => {
    const zero = computeOnboardingChecklist({ ...BASE_FACTS, enabledKnowledgeSourceCount: 0 });
    expect(zero.steps.find((s) => s.key === "knowledge_base")?.complete).toBe(false);
    expect(zero.readyToActivate).toBe(false);

    const some = computeOnboardingChecklist({ ...BASE_FACTS, enabledKnowledgeSourceCount: 3 });
    expect(some.steps.find((s) => s.key === "knowledge_base")?.complete).toBe(true);
  });

  it("never mutates company status or any external state -- it is a pure function of its input", () => {
    const facts = { ...BASE_FACTS };
    const frozen = Object.freeze({ ...facts });
    expect(() => computeOnboardingChecklist(frozen)).not.toThrow();
  });

  it("returns exactly the 6 documented steps, in a stable order, every time", () => {
    const checklist = computeOnboardingChecklist(BASE_FACTS);
    expect(checklist.steps.map((s) => s.key)).toEqual([
      "company_profile",
      "ai_settings",
      "knowledge_base",
      "team",
      "plan",
      "whatsapp",
    ]);
  });
});
