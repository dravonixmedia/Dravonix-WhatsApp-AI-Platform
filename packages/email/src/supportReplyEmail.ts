import type { RenderedEmail } from "./invitationEmail.js";

export interface SupportReplyEmailInput {
  reference: string;
  subject: string;
  statusLabel: string;
  replyMessage: string;
  detailUrl: string;
}

const SUPPORT_CONTACT_EMAIL = "support@dravonixmedia.com";
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

/**
 * Notifies a client that Dravonix posted a public reply (or a status
 * change) on their support request (Phase 5, final plan section 18). Never
 * called for an internal-only note -- the caller (apps/web's
 * adminReplySupportRequestAction) only invokes this when is_internal is
 * false. Pure template renderer, mirroring invitationEmail.ts's exact shape.
 */
export function renderSupportReplyEmail(input: SupportReplyEmailInput): RenderedEmail {
  const safeSubject = escapeHtml(input.subject);
  const safeStatusLabel = escapeHtml(input.statusLabel);
  const safeReplyMessage = escapeHtml(input.replyMessage);
  const safeReference = escapeHtml(input.reference);
  const safeDetailUrl = escapeHtml(input.detailUrl);
  const subject = `DRAIVA Support Update — ${input.reference}`;

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
                  Support Update
                </div>
                <div style="font-size:12px;color:#64748b;margin-top:2px;">by Dravonix Media</div>
                <div style="height:3px;width:48px;background:${COLOR_PRIMARY_BLUE};border-radius:2px;margin-top:14px;"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 12px;"><strong>${safeReference}</strong> · ${safeSubject}</p>
                <p style="margin:0 0 16px;color:#334155;">Status: <strong>${safeStatusLabel}</strong></p>
                <p style="margin:0 0 24px;white-space:pre-wrap;">${safeReplyMessage}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;">
                <a href="${safeDetailUrl}"
                   style="display:inline-block;background:${COLOR_PRIMARY_BLUE};color:#ffffff;text-decoration:none;
                          font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">
                  View request
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
                DRAIVA by Dravonix Media &middot; Questions? Contact
                <a href="mailto:${SUPPORT_CONTACT_EMAIL}" style="color:${COLOR_PRIMARY_BLUE};font-weight:600;text-decoration:none;">${SUPPORT_CONTACT_EMAIL}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `DRAIVA
Support Update
Dravonix Media

${input.reference} · ${input.subject}
Status: ${input.statusLabel}

${input.replyMessage}

View request:
${input.detailUrl}

DRAIVA by Dravonix Media
Questions? Contact ${SUPPORT_CONTACT_EMAIL}
`;

  return { subject, html, text };
}
