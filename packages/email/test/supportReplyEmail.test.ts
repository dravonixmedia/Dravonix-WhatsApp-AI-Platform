import { describe, expect, it } from "vitest";
import { renderSupportReplyEmail } from "../src/supportReplyEmail.js";

const base = {
  reference: "SUP-000123",
  subject: "App keeps crashing",
  statusLabel: "In Progress",
  replyMessage: "We are looking into this and will update you soon.",
  detailUrl: "https://app.example.com/dashboard/support/req-1",
};

describe("renderSupportReplyEmail", () => {
  it("builds the subject exactly as DRAIVA Support Update — {Reference}", () => {
    const rendered = renderSupportReplyEmail(base);
    expect(rendered.subject).toBe("DRAIVA Support Update — SUP-000123");
  });

  it("includes subject, status, and the reply message in both html and text", () => {
    const rendered = renderSupportReplyEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).toContain(base.subject);
      expect(body).toContain(base.statusLabel);
      expect(body).toContain(base.replyMessage);
    }
  });

  it("includes a link back to the client dashboard request", () => {
    const rendered = renderSupportReplyEmail(base);
    expect(rendered.html).toContain(base.detailUrl);
    expect(rendered.text).toContain(base.detailUrl);
  });

  it("HTML-escapes an untrusted reply message in the html body, but not the plain-text body", () => {
    const rendered = renderSupportReplyEmail({
      ...base,
      replyMessage: '<script>alert("x")</script> & thanks',
    });
    expect(rendered.html).not.toContain("<script>alert");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.text).toContain('<script>alert("x")</script> & thanks');
  });

  it("preserves newlines in the reply message via white-space:pre-wrap in the html body", () => {
    const rendered = renderSupportReplyEmail({ ...base, replyMessage: "line one\nline two" });
    expect(rendered.html).toContain("white-space:pre-wrap");
    expect(rendered.text).toContain("line one\nline two");
  });

  it("never includes auth tokens or secrets", () => {
    const rendered = renderSupportReplyEmail(base);
    for (const body of [rendered.html, rendered.text]) {
      expect(body).not.toMatch(/token|api[_-]?key|secret/i);
    }
  });

  it("is a pure function -- identical input produces identical output", () => {
    const first = renderSupportReplyEmail(base);
    const second = renderSupportReplyEmail(base);
    expect(first).toEqual(second);
  });
});
