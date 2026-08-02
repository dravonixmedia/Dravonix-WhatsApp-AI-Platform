import type { AiGenerationInput } from "../src/provider.js";

export function makeInput(overrides: Partial<AiGenerationInput> = {}): AiGenerationInput {
  return {
    company: {
      companyId: "aaaaaaaa-0000-0000-0000-000000000001",
      companyName: "Dravonix Media",
      botName: "Dravonix Assistant",
      tone: "friendly_professional",
      enabledLanguages: ["en", "ml"],
      fallbackLanguage: "en",
      approvedServices: ["Website Development", "AI Automation"],
      approvedProducts: [],
      pricingRules: ["Website Development starts at INR 25,000 (demo pricing)"],
      businessHours: "Mon-Fri 10:00-18:00 IST",
      policies: ["Refunds are processed within 7 business days."],
      faqs: [{ question: "Do you build e-commerce sites?", answer: "Yes, we do." }],
      restrictedTopics: ["medical advice", "legal advice"],
      requiredDisclaimers: [],
      handoverRules: ["customer asks for a human"],
      confidenceThreshold: 0.55,
      staticFallbackMessage:
        "Automated assistance is temporarily unavailable. Our team will respond as soon as possible.",
      voiceEnabled: true,
    },
    memory: {
      recentMessages: [],
      summary: null,
      leadState: {},
      unresolvedQuestions: [],
      customerReplyPreference: null,
      lastDetectedLanguage: null,
    },
    knowledge: [],
    customerMessage: "Hi, what services do you offer?",
    currentMessageChannel: "text",
    ...overrides,
  };
}
