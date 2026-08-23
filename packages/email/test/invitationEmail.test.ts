import { describe, expect, it } from "vitest";
import { renderInvitationEmail } from "../src/invitationEmail.js";

const INVITATION_CONTACT_EMAIL = "admin@dravonixmedia.com";

describe("renderInvitationEmail", () => {
  const base = {
    companyName: "Acme Corp",
    roleLabel: "Owner",
    acceptUrl: "https://app.example.com/invite/abc123token",
    expiresAt: new Date("2026-09-01T12:00:00Z"),
  };

  it("uses a subject with the dynamic company name and DRAIVA, never a hardcoded company name", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.subject).toBe("You're invited to join Acme Corp on DRAIVA");
    expect(rendered.subject).toContain("DRAIVA");

    const otherCompany = renderInvitationEmail({ ...base, companyName: "DRAIVA Test Client" });
    expect(otherCompany.subject).toBe("You're invited to join DRAIVA Test Client on DRAIVA");
  });

  it("strips CR/LF from the company name before building the subject (header-injection guard)", () => {
    const rendered = renderInvitationEmail({
      ...base,
      companyName: "Acme\r\nBcc: evil@example.com",
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject).toBe("You're invited to join Acme Bcc: evil@example.com on DRAIVA");
  });

  it("includes DRAIVA branding, Dravonix Media, company name, and role in both html and text", () => {
    const rendered = renderInvitationEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain("DRAIVA");
      expect(body).toContain("Dravonix Media");
      expect(body).toContain("Acme Corp");
      expect(body).toContain("Owner");
    }
  });

  it('identifies the email as a "Client Invitation" in both html and text', () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.html).toContain("Client Invitation");
    expect(rendered.text).toContain("Client Invitation");
  });

  it("includes an Accept Invitation CTA linking to the exact accept URL, styled with the primary blue", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.html).toContain("Accept Invitation");
    expect(rendered.html).toContain(base.acceptUrl);
    expect(rendered.text).toContain(base.acceptUrl);
    const ctaBlock = rendered.html.match(/<a href="https:\/\/app\.example\.com[^]*?<\/a>/)?.[0];
    expect(ctaBlock).toContain("background:#2563EB");
    expect(ctaBlock).toContain("color:#ffffff");
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

  it("contains the admin@dravonixmedia.com contact, and never support@dravonixmedia.com, in both html and text", () => {
    const rendered = renderInvitationEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain(INVITATION_CONTACT_EMAIL);
      expect(body).not.toContain("support@dravonixmedia.com");
      expect(body.toLowerCase()).not.toContain("support@dravonixmedia.com");
    }
  });

  it("the html contact address is a clickable mailto link, colored with the primary blue", () => {
    const rendered = renderInvitationEmail(base);
    expect(rendered.html).toContain(`href="mailto:${INVITATION_CONTACT_EMAIL}"`);
    const mailtoBlock = rendered.html.match(/<a href="mailto:[^]*?<\/a>/)?.[0];
    expect(mailtoBlock).toContain("color:#2563EB");
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
