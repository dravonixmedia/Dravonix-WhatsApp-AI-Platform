import { describe, expect, it } from "vitest";
import { buildMemberIdentityByUserId, resolveMemberIdentity } from "../lib/memberIdentity.js";

const USER_ID = "82000001-0000-0000-0000-00000000bfe1";

describe("resolveMemberIdentity", () => {
  it("shows the name prominently and the email as a secondary line when both are available", () => {
    const identity = resolveMemberIdentity({
      name: "Pranav Kallada",
      email: "pranavkallada.pk@gmail.com",
      userId: USER_ID,
    });
    expect(identity).toEqual({
      primary: "Pranav Kallada",
      secondary: "pranavkallada.pk@gmail.com",
    });
  });

  it("falls back to the email alone as the primary identity when no name is available", () => {
    const identity = resolveMemberIdentity({
      name: null,
      email: "pranavkallada.pk@gmail.com",
      userId: USER_ID,
    });
    expect(identity).toEqual({ primary: "pranavkallada.pk@gmail.com" });
    expect(identity.secondary).toBeUndefined();
  });

  it("falls back to the masked user id as a final resort when neither name nor email is available", () => {
    const identity = resolveMemberIdentity({ name: null, email: null, userId: USER_ID });
    expect(identity).toEqual({ primary: "User ••bfe1" });
  });

  it("never exposes the full raw user id, even in the masked fallback", () => {
    const identity = resolveMemberIdentity({ userId: USER_ID });
    expect(identity.primary).not.toContain(USER_ID);
    expect(identity.primary.length).toBeLessThan(USER_ID.length);
  });

  it("treats a whitespace-only name the same as a missing name", () => {
    const identity = resolveMemberIdentity({
      name: "   ",
      email: "pranavkallada.pk@gmail.com",
      userId: USER_ID,
    });
    expect(identity).toEqual({ primary: "pranavkallada.pk@gmail.com" });
  });

  it("never sets a secondary line identical to the primary one", () => {
    const identity = resolveMemberIdentity({
      name: "Pranav Kallada",
      email: null,
      userId: USER_ID,
    });
    expect(identity.secondary).toBeUndefined();
  });

  it("is a pure function -- identical input produces identical output", () => {
    const input = { name: "Pranav Kallada", email: "pranavkallada.pk@gmail.com", userId: USER_ID };
    expect(resolveMemberIdentity(input)).toEqual(resolveMemberIdentity(input));
  });

  it("accepts non-English/Unicode display names unchanged, not just ASCII", () => {
    const identity = resolveMemberIdentity({
      name: "Renée O'Malley-García",
      email: "renee@example.test",
      userId: USER_ID,
    });
    expect(identity.primary).toBe("Renée O'Malley-García");
  });
});

describe("buildMemberIdentityByUserId", () => {
  it("indexes list_company_member_identities rows by user_id, not member_id", () => {
    const map = buildMemberIdentityByUserId([
      { member_id: "cm-1", user_id: USER_ID, email: "halo@example.test", display_name: "Halo" },
    ]);
    expect(map.get(USER_ID)).toEqual({ email: "halo@example.test", displayName: "Halo" });
    expect(map.get("cm-1")).toBeUndefined();
  });

  it("returns an empty map for no rows", () => {
    expect(buildMemberIdentityByUserId([]).size).toBe(0);
  });

  it("last row wins when the same user_id appears twice (defensive; the RPC itself never duplicates a member)", () => {
    const map = buildMemberIdentityByUserId([
      { member_id: "cm-1", user_id: USER_ID, email: "old@example.test", display_name: "Old Name" },
      { member_id: "cm-1", user_id: USER_ID, email: "new@example.test", display_name: "New Name" },
    ]);
    expect(map.get(USER_ID)).toEqual({ email: "new@example.test", displayName: "New Name" });
  });
});
