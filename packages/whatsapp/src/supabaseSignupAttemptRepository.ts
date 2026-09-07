import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimSignupAttemptInput,
  CompleteSignupAttemptInput,
  CompleteSignupAttemptResult,
  CreateSignupAttemptInput,
  SignupAttemptRepository,
} from "./embeddedSignupFlow.js";

/**
 * Service-role-backed implementation of SignupAttemptRepository, wrapping
 * migration 37's three service_role-only RPCs
 * (create_whatsapp_signup_attempt/claim_whatsapp_signup_attempt/
 * complete_whatsapp_signup) verbatim. `client` MUST be a service_role
 * Supabase client -- these RPCs are revoked from `authenticated`/`anon`
 * entirely, so an RLS-scoped client would fail with a permission error on
 * every call here, not silently behave differently.
 */
export class SupabaseSignupAttemptRepository implements SignupAttemptRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createAttempt(input: CreateSignupAttemptInput): Promise<{ id: string; expiresAt: string }> {
    const { data, error } = await this.client
      .rpc("create_whatsapp_signup_attempt", {
        p_company_id: input.companyId,
        p_initiated_by_user_id: input.initiatedByUserId,
        p_nonce_hash: input.nonceHash,
        p_expires_at: input.expiresAt,
      })
      .single();
    if (error) throw error;
    const row = data as { id: string; expires_at: string };
    return { id: row.id, expiresAt: row.expires_at };
  }

  async claimAttempt(input: ClaimSignupAttemptInput): Promise<void> {
    const { error } = await this.client
      .rpc("claim_whatsapp_signup_attempt", {
        p_attempt_id: input.attemptId,
        p_company_id: input.companyId,
        p_nonce_hash: input.nonceHash,
      })
      .single();
    if (error) throw error;
  }

  async completeAttempt(input: CompleteSignupAttemptInput): Promise<CompleteSignupAttemptResult> {
    const { data, error } = await this.client
      .rpc("complete_whatsapp_signup", {
        p_attempt_id: input.attemptId,
        p_company_id: input.companyId,
        p_waba_id: input.wabaId,
        p_phone_number_id: input.phoneNumberId,
        p_meta_business_id: input.metaBusinessId,
        p_business_name: input.businessName,
        p_display_phone_number: input.displayPhoneNumber,
        p_encrypted_token: input.encryptedToken,
        p_encryption_key_version: input.encryptionKeyVersion,
        p_token_expires_at: input.tokenExpiresAt,
      })
      .single();
    if (error) throw error;
    const row = data as { whatsapp_account_id: string; whatsapp_phone_number_id: string };
    return {
      whatsappAccountId: row.whatsapp_account_id,
      whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    };
  }
}
