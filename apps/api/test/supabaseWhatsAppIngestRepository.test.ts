import { describe, expect, it, vi } from "vitest";
import { SupabaseWhatsAppIngestRepository } from "../src/repositories/supabaseWhatsAppIngestRepository.js";

/**
 * Meta/WhatsApp Batch 1 (migration 35) regression: inbound routing must only
 * ever resolve a company for a phone_number_id whose mapping is currently
 * "connected" -- a disabled/not_connected/error mapping must fall through
 * to the same safe "unrouted" behavior as a genuinely unknown
 * phone_number_id (routePhoneNumberId/handleSingleEvent in
 * apps/api/src/whatsappWebhookHandler.ts), never guessing or reusing a
 * stale tenant mapping.
 */

function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => result);
  return builder;
}

describe("SupabaseWhatsAppIngestRepository.resolveCompanyIdByPhoneNumberId", () => {
  it("resolves the owning company_id for a connected phone mapping, filtering by status in the query", async () => {
    const phoneChain = chain({ data: { company_id: "company-1" }, error: null });
    const from = vi.fn(() => phoneChain);
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const companyId = await repo.resolveCompanyIdByPhoneNumberId("meta-phone-1");

    expect(companyId).toBe("company-1");
    expect(phoneChain.eq).toHaveBeenCalledWith("phone_number_id", "meta-phone-1");
    expect(phoneChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("returns null (unrouted) for a disabled phone mapping -- never reuses the last-known company_id for a disconnected number", async () => {
    // Simulates the real Supabase behavior once .eq("status","connected") is
    // added: a disabled mapping simply matches zero rows, exactly like a
    // genuinely unknown phone_number_id.
    const phoneChain = chain({ data: null, error: null });
    const from = vi.fn(() => phoneChain);
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const companyId = await repo.resolveCompanyIdByPhoneNumberId("disabled-phone-1");

    expect(companyId).toBeNull();
    expect(phoneChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("returns null (unrouted) for a genuinely unknown phone_number_id, unchanged from before this batch", async () => {
    const phoneChain = chain({ data: null, error: null });
    const from = vi.fn(() => phoneChain);
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const companyId = await repo.resolveCompanyIdByPhoneNumberId("unknown-phone");

    expect(companyId).toBeNull();
  });
});
