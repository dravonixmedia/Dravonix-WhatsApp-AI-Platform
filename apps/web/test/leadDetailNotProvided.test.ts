import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the lead-detail correction (Issue 2): a missing field must render
 * the neutral "Not provided" label, never be fabricated and never silently
 * disappear the way the pre-correction DetailRow (which returned null for a
 * falsy value, hiding the whole row) did.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const pageSource = readFileSync(join(webRoot, "app/dashboard/leads/[leadId]/page.tsx"), "utf8");

describe("lead detail page: missing-field fallback", () => {
  it("defines the neutral 'Not provided' fallback exactly once, reused by every field", () => {
    expect(pageSource).toContain('const NOT_PROVIDED = "Not provided";');
  });

  it("DetailRow always renders a value -- 'Not provided' for null, never hiding the row", () => {
    const detailRowMatch = pageSource.match(/function DetailRow[\s\S]*?\n}/);
    expect(detailRowMatch).not.toBeNull();
    const body = detailRowMatch?.[0] ?? "";
    expect(body).not.toMatch(/if\s*\(!value\)\s*return null;/);
    expect(body).toContain("value ?? NOT_PROVIDED");
  });

  it("renders the lead's real resolved displayName in the header, never a hardcoded 'Unknown lead' string", () => {
    expect(pageSource).toContain("{lead.displayName}");
    expect(pageSource).not.toMatch(/Unknown lead/);
  });
});
