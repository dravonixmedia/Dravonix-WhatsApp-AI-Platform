"use server";

import { loadEnv } from "@dravonix/config";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../supabase/server.js";

/**
 * Server Action backing the login form (Human Handover Inbox final plan
 * section 15/16: no access token ever reaches a client component prop --
 * the credentials are posted directly to this server-only action, which
 * calls Supabase Auth and lets @supabase/ssr set the session cookies).
 * Failures redirect back to /login with an error code rather than throwing,
 * so a bad password renders a normal page instead of a Next.js error screen.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const redirectedFrom = String(formData.get("redirectedFrom") ?? "/dashboard");

  if (!email || !password) {
    redirect(`/login?error=missing_fields`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=invalid_credentials`);
  }

  redirect(redirectedFrom.startsWith("/") ? redirectedFrom : "/dashboard");
}

export async function logoutAction(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Always redirects to the same "check your email" outcome regardless of
 * whether the address belongs to a real account -- Supabase's own
 * resetPasswordForEmail already returns success either way, but this action
 * deliberately never inspects or surfaces its error either, so a bad actor
 * cannot use response timing/content to enumerate registered emails.
 */
export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    redirect("/forgot-password?sent=1");
  }

  const env = loadEnv(process.env);
  const supabase = await createServerSupabaseClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.APP_URL}/auth/callback?next=/reset-password`,
  });

  redirect("/forgot-password?sent=1");
}

/**
 * Called only from /reset-password, which is only reachable after
 * /auth/callback has exchanged a valid recovery code for a session (see
 * app/auth/callback/route.ts) -- so a session already exists here and
 * updateUser() operates on it directly, never accepting a password reset
 * token from client-supplied input.
 */
export async function updatePasswordAction(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || password.length < 8) {
    redirect("/reset-password?error=weak_password");
  }
  if (password !== confirmPassword) {
    redirect("/reset-password?error=mismatch");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?error=session_expired");
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect("/reset-password?error=update_failed");
  }

  redirect("/login?reset=success");
}
