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
 */
export function ReplyComposer({ conversationId }: { conversationId: string }) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

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
