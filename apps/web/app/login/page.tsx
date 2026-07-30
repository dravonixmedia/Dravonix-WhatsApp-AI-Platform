import { platformBrand } from "@dravonix/config";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
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
        <LoginForm />
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
