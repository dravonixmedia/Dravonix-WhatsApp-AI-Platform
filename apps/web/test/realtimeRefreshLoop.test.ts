import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for a confirmed staging bug: both conversation-detail
 * pages called markConversationRead unconditionally on every server render,
 * which unconditionally bumps conversations.handover_last_read_at -- a
 * column covered by that same page's own Realtime watch
 * (CONVERSATION_DETAIL_WATCHES). This created a self-sustaining loop with no
 * real user activity required: mark read -> conversations UPDATE ->
 * Realtime event -> router.refresh() -> page re-renders -> mark read again
 * -> ... The observed symptom was continuous GET/RSC traffic every few
 * seconds while idle. Static source assertions rather than a rendering
 * harness -- this repo has none (see chatAgentPanelWiring.test.ts's
 * identical note); the underlying hooks have no session.ts dependency but
 * there's nothing to gain by importing them directly over reading their
 * source for these particular properties.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const conversationsDetailSource = readSource(
  "app/dashboard/conversations/[conversationId]/page.tsx",
);
const handoverDetailSource = readSource("app/dashboard/handover/[conversationId]/page.tsx");
const markReadComponentSource = readSource("app/dashboard/MarkConversationReadOnMount.tsx");
const useTenantRealtimeChannelSource = readSource("lib/realtime/useTenantRealtimeChannel.ts");
const realtimeRefreshBoundarySource = readSource("lib/realtime/RealtimeRefreshBoundary.tsx");
const watchConfigsSource = readSource("lib/realtime/watchConfigs.ts");

describe("conversation-detail pages: mark-read no longer runs on every server render", () => {
  it("neither page calls markConversationRead unconditionally during render", () => {
    expect(conversationsDetailSource).not.toContain("markConversationRead(repo, conversationId)");
    expect(handoverDetailSource).not.toContain("markConversationRead(repo, conversationId)");
    expect(conversationsDetailSource).not.toMatch(/import\s*\{[^}]*markConversationRead[^}]*\}/);
    expect(handoverDetailSource).not.toMatch(/import\s*\{[^}]*markConversationRead[^}]*\}/);
  });

  it("both pages instead render MarkConversationReadOnMount, scoped to this conversationId", () => {
    expect(conversationsDetailSource).toContain(
      "<MarkConversationReadOnMount conversationId={conversationId} />",
    );
    expect(handoverDetailSource).toContain(
      "<MarkConversationReadOnMount conversationId={conversationId} />",
    );
  });
});

describe("MarkConversationReadOnMount: fires once per navigation, not once per refresh", () => {
  it("is a client component", () => {
    expect(markReadComponentSource).toMatch(/^"use client";/);
  });

  it("calls markConversationReadAction only inside a useEffect keyed by conversationId", () => {
    const effectMatch = markReadComponentSource.match(
      /useEffect\(\(\) => \{([\s\S]*?)\}, \[conversationId\]\)/,
    );
    expect(effectMatch).not.toBeNull();
    expect(effectMatch?.[1] ?? "").toContain("markConversationReadAction(conversationId)");
  });

  it("never calls the action at module/render scope (only inside the effect body)", () => {
    const beforeEffect = markReadComponentSource.split("useEffect(")[0] ?? "";
    expect(beforeEffect).not.toContain("markConversationReadAction(");
  });
});

describe("useTenantRealtimeChannel: no polling, bounded reconnects, clean teardown", () => {
  it("never uses setInterval -- only setTimeout for bounded, one-shot reconnect delays", () => {
    expect(useTenantRealtimeChannelSource).not.toMatch(/setInterval/);
    expect(useTenantRealtimeChannelSource).toContain("setTimeout(connect, delay)");
  });

  it("the effect's cleanup removes the channel and clears the reconnect timer (tenant switch / unmount)", () => {
    expect(useTenantRealtimeChannelSource).toMatch(
      /return \(\) => \{[\s\S]*?teardown\(\);[\s\S]*?\};/,
    );
    expect(useTenantRealtimeChannelSource).toContain(
      "if (reconnectTimer) clearTimeout(reconnectTimer);",
    );
    expect(useTenantRealtimeChannelSource).toContain("if (channel) client.removeChannel(channel);");
  });

  it("depends only on stable, comparable values -- an unrelated re-render cannot spuriously recreate the subscription", () => {
    expect(useTenantRealtimeChannelSource).toContain(
      "[namespace, scopeId, accessToken, enabled, JSON.stringify(watches)]",
    );
  });

  it("only creates one channel per effect run -- reconnecting always tears down the previous channel first", () => {
    expect(useTenantRealtimeChannelSource).toMatch(
      /function scheduleReconnect\(\) \{[\s\S]*?if \(channel\) client\.removeChannel\(channel\);/,
    );
  });

  it("does not force a reconnect on a routine tab-foreground/online event when the channel is already healthy", () => {
    expect(useTenantRealtimeChannelSource).toContain(
      'if (channel && channel.state === "joined") return;',
    );
  });
});

describe("RealtimeRefreshBoundary: debounces bursts into a single refresh, never refreshes on its own", () => {
  it("clears any pending refresh before scheduling a new one -- a burst of events coalesces into one router.refresh()", () => {
    expect(realtimeRefreshBoundarySource).toMatch(
      /function refreshSoon\(\) \{\s*if \(debounceRef\.current\) clearTimeout\(debounceRef\.current\);/,
    );
  });

  it("router.refresh() appears exactly once, inside the debounced setTimeout callback -- never called unconditionally", () => {
    const codeOnly = withoutComments(realtimeRefreshBoundarySource);
    const matches = codeOnly.match(/router\.refresh\(\)/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(codeOnly).toMatch(/setTimeout\(\(\) => router\.refresh\(\), REFRESH_DEBOUNCE_MS\)/);
  });

  it("uses a bounded debounce window, not a recurring timer", () => {
    expect(realtimeRefreshBoundarySource).not.toMatch(/setInterval/);
    expect(realtimeRefreshBoundarySource).toMatch(/REFRESH_DEBOUNCE_MS\s*=\s*\d+/);
  });
});

describe("Realtime watch configuration: notification/Overview/Handover coverage preserved", () => {
  it("DASHBOARD_SHELL_WATCHES (bell badge + nav badge, mounted once in layout.tsx) is unchanged", () => {
    expect(watchConfigsSource).toContain("export const DASHBOARD_SHELL_WATCHES");
    expect(watchConfigsSource).toMatch(
      /DASHBOARD_SHELL_WATCHES[\s\S]*?\{ table: "conversations", filterColumn: "company_id", event: "INSERT" \}/,
    );
  });

  it('every watch list still excludes DELETE and "*" (RLS is not enforced for DELETE on Realtime)', () => {
    expect(watchConfigsSource).not.toMatch(/event:\s*"DELETE"/);
    expect(watchConfigsSource).not.toMatch(/event:\s*"\*"/);
  });
});
