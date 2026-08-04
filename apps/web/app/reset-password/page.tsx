import Link from "next/link";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { BrandLogo } from "../BrandLogo.js";
import { UpdatePasswordForm } from "./UpdatePasswordForm.js";

const ERROR_MESSAGES: Record<string, string> = {
  weak_password: "Password must be at least 8 characters.",
  mismatch: "Passwords do not match.",
  update_failed: "Could not update your password. Request a new reset link and try again.",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong.")
    : undefined;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BrandLogo height={32} />
          </div>
          <h1 style={{ fontSize: "1.05rem", fontWeight: 500, margin: "0.75rem 0 0" }}>
            Choose a new password
          </h1>
        </div>
        {user ? (
          <UpdatePasswordForm />
        ) : (
          <p style={{ fontSize: "0.9rem", textAlign: "center" }}>
            This reset link is invalid or has expired.{" "}
            <Link href="/forgot-password">Request a new one</Link>.
          </p>
        )}
        {errorMessage ? (
          <p style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: "0.75rem" }}>
            {errorMessage}
          </p>
        ) : null}
      </div>
    </main>
  );
}
