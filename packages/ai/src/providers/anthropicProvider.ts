import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../prompt/buildSystemPrompt.js";
import type { AiGenerationInput, AiGenerationResult, AiProvider } from "../provider.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Read from ANTHROPIC_MODEL -- never hard-code a "latest" alias (ADR-0004). */
  model: string;
  maxTokens: number;
}

/**
 * Real Anthropic Claude adapter. Selected whenever `env.anthropicConfigured` is
 * true (packages/config). The system prompt (company identity, safety rules,
 * knowledge) is passed as `system`; conversation memory + the customer's
 * message form the message list. A repair instruction, when present, is
 * appended as an additional user turn within the same call rather than a new
 * customer-visible message.
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
    const system = buildSystemPrompt(input.company, input.memory, input.knowledge);

    const messages: Anthropic.MessageParam[] = [
      ...input.memory.recentMessages.map((m) => ({
        role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
        // A voice note whose transcription is still pending or failed is stored
        // with an empty body; Claude's API rejects any message with empty
        // content outright (400: "user messages must have non-empty content"),
        // which would otherwise hard-fail every future turn in the conversation.
        // Deliberately worded without "voice"/"transcript": a past isolated
        // hiccup on one message must never read back as a standing claim that
        // voice is broken, and must never resurface as a reason to escalate
        // an unrelated later message (see stale-voice-escalation handling in
        // safety.ts).
        content: m.body.trim() ? m.body : "[an earlier message with no further detail available]",
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
    };
  }
}
