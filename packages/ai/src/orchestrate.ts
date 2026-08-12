import { resolveFallbackMessage } from "./fallbackMessage.js";
import { applySafetyRules } from "./safety.js";
import { aiStructuredResponseSchema, type AiStructuredResponse } from "./schema.js";
import { evaluateResearchEligibility, type ResearchEligibility } from "./research/eligibility.js";
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
 * Sanitized, greppable category for a validation outcome -- distinct codes
 * per failure kind so a parsing bug is never conflated with a safety-rule
 * escalation or a repair-effort failure in diagnostic logs. `null` means the
 * attempt succeeded.
 */
export type ValidationCategory =
  | "response_json_parse_failed"
  | "response_schema_validation_failed"
  | "response_safety_validation_failed"
  | "response_repair_failed";

/**
 * Sanitized diagnostics for one pipeline stage (never the raw transcript or
 * response text, never API keys/tokens/phone numbers -- only counts, codes,
 * and the detected language). Emitted after the first parse attempt, after
 * the repair attempt (if any), after a safety-rule-forced escalation, and
 * once more as a final summary if the repair effort as a whole failed.
 */
export interface ValidationDiagnosticEvent {
  stage: "claude_response_parse" | "claude_response_safety" | "claude_response_repair";
  attempt: "first" | "repair" | "final";
  detectedLanguage: string | null;
  transcriptCharCount: number;
  responseCharCount: number;
  category: ValidationCategory | null;
  /** JSON path of the first schema field that failed, e.g. "language" or "leadUpdates.name". */
  failedField: string | null;
  repairAttempted: boolean;
  /** Whether the repair attempt (if one happened) ultimately produced a valid response. null until known. */
  repairSucceeded: boolean | null;
}

export interface OrchestrationDependencies {
  provider: AiProvider;
  /** Called once if both attempts fail, for monitoring (Master Prompt section 11). */
  onValidationFailure?: (details: { rawFirstAttempt: string; rawRepairAttempt: string }) => void;
  /** Called after each parse/validate/safety step with sanitized, logging-safe diagnostics. */
  onDiagnostics?: (event: ValidationDiagnosticEvent) => void;
  /**
   * DRAIVA Research Phase 1 integration seam ONLY (see packages/ai/src/research).
   * When present and `enabled`, the orchestrator evaluates whether already-
   * retrieved company knowledge is sufficient on its own (see
   * research/eligibility.ts) and reports the decision via `onDecision`, for
   * observability. No tool is attached to the Claude call and no external
   * research executes in this phase -- the model call, parse/repair loop,
   * and safety check below are completely unaffected either way. Omitting
   * this field (the default for every current caller: message-consumer and
   * voice-consumer do not pass it) leaves this function's behavior
   * byte-for-byte identical to before this seam existed.
   */
  research?: {
    enabled: boolean;
    onDecision?: (decision: ResearchEligibility) => void;
  };
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
  category: ValidationCategory | null;
  failedField: string | null;
}

/**
 * Parses and schema-validates a raw Claude response -- the exact validator
 * behind every response_json_parse_failed / response_schema_validation_failed
 * diagnostic. The schema itself (schema.ts) has no script/language-specific
 * constraints: any well-formed, complete JSON payload with valid field values
 * is accepted regardless of whether `answer` is English, Malayalam, or a mix
 * of both. A failure here is therefore either a genuine JSON syntax error
 * (most commonly caused by the response being cut off before Claude finished
 * -- see the repair attempt's boosted token budget in anthropicProvider.ts)
 * or a real missing/invalid/malformed field (e.g. an invalid replyMode enum
 * value, or requiresHuman=true with no handoverReason) -- never a rejection
 * based on which language the content is in.
 */
function tryParse(rawText: string): ParseAttempt {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonCandidate(rawText));
  } catch {
    return { data: null, category: "response_json_parse_failed", failedField: null };
  }
  const result = aiStructuredResponseSchema.safeParse(json);
  if (result.success) {
    return { data: result.data, category: null, failedField: null };
  }
  const firstIssue = result.error.issues[0];
  return {
    data: null,
    category: "response_schema_validation_failed",
    failedField: firstIssue && firstIssue.path.length > 0 ? firstIssue.path.join(".") : null,
  };
}

function emitDiagnostics(
  deps: OrchestrationDependencies,
  input: AiGenerationInput,
  event: Omit<ValidationDiagnosticEvent, "detectedLanguage" | "transcriptCharCount">,
): void {
  deps.onDiagnostics?.({
    ...event,
    detectedLanguage: input.currentDetectedLanguage ?? input.memory.lastDetectedLanguage ?? null,
    transcriptCharCount: input.customerMessage.length,
  });
}

/**
 * The safe, static, non-AI-generated response used when both the original
 * and repair attempts fail validation. The message text is resolved by the
 * detected language (current turn's detection takes priority over a prior
 * turn's) so a Malayalam customer gets a Malayalam apology, never an
 * English-only one silently defaulted -- and never an unauthorized
 * response-time promise (see fallbackMessage.ts). The final handoverReason
 * stays a safe, normalized value; the specific parse/schema category that
 * actually caused this is reported separately via onDiagnostics, never
 * folded into this single reason string.
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

const SCHEMA_RECAP =
  '{"answer": string, "language": string (BCP-47), "intent": string, "confidence": number 0-1, ' +
  '"replyMode": "text_only"|"voice_only"|"text_and_voice"|"auto", "leadUpdates": null or an object of ' +
  'string-or-null lead fields, "requiresHuman": boolean, "handoverReason": string or null (must be a ' +
  'non-empty string whenever requiresHuman is true), "knowledgeSourceIds": string[], "internalNotes": ' +
  "string or null}";

/** A short, specific description of what actually failed -- included in the repair request instead of a vague generic message. */
function describeValidationFailure(failure: ParseAttempt): string {
  if (failure.category === "response_json_parse_failed") {
    return "The response was not valid JSON (parsing failed, possibly truncated before it finished).";
  }
  if (failure.failedField) {
    return `The field "${failure.failedField}" was missing, had an invalid type, or had an invalid value.`;
  }
  return "One or more required fields were missing or invalid.";
}

/**
 * Builds the one-shot schema-repair request: the specific validation error
 * from the failed attempt plus a recap of the required schema -- not the
 * customer's message again, and not a second repair attempt's worth of
 * instructions. Explicitly preserves the original response language and asks
 * for concision, since a truncation (the most common real-world cause of a
 * failed first attempt) is itself often a token-budget problem.
 */
function buildRepairInstruction(language: string, failure: ParseAttempt): string {
  return (
    `Your previous response failed validation: ${describeValidationFailure(failure)} ` +
    "Respond again with ONLY a single valid JSON object matching this exact schema -- no prose, no " +
    `markdown fences:\n${SCHEMA_RECAP}\n` +
    `Reply in the same language as before (${language}). Keep the answer as concise as possible while ` +
    "still complete and valid, so the full JSON response fits comfortably within the token limit."
  );
}

/**
 * Orchestrates a single Claude turn end to end: call -> validate -> (repair once
 * if invalid) -> apply structural safety rules -> return. Never sends raw JSON
 * or an unvalidated response to the customer -- a safe static fallback is used
 * if both attempts fail, and the caller is notified for monitoring (ADR-0004).
 * The repair attempt reuses the same logical turn, so it must never be recorded
 * as an additional customer-visible message, and never triggers a second repair.
 */
export async function generateValidatedResponse(
  deps: OrchestrationDependencies,
  input: AiGenerationInput,
): Promise<OrchestrationResult> {
  const language =
    input.currentDetectedLanguage ??
    input.memory.lastDetectedLanguage ??
    input.company.fallbackLanguage;

  // Phase 1 research seam: observation only, see OrchestrationDependencies.research above.
  if (deps.research?.enabled) {
    deps.research.onDecision?.(
      evaluateResearchEligibility({ knowledge: input.knowledge, researchEnabled: true }),
    );
  }

  function finalizeWithSafetyCheck(
    data: AiStructuredResponse,
    usage: AiUsage,
    repaired: boolean,
  ): OrchestrationResult {
    const safetyChecked = applySafetyRules(data, { voiceEnabled: input.company.voiceEnabled });
    // A safety-rule-forced escalation (Claude itself did not set requiresHuman,
    // but an unsupported/ungrounded claim required it) is a distinct category
    // from a parsing/schema failure -- reported separately so it's never
    // conflated with response_json_parse_failed or response_schema_validation_failed.
    if (!data.requiresHuman && safetyChecked.requiresHuman) {
      emitDiagnostics(deps, input, {
        stage: "claude_response_safety",
        attempt: repaired ? "repair" : "first",
        responseCharCount: safetyChecked.answer.length,
        category: "response_safety_validation_failed",
        failedField: null,
        repairAttempted: repaired,
        repairSucceeded: repaired ? true : null,
      });
    }
    return { response: safetyChecked, usage, repaired, usedFallback: false };
  }

  const first = await deps.provider.generate(input);
  const firstAttempt = tryParse(first.rawText);
  emitDiagnostics(deps, input, {
    stage: "claude_response_parse",
    attempt: "first",
    responseCharCount: first.rawText.length,
    category: firstAttempt.category,
    failedField: firstAttempt.failedField,
    repairAttempted: false,
    repairSucceeded: null,
  });

  if (firstAttempt.data) {
    return finalizeWithSafetyCheck(firstAttempt.data, first.usage, false);
  }

  const repair = await deps.provider.generate(
    input,
    buildRepairInstruction(language, firstAttempt),
  );
  const repairAttempt = tryParse(repair.rawText);
  emitDiagnostics(deps, input, {
    stage: "claude_response_parse",
    attempt: "repair",
    responseCharCount: repair.rawText.length,
    category: repairAttempt.category,
    failedField: repairAttempt.failedField,
    repairAttempted: true,
    repairSucceeded: repairAttempt.data !== null,
  });

  const combinedUsage: AiUsage = {
    inputTokens: first.usage.inputTokens + repair.usage.inputTokens,
    outputTokens: first.usage.outputTokens + repair.usage.outputTokens,
    cachedInputTokens: first.usage.cachedInputTokens + repair.usage.cachedInputTokens,
  };

  if (repairAttempt.data) {
    return finalizeWithSafetyCheck(repairAttempt.data, combinedUsage, true);
  }

  // The repair effort as a whole (not just this one attempt) failed to save
  // the turn -- a distinct, final top-level marker on top of the per-attempt
  // category above, so a log consumer can query "repair effort failed" and
  // "why the repair attempt itself failed" independently.
  emitDiagnostics(deps, input, {
    stage: "claude_response_repair",
    attempt: "final",
    responseCharCount: repair.rawText.length,
    category: "response_repair_failed",
    failedField: null,
    repairAttempted: true,
    repairSucceeded: false,
  });

  deps.onValidationFailure?.({ rawFirstAttempt: first.rawText, rawRepairAttempt: repair.rawText });

  return {
    response: safeFallbackResponse(input),
    usage: combinedUsage,
    repaired: true,
    usedFallback: true,
  };
}
