import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../prompt/buildSystemPrompt.js";
import {
  ANTHROPIC_WEB_SEARCH_MAX_USES,
  buildAnthropicWebSearchTool,
  extractResearchExecutionMetadata,
} from "../research/anthropicWebSearch.js";
import type { AiGenerationInput, AiGenerationResult, AiProvider } from "../provider.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Read from ANTHROPIC_MODEL -- never hard-code a "latest" alias (ADR-0004). */
  model: string;
  maxTokens: number;
  /** DRAIVA Research: max web_search invocations per call. Defaults to ANTHROPIC_WEB_SEARCH_MAX_USES (3) -- the conservative staging-pilot ceiling. */
  webSearchMaxUses?: number;
}

/**
 * Real Anthropic Claude adapter. Selected whenever `env.anthropicConfigured` is
 * true (packages/config). The system prompt (company identity, safety rules,
 * knowledge) is passed as `system`; conversation memory + the customer's
 * message form the message list. A repair instruction, when present, is
 * appended as an additional user turn within the same call rather than a new
 * customer-visible message.
 *
 * DRAIVA Research: when `input.researchEnabled` is true AND this is not a
 * repair attempt, Anthropic's native, server-executed web_search tool
 * (`web_search_20250305`) is attached to the call -- Anthropic runs the
 * search itself within this single request and returns citations/results
 * embedded in the response; there is no separate client-side tool_use round
 * trip to orchestrate. The tool is deliberately NEVER attached to a repair
 * call: a repair's message list does not carry the first attempt's own
 * response forward (see the `messages` construction below), so a second
 * search there would be an independent, uncounted-against-the-turn search --
 * dropping it caps total searches for one customer turn at
 * config.webSearchMaxUses regardless of whether a repair happens.
 */
export class AnthropicProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async generate(
    input: AiGenerationInput,
    repairInstruction?: string,
  ): Promise<AiGenerationResult> {
    const researchEnabled = Boolean(input.researchEnabled) && !repairInstruction;
    const system = buildSystemPrompt(
      input.company,
      input.memory,
      input.knowledge,
      input.temporal,
      researchEnabled,
    );

    const messages: Anthropic.MessageParam[] = [
      ...input.memory.recentMessages.map((m) => ({
        role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
        // A voice note whose transcription is still pending or failed is stored
        // with an empty body; Claude's API rejects any message with empty
        // content outright (400: "user messages must have non-empty content"),
        // which would otherwise hard-fail every future turn in the conversation.
        content: m.body.trim()
          ? m.body
          : "[voice message: transcript unavailable for this one message]",
      })),
      { role: "user", content: input.customerMessage },
    ];

    if (repairInstruction) {
      messages.push({ role: "user", content: repairInstruction });
    }

    // A repair attempt only happens after the first attempt's JSON was
    // invalid/incomplete -- frequently because a high-token-density script
    // (e.g. Malayalam) used up the base budget before finishing the
    // structured response. Give the repair call real extra headroom rather
    // than repeating the same ceiling and risking a second truncation.
    const maxTokens = repairInstruction
      ? Math.round(this.config.maxTokens * 1.5)
      : this.config.maxTokens;

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: maxTokens,
      system,
      messages,
      ...(researchEnabled
        ? {
            tools: [
              buildAnthropicWebSearchTool({
                maxUses: this.config.webSearchMaxUses ?? ANTHROPIC_WEB_SEARCH_MAX_USES,
              }),
            ],
          }
        : {}),
    });

    const rawText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      rawText,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // Prompt caching (ADR-0004) is a documented follow-up: the installed SDK
        // version's stable Usage type does not yet surface cache_read_input_tokens
        // outside the beta prompt-caching resource. Wire this up when upgrading.
        cachedInputTokens: 0,
      },
      ...(researchEnabled
        ? { research: extractResearchExecutionMetadata(response.content, new Date()) }
        : {}),
    };
  }
}
