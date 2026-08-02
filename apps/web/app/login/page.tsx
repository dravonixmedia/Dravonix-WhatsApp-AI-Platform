import { platformBrand } from "@dravonix/config";
import { LoginForm } from "./LoginForm.js";

const ERROR_MESSAGES: Record<string, string> = {
  missing_fields: "Email and password are required.",
  invalid_credentials: "Invalid email or password.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectedFrom?: string }>;
}) {
  const params = await searchParams;
  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Sign-in failed.")
    : undefined;

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
        <LoginForm redirectedFrom={params.redirectedFrom} errorMessage={errorMessage} />
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
