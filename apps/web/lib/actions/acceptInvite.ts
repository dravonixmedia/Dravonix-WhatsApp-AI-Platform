"use server";

/**
 * Handles the one Server Action the /invite/[token] page needs: prove a real
 * identity for the invited email (sign in to an existing account, or create
 * one), then call accept_company_invitation. No email is sent by this file
 * -- account creation uses Supabase Auth's own signUp(), the same
 * infrastructure already relied on for password-reset emails; if project
 * settings require email confirmation before a session exists, the new user
 * must confirm before this action's own accept step can run (see the final
 * report's "remaining email-delivery dependency").
 */

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../supabase/server.js";

export async function acceptInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const mode = String(formData.get("mode") ?? "sign_in");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!token) redirect("/login?error=invalid_link");
  if (!email || !password) {
    redirect(`/invite/${token}?error=missing_fields`);
  }

  const supabase = await createServerSupabaseClient();

  if (mode === "sign_up") {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      redirect(`/invite/${token}?error=signup_failed`);
    }
    if (!data.session) {
      // Email confirmation is required before a session exists -- the user
      // must confirm, then return to this same invite link to finish
      // accepting (their auth.users row already matches the invitation by
      // then, so a subsequent sign-in + accept attempt succeeds normally).
      redirect(`/invite/${token}?pending=confirmation`);
    }
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      redirect(`/invite/${token}?error=invalid_credentials`);
    }
  }

  const { error: acceptError } = await supabase.rpc("accept_company_invitation", {
    p_token: token,
  });
  if (acceptError) {
    redirect(`/invite/${token}?error=${encodeURIComponent(acceptError.message)}`);
  }

  redirect("/dashboard");
}
