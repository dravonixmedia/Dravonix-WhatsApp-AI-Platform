import { applySafetyRules } from "./safety.js";
import { aiStructuredResponseSchema, type AiStructuredResponse } from "./schema.js";
import type { AiGenerationInput, AiProvider, AiUsage } from "./provider.js";

export interface OrchestrationResult {
  response: AiStructuredResponse;
  usage: AiUsage;
  /** true if the first attempt was invalid and a repair attempt was needed (or also failed). */
  repaired: boolean;
  /** true if both the original and repair attempts failed and a safe fallback was used. */
  usedFallback: boolean;
}

export interface OrchestrationDependencies {
  provider: AiProvider;
  /** Called once if both attempts fail, for monitoring (Master Prompt section 11). */
  onValidationFailure?: (details: { rawFirstAttempt: string; rawRepairAttempt: string }) => void;
}

function tryParse(rawText: string): AiStructuredResponse | null {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return null;
  }
  const result = aiStructuredResponseSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function safeFallbackResponse(input: AiGenerationInput): AiStructuredResponse {
  return {
    answer: input.company.staticFallbackMessage,
    language: input.memory.lastDetectedLanguage ?? input.company.fallbackLanguage,
    intent: "unknown",
    confidence: 0,
    replyMode: "auto",
    leadUpdates: null,
    requiresHuman: true,
    handoverReason: "ai_response_validation_failed",
    knowledgeSourceIds: [],
    internalNotes: "AI structured response failed validation after one repair attempt.",
  };
}

const REPAIR_INSTRUCTION =
  "Your previous response was not valid JSON matching the required schema, or was missing required " +
  "fields. Respond again with ONLY a single valid JSON object matching the schema exactly -- no prose, " +
  "no markdown fences.";

/**
 * Orchestrates a single Claude turn end to end: call -> validate -> (repair once
 * if invalid) -> apply structural safety rules -> return. Never sends raw JSON
 * or an unvalidated response to the customer -- a safe static fallback is used
 * if both attempts fail, and the caller is notified for monitoring (ADR-0004).
 * The repair attempt reuses the same logical turn, so it must never be recorded
 * as an additional customer-visible message.
 */
export async function generateValidatedResponse(
  deps: OrchestrationDependencies,
  input: AiGenerationInput,
): Promise<OrchestrationResult> {
  const first = await deps.provider.generate(input);
  const firstParsed = tryParse(first.rawText);

  if (firstParsed) {
    return {
      response: applySafetyRules(firstParsed),
      usage: first.usage,
      repaired: false,
      usedFallback: false,
    };
  }

  const repair = await deps.provider.generate(input, REPAIR_INSTRUCTION);
  const repairParsed = tryParse(repair.rawText);

  const combinedUsage: AiUsage = {
    inputTokens: first.usage.inputTokens + repair.usage.inputTokens,
    outputTokens: first.usage.outputTokens + repair.usage.outputTokens,
    cachedInputTokens: first.usage.cachedInputTokens + repair.usage.cachedInputTokens,
  };

  if (repairParsed) {
    return {
      response: applySafetyRules(repairParsed),
      usage: combinedUsage,
      repaired: true,
      usedFallback: false,
    };
  }

  deps.onValidationFailure?.({ rawFirstAttempt: first.rawText, rawRepairAttempt: repair.rawText });

  return {
    response: safeFallbackResponse(input),
    usage: combinedUsage,
    repaired: true,
    usedFallback: true,
  };
}
