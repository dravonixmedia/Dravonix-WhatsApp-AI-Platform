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

const VOICE_RELATED_HANDOVER_REASON_PATTERN =
  /\b(voice messages?|voice notes?|voice mails?|audio messages?|transcripts?|transcriptions?|speech.to.text)\b/i;

/**
 * A text message's own content can never be "an unreadable voice note" -- so
 * if a *text* enquiry is being escalated with a reason that cites voice
 * messages or transcripts, that reason can only be leaking in from stale
 * conversation history (an earlier voice note elsewhere in the thread), not
 * from anything in the message actually being answered right now. This is
 * exactly the regression that let an old, already-handled voice-transcript
 * issue keep re-triggering handover on unrelated new text enquiries.
 */
function isStaleVoiceEscalation(
  requiresHuman: boolean,
  handoverReason: string | null,
  currentMessageIsVoice: boolean,
): boolean {
  if (currentMessageIsVoice || !requiresHuman) return false;
  return VOICE_RELATED_HANDOVER_REASON_PATTERN.test(handoverReason ?? "");
}

export interface SafetyContext {
  /** Whether this company has voice (speech-to-text/text-to-speech) enabled. Defaults to true. */
  voiceEnabled?: boolean;
  /** Whether the message being answered right now is itself a voice note. Defaults to false (text). */
  currentMessageIsVoice?: boolean;
}

/**
 * Applies structural safety rules to an already schema-valid AI response,
 * returning a possibly-modified copy.
 *  - Forces requiresHuman=true (and records a handoverReason) when the answer
 *    appears to make a pricing/availability/hours claim without citing any
 *    knowledgeSourceIds.
 *  - Suppresses an escalation on a text enquiry whose only stated reason is a
 *    stale voice/transcript issue from earlier history (see
 *    isStaleVoiceEscalation) -- requiresHuman must reflect the current
 *    message only.
 *  - Strips a stale voice-unsupported claim from the answer (when voice is
 *    actually enabled) and an unauthorized promise of human follow-up when no
 *    genuine handover (requiresHuman=true) is being triggered for this
 *    response.
 */
export function applySafetyRules(
  response: AiStructuredResponse,
  context: SafetyContext = {},
): AiStructuredResponse {
  let requiresHuman = response.requiresHuman;
  let handoverReason = response.handoverReason;
  let confidence = response.confidence;

  const hasGrounding = response.knowledgeSourceIds.length > 0;
  if (!hasGrounding && containsUngroundedClaim(response.answer)) {
    requiresHuman = true;
    handoverReason = handoverReason ?? "missing_knowledge_grounding";
    confidence = Math.min(confidence, 0.4);
  }

  if (
    isStaleVoiceEscalation(requiresHuman, handoverReason, context.currentMessageIsVoice ?? false)
  ) {
    requiresHuman = false;
    handoverReason = null;
  }

  let answer = stripVoiceUnavailableClaim(response.answer, context.voiceEnabled ?? true);
  if (!requiresHuman) {
    answer = stripUnauthorizedFollowUpPromise(answer);
  }

  if (
    requiresHuman === response.requiresHuman &&
    handoverReason === response.handoverReason &&
    confidence === response.confidence &&
    answer === response.answer
  ) {
    return response;
  }

  return { ...response, requiresHuman, handoverReason, confidence, answer };
}
