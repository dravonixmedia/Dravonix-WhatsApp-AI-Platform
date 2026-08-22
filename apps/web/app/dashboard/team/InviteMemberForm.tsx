"use client";

import { useState, useTransition } from "react";
import { createCompanyInvitationAction } from "../../../lib/actions/invitations.js";

const ROLES = [
  "company_owner",
  "company_admin",
  "manager",
  "agent",
  "knowledge_editor",
  "billing_viewer",
  "viewer",
];

/**
 * No email is sent yet -- creating an invitation returns a one-time accept
 * URL that the inviter copies and delivers out of band (Slack, personal
 * email, phone). See the final report's "remaining email-delivery
 * dependency."
 */
export function InviteMemberForm({
  companyId,
  defaultRole = "agent",
}: {
  companyId: string;
  defaultRole?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ acceptUrl: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <form
        action={(formData) => {
          setError(null);
          setResult(null);
          startTransition(async () => {
            try {
              const invitation = await createCompanyInvitationAction(companyId, formData);
              setResult({ acceptUrl: invitation.acceptUrl, email: invitation.email });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to create invitation");
            }
          });
        }}
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
      >
        <input
          className="dvx-input"
          name="email"
          type="email"
          placeholder="Email to invite"
          required
        />
        <select
          className="dvx-input"
          name="role"
          defaultValue={defaultRole}
          style={{ maxWidth: 180 }}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <button className="dvx-button" type="submit" disabled={isPending}>
          {isPending ? "Inviting..." : "Send invite"}
        </button>
      </form>

      {error ? (
        <p
          className="dvx-muted"
          style={{ color: "#dc2626", fontSize: "0.8rem", marginTop: "0.5rem" }}
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="dvx-card" style={{ marginTop: "0.75rem", padding: "0.75rem" }}>
          <p style={{ fontSize: "0.8rem", margin: "0 0 0.4rem" }}>
            Invitation created for {result.email}. Copy this link and send it to them -- it
            hasn&apos;t been emailed automatically:
          </p>
          <code style={{ fontSize: "0.75rem", wordBreak: "break-all" }}>{result.acceptUrl}</code>
        </div>
      ) : null}
    </div>
  );
}
