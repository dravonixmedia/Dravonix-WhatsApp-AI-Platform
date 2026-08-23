"use client";

import { useState, useTransition } from "react";
import {
  resendCompanyInvitationAction,
  revokeCompanyInvitationAction,
} from "../lib/actions/invitations.js";

/**
 * Resend/Revoke controls for one pending invitation, shared by the Super
 * Admin company page and Team Settings (previously each used a bare
 * `<form action={...}>` around the Server Action, discarding its return
 * value entirely -- clicking Resend rotated the token and attempted a real
 * email send, but nothing in the UI ever showed whether it worked, so the
 * button appeared to do nothing. useTransition's pending state also
 * disables both buttons for the duration of the request: a rapid
 * double-click on the old bare-form version fired two independent resends
 * a few seconds apart, each rotating the token and sending a separate real
 * email (confirmed via staging audit_logs) -- disabling while pending
 * closes that off at the only layer this fix touches, the UI.
 */
export function InvitationActions({ invitationId }: { invitationId: string }) {
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );

  function handleResend() {
    setFeedback(null);
    startTransition(async () => {
      try {
        const result = await resendCompanyInvitationAction(invitationId);
        setFeedback(
          result.emailSent
            ? { kind: "success", text: "Invitation resent successfully." }
            : { kind: "error", text: "Invitation could not be resent. Please try again." },
        );
      } catch {
        setFeedback({ kind: "error", text: "Invitation could not be resent. Please try again." });
      }
    });
  }

  function handleRevoke() {
    setFeedback(null);
    startTransition(async () => {
      try {
        await revokeCompanyInvitationAction(invitationId);
      } catch {
        setFeedback({ kind: "error", text: "Invitation could not be revoked. Please try again." });
      }
    });
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem" }}
    >
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button
          className="dvx-button dvx-button--secondary"
          type="button"
          disabled={isPending}
          onClick={handleResend}
          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
        >
          {isPending ? "Resending..." : "Resend"}
        </button>
        <button
          className="dvx-button dvx-button--secondary"
          type="button"
          disabled={isPending}
          onClick={handleRevoke}
          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
        >
          Revoke
        </button>
      </div>
      {feedback ? (
        <span
          style={{
            fontSize: "0.75rem",
            color: feedback.kind === "error" ? "#dc2626" : undefined,
          }}
        >
          {feedback.text}
        </span>
      ) : null}
    </div>
  );
}
