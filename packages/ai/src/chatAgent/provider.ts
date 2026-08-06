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
 * Real Anthropic adapter for the Chat Agent.
 *
 * Explicitly binds the runtime-native `fetch` (Cloudflare Workers' own
 * implementation, via `globalThis.fetch`) instead of letting the SDK
 * auto-detect a runtime and pull in its Node shim. Confirmed root cause of
 * a production transport failure (repeated `httpStatus: null,
 * providerErrorType: null` provider errors): the installed
 * @anthropic-ai/sdk@0.32.1's Node auto-detection resolves to
 * `_shims/node-runtime.js`, which imports `node-fetch` + `agentkeepalive`
 * as its default HTTP client -- both rely on Node's raw `net`/`tls` socket
 * APIs, which Cloudflare Workers' `nodejs_compat` does not implement (Workers
 * only allow outbound HTTP via the platform's own `fetch()`/connect()
 * primitives, never a raw TCP socket). node-fetch's connection attempt fails
 * outright inside the Workers sandbox, which the SDK wraps as an
 * `APIConnectionError` with no HTTP status and no response body -- exactly
 * the observed symptom. Passing `fetch` here overrides `this.fetch` in the
 * SDK's APIClient (a documented, officially supported ClientOptions field),
 * bypassing node-fetch/agentkeepalive entirely.
 *
 * Any thrown error is re-classified via classifyAnthropicError before
 * leaving this class, so a raw provider message/stack/request id never
 * reaches a caller.
 */
export class AnthropicChatAgentProvider implements ChatAgentProvider {
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicChatAgentProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      fetch: globalThis.fetch.bind(globalThis),
    });
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
