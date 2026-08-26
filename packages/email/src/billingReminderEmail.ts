import type { RenderedEmail } from "./invitationEmail.js";

export type BillingReminderStage =
  "due_in_7" | "due_in_3" | "due_in_1" | "due_today" | "grace_period_started";

export interface BillingReminderEmailInput {
  companyName: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  dueDate: string;
  stage: BillingReminderStage;
  payUrl: string;
}

const COLOR_PRIMARY_BLUE = "#2563EB";
const COLOR_ACCENT_CYAN = "#06B6D4";
const COLOR_WARNING_AMBER = "#D97706";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STAGE_LABEL: Record<BillingReminderStage, string> = {
  due_in_7: "due in 7 days",
  due_in_3: "due in 3 days",
  due_in_1: "due tomorrow",
  due_today: "due today",
  grace_period_started: "overdue -- grace period active",
};

/**
 * Renders a subscription billing reminder (Phase 6C). Pure template
 * renderer -- no side effects/network -- mirroring
 * renderNewSupportRequestEmail's exact shape so it's trivially
 * unit-testable. Not currently wired to any real send path: a repo-wide
 * audit found no existing staging-safety mechanism (recipient override,
 * environment guard) for customer-facing emails, so this template exists
 * for later use once one is built -- see migration 30's header comment.
 */
export function renderBillingReminderEmail(input: BillingReminderEmailInput): RenderedEmail {
  const safeCompanyName = escapeHtml(input.companyName);
  const safeInvoiceNumber = escapeHtml(input.invoiceNumber);
  const safeAmount = escapeHtml(input.amount);
  const safeCurrency = escapeHtml(input.currency);
  const safeDueDate = escapeHtml(input.dueDate);
  const safePayUrl = escapeHtml(input.payUrl);
  const stageLabel = STAGE_LABEL[input.stage];
  const isUrgent = input.stage === "due_today" || input.stage === "grace_period_started";
  const accentColor = isUrgent ? COLOR_WARNING_AMBER : COLOR_ACCENT_CYAN;
  const subject = `[DRAIVA Billing] Invoice ${input.invoiceNumber} ${stageLabel}`;

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
                <div style="font-size:13px;font-weight:600;color:${accentColor};margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">
                  Billing Reminder
                </div>
                <div style="font-size:12px;color:#64748b;margin-top:2px;">by Dravonix Media</div>
                <div style="height:3px;width:48px;background:${COLOR_PRIMARY_BLUE};border-radius:2px;margin-top:14px;"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 12px;color:#334155;">${safeCompanyName}</p>
                <p style="margin:0 0 4px;font-weight:600;">Invoice ${safeInvoiceNumber} is ${stageLabel}</p>
                <p style="margin:0 0 4px;color:#334155;">Amount: <strong>${safeCurrency} ${safeAmount}</strong></p>
                <p style="margin:0 0 24px;color:#334155;">Due date: ${safeDueDate}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;">
                <a href="${safePayUrl}"
                   style="display:inline-block;background:${COLOR_PRIMARY_BLUE};color:#ffffff;text-decoration:none;
                          font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">
                  Pay Now
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `DRAIVA
Billing Reminder
Dravonix Media

${input.companyName}
Invoice ${input.invoiceNumber} is ${stageLabel}
Amount: ${input.currency} ${input.amount}
Due date: ${input.dueDate}

Pay Now:
${input.payUrl}
`;

  return { subject, html, text };
}
