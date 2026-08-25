import { describe, expect, it } from "vitest";
import { formatDateTime, resolveDisplayTimezone } from "../lib/formatDateTime.js";

/**
 * The bug this fixes: Server Components render inside the Cloudflare
 * Worker, whose host runtime default timezone is UTC. A bare
 * `.toLocaleString()` there formats in UTC no matter who's viewing it. This
 * file proves formatDateTime converts correctly for real company timezones
 * instead of silently defaulting to the host's UTC clock.
 */

const SAMPLE_UTC = "2026-08-25T04:25:03Z";

describe("formatDateTime", () => {
  it("converts a UTC timestamp to Asia/Kolkata (UTC+5:30) -- ~9:55 AM", () => {
    const result = formatDateTime(SAMPLE_UTC, "Asia/Kolkata");
    expect(result).toContain("25");
    expect(result).toContain("2026");
    expect(result).toMatch(/9:55\s*AM/i);
  });

  it("converts the same UTC timestamp to Asia/Dubai (UTC+4) -- ~8:25 AM", () => {
    const result = formatDateTime(SAMPLE_UTC, "Asia/Dubai");
    expect(result).toMatch(/8:25\s*AM/i);
  });

  it("converts the same UTC timestamp to Europe/London (BST, UTC+1 in August) -- ~5:25 AM", () => {
    const result = formatDateTime(SAMPLE_UTC, "Europe/London");
    expect(result).toMatch(/5:25\s*AM/i);
  });

  it("falls back to UTC when no timezone is given", () => {
    const result = formatDateTime(SAMPLE_UTC, null);
    expect(result).toMatch(/4:25\s*AM/i);
  });

  it("falls back to UTC when the timezone is an empty string", () => {
    const result = formatDateTime(SAMPLE_UTC, "");
    expect(result).toMatch(/4:25\s*AM/i);
  });

  it("falls back to UTC for an invalid/unrecognized IANA timezone", () => {
    const result = formatDateTime(SAMPLE_UTC, "Not/A_Real_Zone");
    expect(result).toMatch(/4:25\s*AM/i);
  });

  it("returns a safe placeholder for a missing timestamp", () => {
    expect(formatDateTime(null, "Asia/Kolkata")).toBe("--");
    expect(formatDateTime(undefined, "Asia/Kolkata")).toBe("--");
    expect(formatDateTime("", "Asia/Kolkata")).toBe("--");
  });

  it("returns a safe placeholder for an invalid timestamp string, never throwing", () => {
    expect(() => formatDateTime("not-a-date", "Asia/Kolkata")).not.toThrow();
    expect(formatDateTime("not-a-date", "Asia/Kolkata")).toBe("--");
  });

  it("accepts a Date instance directly, not just an ISO string", () => {
    const result = formatDateTime(new Date(SAMPLE_UTC), "Asia/Kolkata");
    expect(result).toMatch(/9:55\s*AM/i);
  });
});

describe("resolveDisplayTimezone", () => {
  it("returns the given timezone when it is a valid IANA identifier", () => {
    expect(resolveDisplayTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("falls back to UTC for null/undefined/empty/invalid input", () => {
    expect(resolveDisplayTimezone(null)).toBe("UTC");
    expect(resolveDisplayTimezone(undefined)).toBe("UTC");
    expect(resolveDisplayTimezone("")).toBe("UTC");
    expect(resolveDisplayTimezone("Definitely/Not_Real")).toBe("UTC");
  });
});
