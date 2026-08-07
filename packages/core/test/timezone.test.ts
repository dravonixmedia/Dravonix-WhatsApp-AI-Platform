import { describe, expect, it } from "vitest";
import {
  buildZonedTemporalContext,
  isValidIanaTimezone,
  normalizeTimezone,
  resolveDaypart,
} from "../src/timezone.js";

describe("isValidIanaTimezone", () => {
  it("accepts real IANA identifiers across regions", () => {
    for (const tz of [
      "Asia/Kolkata",
      "Asia/Dubai",
      "Europe/London",
      "America/New_York",
      "Asia/Kathmandu",
      "Australia/Sydney",
      "UTC",
    ]) {
      expect(isValidIanaTimezone(tz)).toBe(true);
    }
  });

  it("rejects nonsense/invalid input", () => {
    for (const bad of ["", "Not/A/Zone", "Mars/Colony", "  ", 123 as never]) {
      expect(isValidIanaTimezone(bad as string)).toBe(false);
    }
  });

  it("rejects bare numeric UTC offsets even though some engines can technically resolve them -- offsets are not a valid permanent timezone identity", () => {
    for (const offsetLike of ["UTC+5:30", "GMT+4", "+05:30", "-04:00", "utc-8"]) {
      expect(isValidIanaTimezone(offsetLike)).toBe(false);
    }
  });
});

describe("normalizeTimezone", () => {
  it("returns the trimmed value for a valid timezone", () => {
    expect(normalizeTimezone("  Asia/Kolkata  ")).toBe("Asia/Kolkata");
  });

  it("returns null for invalid or missing input", () => {
    expect(normalizeTimezone("Not/A/Zone")).toBeNull();
    expect(normalizeTimezone(null)).toBeNull();
    expect(normalizeTimezone(undefined)).toBeNull();
    expect(normalizeTimezone("")).toBeNull();
  });
});

describe("resolveDaypart boundaries", () => {
  const cases: Array<[number, number, string]> = [
    [4, 59, "night"],
    [5, 0, "morning"],
    [11, 59, "morning"],
    [12, 0, "afternoon"],
    [16, 59, "afternoon"],
    [17, 0, "evening"],
    [20, 59, "evening"],
    [21, 0, "night"],
  ];

  for (const [hour, minute, expected] of cases) {
    it(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} -> ${expected}`, () => {
      expect(resolveDaypart(hour, minute)).toBe(expected);
    });
  }
});

describe("buildZonedTemporalContext", () => {
  it("returns null for an invalid timezone instead of throwing", () => {
    expect(buildZonedTemporalContext({ timezone: "Not/A/Zone", now: new Date() })).toBeNull();
  });

  it("computes local date/time/daypart for a known instant (UTC noon in Asia/Kolkata = +05:30)", () => {
    // 2026-01-15T12:00:00Z -> 2026-01-15 17:30 IST (Thursday, evening)
    const now = new Date("2026-01-15T12:00:00.000Z");
    const ctx = buildZonedTemporalContext({ timezone: "Asia/Kolkata", now });
    expect(ctx).not.toBeNull();
    expect(ctx?.timezone).toBe("Asia/Kolkata");
    expect(ctx?.localDate).toBe("2026-01-15");
    expect(ctx?.localTime).toBe("17:30");
    expect(ctx?.dayOfWeek).toBe("Thursday");
    expect(ctx?.daypart).toBe("evening");
    expect(ctx?.utcOffset).toBe("+05:30");
    expect(ctx?.today).toBe("2026-01-15");
    expect(ctx?.tomorrow).toBe("2026-01-16");
    expect(ctx?.yesterday).toBe("2026-01-14");
  });

  it("half-hour offset: Asia/Kolkata (+05:30)", () => {
    const ctx = buildZonedTemporalContext({
      timezone: "Asia/Kolkata",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(ctx?.utcOffset).toBe("+05:30");
    expect(ctx?.localTime).toBe("05:30");
  });

  it("quarter-hour offset: Asia/Kathmandu (+05:45)", () => {
    const ctx = buildZonedTemporalContext({
      timezone: "Asia/Kathmandu",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(ctx?.utcOffset).toBe("+05:45");
    expect(ctx?.localTime).toBe("05:45");
  });

  it("same UTC instant can fall on different local calendar days in different zones", () => {
    // 2026-03-06T23:30:00Z is still Friday in UTC/London but already
    // Saturday in Kolkata (+05:30) -- exactly the midnight-boundary case
    // "today"/"tomorrow" must never conflate across timezones.
    const now = new Date("2026-03-06T23:30:00.000Z");
    const london = buildZonedTemporalContext({ timezone: "Europe/London", now });
    const kolkata = buildZonedTemporalContext({ timezone: "Asia/Kolkata", now });
    expect(london?.localDate).toBe("2026-03-06");
    expect(london?.dayOfWeek).toBe("Friday");
    expect(kolkata?.localDate).toBe("2026-03-07");
    expect(kolkata?.dayOfWeek).toBe("Saturday");
  });

  describe("DST transitions", () => {
    it("Europe/London: before and after the spring-forward transition (2026-03-29 01:00 UTC)", () => {
      const beforeDst = buildZonedTemporalContext({
        timezone: "Europe/London",
        now: new Date("2026-03-29T00:30:00.000Z"), // still GMT (+00:00)
      });
      const afterDst = buildZonedTemporalContext({
        timezone: "Europe/London",
        now: new Date("2026-03-29T02:00:00.000Z"), // now BST (+01:00)
      });
      expect(beforeDst?.utcOffset).toBe("+00:00");
      expect(afterDst?.utcOffset).toBe("+01:00");
      // Local calendar date/tomorrow/yesterday stay correct across the jump.
      expect(afterDst?.localDate).toBe("2026-03-29");
      expect(afterDst?.tomorrow).toBe("2026-03-30");
      expect(afterDst?.yesterday).toBe("2026-03-28");
    });

    it("America/New_York: before and after the spring-forward transition (2026-03-08 07:00 UTC)", () => {
      const beforeDst = buildZonedTemporalContext({
        timezone: "America/New_York",
        now: new Date("2026-03-08T06:30:00.000Z"), // EST (-05:00)
      });
      const afterDst = buildZonedTemporalContext({
        timezone: "America/New_York",
        now: new Date("2026-03-08T08:00:00.000Z"), // EDT (-04:00)
      });
      expect(beforeDst?.utcOffset).toBe("-05:00");
      expect(afterDst?.utcOffset).toBe("-04:00");
      expect(afterDst?.localDate).toBe("2026-03-08");
      expect(afterDst?.daypart).toBeDefined();
    });
  });
});
