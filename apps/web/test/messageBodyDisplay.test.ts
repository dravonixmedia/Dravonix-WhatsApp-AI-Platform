import { describe, expect, it } from "vitest";
import type { ConversationThreadMessage } from "@dravonix/handover";
import { resolveMessageBodyDisplay } from "../app/dashboard/handover/[conversationId]/messageBodyDisplay.js";

/**
 * Guards ConversationThread's rendering of a message's body (staging
 * incident: an inbound audio message with a null body -- transcript never
 * recorded -- rendered as a completely empty card, with only the
 * "customer · audio · <timestamp>" header line visible, and no player, no
 * duration, and no processing/error indicator). resolveMessageBodyDisplay is
 * the single place this decision is made, so these tests lock in the two
 * required properties: a real transcript/text body always renders verbatim,
 * and a missing audio transcript always renders an explicit, non-empty
 * placeholder instead of silently rendering nothing.
 */

function baseMessage(
  overrides: Partial<ConversationThreadMessage> = {},
): ConversationThreadMessage {
  return {
    id: "msg-1",
    direction: "inbound",
    channelType: "text",
    senderType: "customer",
    senderMemberId: null,
    body: null,
    outboundStatus: null,
    providerMessageId: null,
    createdAt: new Date().toISOString(),
    mediaFileId: null,
    mediaMimeType: null,
    mediaDurationSeconds: null,
    ...overrides,
  };
}

describe("resolveMessageBodyDisplay", () => {
  it("renders the transcript verbatim once it has been recorded", () => {
    const message = baseMessage({
      channelType: "audio",
      body: "എന്‍റെ company ക്ക് വേണ്ടിട്ട് monthly നാല് video ചെയ്യുന്നതിന് എത്ര രൂപയാവും?",
    });
    expect(resolveMessageBodyDisplay(message)).toBe(message.body);
  });

  it("renders an explicit placeholder for an inbound audio message with no transcript yet, never an empty string", () => {
    const message = baseMessage({ channelType: "audio", direction: "inbound", body: null });
    const displayed = resolveMessageBodyDisplay(message);
    expect(displayed.length).toBeGreaterThan(0);
    expect(displayed).toMatch(/voice message/i);
    expect(displayed).toMatch(/not available/i);
  });

  it("renders a distinct placeholder for an outbound voice reply with no transcript recorded", () => {
    const message = baseMessage({ channelType: "audio", direction: "outbound", body: null });
    const displayed = resolveMessageBodyDisplay(message);
    expect(displayed.length).toBeGreaterThan(0);
    expect(displayed).toMatch(/voice reply/i);
  });

  it("also treats an empty (whitespace-only) body as missing, not as an empty transcript", () => {
    const message = baseMessage({ channelType: "audio", body: "   " });
    expect(resolveMessageBodyDisplay(message)).toMatch(/not available/i);
  });

  it("falls back to a generic placeholder for a non-audio message with no body", () => {
    const message = baseMessage({ channelType: "system", body: null });
    expect(resolveMessageBodyDisplay(message)).toBe("(no message content)");
  });
});
