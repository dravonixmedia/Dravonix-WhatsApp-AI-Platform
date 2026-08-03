const MALAYALAM_SCRIPT_PATTERN = /[ഀ-ൿ]/g;
const LATIN_LETTER_PATTERN = /[a-zA-Z]/g;

/**
 * True when Malayalam script characters are at least as numerous as Latin
 * letters in the text -- used to pick the TTS voice/model for a reply,
 * including Malayalam-English mixed replies where Malayalam dominates.
 */
export function isDominantlyMalayalam(text: string): boolean {
  const malayalamCount = (text.match(MALAYALAM_SCRIPT_PATTERN) ?? []).length;
  if (malayalamCount === 0) return false;
  const latinCount = (text.match(LATIN_LETTER_PATTERN) ?? []).length;
  return malayalamCount >= latinCount;
}

/** True when a BCP-47/ISO 639-1 language code identifies Malayalam (e.g. "ml", "ml-IN"). */
export function isMalayalamLanguageCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.trim().toLowerCase().startsWith("ml");
}
