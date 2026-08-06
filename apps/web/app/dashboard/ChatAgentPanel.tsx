"use client";

import { useState } from "react";
import type {
  ChatAgentResult,
  ChatAgentRewriteTone,
  ChatAgentSupportedLanguage,
} from "@dravonix/ai";
import { chatAgentAction, type ChatAgentActionInput } from "../../lib/actions/chatAgent.js";
import { CloseIcon } from "./Icons.js";

const REWRITE_TONES: Array<{ value: ChatAgentRewriteTone; label: string }> = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "concise", label: "Concise" },
  { value: "persuasive", label: "More persuasive" },
  { value: "polite", label: "More polite" },
];

const TRANSLATE_LANGUAGES: Array<{ value: ChatAgentSupportedLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "ml", label: "Malayalam" },
  { value: "hi", label: "Hindi" },
  { value: "ar", label: "Arabic" },
];

type PanelView =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: ChatAgentResult }
  | { status: "error"; message: string };

type PendingRequest = Omit<ChatAgentActionInput, "conversationId">;

/**
 * The Dashboard Chat Agent panel -- an internal staff copilot next to the
 * existing human reply composer. Every action here only ever calls
 * chatAgentAction (a read-only-to-the-outside-world Server Action: it never
 * sends WhatsApp messages, never assigns/pauses/resumes/closes a
 * conversation, and never creates or modifies a lead). "Use this reply"
 * only calls onUseReply, which the parent (ConversationComposerWithAssistant)
 * wires to the existing composer's draft state -- it never sends anything;
 * the existing manual Send button is still required.
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

  const isPending = view.status === "loading";
  const hasDraft = currentDraft.trim().length > 0;

  async function run(request: PendingRequest) {
    if (isPending) return; // duplicate-click guard: never issue a second call while one is in flight
    setCopied(false);
    setLastRequest(request);
    setView({ status: "loading" });
    try {
      const response = await chatAgentAction({ conversationId, ...request });
      if (response.ok) {
        setView({ status: "success", result: response });
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

  function regenerate() {
    if (lastRequest) void run(lastRequest);
  }

  if (!open) return null;

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
        <div className="dvx-assistant-actions">
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => run({ action: "summarize" })}
          >
            Summarize conversation
          </button>
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => run({ action: "suggest_reply" })}
          >
            Suggest a reply
          </button>

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

          <div className="dvx-assistant-action-row">
            <select
              className="dvx-input"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value as ChatAgentSupportedLanguage)}
              aria-label="Translate into"
              disabled={isPending}
            >
              {TRANSLATE_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="dvx-button dvx-button--secondary"
              disabled={isPending || !hasDraft}
              title={hasDraft ? undefined : "Write or generate a reply first"}
              onClick={() => run({ action: "translate", draft: currentDraft, targetLanguage })}
            >
              Translate
            </button>
          </div>

          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => run({ action: "extract_lead" })}
          >
            Extract lead details
          </button>
          <button
            type="button"
            className="dvx-button dvx-button--secondary"
            disabled={isPending}
            onClick={() => run({ action: "prepare_follow_up" })}
          >
            Prepare follow-up
          </button>
        </div>

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

        {view.status === "success" ? (
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
      </div>
    </div>
  );
}
