import { describe, expect, it } from "vitest";
import { computeRetentionExpiry, selectExpiredMedia } from "../src/retention.js";

describe("computeRetentionExpiry", () => {
  it("adds the retention day count to the created date", () => {
    const created = new Date("2026-01-01T00:00:00.000Z");
    expect(computeRetentionExpiry(created, 30).toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});

describe("selectExpiredMedia", () => {
  const now = new Date("2026-01-31T00:00:00.000Z");

  it("selects only candidates whose retention has expired", () => {
    const candidates = [
      {
        mediaFileId: "1",
        storageKey: "k1",
        retentionExpiresAt: new Date("2026-01-30T00:00:00.000Z"),
      },
      {
        mediaFileId: "2",
        storageKey: "k2",
        retentionExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];
    const expired = selectExpiredMedia(candidates, now);
    expect(expired.map((c) => c.mediaFileId)).toEqual(["1"]);
  });

  it("includes a candidate expiring exactly now", () => {
    const candidates = [{ mediaFileId: "1", storageKey: "k1", retentionExpiresAt: now }];
    expect(selectExpiredMedia(candidates, now)).toHaveLength(1);
  });
});
