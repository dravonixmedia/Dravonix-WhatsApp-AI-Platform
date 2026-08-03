/**
 * Curated Malayalam-script equivalents for common Dravonix business terms.
 * Ordered longest-phrase-first so a multi-word phrase is replaced before its
 * constituent single words could match it partially (e.g. "business card
 * design" before "business card", "packages" before "package"). Deliberately
 * a fixed dictionary, not automatic transliteration -- ElevenLabs otherwise
 * flips pronunciation style mid-sentence when Roman-script English words are
 * interleaved with Malayalam script.
 */
const BUSINESS_TERM_DICTIONARY: ReadonlyArray<readonly [string, string]> = [
  ["dravonix media", "ഡ്രാവോണിക്സ് മീഡിയ"],
  ["business card design", "ബിസിനസ് കാർഡ് ഡിസൈൻ"],
  ["business card", "ബിസിനസ് കാർഡ്"],
  ["brand guidelines", "ബ്രാൻഡ് ഗൈഡ്‌ലൈൻസ്"],
  ["full brand identity", "ഫുൾ ബ്രാൻഡ് ഐഡന്റിറ്റി"],
  ["social media templates", "സോഷ്യൽ മീഡിയ ടെംപ്ലേറ്റുകൾ"],
  ["social media", "സോഷ്യൽ മീഡിയ"],
  ["website development", "വെബ്സൈറ്റ് ഡെവലപ്മെന്റ്"],
  ["website", "വെബ്സൈറ്റ്"],
  ["exact quotation", "കൃത്യമായ ക്വട്ടേഷൻ"],
  ["quotation", "ക്വട്ടേഷൻ"],
  ["letterhead", "ലെറ്റർഹെഡ്"],
  ["packages", "പാക്കേജുകൾ"],
  ["package", "പാക്കേജ്"],
  ["services", "സർവീസുകൾ"],
  ["service", "സർവീസ്"],
  ["branding", "ബ്രാൻഡിംഗ്"],
  ["logo", "ലോഗോ"],
  ["budget", "ബജറ്റ്"],
  ["dravonix", "ഡ്രാവോണിക്സ്"],
];

const PAGE_UNIT_WORDS: Record<"page" | "pages", string> = {
  page: "പേജ്",
  pages: "പേജുകൾ",
};

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
/** Round thousands (1000-9000). */
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
/** Round ten-thousands (10000-90000). */
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
/** Mid-range round thousands ending in 5 (15000, 25000, ... 95000) -- a distinct Malayalam allomorph ("ayyi-"), not derivable by simple concatenation. */
const ROUND_MID_THOUSANDS: Record<number, string> = {
  15: "പതിനയ്യായിരം",
  25: "ഇരുപത്തയ്യായിരം",
  35: "മുപ്പത്തയ്യായിരം",
  45: "നാൽപ്പത്തയ്യായിരം",
  55: "അമ്പത്തയ്യായിരം",
  65: "അറുപത്തയ്യായിരം",
  75: "എഴുപത്തയ്യായിരം",
  85: "എൺപത്തയ്യായിരം",
  95: "തൊണ്ണൂറ്റയ്യായിരം",
};

const ORDINAL_ADJECTIVE = [
  "",
  "ഒന്നാമത്തെ",
  "രണ്ടാമത്തെ",
  "മൂന്നാമത്തെ",
  "നാലാമത്തെ",
  "അഞ്ചാമത്തെ",
  "ആറാമത്തെ",
  "ഏഴാമത്തെ",
  "എട്ടാമത്തെ",
  "ഒൻപതാമത്തെ",
  "പത്താമത്തെ",
];
const ORDINAL_STANDALONE = [
  "",
  "ഒന്നാമത്തേത്",
  "രണ്ടാമത്തേത്",
  "മൂന്നാമത്തേത്",
  "നാലാമത്തേത്",
  "അഞ്ചാമത്തേത്",
  "ആറാമത്തേത്",
  "ഏഴാമത്തേത്",
  "എട്ടാമത്തേത്",
  "ഒൻപതാമത്തേത്",
  "പത്താമത്തേത്",
];

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
  return remainder === 0
    ? HUNDREDS[hundreds]!
    : `${HUNDREDS[hundreds]} ${wordsUnder100(remainder)}`;
}

/**
 * Converts a non-negative integer into natural spoken Malayalam words.
 * Round thousands/ten-thousands/mid-thousands use curated standard compound
 * forms (the most common amounts in a business quotation); anything else
 * falls back to a simpler additive construction -- intentionally less
 * fused/literary, matching this hotfix's "natural over literary" goal.
 */
export function numberToMalayalamWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return ONES[0]!;
  if (n < 1000) return wordsUnder1000(n);

  if (n < 100000) {
    const thousands = Math.floor(n / 1000);
    const remainder = n % 1000;
    let thousandsWord: string;
    if (thousands % 10 === 0 && ROUND_TEN_THOUSANDS[thousands / 10]) {
      thousandsWord = ROUND_TEN_THOUSANDS[thousands / 10]!;
    } else if (ROUND_MID_THOUSANDS[thousands]) {
      thousandsWord = ROUND_MID_THOUSANDS[thousands]!;
    } else if (ROUND_THOUSANDS[thousands]) {
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

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyBusinessTermDictionary(text: string): string {
  let result = text;
  for (const [term, replacement] of BUSINESS_TERM_DICTIONARY) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi"), replacement);
  }
  return result;
}

function convertCurrency(text: string): string {
  return text.replace(
    /₹\s?([\d,]+)/g,
    (_match, digits: string) => `${numberToMalayalamWords(parseDigits(digits))} രൂപ`,
  );
}

function convertPageUnits(text: string): string {
  let result = text.replace(
    /(\d+)\s?[–—-]\s?(\d+)\s+(pages?)\b/gi,
    (_match, a: string, b: string, unit: string) => {
      const translated = PAGE_UNIT_WORDS[unit.toLowerCase() === "page" ? "page" : "pages"];
      return `${numberToMalayalamWords(Number(a))} മുതൽ ${numberToMalayalamWords(Number(b))} ${translated} വരെ`;
    },
  );
  result = result.replace(/(\d+)\s+(pages?)\b/gi, (_match, digits: string, unit: string) => {
    const translated = PAGE_UNIT_WORDS[unit.toLowerCase() === "page" ? "page" : "pages"];
    return `${numberToMalayalamWords(Number(digits))} ${translated}`;
  });
  return result;
}

const EMOJI_PATTERN =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
// Variation selector-16 (forces emoji-style rendering of the preceding
// character) -- kept as its own regex since combining it into EMOJI_PATTERN's
// character class trips ESLint's no-misleading-character-class rule.
const VARIATION_SELECTOR_PATTERN = /\u{FE0F}/gu;

function stripUnspokenSymbols(text: string): string {
  return text
    .replace(EMOJI_PATTERN, "")
    .replace(VARIATION_SELECTOR_PATTERN, "")
    .replace(/[•●▪]/g, "")
    .replace(/[()[\]/]/g, " ");
}

function collapseRepeatedPunctuation(text: string): string {
  return text.replace(/([!?.,])\1+/g, "$1");
}

function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/(?<![a-zA-Z0-9])_(.*?)_(?![a-zA-Z0-9])/g, "$1")
    .replace(/`(.*?)`/g, "$1");
}

function ensureSentenceEnding(sentence: string): string {
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

const HEADING_PATTERN = /^#{1,6}\s+/;
const NUMBERED_LIST_PATTERN = /^(\d+)[.)]\s+(.*)$/;
const BULLET_PATTERN = /^[-*•●▪]\s+/;
// A numbered "<description> -- <currency>" line, e.g. "Full Brand Identity
// Package -- Rs.30,000" -- rewritten into an ordinal spoken sentence rather
// than read visually. Matches em dash/en dash/hyphen as the separator.
const PACKAGE_LINE_PATTERN = /^(.*?)\s*[—–-]\s*₹\s?([\d,]+)\s*$/;

function buildPackageSentence(index: number, rawDescription: string, amount: number): string {
  const translatedDescription = applyBusinessTermDictionary(rawDescription).trim();
  const items = translatedDescription
    .split("+")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const amountWords = numberToMalayalamWords(amount);
  const priceSentence = `ഇതിന്റെ വില ${amountWords} രൂപയാണ്.`;

  if (items.length > 1) {
    const adjective = ORDINAL_ADJECTIVE[index] || `${index}-ാമത്തെ`;
    return `${adjective} പാക്കേജിൽ ${items.join(", ")} എന്നിവ ഉൾപ്പെടും. ${priceSentence}`;
  }

  const standalone = ORDINAL_STANDALONE[index] || `${index}-ാമത്തേത്`;
  return `${standalone} ${items[0]} ആണ്. ${priceSentence}`;
}

function convertLineToSpokenSentence(rawLine: string): string {
  let line = rawLine.replace(HEADING_PATTERN, "");

  const numberedMatch = line.match(NUMBERED_LIST_PATTERN);
  if (numberedMatch) {
    const index = Number(numberedMatch[1]);
    const rest = numberedMatch[2]!.trim();
    const packageMatch = rest.match(PACKAGE_LINE_PATTERN);
    if (packageMatch) {
      return buildPackageSentence(index, packageMatch[1]!, parseDigits(packageMatch[2]!));
    }
    line = rest;
  } else {
    line = line.replace(BULLET_PATTERN, "");
  }

  line = stripMarkdownEmphasis(line);
  line = applyBusinessTermDictionary(line);
  line = convertCurrency(line);
  line = convertPageUnits(line);
  line = line.replace(/\d+/g, (digits) => numberToMalayalamWords(Number(digits)));
  return ensureSentenceEnding(line.trim());
}

/**
 * Prepares a separate, TTS-only Malayalam speech string from the AI's
 * WhatsApp display text. The displayed/stored WhatsApp message is never
 * touched by this function -- callers must keep using the original text for
 * the customer-facing reply and only pass this result to the TTS provider.
 */
export function prepareMalayalamSpeechText(displayText: string): string {
  const lines = displayText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let text = lines.map(convertLineToSpokenSentence).join(" ");
  text = stripUnspokenSymbols(text);
  text = collapseRepeatedPunctuation(text);
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
