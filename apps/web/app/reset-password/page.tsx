import Link from "next/link";
import { platformBrand } from "@dravonix/config";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
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
          <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{platformBrand.shortName}</div>
          <h1 style={{ fontSize: "1.05rem", fontWeight: 500, margin: "0.5rem 0 0" }}>
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
