import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Dashboard sidebar navigation -- covers the original dashboard correction
 * pass (Knowledge Base/Billing must never appear; Settings/WhatsApp
 * Connection gated by real permissions, never a hardcoded email or role),
 * the sidebar UI/UX polish pass (exact 9-item order, the DRAIVA two-line
 * entry, the split Team Settings/Company Settings gate), and the dedicated
 * Notifications/DRAIVA sections pass: both are now plain routed links
 * (/dashboard/notifications, /dashboard/draiva), not a popup toggle or a
 * conditional redirect to Live Conversations.
 *
 * Static source assertions rather than importing app/dashboard/layout.tsx
 * directly: that file transitively imports lib/session.ts, which wraps
 * getDashboardSession() in React's cache() -- a real RSC-only API that
 * throws when the module graph loads outside Next's server-component
 * runtime (this repo's vitest config runs plain node, matching every other
 * "use server"/session-adjacent file this codebase already tests this way;
 * see sendHumanReplyGuard.test.ts / serviceRoleGuard.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const layoutSource = readFileSync(join(webRoot, "app/dashboard/layout.tsx"), "utf8");
const navLinksSource = readFileSync(join(webRoot, "app/dashboard/NavLinks.tsx"), "utf8");
const composerSource = readFileSync(
  join(webRoot, "app/dashboard/ConversationComposerWithAssistant.tsx"),
  "utf8",
);
const cssSource = readFileSync(join(webRoot, "app/globals.css"), "utf8");

function indexOfOrThrow(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`Expected to find ${JSON.stringify(needle)} in source`);
  }
  return index;
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("dashboard sidebar navigation", () => {
  it("never constructs a Knowledge Base nav entry -- no client-ready management module exists", () => {
    expect(layoutSource).not.toMatch(/label:\s*"Knowledge Base"/);
    expect(layoutSource).not.toMatch(/href:\s*"\/dashboard\/knowledge"/);
  });

  it("never constructs a Billing nav entry -- no client-ready subscription system exists yet", () => {
    expect(layoutSource).not.toMatch(/label:\s*"Billing"/);
    expect(layoutSource).not.toMatch(/href:\s*"\/dashboard\/billing"/);
  });

  it("builds the sidebar in the exact approved order: Overview, Live Conversations, Human Handover, Leads, Notifications, DRAIVA, Team Settings, Company Settings, WhatsApp Connection", () => {
    const positions = [
      indexOfOrThrow(layoutSource, 'label: "Overview"'),
      indexOfOrThrow(layoutSource, 'label: "Live Conversations"'),
      indexOfOrThrow(layoutSource, 'label: "Human Handover"'),
      indexOfOrThrow(layoutSource, 'label: "Leads"'),
      indexOfOrThrow(layoutSource, 'label: "Notifications"'),
      indexOfOrThrow(layoutSource, 'kind: "draiva"'),
      indexOfOrThrow(layoutSource, 'label: "Team Settings"'),
      indexOfOrThrow(layoutSource, 'label: "Company Settings"'),
      indexOfOrThrow(layoutSource, 'label: "WhatsApp Connection"'),
    ];
    for (let i = 1; i < positions.length; i++) {
      const current = positions[i];
      const previous = positions[i - 1];
      if (current === undefined || previous === undefined) {
        throw new Error("unreachable: positions is a fixed non-empty literal array");
      }
      expect(current).toBeGreaterThan(previous);
    }
  });

  it("places DRAIVA strictly after Notifications and before Team Settings", () => {
    const notifications = indexOfOrThrow(layoutSource, 'label: "Notifications"');
    const draiva = indexOfOrThrow(layoutSource, 'kind: "draiva"');
    const teamSettings = indexOfOrThrow(layoutSource, 'label: "Team Settings"');
    expect(draiva).toBeGreaterThan(notifications);
    expect(teamSettings).toBeGreaterThan(draiva);
  });

  it("keeps every existing route unchanged and links Notifications/DRAIVA to their new dedicated routes", () => {
    expect(layoutSource).toContain('href: "/dashboard"');
    expect(layoutSource).toContain('href: "/dashboard/conversations"');
    expect(layoutSource).toContain('href: "/dashboard/handover"');
    expect(layoutSource).toContain('href: "/dashboard/leads"');
    expect(layoutSource).toContain('href: "/dashboard/settings/whatsapp"');
    expect(layoutSource).toContain('href: "/dashboard/notifications"');
    expect(layoutSource).toContain('kind: "draiva", href: "/dashboard/draiva"');
  });

  it("gates Team Settings behind capabilities.canManageTeam alone, never a hardcoded email or role", () => {
    const block = layoutSource.match(/if \(capabilities\.canManageTeam\) \{[\s\S]*?\}/);
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain('label: "Team Settings"');
    expect(block?.[0]).toContain("/dashboard/settings");
  });

  it("gates Company Settings so its union with Team Settings reproduces the original combined Settings gate (canManageSettings || canManageTeam || canManageBilling) -- no role loses sidebar access", () => {
    const block = layoutSource.match(
      /if \(\s*capabilities\.canManageSettings[\s\S]*?\) \{[\s\S]*?\}/,
    );
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain("capabilities.canManageBilling");
    expect(block?.[0]).toContain('label: "Company Settings"');
    expect(block?.[0]).toContain("/dashboard/settings");
  });

  it("the Billing route itself redirects rather than rendering a fabricated placeholder plan", () => {
    const billingRouteSource = readFileSync(
      join(webRoot, "app/dashboard/billing/page.tsx"),
      "utf8",
    );
    const rendered = withoutComments(billingRouteSource);
    expect(billingRouteSource).toContain('redirect("/dashboard/settings")');
    expect(rendered).not.toContain("Starter (trial)");
  });

  it("gates the WhatsApp Connection nav entry behind capabilities.canManageWhatsapp, never a hardcoded email or role", () => {
    const whatsappBlockMatch = layoutSource.match(
      /if \(capabilities\.canManageWhatsapp\) \{[\s\S]*?\}/,
    );
    expect(whatsappBlockMatch).not.toBeNull();
    expect(whatsappBlockMatch?.[0]).toContain('href: "/dashboard/settings/whatsapp"');
  });

  it("gates the DRAIVA nav entry behind capabilities.canReplyToConversations, the same permission that already gates the composer's Ask DRAIVA entry point", () => {
    const draivaBlockMatch = layoutSource.match(
      /if \(capabilities\.canReplyToConversations\) \{[\s\S]*?\}/,
    );
    expect(draivaBlockMatch).not.toBeNull();
    expect(draivaBlockMatch?.[0]).toContain('kind: "draiva"');
  });

  it("never hardcodes an email address anywhere in the nav-building logic", () => {
    expect(layoutSource).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
  });

  it("the Knowledge Base route itself redirects rather than rendering a developer placeholder", () => {
    const knowledgeRouteSource = readFileSync(
      join(webRoot, "app/dashboard/knowledge/page.tsx"),
      "utf8",
    );
    expect(knowledgeRouteSource).toContain('redirect("/dashboard")');
  });

  it("renders DRAIVA as a two-line card with a title span and a subtitle span, never a single truncated line", () => {
    expect(navLinksSource).toContain('className="dvx-draiva-nav-title"');
    expect(navLinksSource).toContain('className="dvx-draiva-nav-subtitle"');
    expect(navLinksSource).toContain("DRAIVA AI");
    expect(navLinksSource).toContain("Conversation Assistant by");
    // No truncation/overflow escape hatches anywhere in the component.
    expect(navLinksSource).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(navLinksSource).not.toMatch(/white-?[Ss]pace:\s*["']?nowrap/);
    // No CSS rule for these classes forces single-line/ellipsis layout either.
    expect(cssSource).not.toMatch(/\.dvx-draiva-nav-(?:title|subtitle|text)[^{]*\{[^}]*nowrap/);
    expect(cssSource).not.toMatch(/\.dvx-draiva-nav-(?:title|subtitle|text)[^{]*\{[^}]*ellipsis/);
  });

  it("gives DRAIVA an accessible label matching its full two-line identity", () => {
    expect(navLinksSource).toContain('aria-label="DRAIVA AI Conversation Assistant by Dravonix"');
  });

  it("styles DRAIVA AI with the existing cyan/blue brand accent, not a new color", () => {
    const rule = cssSource.match(/\.dvx-draiva-nav-title\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/color:\s*var\(--brand-cyan\)/);
  });

  it("wraps Dravonix in its own span styled with the existing cyan/blue brand accent", () => {
    expect(navLinksSource).toMatch(/<span className="dvx-draiva-brand">\s*Dravonix\s*<\/span>/);
    const rule = cssSource.match(/\.dvx-draiva-brand\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/color:\s*var\(--brand-cyan\)/);
  });

  it("never introduces a new blue/cyan literal for the sidebar -- every new sidebar rule reuses existing --brand-blue/--brand-cyan/--surface-*/--border-* tokens", () => {
    const sidebarSection = cssSource.slice(
      cssSource.indexOf("Sidebar polish phase"),
      cssSource.indexOf(".dvx-topbar {"),
    );
    expect(sidebarSection.length).toBeGreaterThan(0);
    // No raw hex/rgb color literals -- only var(--token) references.
    expect(sidebarSection).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(sidebarSection).not.toMatch(/rgba?\(/);
  });

  it("renders every sidebar entry, including Notifications and DRAIVA, as a real <Link> -- no button/popup-toggle entry kind exists anymore", () => {
    const codeOnly = withoutComments(navLinksSource);
    expect(codeOnly).not.toMatch(/kind === "notifications"/);
    expect(codeOnly).not.toMatch(/useNotificationPanel/);
    expect(codeOnly).not.toMatch(/toggleNotifications/);
    // Every entry (including "draiva") renders through a single <Link>.
    expect((navLinksSource.match(/<Link\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("computes active-route styling, including for DRAIVA, via isActive(pathname, entry.href)", () => {
    expect(navLinksSource).toContain("function isActive(");
    expect(navLinksSource).toMatch(/const active = isActive\(pathname, entry\.href\)/g);
    expect(navLinksSource).toContain("dvx-nav-link--active");
    // DRAIVA's own branch also computes and applies the active class.
    const draivaBranch = navLinksSource.match(/if \(entry\.kind === "draiva"\)[\s\S]*?\n {8}\}/);
    expect(draivaBranch).not.toBeNull();
    expect(draivaBranch?.[0]).toContain("isActive(pathname, entry.href)");
    expect(draivaBranch?.[0]).toContain("dvx-nav-link--active");
  });

  it("renders a right-aligned badge for any entry with a positive badgeCount, reusing formatBadgeCount -- Human Handover and Notifications keep their live counts", () => {
    expect(navLinksSource).toMatch(/badgeCount && entry\.badgeCount > 0 \?/);
    expect(navLinksSource).toContain("formatBadgeCount(");
    expect(cssSource).toMatch(/\.dvx-nav-badge\s*\{[^}]*margin-left:\s*auto/);
  });

  it("wires the Human Handover badge and a Notifications badge from real, session-scoped data -- never a literal number", () => {
    expect(layoutSource).toContain("badgeCount: badgeCounts.handover");
    expect(layoutSource).toContain("badgeCount: badgeCounts.notifications");
    expect(layoutSource).toContain("handover: handoverBadgeCount");
    expect(layoutSource).toContain(
      "notifications: notificationSummary.totalUnreadCustomerMessages",
    );
  });

  it("no longer redirects DRAIVA to Live Conversations, dispatches a custom DOM event, or reads the current pathname to decide where it goes -- it is a plain link to /dashboard/draiva", () => {
    const codeOnly = withoutComments(navLinksSource);
    expect(codeOnly).not.toMatch(/dvx:open-draiva/);
    expect(codeOnly).not.toMatch(/handleDraivaClick/);
    expect(codeOnly).not.toMatch(/CONVERSATION_DETAIL_ROUTE/);
    expect(codeOnly).not.toMatch(/router\.push\("\/dashboard\/conversations"\)/);
    expect(codeOnly).not.toMatch(/useRouter/);
  });

  it("the now-dead dvx:open-draiva listener was removed from ConversationComposerWithAssistant -- nothing dispatches it anymore", () => {
    const codeOnly = withoutComments(composerSource);
    expect(codeOnly).not.toMatch(/dvx:open-draiva/);
    expect(codeOnly).not.toMatch(/handleOpenDraiva/);
    // "Ask DRAIVA" in-conversation launcher is untouched.
    expect(composerSource).toMatch(/>\s*Ask DRAIVA\s*</);
  });

  it("never lets the sidebar manage its own duplicate ChatAgentPanel state -- it never imports ChatAgentPanel or calls chatAgentAction directly", () => {
    const codeOnly = withoutComments(navLinksSource);
    expect(codeOnly).not.toMatch(/ChatAgentPanel/);
    expect(codeOnly).not.toMatch(/chatAgentAction/);
  });

  it("closes the mobile drawer after any sidebar navigation, including Notifications and DRAIVA", () => {
    expect(navLinksSource).toContain("function closeMobileDrawer()");
    expect(navLinksSource).toContain('getElementById("dvx-nav-toggle")');
    // Every rendered <Link> (both the plain-link branch and the draiva
    // branch) wires the same onClick handler -- not just some of them.
    const linkOnClicks = navLinksSource.match(/<Link[\s\S]*?onClick=\{closeMobileDrawer\}/g) ?? [];
    expect(linkOnClicks.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves the existing checkbox-driven mobile drawer mechanism and locks background scroll while it's open", () => {
    expect(layoutSource).toContain('id="dvx-nav-toggle"');
    expect(layoutSource).toContain('className="dvx-nav-toggle-input"');
    expect(cssSource).toContain(".dvx-nav-toggle-input:checked ~ .dvx-sidebar");
    expect(cssSource).toMatch(/body:has\(#dvx-nav-toggle:checked\)\s*\{\s*overflow:\s*hidden;/);
  });

  it("gives every nav card a minimum 44px touch target for mobile", () => {
    const rule = cssSource.match(/\.dvx-nav-card\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/min-height:\s*44px/);
  });
});
