import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the accessible Business/Customer Timezone
 * searchable combobox (app/dashboard/settings/TimezoneCombobox.tsx). This
 * repo has no @testing-library/react harness (see chatAgentPanelWiring.test.ts's
 * identical note), so behavior is verified the same way as every other
 * client component here: asserting the source implements the required
 * ARIA combobox pattern and never bypasses it with a bare, unlabeled div.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const source = readFileSync(join(webRoot, "app/dashboard/settings/TimezoneCombobox.tsx"), "utf8");

describe("TimezoneCombobox: accessible combobox semantics", () => {
  it("is a client component", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("labels the input via a real <label htmlFor> pairing, not a placeholder alone", () => {
    expect(source).toMatch(/<label htmlFor=\{inputId\}/);
    expect(source).toMatch(/<input\s[\s\S]*?id=\{inputId\}/);
  });

  it("uses the ARIA combobox + listbox pattern", () => {
    expect(source).toContain('role="combobox"');
    expect(source).toContain("aria-expanded={open}");
    expect(source).toContain("aria-controls={listboxId}");
    expect(source).toContain("aria-activedescendant={activeOptionId}");
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain("aria-selected={index === activeIndex}");
  });

  it("supports ArrowDown/ArrowUp/Enter/Escape keyboard interaction", () => {
    expect(source).toMatch(/event\.key === "ArrowDown"/);
    expect(source).toMatch(/event\.key === "ArrowUp"/);
    expect(source).toMatch(/event\.key === "Enter"/);
    expect(source).toMatch(/event\.key === "Escape"/);
  });

  it("only ever saves a value taken from the supplied options list, never arbitrary typed text", () => {
    expect(source).toMatch(/isValidSelection\s*=\s*allOptions\.includes\(effectiveValue\)/);
    expect(source).toMatch(/disabled=\{!isValidSelection/);
  });

  it("always guarantees the current saved value is selectable, even if it's a legacy IANA alias missing from the canonical Intl list", () => {
    expect(source).toMatch(
      /if \(!initialValue \|\| options\.includes\(initialValue\)\) return options;/,
    );
  });

  it("shows inline Saving.../Saved/Unable-to-save status instead of a browser alert", () => {
    expect(source).not.toContain("alert(");
    expect(source).toContain('"Saving..."');
    expect(source).toContain('"Saved"');
    expect(source).toContain("Unable to save timezone");
    expect(source).toContain('aria-live="polite"');
  });

  it("never defines its own hardcoded timezone list -- options always come from the `options` prop", () => {
    expect(source).not.toMatch(/const\s+\w*TIMEZONES?\w*\s*[:=]/i);
    expect(source).toContain("options: readonly string[]");
  });

  it("imports its Server Action directly rather than receiving it as a prop (Failed to fetch fix)", () => {
    expect(source).toMatch(
      /^import \{ updateCompanyTimezoneAction \} from "\.\.\/\.\.\/\.\.\/lib\/actions\/timezone\.js";$/m,
    );
    const propsTypeMatch = source.match(
      /export function TimezoneCombobox\(\{[\s\S]*?\}: \{([\s\S]*?)\}\)/,
    );
    expect(propsTypeMatch).not.toBeNull();
    expect(propsTypeMatch?.[1] ?? "").not.toContain("onSave");
    expect(source).toContain("await updateCompanyTimezoneAction(value)");
  });

  it("tracks the selected value and the search query as separate state, so the box never self-filters to just the current value on open", () => {
    expect(source).toContain("const [selectedValue, setSelectedValue] = useState(initialValue);");
    expect(source).toContain('const [searchQuery, setSearchQuery] = useState("");');
    // Filtering must use searchQuery, not the combined display value or the
    // selected value -- an empty searchQuery must fall through to the full list.
    expect(source).toMatch(/const q = searchQuery\.trim\(\)\.toLowerCase\(\);/);
    expect(source).toMatch(/q\.length === 0 \? allOptions : allOptions\.filter/);
  });

  it("does not prefill the search filter with the current value on focus -- only typing (onChange) sets searchQuery", () => {
    const onFocusMatch = source.match(/onFocus=\{[\s\S]{0,80}\}/);
    expect(onFocusMatch).not.toBeNull();
    expect(onFocusMatch?.[0]).not.toContain("setSearchQuery");
    expect(onFocusMatch?.[0]).not.toContain("setSelectedValue");
  });
});
