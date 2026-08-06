"use client";

import { useRef, useState, useTransition } from "react";
import { sendHumanReplyAction } from "../../../../lib/actions/handover.js";

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
 * ConversationComposerWithAssistant, so the Chat Agent's "Use this reply"
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
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isControlled = value !== undefined && onChange !== undefined;

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
    </form>
  );
}
