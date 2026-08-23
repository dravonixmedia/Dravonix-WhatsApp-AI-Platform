import { BrandLogo } from "../../BrandLogo.js";
import { acceptInviteForAuthenticatedUserAction } from "../../../lib/actions/acceptInvite.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { AcceptInviteForm, ERROR_MESSAGES } from "./AcceptInviteForm.js";

export const dynamic = "force-dynamic";

function InviteCard({ children }: { children: React.ReactNode }) {
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
      <div className="dvx-card" style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BrandLogo height={32} />
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; pending?: string }>;
}) {
  const { token } = await params;
  const { error, pending } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const { data: preview, error: previewError } = await supabase
    .rpc("get_invitation_preview", { p_token: token })
    .maybeSingle();

  if (previewError || !preview) {
    return (
      <InviteCard>
        <h1 style={{ fontSize: "1.05rem", textAlign: "center" }}>Invitation not found</h1>
        <p className="dvx-muted" style={{ textAlign: "center", fontSize: "0.85rem" }}>
          This invite link is invalid. Ask whoever invited you to send a new one.
        </p>
      </InviteCard>
    );
  }

  const row = preview as {
    company_name: string;
    invitation_email: string;
    role: string;
    status: string;
    expires_at: string;
  };

  if (row.status !== "pending" || new Date(row.expires_at) < new Date()) {
    return (
      <InviteCard>
        <h1 style={{ fontSize: "1.05rem", textAlign: "center" }}>
          {row.status === "accepted" ? "Already accepted" : "Invitation no longer valid"}
        </h1>
        <p className="dvx-muted" style={{ textAlign: "center", fontSize: "0.85rem" }}>
          {row.status === "accepted"
            ? "This invitation has already been used. Try signing in instead."
            : "This invitation has expired or was revoked. Ask whoever invited you to send a new one."}
        </p>
      </InviteCard>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const sessionEmailMatches = Boolean(
    user?.email && user.email.toLowerCase() === row.invitation_email.toLowerCase(),
  );

  if (pending === "confirmation" && !sessionEmailMatches) {
    return (
      <InviteCard>
        <h1 style={{ fontSize: "1.05rem", textAlign: "center" }}>Check your email</h1>
        <p className="dvx-muted" style={{ textAlign: "center", fontSize: "0.85rem" }}>
          Confirm your new account using the link we just sent, then come back to this page to
          finish joining {row.company_name}.
        </p>
      </InviteCard>
    );
  }

  // Already-authenticated path: either the invited email confirmed their new
  // account and returned here via /auth/callback, or they were already
  // signed in with this exact email when they opened the invite link. Never
  // asks for a password again -- accept_company_invitation derives company
  // and role entirely server-side from the validated invitation row.
  if (sessionEmailMatches) {
    return (
      <InviteCard>
        <h1 style={{ fontSize: "1.05rem", textAlign: "center", margin: "0 0 0.35rem" }}>
          Join {row.company_name}
        </h1>
        <p
          className="dvx-muted"
          style={{ textAlign: "center", fontSize: "0.85rem", marginBottom: "1.25rem" }}
        >
          Signed in as {row.invitation_email}. You&apos;ve been invited as{" "}
          {row.role.replace(/_/g, " ")}.
        </p>
        {error ? (
          <p className="dvx-muted" style={{ color: "#dc2626", fontSize: "0.85rem" }}>
            {ERROR_MESSAGES[error] ?? error}
          </p>
        ) : null}
        <form action={acceptInviteForAuthenticatedUserAction.bind(null, token)}>
          <button className="dvx-button" type="submit" style={{ width: "100%" }}>
            Join {row.company_name}
          </button>
        </form>
      </InviteCard>
    );
  }

  return (
    <InviteCard>
      <h1 style={{ fontSize: "1.05rem", textAlign: "center", margin: "0 0 0.35rem" }}>
        Join {row.company_name}
      </h1>
      <p
        className="dvx-muted"
        style={{ textAlign: "center", fontSize: "0.85rem", marginBottom: "1.25rem" }}
      >
        You&apos;ve been invited as {row.role.replace(/_/g, " ")}.
      </p>
      <AcceptInviteForm token={token} email={row.invitation_email} errorCode={error} />
    </InviteCard>
  );
}
