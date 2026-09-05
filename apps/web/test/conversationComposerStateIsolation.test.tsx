// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationComposerWithAssistant } from "../app/dashboard/ConversationComposerWithAssistant.js";

/**
 * Real DOM-mounting regression test for the Human Handover / Live
 * Conversations conversation-switch stale-state bug (PR #63).
 *
 * PR #63's structural source-text test (conversationComposerRemountWiring
 * .test.ts) only proved `key={conversationId}` is present in the page
 * source -- it never actually mounted React and exercised reconciliation.
 * Staging human verification then showed an unsent draft ("hi test")
 * surviving a real conversation A -> B switch despite that source-level fix
 * being live in production, disproving the structural test's assumption
 * that "the key is present" implies "the state resets". This file mounts
 * the real ConversationComposerWithAssistant component (the same one both
 * page.tsx call sites render) and drives an actual React re-render across a
 * conversationId change, the same way Next.js's App Router re-renders the
 * page subtree on a client-side navigation to a sibling dynamic segment --
 * proving or disproving the remount empirically instead of asserting on
 * source text.
 *
 * Mirrors the exact JSX shape both page.tsx files use: a conditional
 * ternary rendering `<ConversationComposerWithAssistant key={conversationId}
 * conversationId={conversationId} />` for a human_active conversation.
 */

vi.mock("../lib/actions/handover.js", () => ({
  sendHumanReplyAction: vi.fn(async () => ({ success: true }) as const),
  sendServiceWindowTemplateAction: vi.fn(async () => ({ success: true }) as const),
}));

vi.mock("../lib/actions/chatAgent.js", () => ({
  chatAgentAction: vi.fn(async () => {
    throw new Error("chatAgentAction should not be called by this test");
  }),
}));

function ConversationDetailHarness({ conversationId }: { conversationId: string }) {
  // Exactly the shape both apps/web/app/dashboard/{handover,conversations}/
  // [conversationId]/page.tsx use for a human_active conversation.
  return (
    <div>
      <ConversationComposerWithAssistant key={conversationId} conversationId={conversationId} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConversationComposerWithAssistant conversation-switch state isolation (real DOM mount)", () => {
  it("A's unsent draft does not survive a conversationId change (A -> B)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConversationDetailHarness conversationId="conversation-a" />);

    const textareaA = screen.getByPlaceholderText("Type a reply...");
    await user.type(textareaA, "hi test");
    expect(textareaA).toHaveValue("hi test");

    // Simulate the Next.js App Router re-rendering this same subtree with a
    // new conversationId after a client-side navigation to a different
    // conversation -- a rerender, not a fresh render() call, is essential:
    // a fresh render() would trivially pass regardless of whether the real
    // production remount boundary works.
    rerender(<ConversationDetailHarness conversationId="conversation-b" />);

    const textareaB = screen.getByPlaceholderText("Type a reply...");
    expect(textareaB).toHaveValue("");
    expect(textareaB).not.toBe(textareaA);
  });

  it("B's own draft does not leak back into A on a further switch (A -> B -> A)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConversationDetailHarness conversationId="conversation-a" />);
    await user.type(screen.getByPlaceholderText("Type a reply..."), "draft for A");

    rerender(<ConversationDetailHarness conversationId="conversation-b" />);
    await user.type(screen.getByPlaceholderText("Type a reply..."), "draft for B");
    expect(screen.getByPlaceholderText("Type a reply...")).toHaveValue("draft for B");

    rerender(<ConversationDetailHarness conversationId="conversation-a" />);
    expect(screen.getByPlaceholderText("Type a reply...")).toHaveValue("");
  });

  it("the DRAIVA assistant panel from A (opened) does not stay open on B", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConversationDetailHarness conversationId="conversation-a" />);

    await user.click(screen.getByRole("button", { name: "Open DRAIVA conversation assistant" }));
    expect(
      screen.getByRole("dialog", { name: "DRAIVA conversation assistant" }),
    ).toBeInTheDocument();

    rerender(<ConversationDetailHarness conversationId="conversation-b" />);

    // ChatAgentPanel (the assistant overlay) only mounts while
    // ConversationComposerWithAssistant's own assistantOpen state is true --
    // its absence here confirms the remount reset assistantOpen itself, not
    // just that some visible content changed.
    expect(
      screen.queryByRole("dialog", { name: "DRAIVA conversation assistant" }),
    ).not.toBeInTheDocument();
  });

  // Service-window error state (windowClosed, canSendReengagementTemplate,
  // templateSent, templateError) lives in useState hooks declared in this
  // SAME ReplyComposer component instance as the draft-adjacent state above
  // -- not in a separate component, context, or store. React does not
  // support resetting some of a fiber's hooks on remount while preserving
  // others: every useState hook on a given component instance is backed by
  // one linked list on that fiber, discarded and recreated together the
  // instant the fiber itself is torn down. The two tests above already
  // prove, by mounting the real component and driving a real conversationId
  // change through React's actual reconciler, that ReplyComposer's fiber
  // (and ConversationComposerWithAssistant's) is genuinely discarded and
  // recreated on a conversationId change -- so windowClosed/
  // canSendReengagementTemplate/templateSent/templateError reset on exactly
  // the same remount, with no additional test needed to prove it separately.
  //
  // A dedicated behavioral test that first drives ReplyComposer into
  // windowClosed=true and then asserts it clears on remount was attempted
  // and deliberately dropped: it requires submitting the composer's
  // <form action={...}> the same way a real user would, but Next.js's App
  // Router implements that "action" prop's actual submit interception
  // entirely inside its own internally-compiled react-dom
  // (next/dist/compiled/react-dom, confirmed present in node_modules,
  // separate from and incompatible with the plain react-dom@18.3.1 this
  // repo declares and @testing-library/react renders with) -- the plain
  // React 18.3.1 stable release does not implement function-valued <form
  // action> at all, so a raw render() here can mount the form but its
  // action callback is never invoked by a submit, with no error and no
  // observable failure to signal it. Reaching for Next's internal compiled
  // react-dom from a test would exercise an unsupported, non-public build
  // rather than this repo's own dependency graph, which is worse evidence
  // than the fiber-identity argument above, not better.
});
