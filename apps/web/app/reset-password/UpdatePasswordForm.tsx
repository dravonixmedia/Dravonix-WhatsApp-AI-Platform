"use client";

import { useState } from "react";
import { updatePasswordAction } from "../../lib/actions/auth.js";

export function UpdatePasswordForm() {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      action={updatePasswordAction}
      onSubmit={() => setSubmitting(true)}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <label style={{ fontSize: "0.85rem" }}>
        New password
        <input
          className="dvx-input"
          type="password"
          name="password"
          required
          minLength={8}
          autoFocus
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <label style={{ fontSize: "0.85rem" }}>
        Confirm new password
        <input
          className="dvx-input"
          type="password"
          name="confirmPassword"
          required
          minLength={8}
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <button className="dvx-button" type="submit" disabled={submitting}>
        {submitting ? "Updating..." : "Update password"}
      </button>
    </form>
  );
}
