import { describe, expect, it } from "vitest";
import { listSupportedTimezones } from "../lib/timezoneList.js";

describe("listSupportedTimezones", () => {
  it("returns far more than one option (not a Kolkata-only list)", () => {
    const zones = listSupportedTimezones();
    expect(zones.length).toBeGreaterThan(1);
    // Not a brittle snapshot of the entire IANA list -- just a sanity floor
    // proving this is the full runtime-supported set, not a short hardcoded
    // fallback (Intl.supportedValuesOf("timeZone") returns 400+ zones on
    // any modern engine).
    expect(zones.length).toBeGreaterThan(50);
  });

  it("includes every timezone explicitly named in the product spec", () => {
    const zones = listSupportedTimezones();
    for (const required of [
      "Asia/Kolkata",
      "Asia/Dubai",
      "Asia/Kathmandu",
      "Europe/London",
      "Europe/Berlin",
      "America/New_York",
      "America/Los_Angeles",
      "America/Toronto",
      "Australia/Sydney",
      "Pacific/Auckland",
    ]) {
      expect(zones).toContain(required);
    }
  });

  it("returns real IANA identifiers, never a bare UTC offset or a friendly city name alone", () => {
    const zones = listSupportedTimezones();
    for (const zone of zones) {
      expect(zone).not.toMatch(/^[+-]\d{2}:?\d{2}$/);
      expect(zone).not.toBe("GMT+4");
      expect(zone).not.toBe("Dubai");
    }
  });
});
