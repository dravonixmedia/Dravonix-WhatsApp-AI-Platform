import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "./errors.js";

/**
 * Provider-agnostic interface for one Chat Agent call -- mirrors the
 * AiProvider/MockAiProvider split already used for the customer-reply
 * pipeline (packages/ai/src/provider.ts), so runChatAgentAction can be
 * unit-tested with a fake provider instead of a real Anthropic call. Kept
 * as a separate, smaller interface rather than reusing AiProvider: that
 * interface's generate() is shaped entirely around AiGenerationInput/
 * CompanyAiContext (customer-reply memory, knowledge snippets, lead
 * schema), which doesn't fit a multi-action staff-copilot request.
 */
export interface ChatAgentProvider {
  generateText(system: string, userMessage: string): Promise<string>;
}

export interface AnthropicChatAgentProviderConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

/**
 * Real Anthropic adapter for the Chat Agent. Constructed the same way
 * AnthropicProvider (the customer-reply adapter) is: one Anthropic client,
 * config read via loadEnv exactly like apps/workers/message-consumer's
 * worker.ts already does. Any thrown error is re-classified via
 * classifyAnthropicError before leaving this class, so a raw provider
 * message/stack/request id never reaches a caller.
 */
export class AnthropicChatAgentProvider implements ChatAgentProvider {
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicChatAgentProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async generateText(system: string, userMessage: string): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      });
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    } catch (error) {
      throw classifyAnthropicError(error);
    }
  }
}
