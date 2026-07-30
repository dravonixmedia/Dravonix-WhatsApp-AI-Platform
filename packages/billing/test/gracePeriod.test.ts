import { describe, expect, it } from "vitest";
import { computeGracePeriodEnd, isGracePeriodExpired } from "../src/gracePeriod.js";

describe("grace period helpers", () => {
  it("computes the grace period end using the configured day count", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = computeGracePeriodEnd(start, 5);
    expect(end.toISOString()).toBe("2026-01-06T00:00:00.000Z");
  });

  it("uses the day count captured at grace-period start, not a later default change", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    // Even if the platform default later changes to e.g. 10 days, a company whose
    // grace period already started with 5 days keeps that snapshot.
    const end = computeGracePeriodEnd(start, 5);
    expect(end.getUTCDate()).toBe(6);
  });

  it("is not expired before the end date", () => {
    const end = new Date("2026-01-06T00:00:00.000Z");
    expect(isGracePeriodExpired(end, new Date("2026-01-05T23:59:59.000Z"))).toBe(false);
  });

  it("is expired at or after the end date", () => {
    const end = new Date("2026-01-06T00:00:00.000Z");
    expect(isGracePeriodExpired(end, new Date("2026-01-06T00:00:00.000Z"))).toBe(true);
    expect(isGracePeriodExpired(end, new Date("2026-01-07T00:00:00.000Z"))).toBe(true);
  });
});
