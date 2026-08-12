import { describe, expect, it } from "vitest";
import { resolveConversationTemporalContext } from "@dravonix/core";
import { DRAIVA_LANGUAGE_POLICY } from "../src/prompt/languagePolicy.js";
import { buildSystemPrompt } from "../src/prompt/buildSystemPrompt.js";
import { buildChatAgentSystemPrompt } from "../src/chatAgent/systemPrompt.js";
import { makeInput } from "./fixtures.js";
import type { ChatAgentInput } from "../src/chatAgent/types.js";

/**
 * Single-source-of-truth guarantee (final plan section 1): every prompt
 * builder that states DRAIVA's customer-facing multilingual policy must
 * reuse the exact same canonical sentence, never a slightly different
 * paraphrase, so the customer-facing bot and the internal staff copilot
 * never drift into disagreement about what DRAIVA actually does.
 */
describe("DRAIVA_LANGUAGE_POLICY (canonical multilingual policy sentence)", () => {
  it("is the exact, product-approved wording", () => {
    expect(DRAIVA_LANGUAGE_POLICY).toBe(
      "DRAIVA responds in the customer's language whenever it can reasonably determine the language.",
    );
  });

  it("is included verbatim in the customer-facing WhatsApp AI system prompt", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toContain(DRAIVA_LANGUAGE_POLICY);
  });

  it("is included verbatim in the internal DRAIVA staff-copilot system prompt", () => {
    const input: ChatAgentInput = {
      action: "summarize",
      messages: [],
      historyTruncated: false,
      company: {
        companyName: "Dravonix Media",
        tone: "friendly_professional",
        enabledLanguages: ["en", "ml"],
        fallbackLanguage: "en",
        restrictedTopics: [],
      },
      conversation: { state: "human_active", aiMode: "active" },
      contact: null,
      lead: null,
      temporal: resolveConversationTemporalContext({
        companyTimezone: "Asia/Kolkata",
        customerTimezone: null,
        now: new Date("2026-01-15T09:00:00.000Z"),
      }),
    };
    const prompt = buildChatAgentSystemPrompt(input);
    expect(prompt).toContain(DRAIVA_LANGUAGE_POLICY);
  });
});
