export interface InvitationEmailInput {
  companyName: string;
  /** Human-readable role label (e.g. "Owner", "Admin"), never the raw enum value. */
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
  supportEmail: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const SUBJECT = "You're invited to DRAIVA";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Pure template renderer for the DRAIVA client-owner/team invitation email --
 * no side effects, no network, no DB access, so this is trivially unit
 * testable. `companyName` is untrusted free text (set via Company Settings)
 * and is HTML-escaped in the HTML body; `acceptUrl` is a same-origin link
 * built server-side, never user-supplied. Never mentions WhatsApp as an
 * available feature -- that connection remains pending Meta App Review.
 */
export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const expiresLabel = input.expiresAt.toUTCString();
  const safeCompanyName = escapeHtml(input.companyName);
  const safeRoleLabel = escapeHtml(input.roleLabel);
  const safeAcceptUrl = escapeHtml(input.acceptUrl);
  const safeSupportEmail = escapeHtml(input.supportEmail);

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 0;">
                <div style="font-size:20px;font-weight:700;color:#0f172a;">DRAIVA</div>
                <div style="font-size:13px;color:#64748b;margin-top:2px;">by Dravonix Media</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 16px;">Hello,</p>
                <p style="margin:0 0 16px;">
                  You've been invited to join <strong>${safeCompanyName}</strong> on DRAIVA as
                  <strong>${safeRoleLabel}</strong>.
                </p>
                <p style="margin:0 0 24px;color:#334155;">
                  DRAIVA helps businesses manage customer conversations, AI-assisted support,
                  knowledge, leads and team workflows from one platform.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;">
                <a href="${safeAcceptUrl}"
                   style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
                          font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">
                  Accept Invitation
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px;font-size:13px;color:#64748b;">
                This invitation expires on ${expiresLabel}.
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;font-size:13px;color:#64748b;">
                For security, this invitation can only be accepted by the email address it was
                sent to. If you were not expecting this invitation, you can ignore this email.
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
                DRAIVA by Dravonix Media &middot; Questions? Contact
                <a href="mailto:${safeSupportEmail}" style="color:#94a3b8;">${safeSupportEmail}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `Hello,

You've been invited to join ${input.companyName} on DRAIVA as ${input.roleLabel}.

DRAIVA helps businesses manage customer conversations, AI-assisted support, knowledge, leads and team workflows from one platform.

Accept your invitation:
${input.acceptUrl}

This invitation expires on ${expiresLabel}.

For security, this invitation can only be accepted by the email address it was sent to. If you were not expecting this invitation, you can ignore this email.

DRAIVA by Dravonix Media
Questions? Contact ${input.supportEmail}
`;

  return { subject: SUBJECT, html, text };
}
