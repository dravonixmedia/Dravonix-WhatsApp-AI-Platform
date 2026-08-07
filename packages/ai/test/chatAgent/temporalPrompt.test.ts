import { resolveConversationTemporalContext } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { buildChatAgentSystemPrompt } from "../../src/chatAgent/systemPrompt.js";
import type { ChatAgentInput } from "../../src/chatAgent/types.js";

function baseInput(overrides: Partial<ChatAgentInput> = {}): ChatAgentInput {
  return {
    action: "summarize",
    messages: [
      { direction: "inbound", senderType: "customer", body: "Hi, need a website", createdAt: "t1" },
    ],
    historyTruncated: false,
    company: {
      companyName: "Dravonix Media",
      tone: "friendly_professional",
      enabledLanguages: ["en"],
      fallbackLanguage: "en",
      restrictedTopics: [],
    },
    conversation: { state: "human_active", aiMode: "active" },
    contact: null,
    lead: null,
    temporal: resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: "Europe/London",
      now: new Date("2026-06-10T10:00:00.000Z"),
    }),
    ...overrides,
  };
}

describe("DRAIVA temporal context (Global Timezone + Daypart Awareness)", () => {
  it("receives both business and customer temporal context, clearly separated", () => {
    const prompt = buildChatAgentSystemPrompt(baseInput());
    expect(prompt).toContain("CURRENT TEMPORAL CONTEXT");
    expect(prompt).toContain("BUSINESS:");
    expect(prompt).toContain("Timezone: Asia/Dubai");
    expect(prompt).toContain("CUSTOMER:");
    expect(prompt).toContain("Timezone: Europe/London");
  });

  it("explicitly instructs the two-perspective distinction: customer phrases use customer time, staff operational questions use business time", () => {
    const prompt = buildChatAgentSystemPrompt(baseInput());
    expect(prompt).toMatch(/interpret phrases the customer said.*using the customer local time/i);
    expect(prompt).toMatch(
      /interpret a staff member's own question to you.*using the business local time/i,
    );
  });

  it("reports customer timezone as UNKNOWN rather than falling back to the business timezone", () => {
    const prompt = buildChatAgentSystemPrompt(
      baseInput({
        temporal: resolveConversationTemporalContext({
          companyTimezone: "Asia/Dubai",
          customerTimezone: null,
          now: new Date("2026-06-10T10:00:00.000Z"),
        }),
      }),
    );
    expect(prompt).toMatch(/CUSTOMER:\s*\nTimezone: UNKNOWN/);
  });

  it("still gates on the existing prompt-injection defense, safety rules, and never grants a send capability", () => {
    const prompt = buildChatAgentSystemPrompt(baseInput());
    expect(prompt).toMatch(/never send a message automatically/i);
    expect(prompt).toMatch(/UNTRUSTED CONTENT/i);
  });
});
