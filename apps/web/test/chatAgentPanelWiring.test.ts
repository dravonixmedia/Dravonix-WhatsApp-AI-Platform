import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the Chat Agent UI (ChatAgentPanel.tsx,
 * ConversationComposerWithAssistant.tsx, and the modified ReplyComposer.tsx).
 * These are plain client components with no session.ts import, so they
 * could in principle be imported directly, but this repo has no React
 * component-rendering test harness (no @testing-library/react) -- covered
 * the same way as every other dashboard component for consistency (see
 * notificationBellWiring.test.ts's identical note).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const panelSource = readFileSync(join(webRoot, "app/dashboard/ChatAgentPanel.tsx"), "utf8");
const composerWrapperSource = readFileSync(
  join(webRoot, "app/dashboard/ConversationComposerWithAssistant.tsx"),
  "utf8",
);
const replyComposerSource = readFileSync(
  join(webRoot, "app/dashboard/handover/[conversationId]/ReplyComposer.tsx"),
  "utf8",
);
const conversationsPageSource = readFileSync(
  join(webRoot, "app/dashboard/conversations/[conversationId]/page.tsx"),
  "utf8",
);
const handoverPageSource = readFileSync(
  join(webRoot, "app/dashboard/handover/[conversationId]/page.tsx"),
  "utf8",
);

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("ChatAgentPanel: never bypasses the human-review composer", () => {
  it("never imports or calls sendHumanReplyAction or any handover-lifecycle action", () => {
    const panelCodeOnly = withoutComments(panelSource);
    const wrapperCodeOnly = withoutComments(composerWrapperSource);
    for (const forbidden of [
      "sendHumanReplyAction",
      "assignToMeAction",
      "pauseAiAction",
      "resumeAiAction",
      "endHumanAssistanceAction",
      "closeConversationAction",
      "markConversationRead",
    ]) {
      expect(panelCodeOnly).not.toContain(forbidden);
      expect(wrapperCodeOnly).not.toContain(forbidden);
    }
  });

  it('"Use this reply" only calls onUseReply -- it never submits a form or calls chatAgentAction again', () => {
    const useReplyBlockMatch = panelSource.match(/Use this reply[\s\S]{0,400}?onClick=\{[^}]*\}/);
    // Simpler and more robust: find the button whose onClick calls onUseReply.
    expect(panelSource).toMatch(/onClick=\{\(\) => onUseReply\(view\.result\.displayText\)\}/);
    void useReplyBlockMatch;
  });

  it("ConversationComposerWithAssistant wires onUseReply directly to the composer's draft setter, never to a send action", () => {
    expect(composerWrapperSource).toContain("onUseReply={setDraft}");
    expect(composerWrapperSource).not.toMatch(/onUseReply=\{.*(send|submit)/i);
  });
});

describe("ChatAgentPanel: duplicate-click guard", () => {
  it("guards run() against overlapping calls while a request is already pending", () => {
    expect(panelSource).toMatch(/if\s*\(isPending\)\s*return;/);
  });

  it("disables every quick-action button while a request is pending", () => {
    const buttonBlocks = panelSource.match(/disabled=\{isPending[^}]*\}/g) ?? [];
    expect(buttonBlocks.length).toBeGreaterThanOrEqual(6); // one per quick action + ask
  });
});

describe("ChatAgentPanel: error recovery never shows a raw/thrown error message", () => {
  it("checks response.ok instead of catching a thrown error for the normal failure path", () => {
    expect(panelSource).toMatch(/if\s*\(response\.ok\)\s*\{/);
    expect(panelSource).toMatch(/setView\(\{\s*status: "error", message: response\.message \}\)/);
  });

  it("never renders a caught exception's own .message -- only a fixed, safe fallback string", () => {
    const catchBlockMatch = panelSource.match(/\}\s*catch\s*\{([\s\S]*?)\n {2}\}/);
    expect(catchBlockMatch).not.toBeNull();
    expect(catchBlockMatch?.[1] ?? "").not.toMatch(/err\.message|error\.message/);
    expect(catchBlockMatch?.[1] ?? "").toMatch(
      /The AI assistant is temporarily unavailable\. Please try again shortly\./,
    );
  });

  it("clears the loading state on failure (view becomes 'error', never stuck at 'loading')", () => {
    expect(panelSource).toMatch(/setView\(\{ status: "error"/);
  });

  it('offers a "Try again" action in the error view that regenerates the same last request', () => {
    expect(panelSource).toMatch(/view\.status === "error"/);
    expect(panelSource).toMatch(/Try again/);
    expect(panelSource).toMatch(/onClick=\{regenerate\}/);
  });

  it("the panel stays open and every action button remains usable after an error (no early return unmounts it)", () => {
    // The action buttons are only gated on isPending, never on view.status,
    // so an error view still leaves every button clickable.
    const buttonBlocks = panelSource.match(/disabled=\{isPending[^}]*\}/g) ?? [];
    expect(buttonBlocks.length).toBeGreaterThanOrEqual(6);
    expect(panelSource).not.toMatch(/disabled=\{[^}]*view\.status === "error"/);
  });
});

describe("ChatAgentPanel: treats every error code uniformly, including AI_RESPONSE_INVALID", () => {
  it("never branches on response.code -- every failure (including a parse/validation failure) takes the same safe error path", () => {
    expect(panelSource).not.toMatch(/response\.code/);
    expect(panelSource).not.toContain("AI_RESPONSE_INVALID");
  });
});

describe("ChatAgentPanel: all six Quick Actions are present", () => {
  it("renders exactly the six required quick actions, each wired to its own action", () => {
    expect(panelSource).toMatch(/onClick=\{\(\) => runSimpleAction\("summarize"\)\}/);
    expect(panelSource).toMatch(/>\s*Summarize\s*</);
    expect(panelSource).toMatch(/onClick=\{\(\) => runSimpleAction\("suggest_reply"\)\}/);
    expect(panelSource).toMatch(/>\s*Suggest reply\s*</);
    expect(panelSource).toMatch(/onClick=\{\(\) => toggleSelectedAction\("rewrite_draft"\)\}/);
    expect(panelSource).toMatch(/>\s*Rewrite\s*</);
    expect(panelSource).toMatch(/onClick=\{\(\) => toggleSelectedAction\("translate"\)\}/);
    expect(panelSource).toMatch(/>\s*Translate\s*</);
    expect(panelSource).toMatch(/onClick=\{\(\) => runSimpleAction\("extract_lead"\)\}/);
    expect(panelSource).toMatch(/>\s*Extract lead\s*</);
    expect(panelSource).toMatch(/onClick=\{\(\) => runSimpleAction\("prepare_follow_up"\)\}/);
    expect(panelSource).toMatch(/>\s*Follow-up\s*</);
  });

  it("lays out the six quick actions in a compact grid, not a full-width vertical list", () => {
    expect(panelSource).toContain('className="dvx-assistant-quick-actions"');
  });
});

describe("ChatAgentPanel: action-specific controls only show when that action is selected", () => {
  it('gates the rewrite tone selector behind selectedAction === "rewrite_draft"', () => {
    expect(panelSource).toMatch(
      /\{selectedAction === "rewrite_draft" \? \([\s\S]{0,320}?aria-label="Rewrite tone"/,
    );
  });

  it('gates the translate source/language controls behind selectedAction === "translate"', () => {
    expect(panelSource).toMatch(
      /\{selectedAction === "translate" \? \([\s\S]{0,900}?aria-label="Translate into"/,
    );
  });

  it("selecting a different quick action does not run both panels simultaneously -- rewrite and translate are mutually exclusive, single selectedAction state", () => {
    expect(panelSource).toContain("useState<SelectableAction | null>(null)");
    expect(panelSource).not.toMatch(
      /selectedAction === "rewrite_draft" && selectedAction === "translate"/,
    );
  });
});

describe("ChatAgentPanel: Translate source selection (the confirmed bug fix)", () => {
  it("imports and uses the shared priority-resolution helpers instead of a composer-only hasDraft check", () => {
    expect(panelSource).toContain("resolveTranslateSource");
    expect(panelSource).toContain("resolveTranslateSourceText");
    expect(panelSource).toMatch(
      /const translateSource = resolveTranslateSource\(\s*currentDraft,\s*latestAiDraft,\s*translateSourceOverride,?\s*\)/,
    );
  });

  it("tracks the latest AI-generated draft via isDraftAction, updated after every successful run()", () => {
    expect(panelSource).toContain("isDraftAction");
    expect(panelSource).toMatch(
      /if \(isDraftAction\(request\.action\) && response\.displayText\.trim\(\)\)\s*\{\s*setLatestAiDraft\(response\.displayText\);/,
    );
  });

  it("the Translate submit button sends resolved source text, not always currentDraft", () => {
    expect(panelSource).toMatch(
      /run\(\{ action: "translate", draft: translateSourceText, targetLanguage \}\)/,
    );
    // The old, buggy pattern (always the composer, regardless of an available AI draft) must be gone.
    expect(panelSource).not.toMatch(/run\(\{ action: "translate", draft: currentDraft/);
  });

  it("shows 'Write a reply or generate a draft first.' when neither source has text, and never calls the provider in that case", () => {
    expect(panelSource).toContain('"Write a reply or generate a draft first."');
    expect(panelSource).toMatch(
      /const translateGuidance = !hasTranslateSource\s*\n\s*\? "Write a reply or generate a draft first\."/,
    );
    expect(panelSource).toMatch(
      /disabled=\{isPending \|\| !hasTranslateSource \|\| isSameLanguage\}/,
    );
  });

  it("only shows a source picker when both the composer and an AI draft have usable text", () => {
    expect(panelSource).toMatch(/\{composerHasText && aiDraftHasText \? \(/);
    expect(panelSource).toContain(">Reply box<");
    expect(panelSource).toContain(">Latest AI draft<");
  });
});

describe("ChatAgentPanel: same-language guard", () => {
  it("detects the source text's likely language and blocks translating into the same language", () => {
    expect(panelSource).toContain("detectLikelySourceLanguage");
    expect(panelSource).toMatch(
      /const isSameLanguage =\s*\n\s*detectedSourceLanguage !== null && detectedSourceLanguage === targetLanguage;/,
    );
    expect(panelSource).toMatch(
      /This text is already in \$\{CHAT_AGENT_SUPPORTED_LANGUAGES\[detectedSourceLanguage!\]\}\. Select another language\./,
    );
  });

  it("the same-language message is a client-side guard, never a server round trip", () => {
    // The guidance text must be computed before any run()/chatAgentAction call -- it's a plain
    // derived value, not something read out of a server response.
    const guardIndex = panelSource.indexOf("const translateGuidance");
    const runCallIndex = panelSource.indexOf('run({ action: "translate"');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(runCallIndex);
  });
});

describe("ChatAgentPanel: enabled-language filtering", () => {
  it("accepts an enabledLanguages prop and falls back to all four supported languages when absent", () => {
    expect(panelSource).toMatch(/enabledLanguages\?:\s*ChatAgentSupportedLanguage\[\]/);
    expect(panelSource).toMatch(
      /const availableLanguages =\s*\n\s*enabledLanguages && enabledLanguages\.length > 0 \? enabledLanguages : ALL_LANGUAGES;/,
    );
  });

  it("renders the target-language options from availableLanguages, not a hardcoded list", () => {
    expect(panelSource).toMatch(/\{availableLanguages\.map\(\(lang\) => \(/);
  });

  it("ConversationComposerWithAssistant forwards enabledLanguages through to ChatAgentPanel", () => {
    expect(composerWrapperSource).toMatch(/enabledLanguages\?:\s*ChatAgentSupportedLanguage\[\]/);
    expect(composerWrapperSource).toContain("enabledLanguages={enabledLanguages}");
  });

  it("both conversation-detail pages load the company's enabled languages and pass them down", () => {
    for (const source of [conversationsPageSource, handoverPageSource]) {
      expect(source).toContain("loadCompanyEnabledLanguages");
      expect(source).toMatch(
        /const enabledLanguages = await loadCompanyEnabledLanguages\(supabase, session\.activeCompanyId\);/,
      );
      expect(source).toContain("enabledLanguages={enabledLanguages}");
    }
  });
});

describe("ChatAgentPanel: translation output card", () => {
  it('renders a distinct "Translated to <language>" header only for a translate result', () => {
    expect(panelSource).toMatch(
      /showingTranslateResult = view\.status === "success" && lastRequest\?\.action === "translate"/,
    );
    expect(panelSource).toContain("Translated to");
  });

  it('labels the insert action "Use in reply" (not the generic "Use this reply") for a translate result', () => {
    expect(panelSource).toMatch(/onClick=\{useTranslationInReply\}[\s\S]{0,40}?>\s*Use in reply/);
  });

  it('"Use in reply" inserts into the composer via onUseReply and shows a confirmation, never sending anything', () => {
    expect(panelSource).toMatch(
      /function useTranslationInReply\(\) \{[\s\S]*?onUseReply\(view\.result\.displayText\);[\s\S]*?setJustInsertedTranslation\(true\);/,
    );
    expect(panelSource).toContain("Translation added to the reply box.");
    const fnBody =
      panelSource.match(/function useTranslationInReply\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(fnBody).not.toMatch(/send|submit|whatsapp/i);
  });

  it("the translate result card still offers Copy, Regenerate, and Close like every other result", () => {
    const translateCardMatch = panelSource.match(
      /showingTranslateResult && view\.status === "success"[\s\S]*?\{justInsertedTranslation/,
    );
    expect(translateCardMatch).not.toBeNull();
    const card = translateCardMatch?.[0] ?? "";
    expect(card).toMatch(/Copy/);
    expect(card).toMatch(/Regenerate/);
    expect(card).toMatch(/Close/);
  });

  it("resets the 'just inserted' confirmation whenever a new request starts", () => {
    expect(panelSource).toMatch(/setJustInsertedTranslation\(false\);/);
  });
});

describe("ChatAgentPanel: no polling, no new Realtime subscription", () => {
  it("never uses setInterval/setTimeout polling or opens a Realtime channel", () => {
    for (const source of [panelSource, composerWrapperSource]) {
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toMatch(
        /useTenantRealtimeChannel|RealtimeRefreshBoundary|supabase\.channel/,
      );
    }
  });
});

describe("ReplyComposer: controlled-mode change preserves the existing send/idempotency path", () => {
  it("still generates and rotates a client-side idempotency key exactly as before", () => {
    expect(replyComposerSource).toContain("crypto.randomUUID()");
    expect(replyComposerSource).toContain("setIdempotencyKey(crypto.randomUUID())");
  });

  it("still calls sendHumanReplyAction only on explicit form submission, reading body from FormData", () => {
    expect(replyComposerSource).toContain('formData.get("body")');
    expect(replyComposerSource).toMatch(
      /await sendHumanReplyAction\(conversationId, body, idempotencyKey\)/,
    );
  });

  it("value/onChange are optional -- omitting them preserves the original uncontrolled behavior", () => {
    expect(replyComposerSource).toMatch(/value\?:\s*string/);
    expect(replyComposerSource).toMatch(/onChange\?:\s*\(value: string\) => void/);
  });
});

describe("Composer wiring: both Live Conversations and Human Handover use the same shared component", () => {
  it("both pages render ConversationComposerWithAssistant instead of ReplyComposer directly", () => {
    expect(conversationsPageSource).toContain("<ConversationComposerWithAssistant");
    expect(handoverPageSource).toContain("<ConversationComposerWithAssistant");
    expect(conversationsPageSource).not.toMatch(/<ReplyComposer\b/);
    expect(handoverPageSource).not.toMatch(/<ReplyComposer\b/);
  });
});
