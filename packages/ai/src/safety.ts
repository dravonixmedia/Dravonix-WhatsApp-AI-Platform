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
 * Matches an answer that promises staff/human follow-up (e.g. "Our team will
 * also follow up with you shortly.", or a Malayalam-English reply like
 * "ഞങ്ങളുടെ team നിങ്ങളെ contact ചെയ്യും, meeting time fix ചെയ്യാം"). Used as a
 * defense-in-depth backstop for the prompt-level rule (buildSystemPrompt.ts
 * already instructs the model never to promise follow-up unless
 * requiresHuman is true) -- a 2026-08-05 staging incident showed the model
 * can still violate that instruction, especially in mixed Malayalam-English
 * replies the first (English-only, sentence-scoped) version of this pattern
 * never matched at all.
 *
 * Deliberately NOT sentence-scoped ([^.!?\n]*) any more: Malayalam text
 * frequently lacks clean terminal punctuation, so a sentence boundary
 * assumption silently failed to match real replies. Business-loanword
 * co-occurrence (team/contact/meeting/arrange/call) is checked instead,
 * since those terms are consistently kept in English/Latin script even in
 * an otherwise Malayalam-script reply (see buildSystemPrompt.ts's Malayalam
 * conversation style section).
 */
const HUMAN_FOLLOWUP_PROMISE_PATTERNS: RegExp[] = [
  // Full-sentence English promise (e.g. "A team member will follow up with you shortly.")
  /\b(our team|the team|a team member|someone from our team|a human agent|our staff|a member of our team|a staff member)\b[^.!?\n]*\b(will|would|shall)\b[^.!?\n]*\b(follow up|reach out|contact you|get back to you|respond to you|assist you|call you)\b/i,
  // Language-agnostic loanword co-occurrence -- catches Malayalam/Malayalam-English replies.
  /\bteam\b[\s\S]{0,60}\bcontact\b|\bcontact\b[\s\S]{0,60}\bteam\b/i,
  /\bmeeting\b[\s\S]{0,40}\b(arrange|fix|schedule|set ?up)\b|\b(arrange|fix|schedule|set ?up)\b[\s\S]{0,40}\bmeeting\b/i,
  /\bcall\s?(back)?\b[\s\S]{0,40}\byou\b/i,
];

/**
 * True when the answer appears to promise human/team follow-up in any
 * supported language or code-switched mix.
 */
function containsHumanFollowupPromise(answer: string): boolean {
  return HUMAN_FOLLOWUP_PROMISE_PATTERNS.some((pattern) => pattern.test(answer));
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
  /**
   * DRAIVA Research: the number of external web-search findings actually
   * returned for this turn (orchestrate.ts passes
   * LiveResearchExecutionMetadata.findings.length -- the same count already
   * surfaced as ResearchExecutionDiagnostics.sourceCount, never recomputed
   * separately here). A cited, successfully-researched claim is real
   * grounding, just structurally distinct from company knowledge --
   * knowledgeSourceIds must never absorb research citations (see
   * research/attribution.ts's company-fact/external-research separation
   * policy), so this is a second, independent grounding signal rather than
   * a change to what knowledgeSourceIds means. Defaults to 0 (no research
   * grounding), which is the correct value both when research never ran and
   * when it ran but genuinely failed/found nothing -- findings.length is
   * already 0 in both cases, so no separate failureReason check is needed
   * here.
   */
  researchSourceCount?: number;
}

/**
 * Applies structural safety rules to an already schema-valid AI response,
 * returning a possibly-modified copy. Forces requiresHuman=true (and records a
 * handoverReason) when the answer appears to make a pricing/availability/hours
 * claim without citing any knowledgeSourceIds AND without any successful
 * research grounding (context.researchSourceCount) -- a genuinely successful,
 * cited research answer must not be forced into a handover merely because it
 * has no company-knowledge sourceIds (see context.researchSourceCount's doc
 * comment). Also strips a stale voice-unsupported claim (when voice is
 * actually enabled).
 *
 * Escalates -- rather than silently rewriting the text -- when the answer
 * promises human/team follow-up but the model didn't set requiresHuman=true
 * itself: message-consumer/voice-consumer both call triggerHandoverAtomic
 * whenever requiresHuman is true, *before* sending the reply, so forcing it
 * true here is what turns the promise into a real, persisted handover
 * instead of an unfulfilled one. This replaces an earlier version of this
 * function that stripped the promise sentence out of the answer instead --
 * that left the underlying customer intent (wanting a human) completely
 * unhandled, which is exactly the failure mode a 2026-08-05 staging
 * incident surfaced.
 */
export function applySafetyRules(
  response: AiStructuredResponse,
  context: SafetyContext = {},
): AiStructuredResponse {
  const hasGrounding =
    response.knowledgeSourceIds.length > 0 || (context.researchSourceCount ?? 0) > 0;

  if (!hasGrounding && containsUngroundedClaim(response.answer)) {
    return {
      ...response,
      requiresHuman: true,
      handoverReason: response.handoverReason ?? "missing_knowledge_grounding",
      confidence: Math.min(response.confidence, 0.4),
    };
  }

  const answer = stripVoiceUnavailableClaim(response.answer, context.voiceEnabled ?? true);

  if (!response.requiresHuman && containsHumanFollowupPromise(answer)) {
    return {
      ...response,
      answer,
      requiresHuman: true,
      handoverReason: response.handoverReason ?? "AI reply promised human/team follow-up",
    };
  }

  return answer === response.answer ? response : { ...response, answer };
}
