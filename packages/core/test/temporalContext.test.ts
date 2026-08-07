import { describe, expect, it } from "vitest";
import { resolveConversationTemporalContext } from "../src/temporalContext.js";

describe("resolveConversationTemporalContext", () => {
  it("resolves both sides when company and customer share the same timezone", () => {
    const now = new Date("2026-06-10T04:00:00.000Z"); // 09:30 IST
    const ctx = resolveConversationTemporalContext({
      companyTimezone: "Asia/Kolkata",
      customerTimezone: "Asia/Kolkata",
      now,
    });
    expect(ctx.company.timezone).toBe("Asia/Kolkata");
    expect(ctx.customer.timezone).toBe("Asia/Kolkata");
    expect(ctx.customer.timezoneKnown).toBe(true);
    expect(ctx.company.localTime).toBe(ctx.customer.localTime);
    expect(ctx.company.daypart).toBe(ctx.customer.daypart);
    expect(ctx.nowUtc).toBe(now.toISOString());
  });

  it("resolves company and customer independently when their timezones differ (Dubai vs London)", () => {
    // 2026-06-10T10:00:00Z -> Dubai 14:00 (+04:00, afternoon), London 11:00 (+01:00 BST, morning)
    const now = new Date("2026-06-10T10:00:00.000Z");
    const ctx = resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: "Europe/London",
      now,
    });
    expect(ctx.company.timezone).toBe("Asia/Dubai");
    expect(ctx.company.localTime).toBe("14:00");
    expect(ctx.company.daypart).toBe("afternoon");
    expect(ctx.customer.timezone).toBe("Europe/London");
    expect(ctx.customer.localTime).toBe("11:00");
    expect(ctx.customer.daypart).toBe("morning");
    expect(ctx.company.daypart).not.toBe(ctx.customer.daypart);
  });

  it("never falls back customer timezone to company timezone when customer timezone is unknown", () => {
    const ctx = resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: null,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    expect(ctx.customer.timezone).toBeNull();
    expect(ctx.customer.timezoneKnown).toBe(false);
    expect(ctx.customer.localDate).toBeUndefined();
    expect(ctx.customer.localTime).toBeUndefined();
    expect(ctx.customer.daypart).toBeUndefined();
    // Company side is still fully resolved and NOT equal to customer's (which has no values at all).
    expect(ctx.company.timezone).toBe("Asia/Dubai");
    expect(ctx.company.localTime).toBeDefined();
  });

  it("treats an invalid stored customer timezone the same as unknown", () => {
    const ctx = resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: "Not/A/Zone",
      now: new Date(),
    });
    expect(ctx.customer.timezone).toBeNull();
    expect(ctx.customer.timezoneKnown).toBe(false);
  });

  it("falls back company context to UTC internally when company timezone is missing, but still reports timezone: null to surface the gap", () => {
    const now = new Date("2026-06-10T10:00:00.000Z");
    const ctx = resolveConversationTemporalContext({
      companyTimezone: null,
      customerTimezone: null,
      now,
    });
    expect(ctx.company.timezone).toBeNull();
    // Local date/time are still populated (computed via the UTC fallback),
    // so the fallback is genuinely usable, not just a null placeholder.
    expect(ctx.company.localDate).toBe("2026-06-10");
    expect(ctx.company.localTime).toBe("10:00");
    expect(ctx.company.utcOffset).toBe("+00:00");
  });

  it("treats an invalid stored company timezone the same as missing (UTC fallback, timezone reported null)", () => {
    const ctx = resolveConversationTemporalContext({
      companyTimezone: "Not/A/Zone",
      customerTimezone: null,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    expect(ctx.company.timezone).toBeNull();
    expect(ctx.company.localDate).toBe("2026-06-10");
  });

  it("midnight-boundary: company and customer 'today' can legitimately be different calendar days", () => {
    // 2026-03-06T23:30:00Z: America/New_York is still 2026-03-06 (Friday),
    // Asia/Kolkata is already 2026-03-07 (Saturday). Each side's today/
    // tomorrow/yesterday must reflect only its own local calendar.
    const now = new Date("2026-03-06T23:30:00.000Z");
    const ctx = resolveConversationTemporalContext({
      companyTimezone: "America/New_York",
      customerTimezone: "Asia/Kolkata",
      now,
    });
    expect(ctx.company.localDate).toBe("2026-03-06");
    expect(ctx.customer.localDate).toBe("2026-03-07");
    expect(ctx.company.localDate).not.toBe(ctx.customer.localDate);
  });
});
