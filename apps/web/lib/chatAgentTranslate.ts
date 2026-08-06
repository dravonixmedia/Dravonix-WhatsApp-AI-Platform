import type { ChatAgentActionType, ChatAgentSupportedLanguage } from "@dravonix/ai";

/**
 * Actions whose successful output is a customer-ready draft -- eligible as
 * a Translate source, and the ones ChatAgentPanel tracks as "the latest
 * AI-generated draft". summarize/extract_lead/ask_question are
 * informational/internal outputs (tracked separately as "the latest
 * assistant result"), never customer-facing drafts, so they're
 * deliberately excluded.
 */
const DRAFT_ACTIONS: ReadonlySet<ChatAgentActionType> = new Set([
  "suggest_reply",
  "rewrite_draft",
  "translate",
  "prepare_follow_up",
]);

export function isDraftAction(action: ChatAgentActionType): boolean {
  return DRAFT_ACTIONS.has(action);
}

export type TranslateSource = "composer" | "draft" | "result";

/**
 * Resolves which source Translate should actually use. Priority: the human
 * reply composer first (if it has text), then the latest AI-generated
 * draft (Suggest reply/Rewrite/previous Translate/Follow-up), then the
 * latest non-draft assistant result (Summary/Extract lead/Ask AI answer).
 * `override` lets the user manually pick among the three -- but only when
 * the overridden option still has usable text; a stale override (e.g. the
 * composer was cleared after the user picked it as the source) silently
 * falls back to the priority default rather than pointing at now-empty
 * text. Returns null when none of the three sources has any text at all.
 */
export function resolveTranslateSource(
  composerText: string,
  aiDraftText: string | null,
  assistantResultText: string | null,
  override: TranslateSource | null,
): TranslateSource | null {
  const composerHasText = composerText.trim().length > 0;
  const draftHasText = Boolean(aiDraftText && aiDraftText.trim().length > 0);
  const resultHasText = Boolean(assistantResultText && assistantResultText.trim().length > 0);

  if (override === "composer" && composerHasText) return "composer";
  if (override === "draft" && draftHasText) return "draft";
  if (override === "result" && resultHasText) return "result";

  if (composerHasText) return "composer";
  if (draftHasText) return "draft";
  if (resultHasText) return "result";
  return null;
}

/** The actual text a resolved source points at -- "" when there is no valid source. */
export function resolveTranslateSourceText(
  source: TranslateSource | null,
  composerText: string,
  aiDraftText: string | null,
  assistantResultText: string | null,
): string {
  if (source === "composer") return composerText;
  if (source === "draft") return aiDraftText ?? "";
  if (source === "result") return assistantResultText ?? "";
  return "";
}

/** Staff-facing label for a resolved translate source, used by both the single-source label and the source selector's options. */
export const TRANSLATE_SOURCE_LABELS: Record<TranslateSource, string> = {
  composer: "Reply box",
  draft: "Latest AI draft",
  result: "Latest assistant result",
};

/**
 * Picks a sensible default target language, always different from the
 * detected source, so opening Translate never lands on a same-language
 * combination the staff member would just have to fix themselves:
 *
 *  - English source            -> Malayalam
 *  - Malayalam/Hindi/Arabic    -> English
 *  - unknown/no signal (null)  -> English
 *
 * This is only ever used to pre-select the target dropdown -- the user can
 * always change it manually afterward, and doing so is never overridden
 * again unless the resolved source text itself changes (see
 * ChatAgentPanel's own tracking of "which source text this default was
 * computed for"). Never calls the provider by itself.
 */
export function resolveDefaultTargetLanguage(
  detectedSourceLanguage: ChatAgentSupportedLanguage | null,
): ChatAgentSupportedLanguage {
  return detectedSourceLanguage === "en" ? "ml" : "en";
}
