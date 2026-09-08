import type { SupabaseClient } from "@supabase/supabase-js";
import type { RegistrationPinEnvelope } from "./embeddedSignupFlow.js";

/**
 * Service-role-backed implementation of CompleteEmbeddedSignupDeps'
 * findRegistrationPin/saveRegistrationPin, wrapping migration 39's
 * whatsapp_registration_pins table directly -- no RPC needed, since this is
 * a plain read/upsert on a table with no RLS policy for any role (same
 * "service role bypasses RLS by design" convention already used for
 * whatsapp_signup_attempts, see migration 37's own comment). `client` MUST
 * be a service_role Supabase client -- an RLS-scoped client can never see
 * or write this table at all, by design.
 */
export async function findRegistrationPin(
  client: SupabaseClient,
  phoneNumberId: string,
): Promise<RegistrationPinEnvelope | null> {
  const { data, error } = await client
    .from("whatsapp_registration_pins")
    .select("registration_pin_encrypted, registration_pin_key_version")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    encryptedPin: data.registration_pin_encrypted as string,
    keyVersion: data.registration_pin_key_version as number,
  };
}

export async function saveRegistrationPin(
  client: SupabaseClient,
  phoneNumberId: string,
  pin: RegistrationPinEnvelope,
): Promise<void> {
  const { error } = await client.from("whatsapp_registration_pins").upsert(
    {
      phone_number_id: phoneNumberId,
      registration_pin_encrypted: pin.encryptedPin,
      registration_pin_key_version: pin.keyVersion,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "phone_number_id" },
  );
  if (error) throw error;
}
