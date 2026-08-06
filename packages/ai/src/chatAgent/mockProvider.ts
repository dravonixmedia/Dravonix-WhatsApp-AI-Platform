import type { ChatAgentProvider } from "./provider.js";

export type ChatAgentMockResponder = (system: string, userMessage: string) => string;

/**
 * Deterministic ChatAgentProvider for local development (no ANTHROPIC_API_KEY)
 * and tests -- mirrors MockAiProvider's role for the customer-reply pipeline.
 */
export class MockChatAgentProvider implements ChatAgentProvider {
  public respond: ChatAgentMockResponder;
  public calls: Array<{ system: string; userMessage: string }> = [];

  constructor(respond?: ChatAgentMockResponder) {
    this.respond = respond ?? (() => "This is a mock Chat Agent response.");
  }

  async generateText(system: string, userMessage: string): Promise<string> {
    this.calls.push({ system, userMessage });
    return this.respond(system, userMessage);
  }
}
