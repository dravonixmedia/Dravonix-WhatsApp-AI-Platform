import { describe, expect, it } from "vitest";
import { mergeLeadUpdates } from "../src/leadExtraction.js";

describe("mergeLeadUpdates", () => {
  it("adds new fields from updates into existing lead state", () => {
    const merged = mergeLeadUpdates({}, { name: "Asha", service: "Website Development" });
    expect(merged).toEqual({ name: "Asha", service: "Website Development" });
  });

  it("does not overwrite an existing field with null (never re-ask for known info)", () => {
    const merged = mergeLeadUpdates(
      { name: "Asha", budget: "50000" },
      { name: null, budget: null },
    );
    expect(merged).toEqual({ name: "Asha", budget: "50000" });
  });

  it("overwrites an existing field when the AI provides a new non-null value", () => {
    const merged = mergeLeadUpdates({ budget: "50000" }, { budget: "75000" });
    expect(merged.budget).toBe("75000");
  });

  it("returns the existing state unchanged when updates is null", () => {
    const existing = { name: "Asha" };
    expect(mergeLeadUpdates(existing, null)).toEqual(existing);
  });
});
