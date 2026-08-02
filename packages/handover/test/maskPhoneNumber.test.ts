import { describe, expect, it } from "vitest";
import { maskPhoneNumber } from "../src/maskPhoneNumber.js";

describe("maskPhoneNumber", () => {
  it("masks all but the last 4 digits", () => {
    expect(maskPhoneNumber("15551234567")).toBe("*******4567");
  });

  it("strips non-digit formatting before masking", () => {
    expect(maskPhoneNumber("+1 (555) 123-4567")).toBe("*******4567");
  });

  it("masks everything when there are 4 or fewer digits", () => {
    expect(maskPhoneNumber("123")).toBe("***");
    expect(maskPhoneNumber("")).toBe("");
  });
});
