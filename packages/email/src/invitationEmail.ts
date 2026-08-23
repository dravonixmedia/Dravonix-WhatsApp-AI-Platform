export interface InvitationEmailInput {
  companyName: string;
  /** Human-readable role label (e.g. "Owner", "Admin"), never the raw enum value. */
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Fixed invitation-specific contact address -- deliberately not
 * `platformBrand.supportEmail` (packages/config/src/branding.ts), which
 * remains the general-purpose support address used elsewhere (login page,
 * invoices, notifications). This invitation email is the one surface DRAIVA
 * asked to route to the admin mailbox specifically.
 */
const INVITATION_CONTACT_EMAIL = "admin@dravonixmedia.com";

// Official DRAIVA / Dravonix Media email visual system.
const COLOR_PRIMARY_BLUE = "#2563EB";
const COLOR_ACCENT_CYAN = "#06B6D4";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Email subject headers can't contain raw CR/LF -- untrusted company names are collapsed to one line before use. */
function buildSubject(companyName: string): string {
  const singleLineCompanyName = companyName.replace(/[\r\n]+/g, " ").trim();
  return `You're invited to join ${singleLineCompanyName} on DRAIVA`;
}

/**
 * Pure template renderer for the DRAIVA client-owner/team invitation email --
 * no side effects, no network, no DB access, so this is trivially unit
 * testable. `companyName` is untrusted free text (set via Company Settings)
 * and is HTML-escaped in the HTML body; `acceptUrl` is a same-origin link
 * built server-side, never user-supplied. Never mentions WhatsApp as an
 * available feature -- that connection remains pending Meta App Review.
 * Shared verbatim by the initial-send and Resend paths (both call through
 * apps/web/lib/email/sendInvitationEmail.ts's single sendInvitationEmail()).
 */
export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const expiresLabel = input.expiresAt.toUTCString();
  const safeCompanyName = escapeHtml(input.companyName);
  const safeRoleLabel = escapeHtml(input.roleLabel);
  const safeAcceptUrl = escapeHtml(input.acceptUrl);

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 0;">
                <div style="font-size:22px;font-weight:700;color:#0f172a;letter-spacing:0.2px;">DRAIVA</div>
                <div style="font-size:13px;font-weight:600;color:${COLOR_ACCENT_CYAN};margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">
                  Client Invitation
                </div>
                <div style="font-size:12px;color:#64748b;margin-top:2px;">by Dravonix Media</div>
                <div style="height:3px;width:48px;background:${COLOR_PRIMARY_BLUE};border-radius:2px;margin-top:14px;"></div>
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
                   style="display:inline-block;background:${COLOR_PRIMARY_BLUE};color:#ffffff;text-decoration:none;
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
                <a href="mailto:${INVITATION_CONTACT_EMAIL}" style="color:${COLOR_PRIMARY_BLUE};font-weight:600;text-decoration:none;">${INVITATION_CONTACT_EMAIL}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `DRAIVA
Client Invitation
Dravonix Media

Hello,

You've been invited to join ${input.companyName} on DRAIVA as ${input.roleLabel}.

DRAIVA helps businesses manage customer conversations, AI-assisted support, knowledge, leads and team workflows from one platform.

Accept your invitation:
${input.acceptUrl}

This invitation expires on ${expiresLabel}.

For security, this invitation can only be accepted by the email address it was sent to. If you were not expecting this invitation, you can ignore this email.

DRAIVA by Dravonix Media
Questions? Contact ${INVITATION_CONTACT_EMAIL}
`;

  return { subject: buildSubject(input.companyName), html, text };
}
