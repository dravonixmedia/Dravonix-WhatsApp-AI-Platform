import { describe, expect, it } from "vitest";
import { deriveEffectiveStatus } from "../src/statusReconciliation.js";

describe("deriveEffectiveStatus", () => {
  it("returns null for no events", () => {
    expect(deriveEffectiveStatus([])).toBeNull();
  });

  it("returns the single event when only one has arrived", () => {
    expect(deriveEffectiveStatus(["sent"])).toBe("sent");
  });

  it("progresses sent -> delivered -> read in normal order", () => {
    expect(deriveEffectiveStatus(["sent", "delivered", "read"])).toBe("read");
  });

  it("does not regress when a lower-ranked status arrives out of order after a higher one", () => {
    expect(deriveEffectiveStatus(["read", "delivered"])).toBe("read");
  });

  it("handles read arriving before delivered (out-of-order webhook delivery)", () => {
    expect(deriveEffectiveStatus(["read", "sent"])).toBe("read");
  });

  it("always resolves to failed once a failure event is present, regardless of order", () => {
    expect(deriveEffectiveStatus(["sent", "delivered", "failed"])).toBe("failed");
    expect(deriveEffectiveStatus(["failed", "sent"])).toBe("failed");
  });
});
