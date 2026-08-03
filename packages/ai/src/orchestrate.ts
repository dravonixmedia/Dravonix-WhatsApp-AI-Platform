import { resolveFallbackMessage } from "./fallbackMessage.js";
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

/**
 * Sanitized diagnostics for one parse/validate attempt (never the raw
 * transcript or response text, never API keys/tokens/phone numbers -- only
 * counts, codes, and the detected language). Emitted after both the first
 * and, if needed, the repair attempt, so a validation failure can be traced
 * without exposing customer message content.
 */
export interface ValidationDiagnosticEvent {
  stage: "claude_response_parse";
  attempt: "first" | "repair";
  detectedLanguage: string | null;
  transcriptCharCount: number;
  responseCharCount: number;
  errorCode: "json_parse_error" | "schema_validation_failed" | null;
  /** JSON path of the first schema field that failed, e.g. "language" or "leadUpdates.name". */
  failedField: string | null;
  repairAttempted: boolean;
}

export interface OrchestrationDependencies {
  provider: AiProvider;
  /** Called once if both attempts fail, for monitoring (Master Prompt section 11). */
  onValidationFailure?: (details: { rawFirstAttempt: string; rawRepairAttempt: string }) => void;
  /** Called after each parse/validate attempt with sanitized, logging-safe diagnostics. */
  onDiagnostics?: (event: ValidationDiagnosticEvent) => void;
}

/**
 * Claude frequently wraps its JSON answer in a markdown code fence (```json ... ```)
 * even when explicitly told not to, and may add stray prose before/after it. Strip
 * a wrapping fence and fall back to the first {...} substring before giving up, so a
 * cosmetically-decorated but otherwise valid response isn't treated as a parse failure.
 */
function extractJsonCandidate(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1] !== undefined) return fenced[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

interface ParseAttempt {
  data: AiStructuredResponse | null;
  errorCode: "json_parse_error" | "schema_validation_failed" | null;
  failedField: string | null;
}

/**
 * Parses and schema-validates a raw Claude response. The schema itself
 * (schema.ts) has no script/language-specific constraints -- any well-formed,
 * complete JSON payload with valid field values is accepted regardless of
 * whether `answer` is English, Malayalam, or a mix of both. A failure here is
 * therefore either a genuine JSON syntax error (most commonly caused by the
 * response being cut off before Claude finished -- see the repair attempt's
 * boosted token budget in anthropicProvider.ts) or a real missing/invalid
 * field, never a rejection based on which language the content is in.
 */
function tryParse(rawText: string): ParseAttempt {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonCandidate(rawText));
  } catch {
    return { data: null, errorCode: "json_parse_error", failedField: null };
  }
  const result = aiStructuredResponseSchema.safeParse(json);
  if (result.success) {
    return { data: result.data, errorCode: null, failedField: null };
  }
  const firstIssue = result.error.issues[0];
  return {
    data: null,
    errorCode: "schema_validation_failed",
    failedField: firstIssue && firstIssue.path.length > 0 ? firstIssue.path.join(".") : null,
  };
}

function emitDiagnostics(
  deps: OrchestrationDependencies,
  input: AiGenerationInput,
  attempt: ParseAttempt,
  rawText: string,
  which: "first" | "repair",
): void {
  deps.onDiagnostics?.({
    stage: "claude_response_parse",
    attempt: which,
    detectedLanguage: input.currentDetectedLanguage ?? input.memory.lastDetectedLanguage ?? null,
    transcriptCharCount: input.customerMessage.length,
    responseCharCount: rawText.length,
    errorCode: attempt.errorCode,
    failedField: attempt.failedField,
    repairAttempted: which === "repair",
  });
}

/**
 * The safe, static, non-AI-generated response used when both the original
 * and repair attempts fail validation. The message text is resolved by the
 * detected language (current turn's detection takes priority over a prior
 * turn's) so a Malayalam customer gets a Malayalam apology, never an
 * English-only one silently defaulted -- and never the old unauthorized
 * response-time promise (see fallbackMessage.ts).
 */
export function safeFallbackResponse(input: AiGenerationInput): AiStructuredResponse {
  const language =
    input.currentDetectedLanguage ??
    input.memory.lastDetectedLanguage ??
    input.company.fallbackLanguage;
  return {
    answer: resolveFallbackMessage(input.company.staticFallbackMessage, language),
    language,
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

function buildRepairInstruction(language: string): string {
  return (
    "Your previous response was not valid JSON matching the required schema, or was missing required " +
    "fields. Respond again with ONLY a single valid JSON object matching the schema exactly -- no prose, " +
    `no markdown fences. Reply in the same language as before (${language}). Keep the answer as concise ` +
    "as possible while still complete and valid, so the full JSON response fits comfortably within the " +
    "token limit -- an unfinished, truncated JSON object is treated the same as an invalid one."
  );
}

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
  const language =
    input.currentDetectedLanguage ??
    input.memory.lastDetectedLanguage ??
    input.company.fallbackLanguage;

  const first = await deps.provider.generate(input);
  const firstAttempt = tryParse(first.rawText);
  emitDiagnostics(deps, input, firstAttempt, first.rawText, "first");

  if (firstAttempt.data) {
    return {
      response: applySafetyRules(firstAttempt.data, { voiceEnabled: input.company.voiceEnabled }),
      usage: first.usage,
      repaired: false,
      usedFallback: false,
    };
  }

  const repair = await deps.provider.generate(input, buildRepairInstruction(language));
  const repairAttempt = tryParse(repair.rawText);
  emitDiagnostics(deps, input, repairAttempt, repair.rawText, "repair");

  const combinedUsage: AiUsage = {
    inputTokens: first.usage.inputTokens + repair.usage.inputTokens,
    outputTokens: first.usage.outputTokens + repair.usage.outputTokens,
    cachedInputTokens: first.usage.cachedInputTokens + repair.usage.cachedInputTokens,
  };

  if (repairAttempt.data) {
    return {
      response: applySafetyRules(repairAttempt.data, { voiceEnabled: input.company.voiceEnabled }),
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
