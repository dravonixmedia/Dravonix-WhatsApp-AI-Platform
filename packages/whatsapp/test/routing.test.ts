import { describe, expect, it } from "vitest";
import { routePhoneNumberId, type PhoneNumberRoutingRepository } from "../src/routing.js";

class FakeRoutingRepository implements PhoneNumberRoutingRepository {
  constructor(private readonly map: Record<string, string>) {}
  async resolveCompanyIdByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    return this.map[phoneNumberId] ?? null;
  }
}

describe("routePhoneNumberId", () => {
  it("routes a known phone_number_id to its owning company", async () => {
    const repo = new FakeRoutingRepository({ TEST_PHONE_NUMBER_ID: "company-a" });
    const result = await routePhoneNumberId(repo, "TEST_PHONE_NUMBER_ID");
    expect(result).toEqual({ routed: true, companyId: "company-a" });
  });

  it("marks an unknown phone_number_id as unrouted instead of guessing a default tenant", async () => {
    const repo = new FakeRoutingRepository({ TEST_PHONE_NUMBER_ID: "company-a" });
    const result = await routePhoneNumberId(repo, "SOME_OTHER_NUMBER_ID");
    expect(result).toEqual({ routed: false, companyId: null });
  });
});
