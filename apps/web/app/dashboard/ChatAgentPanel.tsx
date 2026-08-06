"use client";

import { useEffect, useState } from "react";
import {
  CHAT_AGENT_SUPPORTED_LANGUAGES,
  detectLikelySourceLanguage,
  type ChatAgentActionType,
  type ChatAgentResult,
  type ChatAgentRewriteTone,
  type ChatAgentSupportedLanguage,
} from "@dravonix/ai";
import { chatAgentAction, type ChatAgentActionInput } from "../../lib/actions/chatAgent.js";
import {
  isDraftAction,
  resolveDefaultTargetLanguage,
  resolveTranslateSource,
  resolveTranslateSourceText,
  type TranslateSource,
} from "../../lib/chatAgentTranslate.js";
import { CloseIcon } from "./Icons.js";

const REWRITE_TONES: Array<{ value: ChatAgentRewriteTone; label: string }> = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "concise", label: "Concise" },
  { value: "persuasive", label: "More persuasive" },
  { value: "polite", label: "More polite" },
];

const ALL_LANGUAGES = Object.keys(CHAT_AGENT_SUPPORTED_LANGUAGES) as ChatAgentSupportedLanguage[];

type PanelView =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: ChatAgentResult }
  | { status: "error"; message: string };

type PendingRequest = Omit<ChatAgentActionInput, "conversationId">;
type SelectableAction = "rewrite_draft" | "translate";

/**
 * The Dashboard Chat Agent panel -- an internal staff copilot next to the
 * existing human reply composer. Every action here only ever calls
 * chatAgentAction (a read-only-to-the-outside-world Server Action: it never
 * sends WhatsApp messages, never assigns/pauses/resumes/closes a
 * conversation, and never creates or modifies a lead). "Use this reply"/
 * "Use in reply" only ever calls onUseReply, which the parent
 * (ConversationComposerWithAssistant) wires to the existing composer's
 * draft state -- it never sends anything; the existing manual Send button
 * is still required.
 *
 * Six quick actions are always visible: Summarize, Suggest reply, Rewrite,
 * Translate, Extract lead, Follow-up. Rewrite and Translate need extra
 * input before they can run, so selecting one reveals only that action's
 * own controls (never all controls at once) instead of running
 * immediately.
 *
 * Translate's target-language list is deliberately NOT filtered by the
 * company's automatic-bot enabled_languages setting -- this panel is an
 * internal staff tool, not the customer-facing WhatsApp bot, so it always
 * offers all four platform-supported languages. Per-company/subscription
 * language limits for this internal tool are a separate, not-yet-built
 * concern (see claude/subscriptions-team-management).
 */
export function ChatAgentPanel({
  conversationId,
  open,
  onClose,
  currentDraft,
  onUseReply,
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
  currentDraft: string;
  onUseReply: (text: string) => void;
}) {
  const [view, setView] = useState<PanelView>({ status: "idle" });
  const [lastRequest, setLastRequest] = useState<PendingRequest | null>(null);
  const [question, setQuestion] = useState("");
  const [tone, setTone] = useState<ChatAgentRewriteTone>("professional");
  const [targetLanguage, setTargetLanguage] = useState<ChatAgentSupportedLanguage>("en");
  const [copied, setCopied] = useState(false);
  const [selectedAction, setSelectedAction] = useState<SelectableAction | null>(null);
  const [latestAiDraft, setLatestAiDraft] = useState<string | null>(null);
  const [translateSourceOverride, setTranslateSourceOverride] = useState<TranslateSource | null>(
    null,
  );
  const [justInsertedTranslation, setJustInsertedTranslation] = useState(false);
  // Tracks which resolved source-text snapshot the current targetLanguage
  // was last auto-selected (or manually confirmed) for -- see the effect
  // below. Starts as a sentinel that can never equal a real source string,
  // so the very first time Translate has a source, the effect always runs.
  const [targetLanguageResolvedFor, setTargetLanguageResolvedFor] = useState<string | null>(null);

  const isPending = view.status === "loading";
  const hasDraft = currentDraft.trim().length > 0;

  const composerHasText = currentDraft.trim().length > 0;
  const aiDraftHasText = Boolean(latestAiDraft && latestAiDraft.trim().length > 0);
  const translateSource = resolveTranslateSource(
    currentDraft,
    latestAiDraft,
    translateSourceOverride,
  );
  const translateSourceText = resolveTranslateSourceText(
    translateSource,
    currentDraft,
    latestAiDraft,
  );
  const hasTranslateSource = translateSourceText.trim().length > 0;
  const detectedSourceLanguage = hasTranslateSource
    ? detectLikelySourceLanguage(translateSourceText)
    : null;
  const isSameLanguage =
    detectedSourceLanguage !== null && detectedSourceLanguage === targetLanguage;

  // Auto-selects a target language different from the detected source
  // whenever Translate is opened, or whenever the resolved source text
  // changes (a new draft became available, the source was switched, or the
  // composer/draft text itself changed) -- but never overwrites a target
  // the user already manually confirmed for THIS exact source text. Purely
  // a UI default: never calls chatAgentAction/Anthropic by itself.
  useEffect(() => {
    if (selectedAction !== "translate") return;
    if (!hasTranslateSource) return;
    if (targetLanguageResolvedFor === translateSourceText) return;
    setTargetLanguage(resolveDefaultTargetLanguage(detectedSourceLanguage));
    setTargetLanguageResolvedFor(translateSourceText);
  }, [
    selectedAction,
    hasTranslateSource,
    translateSourceText,
    detectedSourceLanguage,
    targetLanguageResolvedFor,
  ]);

  const noSourceGuidance = !hasTranslateSource ? "Write a reply or generate a draft first." : null;
  const sameLanguageGuidance = isSameLanguage
    ? `This text already appears to be in ${CHAT_AGENT_SUPPORTED_LANGUAGES[detectedSourceLanguage!]}. Select another language.`
    : null;

  async function run(request: PendingRequest) {
    if (isPending) return; // duplicate-click guard: never issue a second call while one is in flight
    setCopied(false);
    setJustInsertedTranslation(false);
    setLastRequest(request);
    setView({ status: "loading" });
    try {
      const response = await chatAgentAction({ conversationId, ...request });
      if (response.ok) {
        setView({ status: "success", result: response });
        if (isDraftAction(request.action) && response.displayText.trim()) {
          setLatestAiDraft(response.displayText);
        }
      } else {
        setView({ status: "error", message: response.message });
      }
    } catch {
      // chatAgentAction is designed to always return a result rather than
      // throw; this is a last-resort net in case anything upstream still
      // throws. The caught error's own message is never rendered -- in a
      // production build it may be Next.js's generic Server Components
      // digest text rather than anything safe to show staff.
      setView({
        status: "error",
        message: "The AI assistant is temporarily unavailable. Please try again shortly.",
      });
    }
  }

  function runSimpleAction(action: ChatAgentActionType) {
    setSelectedAction(null);
    void run({ action });
  }

  function toggleSelectedAction(action: SelectableAction) {
    setSelectedAction((current) => (current === action ? null : action));
  }

  function regenerate() {
    if (lastRequest) void run(lastRequest);
  }

  function useTranslationInReply() {
    if (view.status !== "success") return;
    onUseReply(view.result.displayText);
    setJustInsertedTranslation(true);
  }

  if (!open) return null;

  const showingTranslateResult = view.status === "success" && lastRequest?.action === "translate";

  return (
    <div className="dvx-assistant-panel" role="dialog" aria-label="AI Assistant">
      <div className="dvx-assistant-header">
        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>AI Assistant</span>
        <button
          type="button"
          className="dvx-icon-button"
          onClick={onClose}
          aria-label="Close AI Assistant"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="dvx-assistant-body">
        <div className="dvx-assistant-quick-actions">
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => runSimpleAction("summarize")}
          >
            Summarize
          </button>
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => runSimpleAction("suggest_reply")}
          >
            Suggest reply
          </button>
          <button
            type="button"
            className={
              selectedAction === "rewrite_draft" ? "dvx-button" : "dvx-button dvx-button--secondary"
            }
            aria-pressed={selectedAction === "rewrite_draft"}
            disabled={isPending}
            onClick={() => toggleSelectedAction("rewrite_draft")}
          >
            Rewrite
          </button>
          <button
            type="button"
            className={
              selectedAction === "translate" ? "dvx-button" : "dvx-button dvx-button--secondary"
            }
            aria-pressed={selectedAction === "translate"}
            disabled={isPending}
            onClick={() => toggleSelectedAction("translate")}
          >
            Translate
          </button>
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => runSimpleAction("extract_lead")}
          >
            Extract lead
          </button>
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => runSimpleAction("prepare_follow_up")}
          >
            Follow-up
          </button>
        </div>

        {selectedAction === "rewrite_draft" ? (
          <div className="dvx-assistant-action-row">
            <select
              className="dvx-input"
              value={tone}
              onChange={(e) => setTone(e.target.value as ChatAgentRewriteTone)}
              aria-label="Rewrite tone"
              disabled={isPending}
            >
              {REWRITE_TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="dvx-button dvx-button--secondary"
              disabled={isPending || !hasDraft}
              title={hasDraft ? undefined : "Write a draft first"}
              onClick={() => run({ action: "rewrite_draft", draft: currentDraft, tone })}
            >
              Rewrite my draft
            </button>
          </div>
        ) : null}

        {selectedAction === "translate" ? (
          <div className="dvx-assistant-translate-panel">
            {composerHasText && aiDraftHasText ? (
              <div className="dvx-assistant-action-row">
                <span className="dvx-muted" style={{ fontSize: "0.72rem" }}>
                  Source:
                </span>
                <select
                  className="dvx-input"
                  aria-label="Translate source"
                  value={translateSource ?? "composer"}
                  onChange={(e) => setTranslateSourceOverride(e.target.value as TranslateSource)}
                  disabled={isPending}
                >
                  <option value="composer">Reply box</option>
                  <option value="draft">Latest AI draft</option>
                </select>
              </div>
            ) : hasTranslateSource ? (
              <p className="dvx-muted" style={{ fontSize: "0.72rem", margin: 0 }}>
                Source: {translateSource === "composer" ? "Reply box" : "Latest AI draft"}
              </p>
            ) : null}

            <select
              className="dvx-input"
              aria-label="Translate into"
              value={targetLanguage}
              onChange={(e) => {
                const nextLanguage = e.target.value as ChatAgentSupportedLanguage;
                setTargetLanguage(nextLanguage);
                // A manual pick counts as "resolved" for this source text --
                // the auto-select effect must not immediately overwrite it.
                setTargetLanguageResolvedFor(translateSourceText);
              }}
              disabled={isPending}
            >
              {ALL_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {CHAT_AGENT_SUPPORTED_LANGUAGES[lang]}
                </option>
              ))}
            </select>

            {noSourceGuidance ? (
              <p className="dvx-muted" style={{ fontSize: "0.72rem", margin: 0 }}>
                {noSourceGuidance}
              </p>
            ) : null}

            {sameLanguageGuidance ? (
              <p className="dvx-muted" style={{ fontSize: "0.72rem", margin: 0 }}>
                {sameLanguageGuidance}
              </p>
            ) : null}

            <button
              type="button"
              className="dvx-button dvx-button--secondary"
              disabled={isPending || !hasTranslateSource || isSameLanguage}
              onClick={() =>
                run({ action: "translate", draft: translateSourceText, targetLanguage })
              }
            >
              Translate
            </button>
          </div>
        ) : null}

        <div className="dvx-assistant-question">
          <input
            className="dvx-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask AI about this conversation…"
            disabled={isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && question.trim()) run({ action: "ask_question", question });
            }}
          />
          <button
            type="button"
            className="dvx-button"
            disabled={isPending || !question.trim()}
            onClick={() => run({ action: "ask_question", question })}
          >
            Ask
          </button>
        </div>

        {view.status === "loading" ? <div className="dvx-assistant-status">Thinking…</div> : null}

        {view.status === "error" ? (
          <div className="dvx-assistant-status dvx-assistant-status--error">
            <p style={{ margin: 0 }}>{view.message}</p>
            {lastRequest ? (
              <button
                type="button"
                className="dvx-button dvx-button--secondary"
                style={{ marginTop: "0.5rem" }}
                onClick={regenerate}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {view.status === "success" && !showingTranslateResult ? (
          view.result.displayText.trim() ? (
            <div className="dvx-assistant-result">
              <pre className="dvx-assistant-result-text">{view.result.displayText}</pre>
              {view.result.historyTruncated ? (
                <p className="dvx-muted" style={{ fontSize: "0.72rem" }}>
                  Note: only the most recent portion of this conversation was used -- older messages
                  were not reviewed.
                </p>
              ) : null}
              <div className="dvx-assistant-result-actions">
                <button
                  type="button"
                  className="dvx-button"
                  onClick={() => onUseReply(view.result.displayText)}
                >
                  Use this reply
                </button>
                <button
                  type="button"
                  className="dvx-button dvx-button--secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(view.result.displayText);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="dvx-button dvx-button--secondary"
                  onClick={regenerate}
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  className="dvx-button dvx-button--secondary"
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div className="dvx-assistant-status">
              The assistant had nothing to add for this request.
            </div>
          )
        ) : null}

        {showingTranslateResult && view.status === "success" ? (
          view.result.displayText.trim() ? (
            <div className="dvx-assistant-result">
              <div className="dvx-muted" style={{ fontSize: "0.72rem", fontWeight: 600 }}>
                Translated to {CHAT_AGENT_SUPPORTED_LANGUAGES[lastRequest?.targetLanguage ?? "en"]}
              </div>
              <pre className="dvx-assistant-result-text">{view.result.displayText}</pre>
              {view.result.historyTruncated ? (
                <p className="dvx-muted" style={{ fontSize: "0.72rem" }}>
                  Note: only the most recent portion of this conversation was used -- older messages
                  were not reviewed.
                </p>
              ) : null}
              <div className="dvx-assistant-result-actions">
                <button type="button" className="dvx-button" onClick={useTranslationInReply}>
                  Use in reply
                </button>
                <button
                  type="button"
                  className="dvx-button dvx-button--secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(view.result.displayText);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="dvx-button dvx-button--secondary"
                  onClick={regenerate}
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  className="dvx-button dvx-button--secondary"
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
              {justInsertedTranslation ? (
                <p className="dvx-muted" style={{ fontSize: "0.72rem" }}>
                  Translation added to the reply box.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="dvx-assistant-status">
              The assistant had nothing to add for this request.
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
