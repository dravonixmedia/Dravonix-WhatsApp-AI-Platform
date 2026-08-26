import { describe, expect, it } from "vitest";
import { renderBillingReminderEmail } from "../src/billingReminderEmail.js";

const base = {
  companyName: "Acme Corp",
  invoiceNumber: "DRV-2026-000123",
  amount: "2999.00",
  currency: "INR",
  dueDate: "2026-09-30",
  stage: "due_in_7" as const,
  payUrl: "https://app.example.com/dashboard/billing",
};

describe("renderBillingReminderEmail", () => {
  it("builds the subject exactly as [DRAIVA Billing] Invoice {number} {stage label}", () => {
    const rendered = renderBillingReminderEmail(base);
    expect(rendered.subject).toBe("[DRAIVA Billing] Invoice DRV-2026-000123 due in 7 days");
  });

  it("renders a distinct stage label for each stage", () => {
    expect(renderBillingReminderEmail({ ...base, stage: "due_in_3" }).subject).toContain(
      "due in 3 days",
    );
    expect(renderBillingReminderEmail({ ...base, stage: "due_in_1" }).subject).toContain(
      "due tomorrow",
    );
    expect(renderBillingReminderEmail({ ...base, stage: "due_today" }).subject).toContain(
      "due today",
    );
    expect(
      renderBillingReminderEmail({ ...base, stage: "grace_period_started" }).subject,
    ).toContain("overdue -- grace period active");
  });

  it("includes company name, invoice number, amount, currency, and due date in both html and text", () => {
    const rendered = renderBillingReminderEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain(base.companyName);
      expect(body).toContain(base.invoiceNumber);
      expect(body).toContain(base.amount);
      expect(body).toContain(base.currency);
      expect(body).toContain(base.dueDate);
    }
  });

  it("includes a Pay Now link pointing at the given payUrl", () => {
    const rendered = renderBillingReminderEmail(base);
    expect(rendered.html).toContain(`href="${base.payUrl}"`);
    expect(rendered.html).toContain("Pay Now");
    expect(rendered.text).toContain(base.payUrl);
  });

  it("HTML-escapes a company name containing markup (XSS guard)", () => {
    const rendered = renderBillingReminderEmail({
      ...base,
      companyName: '<script>alert("x")</script>',
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });

  it("uses a warning color accent for urgent stages (due_today, grace_period_started) and a neutral accent otherwise", () => {
    const urgent = renderBillingReminderEmail({ ...base, stage: "due_today" });
    const notUrgent = renderBillingReminderEmail({ ...base, stage: "due_in_7" });
    expect(urgent.html).toContain("#D97706");
    expect(notUrgent.html).not.toContain("#D97706");
  });

  it("is a pure function with no side effects -- calling it twice with the same input yields identical output", () => {
    expect(renderBillingReminderEmail(base)).toEqual(renderBillingReminderEmail(base));
  });
});
