"use client";

import { useState } from "react";
import { requestPasswordResetAction } from "../../lib/actions/auth.js";

export function ForgotPasswordForm() {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      action={requestPasswordResetAction}
      onSubmit={() => setSubmitting(true)}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <label style={{ fontSize: "0.85rem" }}>
        Email
        <input
          className="dvx-input"
          type="email"
          name="email"
          required
          autoFocus
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <button className="dvx-button" type="submit" disabled={submitting}>
        {submitting ? "Sending..." : "Send reset link"}
      </button>
    </form>
  );
}
