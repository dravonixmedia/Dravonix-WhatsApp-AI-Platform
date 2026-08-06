import type { ChatAgentActionType } from "@dravonix/ai";

/**
 * Actions whose successful output is a customer-ready draft -- eligible as
 * a Translate source, and the ones ChatAgentPanel tracks as "the latest
 * AI-generated draft". summarize/extract_lead/ask_question are
 * informational/internal outputs, never customer-facing drafts, so they're
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

export type TranslateSource = "composer" | "draft";

/**
 * Resolves which source Translate should actually use. Priority: the human
 * reply composer first (if it has text), otherwise the latest AI-generated
 * draft. `override` lets the user manually pick between the two -- but only
 * when the overridden option still has usable text; a stale override (e.g.
 * the composer was cleared after the user picked it as the source) silently
 * falls back to the priority default rather than pointing at now-empty
 * text. Returns null when neither source has any text at all.
 */
export function resolveTranslateSource(
  composerText: string,
  aiDraftText: string | null,
  override: TranslateSource | null,
): TranslateSource | null {
  const composerHasText = composerText.trim().length > 0;
  const draftHasText = Boolean(aiDraftText && aiDraftText.trim().length > 0);

  if (override === "composer" && composerHasText) return "composer";
  if (override === "draft" && draftHasText) return "draft";

  if (composerHasText) return "composer";
  if (draftHasText) return "draft";
  return null;
}

/** The actual text a resolved source points at -- "" when there is no valid source. */
export function resolveTranslateSourceText(
  source: TranslateSource | null,
  composerText: string,
  aiDraftText: string | null,
): string {
  if (source === "composer") return composerText;
  if (source === "draft") return aiDraftText ?? "";
  return "";
}
