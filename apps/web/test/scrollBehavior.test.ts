import { describe, expect, it } from "vitest";
import {
  BOTTOM_PROXIMITY_PX,
  bottomScrollTop,
  isNearBottom,
  scrollTopAfterPrepend,
} from "../app/dashboard/handover/[conversationId]/scrollBehavior.js";

describe("isNearBottom", () => {
  it("is true when scrolled exactly to the bottom", () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("is true within the proximity threshold", () => {
    const unscrolled = BOTTOM_PROXIMITY_PX - 1;
    expect(
      isNearBottom({
        scrollTop: 1000 - 100 - unscrolled,
        scrollHeight: 1000,
        clientHeight: 100,
      }),
    ).toBe(true);
  });

  it("is true exactly at the proximity threshold (inclusive boundary)", () => {
    expect(
      isNearBottom({
        scrollTop: 1000 - 100 - BOTTOM_PROXIMITY_PX,
        scrollHeight: 1000,
        clientHeight: 100,
      }),
    ).toBe(true);
  });

  it("is false when scrolled up to read history, beyond the threshold", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 5000, clientHeight: 400 })).toBe(false);
  });

  it("is true when there is no scrollable overflow at all (short thread)", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true);
  });

  it("respects a custom threshold override", () => {
    const metrics = { scrollTop: 700, scrollHeight: 1000, clientHeight: 100 };
    // unscrolled = 1000 - 700 - 100 = 200
    expect(isNearBottom(metrics, 200)).toBe(true);
    expect(isNearBottom(metrics, 199)).toBe(false);
  });
});

describe("bottomScrollTop", () => {
  it("returns scrollHeight minus clientHeight for a normally overflowing thread", () => {
    expect(bottomScrollTop(3000, 500)).toBe(2500);
  });

  it("never goes negative when content is shorter than the viewport", () => {
    expect(bottomScrollTop(200, 500)).toBe(0);
  });

  it("is zero when content exactly fills the viewport", () => {
    expect(bottomScrollTop(500, 500)).toBe(0);
  });
});

describe("scrollTopAfterPrepend", () => {
  it("shifts scrollTop by exactly the height the prepend added, keeping the same content on screen", () => {
    // Mirrors the task's own worked example: messages 101-150 loaded, the
    // reader is scrolled near message 101 (the top of what's currently
    // shown), then "Load older" prepends 51-100 above it. The added height
    // must be added to scrollTop so the reader stays looking at 101, not
    // rocket up to the very top (or get left at the old, now-wrong,
    // position).
    const scrollTopBefore = 40; // reader was 40px into the (now-old) top of the list
    const scrollHeightBefore = 5000;
    const scrollHeightAfter = 7000; // the older page added 2000px of content above
    expect(scrollTopAfterPrepend(scrollTopBefore, scrollHeightBefore, scrollHeightAfter)).toBe(
      2040,
    );
  });

  it("is a no-op when the prepended page adds no height (e.g. an empty older page)", () => {
    expect(scrollTopAfterPrepend(120, 5000, 5000)).toBe(120);
  });
});
