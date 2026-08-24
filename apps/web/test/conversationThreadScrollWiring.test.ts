import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 3B: guards against regressing the two structural properties that
 * pure-logic unit tests can't reach without a DOM-rendering stack (this
 * repo has none -- see scrollBehavior.test.ts for the decision-logic tests,
 * and threadPagination.test.ts / serviceRoleGuard.test.ts /
 * sendHumanReplyGuard.test.ts for the established convention this file
 * follows: a structural source-text assertion where a full render isn't
 * available).
 *
 * 1. Both page.tsx call sites must key <ConversationThread> by
 *    conversationId, not companyId. Root cause of the original "opens at
 *    the top, and stale on conversation switch" bug: keying by companyId
 *    means React reuses the same component instance (and its useState-held
 *    message list + scroll position) across a conversation switch within
 *    the same company, since the lazy useState initializer only runs on
 *    mount, never on a later prop change.
 * 2. The scroll-position effect must use useLayoutEffect, not useEffect --
 *    a plain useEffect runs after the browser paints, which is exactly the
 *    visible top-then-jump-to-bottom flash this phase exists to remove.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

const conversationsPagePath = join(
  webRoot,
  "app/dashboard/conversations/[conversationId]/page.tsx",
);
const handoverPagePath = join(webRoot, "app/dashboard/handover/[conversationId]/page.tsx");
const threadPath = join(webRoot, "app/dashboard/handover/[conversationId]/ConversationThread.tsx");

describe("ConversationThread remount + scroll-timing wiring", () => {
  it("Live Conversations detail page keys ConversationThread by conversationId", () => {
    const source = readFileSync(conversationsPagePath, "utf8");
    const match = source.match(/<ConversationThread\s+key=\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("conversationId");
  });

  it("Human Handover detail page keys ConversationThread by conversationId (shared component, same fix)", () => {
    const source = readFileSync(handoverPagePath, "utf8");
    const match = source.match(/<ConversationThread\s+key=\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("conversationId");
  });

  it("neither call site keys ConversationThread by activeCompanyId anymore", () => {
    for (const path of [conversationsPagePath, handoverPagePath]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/<ConversationThread\s+key=\{session\.activeCompanyId\}/);
    }
  });

  it("the scroll-position effect uses useLayoutEffect, not useEffect, to avoid a visible jump", () => {
    const source = readFileSync(threadPath, "utf8");
    expect(source).toMatch(/import\s*\{[^}]*\buseLayoutEffect\b[^}]*\}\s*from\s*["']react["']/);
    expect(source).toMatch(/useLayoutEffect\(\s*\(\)\s*=>/);
    // Guards against a bare "useEffect(() =>" being (re)introduced as an
    // alternative/duplicate scroll-position effect alongside it.
    expect(source).not.toMatch(/\buseEffect\(/);
  });

  it("does not reintroduce an arbitrary setTimeout as the initial-scroll mechanism", () => {
    const source = readFileSync(threadPath, "utf8");
    expect(source).not.toMatch(/setTimeout/);
  });
});
