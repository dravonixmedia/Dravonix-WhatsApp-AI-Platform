import { describe, expect, it } from "vitest";
import { pageTitle, platformBrand } from "../src/branding.js";

describe("platformBrand", () => {
  it("defaults to the Dravonix WhatsApp AI Platform brand", () => {
    expect(platformBrand.productName).toBe("Dravonix WhatsApp AI Platform");
    expect(platformBrand.shortName).toBe("Dravonix AI");
    expect(platformBrand.companyName).toBe("Dravonix Media");
  });

  it("exposes the support email alongside a matching mailto: href", () => {
    expect(platformBrand.supportEmail).toBe("admin@dravonixmedia.com");
    expect(platformBrand.supportEmailHref).toBe("mailto:admin@dravonixmedia.com");
  });

  it("never defaults to the nonexistent support@dravonixmedia.com mailbox", () => {
    expect(platformBrand.supportEmail.toLowerCase()).not.toBe("support@dravonixmedia.com");
    expect(platformBrand.supportEmailHref.toLowerCase()).not.toBe(
      "mailto:support@dravonixmedia.com",
    );
  });

  it("builds a section page title using the short name", () => {
    expect(pageTitle("Inbox")).toBe("Inbox · Dravonix AI");
  });

  it("falls back to the full product name with no section", () => {
    expect(pageTitle()).toBe("Dravonix WhatsApp AI Platform");
  });
});
