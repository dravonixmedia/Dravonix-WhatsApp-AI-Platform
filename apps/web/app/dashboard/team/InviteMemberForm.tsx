"use client";

import type { CompanyRole } from "@dravonix/database";
import { useState, useTransition } from "react";
import { createCompanyInvitationAction } from "../../../lib/actions/invitations.js";
import { CLIENT_ASSIGNABLE_ROLES, companyRoleLabel } from "../../../lib/companyRoles.js";

/**
 * Invitation delivery is handled server-side by the shared
 * lib/email/sendInvitationEmail.ts service (same one the Super Admin invite
 * form uses) -- when a real email provider is configured, this form never
 * sees or displays the raw invite link. The manual-copy fallback only
 * appears when email delivery didn't happen (no provider configured yet, or
 * a non-production send failure) -- acceptUrl is otherwise omitted by the
 * server response entirely, never just hidden client-side.
 *
 * `roles` defaults to the five non-owner active roles a client (team.manage)
 * may invite -- create_company_invitation itself rejects company_owner from
 * that path regardless of what this form renders (see migration 24). The
 * Super Admin company page passes the full active-role list explicitly
 * (including company_owner, for bootstrapping a brand new company's first
 * owner), since only a super_admin caller is authorized for that role.
 */
export function InviteMemberForm({
  companyId,
  defaultRole = "manager",
  roles = CLIENT_ASSIGNABLE_ROLES,
}: {
  companyId: string;
  defaultRole?: CompanyRole;
  roles?: readonly CompanyRole[];
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    email: string;
    emailSent: boolean;
    acceptUrl?: string;
  } | null>(null);
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
              setResult({
                email: invitation.email,
                emailSent: invitation.emailSent,
                acceptUrl: invitation.acceptUrl,
              });
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
          {roles.map((role) => (
            <option key={role} value={role}>
              {companyRoleLabel(role)}
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
          {result.emailSent ? (
            <p style={{ fontSize: "0.8rem", margin: 0 }}>
              Invite sent to <strong>{result.email}</strong>.
            </p>
          ) : result.acceptUrl ? (
            <>
              <p style={{ fontSize: "0.8rem", margin: "0 0 0.4rem" }}>
                Invitation created for {result.email}, but no email could be delivered
                automatically. Copy this link and send it to them:
              </p>
              <code style={{ fontSize: "0.75rem", wordBreak: "break-all" }}>
                {result.acceptUrl}
              </code>
            </>
          ) : (
            <p style={{ fontSize: "0.8rem", margin: 0, color: "#dc2626" }}>
              Invitation created for {result.email}, but the invitation email could not be
              delivered. Please try Resend shortly, or contact support if this continues.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
