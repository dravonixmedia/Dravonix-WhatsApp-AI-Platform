import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the Business Currency dropdown
 * (app/dashboard/settings/CurrencySelect.tsx). See timezoneCombobox.test.ts's
 * identical note on why this repo asserts against source rather than
 * rendering with @testing-library/react.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const source = readFileSync(join(webRoot, "app/dashboard/settings/CurrencySelect.tsx"), "utf8");

describe("CurrencySelect: accessible native dropdown", () => {
  it("is a client component", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("labels a real <select> via <label htmlFor>, which is inherently keyboard/screen-reader accessible", () => {
    expect(source).toMatch(/<label\s[\s\S]*?htmlFor="business-currency"/);
    expect(source).toMatch(/<select\s[\s\S]*?id="business-currency"/);
  });

  it("renders one option per supplied currency, showing the friendly 'CODE — Name' label", () => {
    expect(source).toMatch(/currencies\.map\(/);
    expect(source).toContain("currency.label");
    expect(source).toContain("value={currency.code}");
  });

  it("shows inline Saving.../Saved/Unable-to-save status instead of a browser alert", () => {
    expect(source).not.toContain("alert(");
    expect(source).toContain('"Saving..."');
    expect(source).toContain('"Saved"');
    expect(source).toContain("Unable to save currency");
    expect(source).toContain('aria-live="polite"');
  });

  it("never imports the timezone utilities or component -- fully independent of Business Timezone", () => {
    expect(source).not.toMatch(/^import .*(timezoneList|TimezoneCombobox)/m);
    expect(source).not.toContain("company.timezone");
    expect(source).not.toContain("p_timezone");
  });

  it("imports its Server Action directly rather than receiving it as a prop (Failed to fetch fix)", () => {
    expect(source).toMatch(
      /^import \{ updateCompanyCurrencyAction \} from "\.\.\/\.\.\/\.\.\/lib\/actions\/currency\.js";$/m,
    );
    expect(source).not.toContain("onSave");
    expect(source).toContain("await updateCompanyCurrencyAction(value)");
  });
});
