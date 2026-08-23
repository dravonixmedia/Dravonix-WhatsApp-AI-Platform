"use server";

/**
 * Handles the Server Actions the /invite/[token] page needs: prove a real
 * identity for the invited email (sign in to an existing account, create
 * one, or reuse an already-active session), then call
 * accept_company_invitation. No email is sent by this file -- account
 * creation uses Supabase Auth's own signUp(), the same infrastructure
 * already relied on for password-reset emails.
 *
 * New-account signup requires Supabase's own email confirmation before a
 * session exists. That confirmation link must survive the round trip back
 * to this exact pending invitation -- signUp() is called with
 * `emailRedirectTo` pointing at `/auth/callback?next=/invite/{token}`
 * (already an allow-listed Supabase redirect path; the query string rides
 * along on top of it), so once the user confirms, the auth callback lands
 * them back on this same page with a real session already established.
 * acceptInviteForAuthenticatedUserAction below is what /invite/[token]/page.tsx
 * calls at that point (and for an already-signed-in user whose session
 * email already matches the invitation) -- it never re-asks for a password.
 */

import { redirect } from "next/navigation";
import { loadEnv } from "@dravonix/config";
import { createServerSupabaseClient } from "../supabase/server.js";

function buildEmailConfirmationRedirect(token: string): string {
  const env = loadEnv(process.env);
  return `${env.APP_URL}/auth/callback?next=${encodeURIComponent(`/invite/${token}`)}`;
}

/**
 * Calls accept_company_invitation and maps every outcome to a redirect.
 * `invitation_not_pending` is treated as an idempotent success when the
 * invitation (per the anon-safe get_invitation_preview RPC) is already
 * `accepted` and its invited email matches the caller's own authenticated
 * email -- this is exactly what a refreshed callback, a confirmation link
 * opened twice, or a retried accept request looks like: the same person's
 * earlier attempt already finished the job, so this call does not need to
 * (and structurally cannot, since accept_company_invitation only ever
 * activates membership for the caller's own matching email) create a
 * second membership.
 */
async function acceptAndRedirect(token: string): Promise<never> {
  const supabase = await createServerSupabaseClient();

  const { error: acceptError } = await supabase.rpc("accept_company_invitation", {
    p_token: token,
  });

  if (!acceptError) {
    redirect("/dashboard");
  }

  if (acceptError.message === "invitation_not_pending") {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: previewData } = await supabase
      .rpc("get_invitation_preview", { p_token: token })
      .maybeSingle();
    const preview = previewData as { invitation_email: string; status: string } | null;
    const alreadyAcceptedByThisEmail =
      preview?.status === "accepted" &&
      user?.email &&
      preview.invitation_email.toLowerCase() === user.email.toLowerCase();
    if (alreadyAcceptedByThisEmail) {
      redirect("/dashboard");
    }
  }

  redirect(`/invite/${token}?error=${encodeURIComponent(acceptError.message)}`);
}

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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: buildEmailConfirmationRedirect(token) },
    });
    if (error) {
      redirect(`/invite/${token}?error=signup_failed`);
    }
    if (!data.session) {
      // Email confirmation is required before a session exists -- the user
      // must confirm, then their confirmation link's emailRedirectTo above
      // brings them back through /auth/callback to this same invite page,
      // which by then has a session and finishes accepting automatically
      // (see acceptInviteForAuthenticatedUserAction).
      redirect(`/invite/${token}?pending=confirmation`);
    }
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      redirect(`/invite/${token}?error=invalid_credentials`);
    }
  }

  await acceptAndRedirect(token);
}

/**
 * Finishes accepting a pending invitation for a caller who already has a
 * real session -- either just returned from the Supabase email-confirmation
 * round trip, or was already signed in when they opened the invite link
 * (the invited email's existing-account case; never forces a redundant
 * second signup). /invite/[token]/page.tsx only ever renders the button
 * bound to this action when the current session's email already matches
 * the invitation, so this never needs (and never accepts) a company id or
 * role from the browser -- both are derived server-side, inside
 * accept_company_invitation, strictly from the validated invitation row.
 */
export async function acceptInviteForAuthenticatedUserAction(token: string): Promise<void> {
  if (!token) redirect("/login?error=invalid_link");

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/invite/${token}`);

  await acceptAndRedirect(token);
}
