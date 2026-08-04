import { redirect } from "next/navigation";
import Link from "next/link";
import { platformBrand } from "@dravonix/config";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { LoginForm } from "./LoginForm.js";

const ERROR_MESSAGES: Record<string, string> = {
  missing_fields: "Email and password are required.",
  invalid_credentials: "Invalid email or password.",
  invalid_link: "That link is invalid or has expired. Please try again.",
  session_expired: "Your session expired. Please sign in again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectedFrom?: string; reset?: string }>;
}) {
  const params = await searchParams;

  // An already-authenticated user hitting /login (e.g. a bookmarked tab, or
  // navigating back) goes straight to the dashboard instead of seeing the
  // form again.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    redirect("/dashboard");
  }

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Sign-in failed.")
    : undefined;
  const resetSuccess = params.reset === "success";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div className="dvx-card" style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{platformBrand.shortName}</div>
          <h1 style={{ fontSize: "1.05rem", fontWeight: 500, margin: "0.5rem 0 0" }}>
            {platformBrand.login.heading}
          </h1>
          <p className="dvx-muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
            {platformBrand.tagline}
          </p>
        </div>
        {resetSuccess ? (
          <p
            className="dvx-badge dvx-badge--success"
            style={{ display: "block", textAlign: "center", marginBottom: "1rem" }}
          >
            Password updated. Please sign in.
          </p>
        ) : null}
        <LoginForm redirectedFrom={params.redirectedFrom} errorMessage={errorMessage} />
        <p style={{ fontSize: "0.85rem", textAlign: "center", marginTop: "0.75rem" }}>
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
        <p
          className="dvx-muted"
          style={{ fontSize: "0.8rem", textAlign: "center", marginTop: "1.5rem" }}
        >
          Need help? Contact {platformBrand.supportEmail}
        </p>
      </div>
    </main>
  );
}
