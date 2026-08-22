import { describe, expect, it } from "vitest";
import { renderInvitationEmail } from "../src/invitationEmail.js";

describe("renderInvitationEmail", () => {
  const base = {
    companyName: "Acme Corp",
    roleLabel: "Owner",
    acceptUrl: "https://app.example.com/invite/abc123token",
    expiresAt: new Date("2026-09-01T12:00:00Z"),
    supportEmail: "support@dravonix.com",
  };

  it("uses the exact required subject line", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.subject).toBe("You're invited to DRAIVA");
  });

  it("includes DRAIVA branding, company name, and role in both html and text", () => {
    const rendered = renderInvitationEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain("DRAIVA");
      expect(body).toContain("Acme Corp");
      expect(body).toContain("Owner");
    }
  });

  it("includes an Accept Invitation CTA linking to the exact accept URL", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.html).toContain("Accept Invitation");
    expect(rendered.html).toContain(base.acceptUrl);
    expect(rendered.text).toContain(base.acceptUrl);
  });

  it("includes the expiry date/time", () => {
    const rendered = renderInvitationEmail(base);
    const expected = base.expiresAt.toUTCString();
    expect(rendered.html).toContain(expected);
    expect(rendered.text).toContain(expected);
  });

  it("includes a security note that the invitation is email-address-scoped", () => {
    const rendered = renderInvitationEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body.toLowerCase()).toContain("can only be accepted by the email address");
    }
  });

  it("includes a support contact", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.html).toContain(base.supportEmail);
    expect(rendered.text).toContain(base.supportEmail);
  });

  it("never mentions WhatsApp as an available feature", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.html).not.toMatch(/whatsapp/i);
    expect(rendered.text).not.toMatch(/whatsapp/i);
  });

  it("HTML-escapes an untrusted company name in the html body, but not the plain-text body", () => {
    const rendered = renderInvitationEmail({
      ...base,
      companyName: '<script>alert("x")</script> & Co',
    });
    expect(rendered.html).not.toContain("<script>alert");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("&amp; Co");
    // The plain-text body has no HTML context to escape.
    expect(rendered.text).toContain('<script>alert("x")</script> & Co');
  });

  it("is a pure function -- identical input produces identical output", () => {
    const first = renderInvitationEmail(base);
    const second = renderInvitationEmail(base);
    expect(first).toEqual(second);
  });
});
