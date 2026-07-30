import { describe, expect, it } from "vitest";
import { pageTitle, platformBrand } from "../src/branding.js";

describe("platformBrand", () => {
  it("defaults to the Dravonix WhatsApp AI Platform brand", () => {
    expect(platformBrand.productName).toBe("Dravonix WhatsApp AI Platform");
    expect(platformBrand.shortName).toBe("Dravonix AI");
    expect(platformBrand.companyName).toBe("Dravonix Media");
  });

  it("builds a section page title using the short name", () => {
    expect(pageTitle("Inbox")).toBe("Inbox · Dravonix AI");
  });

  it("falls back to the full product name with no section", () => {
    expect(pageTitle()).toBe("Dravonix WhatsApp AI Platform");
  });
});
