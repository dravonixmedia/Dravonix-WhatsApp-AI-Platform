import type { ChatAgentSupportedLanguage } from "./types.js";

/**
 * Deterministic, script-based heuristic for guessing which of the Chat
 * Agent's four supported languages a piece of staff-authored text is
 * already in. Used only for the dashboard's client-side "this text is
 * already in X -- select another language" guard before Translate, never
 * sent to or trusted by the Anthropic provider itself. Not a real language
 * identifier -- it only distinguishes the four supported scripts
 * (Malayalam/Devanagari/Arabic/Latin) by counting characters in each
 * Unicode block, which is sufficient for this one narrow purpose. Returns
 * null when the text is empty or has no clear signal either way (never
 * blocks a translation attempt on an ambiguous guess).
 */
export function detectLikelySourceLanguage(text: string): ChatAgentSupportedLanguage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const scriptCounts: Array<[ChatAgentSupportedLanguage, number]> = [
    ["ml", (trimmed.match(/[ഀ-ൿ]/g) ?? []).length],
    ["hi", (trimmed.match(/[ऀ-ॿ]/g) ?? []).length],
    ["ar", (trimmed.match(/[؀-ۿ]/g) ?? []).length],
  ];
  const latinCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;

  const [topScript, topCount] = scriptCounts.sort((a, b) => b[1] - a[1])[0]!;

  if (topCount > 0 && topCount >= latinCount) return topScript;
  if (latinCount > 0) return "en";
  return null;
}
