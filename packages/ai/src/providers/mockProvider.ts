import type { AiGenerationInput, AiGenerationResult, AiProvider } from "../provider.js";

export type MockResponder = (input: AiGenerationInput, repairInstruction?: string) => string;

/**
 * Deterministic AI provider for local development (no ANTHROPIC_API_KEY) and
 * tests. By default echoes a plausible, schema-valid structured response; tests
 * can override `respond` to simulate invalid JSON, low confidence, etc.
 */
export class MockAiProvider implements AiProvider {
  public respond: MockResponder;
  public calls: Array<{ input: AiGenerationInput; repairInstruction?: string }> = [];

  constructor(respond?: MockResponder) {
    this.respond = respond ?? MockAiProvider.defaultResponder;
  }

  static defaultResponder(input: AiGenerationInput): string {
    return JSON.stringify({
      answer: `Thanks for reaching out to ${input.company.companyName}! How can I help you today?`,
      language: input.memory.lastDetectedLanguage ?? input.company.fallbackLanguage,
      intent: "general_enquiry",
      confidence: 0.8,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: input.knowledge.length > 0 ? [input.knowledge[0]!.sourceId] : [],
      internalNotes: null,
    });
  }

  async generate(
    input: AiGenerationInput,
    repairInstruction?: string,
  ): Promise<AiGenerationResult> {
    this.calls.push({ input, repairInstruction });
    const rawText = this.respond(input, repairInstruction);
    return {
      rawText,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
    };
  }
}
