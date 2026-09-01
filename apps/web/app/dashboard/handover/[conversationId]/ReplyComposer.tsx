"use client";

import { useRef, useState, useTransition } from "react";
import {
  sendHumanReplyAction,
  sendServiceWindowTemplateAction,
} from "../../../../lib/actions/handover.js";

/**
 * Meta/WhatsApp Batch 2, Phase 8: the exact copy WhatsAppServiceWindowClosedError
 * throws (packages/handover/src/errors.ts) when the 24-hour free-form
 * service window has closed. Matched verbatim against OUR OWN
 * first-party error string (never Meta's) purely to decide whether to
 * offer the "Send re-engagement template" fallback action -- Server
 * Actions only cross the client boundary as a plain Error, losing the
 * original WhatsAppServiceWindowClosedError class identity.
 */
const SERVICE_WINDOW_CLOSED_MESSAGE =
  "The WhatsApp customer service window has expired. An approved template is required before free-form replies can resume.";

/**
 * Client component only for the client-generated idempotency key (Human
 * Handover Inbox final plan section 11): generated once per compose action,
 * held in component state, rotated only after a confirmed send -- a retry of
 * the same compose (e.g. a flaky network re-submit) reuses the same key so
 * the server-side reserve_human_outbound_message call is idempotent, never
 * producing a duplicate WhatsApp send.
 *
 * `value`/`onChange` are optional: omitted, the textarea is a plain
 * uncontrolled field (the original behavior). Passed (by
 * ConversationComposerWithAssistant, so the Chat Agent's "Use in reply"
 * can insert text), the textarea becomes controlled -- but the actual send
 * path below is completely unchanged either way: it still reads `body` from
 * the submitted FormData (a controlled input still participates in
 * FormData via its `name` attribute), still generates/rotates the same
 * idempotency key, and still only ever calls sendHumanReplyAction on
 * explicit form submit. The Chat Agent itself never calls this function.
 */
export function ReplyComposer({
  conversationId,
  value,
  onChange,
}: {
  conversationId: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [templateIdempotencyKey, setTemplateIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isPending, startTransition] = useTransition();
  const [isSendingTemplate, startTemplateTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSent, setTemplateSent] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const isControlled = value !== undefined && onChange !== undefined;
  const windowClosed = error === SERVICE_WINDOW_CLOSED_MESSAGE;

  return (
    <form
      ref={formRef}
      action={(formData) => {
        const body = String(formData.get("body") ?? "").trim();
        if (!body) return;
        setError(null);
        startTransition(async () => {
          try {
            await sendHumanReplyAction(conversationId, body, idempotencyKey);
            setIdempotencyKey(crypto.randomUUID());
            formRef.current?.reset();
            onChange?.("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send reply");
          }
        });
      }}
      style={{ marginTop: "1rem" }}
    >
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <textarea
          name="body"
          required
          className="dvx-input"
          style={{ flex: 1, minHeight: 60 }}
          placeholder="Type a reply..."
          disabled={isPending}
          {...(isControlled
            ? {
                value,
                onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value),
              }
            : {})}
        />
        <button className="dvx-button" type="submit" disabled={isPending}>
          {isPending ? "Sending..." : "Send"}
        </button>
      </div>
      {error ? (
        <p style={{ color: "#dc2626", fontSize: "0.8rem", marginTop: "0.35rem" }}>{error}</p>
      ) : null}
      {windowClosed ? (
        templateSent ? (
          <p className="dvx-muted" style={{ fontSize: "0.78rem", marginTop: "0.35rem" }}>
            Re-engagement template sent. The customer's next reply will reopen free-form replies.
          </p>
        ) : (
          <div style={{ marginTop: "0.35rem" }}>
            <button
              className="dvx-button dvx-button--secondary"
              type="button"
              disabled={isSendingTemplate}
              onClick={() => {
                setTemplateError(null);
                startTemplateTransition(async () => {
                  try {
                    await sendServiceWindowTemplateAction(conversationId, templateIdempotencyKey);
                    setTemplateIdempotencyKey(crypto.randomUUID());
                    setTemplateSent(true);
                  } catch (err) {
                    setTemplateError(
                      err instanceof Error ? err.message : "Failed to send re-engagement template",
                    );
                  }
                });
              }}
            >
              {isSendingTemplate ? "Sending template..." : "Send re-engagement template"}
            </button>
            {templateError ? (
              <p style={{ color: "#dc2626", fontSize: "0.78rem", marginTop: "0.25rem" }}>
                {templateError}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </form>
  );
}
