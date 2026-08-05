import { describe, expect, it } from "vitest";
import { initialsFor } from "../app/dashboard/Avatar.js";

describe("initialsFor", () => {
  it("derives two initials from a two-word name", () => {
    expect(initialsFor("Arun Raj")).toBe("AR");
  });

  it("derives initials from an email's local part when no display name is given", () => {
    expect(initialsFor("arun.raj@example.com")).toBe("AR");
  });

  it("falls back to the first two characters for a single unbroken word", () => {
    expect(initialsFor("dravonixmedia@gmail.com")).toBe("DR");
  });

  it("returns a placeholder for an empty label rather than throwing", () => {
    expect(initialsFor("")).toBe("?");
    expect(initialsFor("   ")).toBe("?");
  });
});
