/**
 * Defensive normalization for ElevenLabs STT keyterms (2026-08-04 incident:
 * a Scribe request failed with HTTP 400 invalid_keyword_length because the
 * caller-supplied keyterms array was submitted without any per-term
 * validation). This is the single point every keyterms array must pass
 * through before it can reach an ElevenLabsSpeechToTextProvider request --
 * no valid combination of caller input can make it past here and still
 * violate ElevenLabs' constraints, so a bad keyterm can never fail the
 * containing transcription request.
 *
 * Characters are counted by Unicode code point (not UTF-16 code unit) so a
 * term made entirely of astral-plane characters isn't undercounted relative
 * to what ElevenLabs itself measures.
 */

const UNSUPPORTED_CHARACTERS_PATTERN = /[<>{}[\]\\]/g;
const WHITESPACE_RUN_PATTERN = /\s+/g;
const MAX_KEYTERM_LENGTH = 50;
const MAX_KEYTERM_WORDS = 5;

export type KeytermRejectionReason =
  "invalidType" | "empty" | "tooLong" | "tooManyWords" | "duplicate";

export interface KeytermSanitizationSummary {
  inputCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rejectionReasons: Record<KeytermRejectionReason, number>;
}

export interface SanitizeKeytermsResult {
  keyterms: string[];
  summary: KeytermSanitizationSummary;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function cleanCandidate(raw: string): string {
  return raw
    .replace(UNSUPPORTED_CHARACTERS_PATTERN, "")
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim();
}

/**
 * Filters an arbitrary (possibly caller-controlled, possibly malformed)
 * value down to a keyterms array ElevenLabs will always accept. Never
 * throws -- every rejection is a silent drop, tallied in the returned
 * summary rather than logged with the actual term value.
 */
export function sanitizeKeyterms(input: unknown): SanitizeKeytermsResult {
  const rejectionReasons: Record<KeytermRejectionReason, number> = {
    invalidType: 0,
    empty: 0,
    tooLong: 0,
    tooManyWords: 0,
    duplicate: 0,
  };

  const candidates = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const keyterms: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      rejectionReasons.invalidType += 1;
      continue;
    }

    const cleaned = cleanCandidate(candidate);
    if (cleaned.length === 0) {
      rejectionReasons.empty += 1;
      continue;
    }

    if (unicodeLength(cleaned) >= MAX_KEYTERM_LENGTH) {
      rejectionReasons.tooLong += 1;
      continue;
    }

    const wordCount = cleaned.split(" ").length;
    if (wordCount > MAX_KEYTERM_WORDS) {
      rejectionReasons.tooManyWords += 1;
      continue;
    }

    const dedupeKey = cleaned.toLowerCase();
    if (seen.has(dedupeKey)) {
      rejectionReasons.duplicate += 1;
      continue;
    }
    seen.add(dedupeKey);
    keyterms.push(cleaned);
  }

  const inputCount = candidates.length;
  const acceptedCount = keyterms.length;
  return {
    keyterms,
    summary: {
      inputCount,
      acceptedCount,
      rejectedCount: inputCount - acceptedCount,
      rejectionReasons,
    },
  };
}
