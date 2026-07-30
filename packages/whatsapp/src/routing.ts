/**
 * Resolves a Meta `phone_number_id` to the company that owns it. Kept as an
 * interface so the webhook route (apps/api) can supply a Supabase-backed
 * implementation while tests supply an in-memory one -- see ADR-0002.
 */
export interface PhoneNumberRoutingRepository {
  resolveCompanyIdByPhoneNumberId(phoneNumberId: string): Promise<string | null>;
}

export interface RoutingResult {
  routed: boolean;
  companyId: string | null;
}

/**
 * Never throws for an unknown phone_number_id -- the caller is expected to
 * store the event with status "unrouted" for admin visibility rather than
 * dropping it or guessing a default tenant (Master Prompt section 10).
 */
export async function routePhoneNumberId(
  repo: PhoneNumberRoutingRepository,
  phoneNumberId: string,
): Promise<RoutingResult> {
  const companyId = await repo.resolveCompanyIdByPhoneNumberId(phoneNumberId);
  return { routed: companyId !== null, companyId };
}
