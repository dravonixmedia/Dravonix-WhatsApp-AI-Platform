"use client";

import { useState } from "react";
import { loginAction } from "../../lib/actions/auth.js";

/**
 * Posts credentials directly to the loginAction Server Action (never a
 * client-side Supabase call) -- see Human Handover Inbox final plan section
 * 15/16: no access token ever reaches a client component prop. The
 * `submitting` state here is a plain visual affordance only; the actual
 * navigation on success/failure is a server-side redirect from loginAction.
 */
export function LoginForm({
  redirectedFrom,
  errorMessage,
}: {
  redirectedFrom?: string;
  errorMessage?: string;
}) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      action={loginAction}
      onSubmit={() => setSubmitting(true)}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <input type="hidden" name="redirectedFrom" value={redirectedFrom ?? "/dashboard"} />
      <label style={{ fontSize: "0.85rem" }}>
        Email
        <input
          className="dvx-input"
          type="email"
          name="email"
          required
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
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <button className="dvx-button" type="submit" disabled={submitting}>
        {submitting ? "Signing in..." : "Sign in"}
      </button>
      {errorMessage ? <p style={{ color: "#dc2626", fontSize: "0.8rem" }}>{errorMessage}</p> : null}
    </form>
  );
}
