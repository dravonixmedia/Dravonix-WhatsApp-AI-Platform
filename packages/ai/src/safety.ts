import type { AiStructuredResponse } from "./schema.js";

/**
 * Heuristic patterns indicating the answer makes a pricing, availability, or
 * business-hours claim -- the categories Master Prompt section 12 requires to
 * be grounded in approved knowledge. This is a defense-in-depth structural
 * check on top of the prompt-level instruction (ADR-0004); it cannot prove the
 * answer is correct, only that an ungrounded claim in these categories is
 * downgraded rather than sent to the customer as if certain.
 */
const UNGROUNDED_CLAIM_PATTERNS: RegExp[] = [
  /[₹$€£]\s?\d/, // currency amounts
  /\brs\.?\s?\d/i,
  /\d+\s?(per|\/)\s?(month|year|hour|day|week)/i,
  /\bavailable\b/i,
  /\bin stock\b/i,
  /\bopen (from|between|on)\b/i,
  /\bbusiness hours\b/i,
];

function containsUngroundedClaim(answer: string): boolean {
  return UNGROUNDED_CLAIM_PATTERNS.some((pattern) => pattern.test(answer));
}

/**
 * Matches sentences that promise staff/human follow-up (e.g. "Our team will
 * also follow up with you shortly."). Used as a defense-in-depth backstop for
 * the prompt-level rule: a promise like this must never reach the customer
 * unless requiresHuman is true, since otherwise no handover actually happens
 * and the promise goes unfulfilled.
 */
const HUMAN_FOLLOWUP_PROMISE_PATTERN =
  /[^.!?\n]*\b(our team|the team|a team member|someone from our team|a human agent|our staff|a member of our team|a staff member)\b[^.!?\n]*\b(will|would|shall)\b[^.!?\n]*\b(follow up|reach out|contact you|get back to you|respond to you|assist you)\b[^.!?\n]*[.!?]?/gi;

/**
 * Removes any unauthorized human-follow-up promise from an answer that isn't
 * actually escalating (requiresHuman=false). Returns the original string
 * unchanged if stripping would leave nothing customer-facing -- an imperfect
 * match is safer to leave in place than to send a blank reply.
 */
function stripUnauthorizedFollowUpPromise(answer: string): string {
  // .match() (unlike .test()) resets a global regex's lastIndex before scanning,
  // so repeated calls against different strings can't leak state between them.
  if (!answer.match(HUMAN_FOLLOWUP_PROMISE_PATTERN)) return answer;
  const stripped = answer.replace(HUMAN_FOLLOWUP_PROMISE_PATTERN, "").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : answer;
}

const VOICE_NEGATION_PATTERN = /\b(unable|not able|can'?t|cannot|won'?t|don'?t|do not|doesn'?t)\b/i;
const VOICE_MENTION_PATTERN = /\bvoice\b/i;
const VOICE_CAPABILITY_VERB_PATTERN = /\b(listen|transcribe|hear|process|understand|support)/i;

/**
 * Removes a stale "we can't handle voice messages" sentence from an answer
 * when the company's voice_settings actually have voice enabled (ElevenLabs
 * STT/TTS). This is a defense-in-depth backstop for the prompt-level rule --
 * an isolated missing transcript for one earlier message must never surface
 * as a blanket claim that voice notes are unsupported.
 */
function stripVoiceUnavailableClaim(answer: string, voiceEnabled: boolean): string {
  if (!voiceEnabled) return answer;
  const sentences = answer.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(
    (sentence) =>
      !(
        VOICE_NEGATION_PATTERN.test(sentence) &&
        VOICE_MENTION_PATTERN.test(sentence) &&
        VOICE_CAPABILITY_VERB_PATTERN.test(sentence)
      ),
  );
  if (kept.length === sentences.length) return answer;
  const stripped = kept.join(" ").trim();
  return stripped.length > 0 ? stripped : answer;
}

export interface SafetyContext {
  /** Whether this company has voice (speech-to-text/text-to-speech) enabled. Defaults to true. */
  voiceEnabled?: boolean;
}

/**
 * Applies structural safety rules to an already schema-valid AI response,
 * returning a possibly-modified copy. Forces requiresHuman=true (and records a
 * handoverReason) when the answer appears to make a pricing/availability/hours
 * claim without citing any knowledgeSourceIds. Also strips a stale
 * voice-unsupported claim (when voice is actually enabled) and an unauthorized
 * promise of human follow-up when no genuine handover (requiresHuman=true) is
 * being triggered for this response.
 */
export function applySafetyRules(
  response: AiStructuredResponse,
  context: SafetyContext = {},
): AiStructuredResponse {
  const hasGrounding = response.knowledgeSourceIds.length > 0;

  if (!hasGrounding && containsUngroundedClaim(response.answer)) {
    return {
      ...response,
      requiresHuman: true,
      handoverReason: response.handoverReason ?? "missing_knowledge_grounding",
      confidence: Math.min(response.confidence, 0.4),
    };
  }

  let answer = stripVoiceUnavailableClaim(response.answer, context.voiceEnabled ?? true);
  if (!response.requiresHuman) {
    answer = stripUnauthorizedFollowUpPromise(answer);
  }

  return answer === response.answer ? response : { ...response, answer };
}
