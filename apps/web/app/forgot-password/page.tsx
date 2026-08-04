import Link from "next/link";
import { BrandLogo } from "../BrandLogo.js";
import { ForgotPasswordForm } from "./ForgotPasswordForm.js";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const params = await searchParams;
  const sent = params.sent === "1";

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
            Reset your password
          </h1>
        </div>
        {sent ? (
          <p style={{ fontSize: "0.9rem", textAlign: "center" }}>
            If an account exists for that email, a reset link has been sent. Check your inbox.
          </p>
        ) : (
          <>
            <p className="dvx-muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>
              Enter the email associated with your account and we&apos;ll send a link to reset your
              password.
            </p>
            <ForgotPasswordForm />
          </>
        )}
        <p style={{ fontSize: "0.85rem", textAlign: "center", marginTop: "1.5rem" }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
