import { describe, expect, it } from "vitest";
import { MockChatAgentProvider } from "../../src/chatAgent/mockProvider.js";
import { runChatAgentAction } from "../../src/chatAgent/orchestrate.js";
import { ChatAgentResponseError, ChatAgentValidationError } from "../../src/chatAgent/errors.js";
import type { ChatAgentInput } from "../../src/chatAgent/types.js";

function baseInput(overrides: Partial<ChatAgentInput> = {}): ChatAgentInput {
  return {
    action: "suggest_reply",
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
    ...overrides,
  };
}

describe("runChatAgentAction", () => {
  it("calls the provider exactly once with the built system prompt and instruction, and returns the parsed result", async () => {
    const provider = new MockChatAgentProvider(() => "Sure, happy to help with your website!");
    const result = await runChatAgentAction(provider, baseInput());

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.system).toMatch(/internal AI copilot/i);
    expect(provider.calls[0]?.userMessage).toMatch(/Draft ONE customer-ready reply/i);
    expect(result).toEqual({
      action: "suggest_reply",
      displayText: "Sure, happy to help with your website!",
      structured: undefined,
      historyTruncated: false,
    });
  });

  it("validates required action fields before ever calling the provider", async () => {
    const provider = new MockChatAgentProvider();
    await expect(
      runChatAgentAction(provider, baseInput({ action: "ask_question" })),
    ).rejects.toBeInstanceOf(ChatAgentValidationError);
    expect(provider.calls).toHaveLength(0);
  });

  it("propagates a response-parsing failure for a structured action without inventing a result", async () => {
    const provider = new MockChatAgentProvider(() => "not valid json");
    await expect(
      runChatAgentAction(provider, baseInput({ action: "summarize" })),
    ).rejects.toBeInstanceOf(ChatAgentResponseError);
  });

  it("propagates the historyTruncated flag through to the result", async () => {
    const provider = new MockChatAgentProvider(() => "A concise reply.");
    const result = await runChatAgentAction(provider, baseInput({ historyTruncated: true }));
    expect(result.historyTruncated).toBe(true);
  });

  it("returns the structured object alongside displayText for summarize", async () => {
    const provider = new MockChatAgentProvider(() =>
      JSON.stringify({
        customerRequest: "Website",
        importantDetails: [],
        currentStatus: "New",
        unansweredQuestions: [],
        recommendedNextStep: "Reply",
      }),
    );
    const result = await runChatAgentAction(provider, baseInput({ action: "summarize" }));
    expect(result.structured).toMatchObject({ customerRequest: "Website" });
    expect(result.displayText).toContain("Customer request: Website");
  });
});
