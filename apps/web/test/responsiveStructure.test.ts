import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural regression checks for the mobile responsive pass -- asserts
 * the CSS mechanisms exist and collapse at the right breakpoints, not
 * pixel-perfect rendering (no visual snapshot tests; a real browser is
 * needed for that and this repo has no such harness -- see
 * timezoneCombobox.test.ts's identical note on why source assertions are
 * this codebase's established pattern for UI regression coverage).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const css = readFileSync(join(webRoot, "app/globals.css"), "utf8");
const layoutSource = readFileSync(join(webRoot, "app/dashboard/layout.tsx"), "utf8");

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.#[\]]/g, (c) => `\\${c}`);
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  expect(match, `expected a CSS rule for ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("Responsive: shared card grid never forces a fixed desktop-only column count onto a narrow phone", () => {
  it(".dvx-card-grid (and its --wide/--narrow variants) collapse to a single column at <= 430px", () => {
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 430px)"));
    const rule = mobileBlock.match(/@media \(max-width: 430px\) \{[\s\S]*?\n\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain(".dvx-card-grid");
    expect(rule?.[0]).toContain(".dvx-card-grid--wide");
    expect(rule?.[0]).toContain(".dvx-card-grid--narrow");
    expect(rule?.[0]).toContain("grid-template-columns: 1fr");
  });

  it(".dvx-card-grid is a real CSS grid using auto-fit, not a fixed multi-column layout", () => {
    const rule = ruleFor(".dvx-card-grid");
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/repeat\(auto-fit,\s*minmax\(/);
  });

  it("cards default to width:100% and min-width:0 so they never overflow their grid track", () => {
    const rule = ruleFor(".dvx-card");
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
  });

  it(".dvx-kpi-grid already steps down 4 -> 3 -> 2 -> 1 columns across the requested breakpoints", () => {
    expect(css).toMatch(/\.dvx-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4, 1fr\)/);
    expect(css).toMatch(
      /@media \(max-width: 1180px\)\s*\{\s*\.dvx-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, 1fr\)/,
    );
    expect(css).toMatch(
      /@media \(max-width: 860px\)\s*\{\s*\.dvx-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, 1fr\)/,
    );
    expect(css).toMatch(
      /@media \(max-width: 480px\)\s*\{\s*\.dvx-kpi-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
  });
});

describe("Responsive: no page hand-rolls its own fixed-pixel grid outside the shared class", () => {
  it("Overview, Company Settings, WhatsApp Connection, and lead detail all use .dvx-card-grid instead of an inline gridTemplateColumns", () => {
    for (const file of [
      "app/dashboard/page.tsx",
      "app/dashboard/settings/page.tsx",
      "app/dashboard/settings/whatsapp/page.tsx",
      "app/dashboard/leads/[leadId]/page.tsx",
    ]) {
      const source = readFileSync(join(webRoot, file), "utf8");
      expect(source, `${file} should not inline its own gridTemplateColumns`).not.toContain(
        "gridTemplateColumns",
      );
      expect(source, `${file} should use the shared .dvx-card-grid class`).toContain(
        "dvx-card-grid",
      );
    }
  });
});

describe("Responsive: mobile header stays compact without removing search", () => {
  it("the search bar is hidden by default below 768px and revealed by a real checkbox toggle, never deleted", () => {
    const block = css.match(
      /@media \(max-width: 768px\) \{[\s\S]*?\n\}\n\n@media \(max-width: 480px\)/,
    );
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain(".dvx-topbar-search {");
    expect(block?.[0]).toMatch(/\.dvx-topbar-search\s*\{\s*display:\s*none;/);
    expect(block?.[0]).toContain(".dvx-topbar-search-toggle-input:checked ~ .dvx-topbar-search");
  });

  it("layout.tsx renders the search toggle as a real checkbox+label pair (same accessible pattern as the sidebar drawer), and GlobalSearch itself is never removed", () => {
    expect(layoutSource).toContain('id="dvx-search-toggle"');
    expect(layoutSource).toContain('className="dvx-topbar-search-toggle-input"');
    expect(layoutSource).toContain("<GlobalSearch />");
  });

  it("the profile name/company text is hidden at the narrowest widths, leaving just the avatar (never overflows)", () => {
    expect(css).toMatch(
      /@media \(max-width: 480px\)\s*\{\s*\.dvx-user-menu-label\s*\{\s*display:\s*none;/,
    );
    expect(layoutSource).toContain('className="dvx-user-menu-label"');
  });
});

describe("Responsive: sidebar drawer never exceeds the viewport on the narrowest phones", () => {
  it(".dvx-sidebar caps its width to min(312px, 88vw) once the drawer is fixed-positioned", () => {
    const mobileSidebarRule = css.match(/\.dvx-sidebar\s*\{\s*position:\s*fixed;[^}]*\}/);
    expect(mobileSidebarRule).not.toBeNull();
    expect(mobileSidebarRule?.[0]).toMatch(/max-width:\s*min\(312px,\s*88vw\)/);
  });
});

describe("Responsive: Team Settings member rows wrap instead of forcing a desktop-only table", () => {
  it("stacks name above role/status badges at <= 390px rather than clipping or scrolling horizontally", () => {
    expect(css).toMatch(
      /@media \(max-width: 390px\)\s*\{\s*\.dvx-team-member-row\s*\{\s*flex-direction:\s*column;/,
    );
  });
});

describe("Responsive: Team Settings and Company Settings are distinct routes", () => {
  it("layout.tsx wires /dashboard/team and /dashboard/settings as two separate hrefs", () => {
    expect(layoutSource).toContain('href: "/dashboard/team"');
    expect(layoutSource).toContain('href: "/dashboard/settings"');
  });
});
