"use client";

import { useState, type FormEvent } from "react";

/**
 * Client-side login form. Wiring to real authentication is documented in
 * SUPABASE_SETUP.md: on submit, this calls Supabase Auth's
 * `signInWithPassword` (via the browser Supabase client, anon key only --
 * never the service role) and, on success, redirects into /dashboard. Left as
 * a clearly-labeled TODO here because this session has no live Supabase
 * project to authenticate against.
 */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    // TODO: wire to Supabase Auth signInWithPassword({ email, password }) once
    // a real project is configured (see SUPABASE_SETUP.md).
    setStatus("error");
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <label style={{ fontSize: "0.85rem" }}>
        Email
        <input
          className="dvx-input"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <label style={{ fontSize: "0.85rem" }}>
        Password
        <input
          className="dvx-input"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ marginTop: "0.35rem" }}
        />
      </label>
      <button className="dvx-button" type="submit" disabled={status === "submitting"}>
        {status === "submitting" ? "Signing in..." : "Sign in"}
      </button>
      {status === "error" && (
        <p style={{ color: "#dc2626", fontSize: "0.8rem" }}>
          Authentication is not yet connected to a live Supabase project in this environment. See
          SUPABASE_SETUP.md.
        </p>
      )}
    </form>
  );
}
