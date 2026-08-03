/**
 * Normalizes a raw STT transcript before it's used as the customer's message
 * text: Unicode NFC normalization (matters for scripts like Malayalam, whose
 * conjunct consonants and vowel signs can be represented by more than one
 * equivalent sequence of combining code points depending on the STT
 * provider's output) plus whitespace collapsing. Never assumes or requires a
 * Latin/ASCII script -- correctness here doesn't depend on which language was
 * spoken.
 */
export function normalizeTranscript(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
