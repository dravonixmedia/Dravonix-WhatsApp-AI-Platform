import { describe, expect, it } from "vitest";
import { deriveAiLikelyProcessing, deriveUnreadCount, derivePriority } from "../src/priority.js";

const NOW = new Date("2026-08-02T12:00:00Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("derivePriority", () => {
  it("is high for an unassigned handover waiting 30+ minutes", () => {
    expect(derivePriority("handover_requested", minutesAgo(31), NOW)).toBe("high");
  });

  it("is medium for a queued handover waiting 10-29 minutes", () => {
    expect(derivePriority("queued_for_agent", minutesAgo(15), NOW)).toBe("medium");
  });

  it("is low for a handover waiting under 10 minutes", () => {
    expect(derivePriority("handover_requested", minutesAgo(2), NOW)).toBe("low");
  });

  it("is always low once a human is actively assisting, regardless of age", () => {
    expect(derivePriority("human_active", minutesAgo(120), NOW)).toBe("low");
  });

  it("is always low for ai_active/paused/closed, regardless of age", () => {
    for (const state of ["ai_active", "paused", "closed"] as const) {
      expect(derivePriority(state, minutesAgo(120), NOW)).toBe("low");
    }
  });
});

describe("deriveUnreadCount", () => {
  it("counts every inbound message when the conversation has never been read", () => {
    expect(deriveUnreadCount([minutesAgo(10), minutesAgo(5), minutesAgo(1)], null)).toBe(3);
  });

  it("counts only inbound messages strictly after the last read timestamp", () => {
    const lastRead = minutesAgo(6);
    expect(deriveUnreadCount([minutesAgo(10), minutesAgo(5), minutesAgo(1)], lastRead)).toBe(2);
  });

  it("is zero when every inbound message predates the last read timestamp", () => {
    const lastRead = minutesAgo(1);
    expect(deriveUnreadCount([minutesAgo(10), minutesAgo(5)], lastRead)).toBe(0);
  });
});

describe("deriveAiLikelyProcessing", () => {
  it("is false when ai_mode is paused", () => {
    expect(
      deriveAiLikelyProcessing({
        aiMode: "paused",
        latestInboundAt: minutesAgo(1),
        latestAiOutboundAt: null,
      }),
    ).toBe(false);
  });

  it("is false when there has never been an inbound message", () => {
    expect(
      deriveAiLikelyProcessing({
        aiMode: "active",
        latestInboundAt: null,
        latestAiOutboundAt: null,
      }),
    ).toBe(false);
  });

  it("is true when the latest inbound message has no AI reply yet", () => {
    expect(
      deriveAiLikelyProcessing({
        aiMode: "active",
        latestInboundAt: minutesAgo(1),
        latestAiOutboundAt: null,
      }),
    ).toBe(true);
  });

  it("is true when the latest inbound message is newer than the latest AI reply", () => {
    expect(
      deriveAiLikelyProcessing({
        aiMode: "active",
        latestInboundAt: minutesAgo(1),
        latestAiOutboundAt: minutesAgo(5),
      }),
    ).toBe(true);
  });

  it("is false once the latest AI reply is newer than the latest inbound message", () => {
    expect(
      deriveAiLikelyProcessing({
        aiMode: "active",
        latestInboundAt: minutesAgo(5),
        latestAiOutboundAt: minutesAgo(1),
      }),
    ).toBe(false);
  });
});
