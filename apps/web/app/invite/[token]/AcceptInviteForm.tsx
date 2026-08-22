"use client";

import { useState } from "react";
import { acceptInviteAction } from "../../../lib/actions/acceptInvite.js";

const ERROR_MESSAGES: Record<string, string> = {
  missing_fields: "Email and password are required.",
  invalid_credentials: "That password doesn't match an existing account with this email.",
  signup_failed: "Couldn't create an account with this email -- it may already be registered.",
  email_mismatch: "This invitation was sent to a different email address than the one you used.",
  invitation_expired: "This invitation has expired. Ask whoever invited you to resend it.",
  invitation_not_pending: "This invitation has already been used or revoked.",
};

export function AcceptInviteForm({
  token,
  email,
  errorCode,
}: {
  token: string;
  email: string;
  errorCode?: string;
}) {
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_up");
  const [submitting, setSubmitting] = useState(false);

  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? errorCode) : undefined;

  return (
    <form
      action={acceptInviteAction}
      onSubmit={() => setSubmitting(true)}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="mode" value={mode} />

      {errorMessage ? (
        <p className="dvx-muted" style={{ color: "#dc2626", fontSize: "0.85rem", margin: 0 }}>
          {errorMessage}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          className={`dvx-button ${mode === "sign_up" ? "" : "dvx-button--secondary"}`}
          style={{ flex: 1, fontSize: "0.85rem" }}
          onClick={() => setMode("sign_up")}
        >
          I&apos;m new -- create account
        </button>
        <button
          type="button"
          className={`dvx-button ${mode === "sign_in" ? "" : "dvx-button--secondary"}`}
          style={{ flex: 1, fontSize: "0.85rem" }}
          onClick={() => setMode("sign_in")}
        >
          I already have an account
        </button>
      </div>

      <label style={{ fontSize: "0.85rem" }}>
        Email
        <input
          className="dvx-input"
          type="email"
          name="email"
          defaultValue={email}
          readOnly
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <label style={{ fontSize: "0.85rem" }}>
        Password
        <input
          className="dvx-input"
          type="password"
          name="password"
          required
          minLength={8}
          style={{ marginTop: "0.35rem" }}
        />
      </label>

      <button className="dvx-button" type="submit" disabled={submitting}>
        {submitting
          ? "Please wait..."
          : mode === "sign_up"
            ? "Create account & join"
            : "Sign in & join"}
      </button>
    </form>
  );
}
