"use server";

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
