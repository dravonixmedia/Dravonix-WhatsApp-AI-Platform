import { describe, expect, it } from "vitest";
import { formatBadgeCount, NOTIFICATION_BADGE_DISPLAY_CAP } from "../lib/notificationBadge.js";

describe("formatBadgeCount", () => {
  it("shows the exact count under the cap", () => {
    expect(formatBadgeCount(3)).toBe("3");
  });

  it("caps the visible label at 99+ above the display cap", () => {
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(1000)).toBe("99+");
  });

  it("shows the exact count at the cap boundary", () => {
    expect(formatBadgeCount(NOTIFICATION_BADGE_DISPLAY_CAP)).toBe("99");
  });

  it("shows 0 for a zero count -- callers hide the badge entirely rather than rendering this", () => {
    expect(formatBadgeCount(0)).toBe("0");
  });
});
