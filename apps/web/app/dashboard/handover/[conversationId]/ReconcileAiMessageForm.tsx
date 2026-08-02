"use client";

import { useState, useTransition } from "react";
import { reconcileAiOutboundMessageAction } from "../../../../lib/actions/reconcileAiOutboundMessage.js";

/**
 * The AI-message reconciliation UI (final plan section 14): a manager must
 * open this panel, pick confirm_sent/confirm_not_sent, and give a reason --
 * the reason is required and is what ends up on the audit_logs row this
 * action writes. Submitting calls reconcileAiOutboundMessageAction, a
 * server-only Server Action that never runs in the browser and never
 * exposes the service_role key it uses internally.
 */
export function ReconcileAiMessageForm({
  messageId,
  conversationId,
}: {
  messageId: string;
  conversationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        className="dvx-button"
        type="button"
        style={{ fontSize: "0.75rem" }}
        onClick={() => setOpen(true)}
      >
        Reconcile AI message
      </button>
    );
  }

  function submit(resolution: "confirm_sent" | "confirm_not_sent") {
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await reconcileAiOutboundMessageAction(
          messageId,
          conversationId,
          resolution,
          reason.trim(),
        );
        setOpen(false);
        setReason("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to reconcile");
      }
    });
  }

  return (
    <div style={{ marginTop: "0.4rem" }}>
      <input
        className="dvx-input"
        style={{ fontSize: "0.75rem", width: "100%" }}
        placeholder="Reason (e.g. confirmed delivered in Meta Business dashboard)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={isPending}
      />
      <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.3rem" }}>
        <button
          className="dvx-button"
          type="button"
          style={{ fontSize: "0.75rem" }}
          disabled={isPending}
          onClick={() => submit("confirm_sent")}
        >
          Confirm sent
        </button>
        <button
          className="dvx-button"
          type="button"
          style={{ fontSize: "0.75rem" }}
          disabled={isPending}
          onClick={() => submit("confirm_not_sent")}
        >
          Confirm not sent
        </button>
        <button
          className="dvx-button"
          type="button"
          style={{ fontSize: "0.75rem" }}
          disabled={isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p style={{ color: "#dc2626", fontSize: "0.75rem", marginTop: "0.3rem" }}>{error}</p>
      ) : null}
    </div>
  );
}
