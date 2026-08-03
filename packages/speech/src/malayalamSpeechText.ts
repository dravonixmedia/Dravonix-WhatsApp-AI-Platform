const MALAYALAM_SCRIPT_PATTERN = /[ഀ-ൿ]/g;
const LATIN_LETTER_PATTERN = /[a-zA-Z]/g;

/**
 * True when Malayalam script is the dominant script in the text -- pure
 * Malayalam, or Malayalam-English mixed text where Malayalam characters
 * outnumber Latin ones. Used to decide both which ElevenLabs voice to
 * synthesize with and whether to run the Malayalam TTS-preparation layer
 * below. Never based on a language *tag* alone (e.g. the AI response's
 * `language` field, or the STT-detected code) -- a reply can be written in
 * Malayalam even when an upstream label says otherwise, and this is the
 * only check that reflects what will actually be read aloud.
 */
export function isDominantlyMalayalam(text: string): boolean {
  const malayalamCount = (text.match(MALAYALAM_SCRIPT_PATTERN) ?? []).length;
  if (malayalamCount === 0) return false;
  const latinCount = (text.match(LATIN_LETTER_PATTERN) ?? []).length;
  return malayalamCount >= latinCount;
}

const ONES = [
  "പൂജ്യം",
  "ഒന്ന്",
  "രണ്ട്",
  "മൂന്ന്",
  "നാല്",
  "അഞ്ച്",
  "ആറ്",
  "ഏഴ്",
  "എട്ട്",
  "ഒൻപത്",
];

const TEENS = [
  "പത്ത്",
  "പതിനൊന്ന്",
  "പന്ത്രണ്ട്",
  "പതിമൂന്ന്",
  "പതിനാല്",
  "പതിനഞ്ച്",
  "പതിനാറ്",
  "പതിനേഴ്",
  "പതിനെട്ട്",
  "പത്തൊൻപത്",
];

/** Index 2 = twenty, ... index 9 = ninety; 0/1 unused (covered by ONES/TEENS). */
const TENS = [
  "",
  "",
  "ഇരുപത്",
  "മുപ്പത്",
  "നാൽപത്",
  "അമ്പത്",
  "അറുപത്",
  "എഴുപത്",
  "എൺപത്",
  "തൊണ്ണൂറ്",
];

/** Index 1-9 = one hundred, ..., nine hundred -- standard Malayalam compound forms. */
const HUNDREDS: Record<number, string> = {
  1: "നൂറ്",
  2: "ഇരുനൂറ്",
  3: "മുന്നൂറ്",
  4: "നാനൂറ്",
  5: "അഞ്ഞൂറ്",
  6: "അറുനൂറ്",
  7: "എഴുനൂറ്",
  8: "എണ്ണൂറ്",
  9: "തൊള്ളായിരം",
};

/** Round thousands (1000-9000): standard Malayalam compound forms. */
const ROUND_THOUSANDS: Record<number, string> = {
  1: "ആയിരം",
  2: "രണ്ടായിരം",
  3: "മൂവായിരം",
  4: "നാലായിരം",
  5: "അയ്യായിരം",
  6: "ആറായിരം",
  7: "ഏഴായിരം",
  8: "എട്ടായിരം",
  9: "ഒൻപതിനായിരം",
};

/** Round ten-thousands (10,000-90,000): standard Malayalam compound forms. */
const ROUND_TEN_THOUSANDS: Record<number, string> = {
  1: "പതിനായിരം",
  2: "ഇരുപതിനായിരം",
  3: "മുപ്പതിനായിരം",
  4: "നാൽപതിനായിരം",
  5: "അമ്പതിനായിരം",
  6: "അറുപതിനായിരം",
  7: "എഴുപതിനായിരം",
  8: "എൺപതിനായിരം",
  9: "തൊണ്ണൂറായിരം",
};

function wordsUnder100(n: number): string {
  if (n < 10) return ONES[n]!;
  if (n < 20) return TEENS[n - 10]!;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? TENS[tens]! : `${TENS[tens]} ${ONES[ones]}`;
}

function wordsUnder1000(n: number): string {
  if (n < 100) return wordsUnder100(n);
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  const hundredsWord = HUNDREDS[hundreds] ?? `${ONES[hundreds]} നൂറ്`;
  return remainder === 0 ? hundredsWord : `${hundredsWord} ${wordsUnder100(remainder)}`;
}

/**
 * Converts a non-negative integer into spoken Malayalam words (Indian
 * numbering: thousand, lakh), using standard compound forms for common
 * round numbers (e.g. 30000 -> "മുപ്പതിനായിരം") and a natural, additive,
 * space-separated construction for anything else -- conversational Malayalam
 * commonly drops the more literary sandhi fusion for less common values,
 * which is intentional here (final plan: prefer natural over literary).
 */
export function numberToMalayalamWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return ONES[0]!;
  if (n < 1000) return wordsUnder1000(n);

  if (n < 100000) {
    const thousands = Math.floor(n / 1000);
    const remainder = n % 1000;
    let thousandsWord: string;
    if (remainder === 0 && thousands % 10 === 0 && ROUND_TEN_THOUSANDS[thousands / 10]) {
      thousandsWord = ROUND_TEN_THOUSANDS[thousands / 10]!;
    } else if (remainder === 0 && ROUND_THOUSANDS[thousands]) {
      thousandsWord = ROUND_THOUSANDS[thousands]!;
    } else {
      thousandsWord = `${wordsUnder1000(thousands)} ആയിരം`;
    }
    return remainder === 0 ? thousandsWord : `${thousandsWord} ${wordsUnder1000(remainder)}`;
  }

  const lakhs = Math.floor(n / 100000);
  const remainder = n % 100000;
  const lakhsWord = lakhs === 1 ? "ഒരു ലക്ഷം" : `${numberToMalayalamWords(lakhs)} ലക്ഷം`;
  return remainder === 0 ? lakhsWord : `${lakhsWord} ${numberToMalayalamWords(remainder)}`;
}

function parseDigits(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * Prepares a Malayalam (or Malayalam-dominant mixed) AI reply for
 * text-to-speech, entirely separate from the WhatsApp display text (the
 * caller must keep using the original `response.answer` for the text
 * message/DB record -- this function's output is only ever passed to the
 * TTS provider):
 *  - Markdown numbering/bullets/bold/italics/headers are stripped, and each
 *    list item becomes its own short spoken sentence instead of a bullet.
 *  - Currency amounts and numbers are converted into spoken Malayalam words
 *    (₹30,000 -> "മുപ്പതിനായിരം രൂപ"), while a plain number followed by an
 *    English unit word keeps that word in English (10 pages -> "പത്ത് pages"),
 *    and a range converts to a natural "X മുതൽ Y ... വരെ" construction
 *    (1-5 pages -> "ഒന്ന് മുതൽ അഞ്ച് pages വരെ").
 *  - Unicode-normalized to NFC, since Malayalam's combining vowel signs/
 *    conjuncts can otherwise reach the TTS provider in more than one
 *    equivalent code-point sequence.
 */
export function prepareMalayalamSpeechText(displayText: string): string {
  const lines = displayText
    .split(/\r?\n+/)
    .map((line) =>
      line
        .replace(/^\s*(?:\d+[.)]|[-*•●▪])\s+/, "")
        .trim()
        .replace(/[:：]\s*$/, ""),
    )
    .filter((line) => line.length > 0);

  let text = lines.join(". ");

  // Strip remaining inline Markdown formatting/headers/symbols -- none of
  // this should ever be read aloud.
  text = text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/(?<![a-zA-Z0-9])_(.*?)_(?![a-zA-Z0-9])/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[•●▪]/g, "");

  // Currency: ₹30,000 -> മുപ്പതിനായിരം രൂപ
  text = text.replace(
    /₹\s?([\d,]+)/g,
    (_match, digits: string) => `${numberToMalayalamWords(parseDigits(digits))} രൂപ`,
  );

  // Ranges: 1-5 pages -> ഒന്ന് മുതൽ അഞ്ച് pages വരെ
  text = text.replace(
    /(\d+)\s?[–—-]\s?(\d+)\s+([a-zA-Z]+)/g,
    (_match, a: string, b: string, word: string) =>
      `${numberToMalayalamWords(Number(a))} മുതൽ ${numberToMalayalamWords(Number(b))} ${word} വരെ`,
  );

  // Remaining bare numbers followed by an English word: 10 pages -> പത്ത് pages
  text = text.replace(
    /(\d+)\s+([a-zA-Z]+)/g,
    (_match, digits: string, word: string) => `${numberToMalayalamWords(Number(digits))} ${word}`,
  );

  // A bare number with no following word still needs to be spoken as words.
  text = text.replace(/\d+/g, (digits) => numberToMalayalamWords(Number(digits)));

  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
