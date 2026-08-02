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
 * Matches a mention of staff/a human handling this conversation (e.g. "our
 * team", "a staff member").
 */
const STAFF_MENTION_PATTERN =
  /\b(our team|the team|a team member|someone from our team|a human agent|our staff|a member of our team|a staff member)\b/i;

/**
 * Matches the action half of a handover promise, in whatever tense the model
 * used -- both future ("will follow up") and present-continuous ("I'm
 * connecting you with our team") phrasing are covered, since either reads to
 * the customer as staff are being looped in right now.
 */
const HANDOVER_ACTION_PATTERN =
  /\b(follow(ing)? up|reach(ing)? out|contact(ing)? you|get(ting)? back to you|respond(ing)? to you|assist(ing)? you|connect(ing)? you|transferr?(ing)? you|hand(ing)? (this |you )?over|put(ting)? you through)\b/i;

/**
 * Used only when stripping an unauthorized follow-up promise would otherwise
 * leave nothing customer-facing (the whole answer was just that promise).
 * Sending the forbidden wording is never acceptable, so a short, neutral
 * acknowledgement is used instead of a blank WhatsApp message.
 */
const SAFE_ACKNOWLEDGEMENT_FALLBACK = "Thanks for reaching out -- how can I help you today?";

/**
 * Removes any unauthorized human-follow-up promise sentence from an answer
 * that isn't actually escalating (requiresHuman=false). Falls back to a
 * neutral acknowledgement if that would otherwise strip the entire answer --
 * the forbidden wording must never reach the customer, even in that edge case.
 */
function stripUnauthorizedFollowUpPromise(answer: string): string {
  const sentences = answer.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(
    (sentence) => !(STAFF_MENTION_PATTERN.test(sentence) && HANDOVER_ACTION_PATTERN.test(sentence)),
  );
  if (kept.length === sentences.length) return answer;
  const stripped = kept.join(" ").trim();
  return stripped.length > 0 ? stripped : SAFE_ACKNOWLEDGEMENT_FALLBACK;
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
 * Matches a handoverReason that shows the *customer* explicitly asked for a
 * human -- a legitimate escalation that must never be suppressed, even if the
 * same reason also happens to mention repetition or voice history.
 */
const EXPLICIT_HUMAN_REQUEST_PATTERN =
  /\b(explicitly (asked|requested)|requested (a |to speak (with|to) a )?human|asked (for|to speak (with|to)) a human|wants? to (speak|talk) (with|to) a (human|person|agent)|connect (me|them|us) (to|with) a human)\b/i;

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
  const reason = handoverReason ?? "";
  if (EXPLICIT_HUMAN_REQUEST_PATTERN.test(reason)) return false;
  return VOICE_RELATED_HANDOVER_REASON_PATTERN.test(reason);
}

const FREQUENCY_BASED_ESCALATION_PATTERN =
  /\b(sent (the )?same message|repeated(ly)? (greetings?|messages?|enquir(y|ies))|multiple times|several times|contacted (us|them|the business)?\s*(several|multiple) times|reached out (multiple|several) times|message frequency|keeps? (sending|messaging|repeating))\b/i;

/**
 * Repeated greetings, a duplicate enquiry, or a customer contacting the
 * business several times is never, by itself, urgency -- a customer re-
 * sending the same ordinary question is not a reason to stop AI replies. This
 * is exactly the regression that let plain message frequency read as "urgent
 * need for direct human assistance". Never suppressed when the customer
 * genuinely, explicitly asked for a human.
 */
function isFrequencyBasedEscalation(
  requiresHuman: boolean,
  handoverReason: string | null,
): boolean {
  if (!requiresHuman) return false;
  const reason = handoverReason ?? "";
  if (EXPLICIT_HUMAN_REQUEST_PATTERN.test(reason)) return false;
  return FREQUENCY_BASED_ESCALATION_PATTERN.test(reason);
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
 *  - Suppresses an escalation whose only stated reason is a stale
 *    voice/transcript issue from earlier history on a text enquiry (see
 *    isStaleVoiceEscalation), or is based only on message repetition/
 *    frequency (see isFrequencyBasedEscalation) -- requiresHuman must reflect
 *    something about the current message, never just how many times the
 *    customer has written in. Both carve out a genuine explicit request for a
 *    human, which always still escalates.
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
    isStaleVoiceEscalation(requiresHuman, handoverReason, context.currentMessageIsVoice ?? false) ||
    isFrequencyBasedEscalation(requiresHuman, handoverReason)
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
