import { describe, expect, it } from "vitest";
import { renderNewSupportRequestEmail } from "../src/supportRequestEmail.js";

const base = {
  reference: "SUP-000123",
  companyName: "Acme Corp",
  submittedByLabel: "j***@acme.test",
  typeLabel: "Technical Issue",
  subject: "App keeps crashing",
  description: "It crashes every time I open a conversation.",
  detailUrl: "https://app.example.com/admin/support-requests/req-1",
};

describe("renderNewSupportRequestEmail", () => {
  it("builds the subject exactly as [DRAIVA Support] New {Type} — {Company}", () => {
    const rendered = renderNewSupportRequestEmail(base);
    expect(rendered.subject).toBe("[DRAIVA Support] New Technical Issue — Acme Corp");
  });

  it("strips CR/LF from type/company name before building the subject (header-injection guard)", () => {
    const rendered = renderNewSupportRequestEmail({
      ...base,
      companyName: "Acme\r\nBcc: evil@example.com",
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it("includes reference, company, submitted-by, subject, and description in both html and text", () => {
    const rendered = renderNewSupportRequestEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain(base.reference);
      expect(body).toContain(base.companyName);
      expect(body).toContain(base.submittedByLabel);
      expect(body).toContain(base.subject);
      expect(body).toContain(base.description);
    }
  });

  it("includes a link to the Super Admin detail page, styled with the primary blue", () => {
    const rendered = renderNewSupportRequestEmail(base);
    expect(rendered.html).toContain(base.detailUrl);
    expect(rendered.text).toContain(base.detailUrl);
    const ctaBlock = rendered.html.match(/<a href="https:\/\/app\.example\.com[^]*?<\/a>/)?.[0];
    expect(ctaBlock).toContain("background:#2563EB");
  });

  it("truncates a very long description in the email but never mutates the original subject/reference", () => {
    const longDescription = "x".repeat(1000);
    const rendered = renderNewSupportRequestEmail({ ...base, description: longDescription });
    expect(rendered.html.length).toBeLessThan(longDescription.length + 2000);
    expect(rendered.subject).toBe("[DRAIVA Support] New Technical Issue — Acme Corp");
  });

  it("HTML-escapes untrusted subject/description/company name in the html body, but not the plain-text body", () => {
    const rendered = renderNewSupportRequestEmail({
      ...base,
      subject: '<script>alert("x")</script>',
      companyName: "A & B Co",
    });
    expect(rendered.html).not.toContain("<script>alert");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("&amp; B Co");
    expect(rendered.text).toContain('<script>alert("x")</script>');
  });

  it("never includes auth tokens or secrets -- only the fields explicitly passed in", () => {
    const rendered = renderNewSupportRequestEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).not.toMatch(/token|api[_-]?key|secret/i);
    }
  });

  it("is a pure function -- identical input produces identical output", () => {
    const first = renderNewSupportRequestEmail(base);
    const second = renderNewSupportRequestEmail(base);
    expect(first).toEqual(second);
  });

  it("contains the admin@dravonixmedia.com contact, and never support@dravonixmedia.com (nonexistent mailbox), in both html and text", () => {
    const rendered = renderNewSupportRequestEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain("admin@dravonixmedia.com");
      expect(body.toLowerCase()).not.toContain("support@dravonixmedia.com");
    }
  });
});
