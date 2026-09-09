import { describe, expect, it, vi } from "vitest";
import { SupabaseMessageConsumerRepository } from "../src/repositories/supabaseMessageConsumerRepository.js";

/**
 * Meta/WhatsApp Batch 1 (migration 35) regression: loadConversationContext's
 * phone-number lookup must require status = "connected" in both the
 * by-conversation-id and the by-company-fallback branch, so a disabled/
 * not_connected/error mapping can never be used to send an outbound AI
 * reply.
 *
 * Extended for Meta/WhatsApp Batch 3 Slice E: loadConversationContext also
 * resolves the connected whatsapp_accounts row's own outbound-send
 * credential (conversation -> whatsapp_phone_number_id ->
 * whatsapp_phone_numbers -> whatsapp_account_id -> whatsapp_accounts),
 * required by AI outbound sends to stop using a single global token for
 * every tenant (the root cause of the first real staging AI outbound
 * failure). Still scoped narrowly to phone/account status filtering and
 * credential-row shape -- not a general-purpose test of the rest of
 * loadConversationContext's aggregation.
 */

function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => result);
  builder.maybeSingle = vi.fn(async () => result);
  return builder;
}

const BASE_CONVERSATION = {
  company_id: "company-1",
  contact_id: "contact-1",
  state: "ai_active",
  ai_mode: "auto",
  unresolved_questions: [],
  whatsapp_phone_number_id: "phone-row-1",
  contacts: { whatsapp_wa_id: "911234567890", last_detected_language: null, timezone: null },
};

const CONNECTED_MANUAL_ADMIN_ACCOUNT = {
  waba_id: "waba-1",
  connection_source: "manual_admin",
  encrypted_access_token: null,
  encryption_key_version: null,
};

function buildFrom(
  phoneNumberChain: ReturnType<typeof chain>,
  options: {
    conversation?: Record<string, unknown>;
    accountChain?: ReturnType<typeof chain>;
  } = {},
) {
  const conversation = options.conversation ?? BASE_CONVERSATION;
  const accountChain =
    options.accountChain ?? chain({ data: CONNECTED_MANUAL_ADMIN_ACCOUNT, error: null });
  const conversationChain = chain({ data: conversation, error: null });
  const companyChain = chain({
    data: { name: "Co", timezone: "Asia/Kolkata", is_demo: false },
    error: null,
  });
  const settingsChain = chain({
    data: {
      bot_name: "Bot",
      tone: "friendly",
      enabled_languages: ["en"],
      fallback_language: "en",
      restricted_topics: [],
      confidence_threshold: 0.5,
      static_fallback_message: "Let me connect you with a human.",
    },
    error: null,
  });
  const aiSettingsChain = chain({ data: { required_disclaimers: [] }, error: null });
  const voiceSettingsChain = chain({ data: { is_enabled: false }, error: null });
  const preferenceChain = chain({ data: null, error: null });
  const leadChain = chain({ data: null, error: null });
  const messagesChain = chain({ data: [], error: null });

  const from = vi.fn((table: string) => {
    switch (table) {
      case "conversations":
        return conversationChain;
      case "companies":
        return companyChain;
      case "company_settings":
        return settingsChain;
      case "ai_settings":
        return aiSettingsChain;
      case "voice_settings":
        return voiceSettingsChain;
      case "whatsapp_phone_numbers":
        return phoneNumberChain;
      case "whatsapp_accounts":
        return accountChain;
      case "contact_preferences":
        return preferenceChain;
      case "leads":
        return leadChain;
      case "messages":
        return messagesChain;
      default:
        throw new Error(`Unexpected table: ${table}`);
    }
  });

  return { from, accountChain };
}

describe("SupabaseMessageConsumerRepository.loadConversationContext phone-number status filtering", () => {
  it("resolves the phone_number_id when the mapped phone number is connected, filtering by status in the query", async () => {
    const phoneNumberChain = chain({
      data: { phone_number_id: "meta-phone-1", whatsapp_account_id: "account-1" },
      error: null,
    });
    const { from } = buildFrom(phoneNumberChain);
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    const context = await repo.loadConversationContext("conversation-1");

    expect(context.phoneNumberId).toBe("meta-phone-1");
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("throws a safe error instead of using a disabled phone mapping -- the status filter returns no row, never a stale phone_number_id", async () => {
    // Simulates the real Supabase behavior once .eq("status","connected") is
    // added: a disabled mapping simply matches zero rows.
    const phoneNumberChain = chain({ data: null, error: null });
    const { from } = buildFrom(phoneNumberChain);
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    await expect(repo.loadConversationContext("conversation-1")).rejects.toThrow(
      "No WhatsApp phone number configured for company company-1",
    );
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("also filters by status in the by-company fallback branch (no whatsapp_phone_number_id on the conversation)", async () => {
    const phoneNumberChain = chain({
      data: { phone_number_id: "meta-phone-2", whatsapp_account_id: "account-1" },
      error: null,
    });
    const conversationWithoutPhone = { ...BASE_CONVERSATION, whatsapp_phone_number_id: null };
    const { from } = buildFrom(phoneNumberChain, { conversation: conversationWithoutPhone });
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    const context = await repo.loadConversationContext("conversation-1");

    expect(context.phoneNumberId).toBe("meta-phone-2");
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("company_id", "company-1");
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("status", "connected");
  });
});

describe("SupabaseMessageConsumerRepository.loadConversationContext whatsapp account credential resolution (Meta/WhatsApp Batch 3 Slice E)", () => {
  function connectedPhoneChain(accountId = "account-1") {
    return chain({
      data: { phone_number_id: "meta-phone-1", whatsapp_account_id: accountId },
      error: null,
    });
  }

  it("resolves the credential from the connected account referenced by the phone row -- never a browser/company-supplied identifier", async () => {
    const accountChain = chain({
      data: {
        waba_id: "waba-embedded-1",
        connection_source: "embedded_signup",
        encrypted_access_token: '{"v":1,"kv":1,"iv":"AAAA","ct":"BBBB"}',
        encryption_key_version: 1,
      },
      error: null,
    });
    const { from } = buildFrom(connectedPhoneChain("account-1"), { accountChain });
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    const context = await repo.loadConversationContext("conversation-1");

    expect(context.whatsappCredential).toEqual({
      connectionSource: "embedded_signup",
      wabaId: "waba-embedded-1",
      encryptedAccessToken: '{"v":1,"kv":1,"iv":"AAAA","ct":"BBBB"}',
      encryptionKeyVersion: 1,
    });
    expect(accountChain.eq).toHaveBeenCalledWith("id", "account-1");
    expect(accountChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("resolves a manual_admin account's credential row (encryptedAccessToken/encryptionKeyVersion both null)", async () => {
    const { from } = buildFrom(connectedPhoneChain());
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    const context = await repo.loadConversationContext("conversation-1");

    expect(context.whatsappCredential).toEqual({
      connectionSource: "manual_admin",
      wabaId: "waba-1",
      encryptedAccessToken: null,
      encryptionKeyVersion: null,
    });
  });

  it("fails closed with a safe error when the phone row has no whatsapp_account_id at all", async () => {
    const phoneNumberChain = chain({
      data: { phone_number_id: "meta-phone-1", whatsapp_account_id: null },
      error: null,
    });
    const { from } = buildFrom(phoneNumberChain);
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    await expect(repo.loadConversationContext("conversation-1")).rejects.toThrow(
      "No WhatsApp account configured for company company-1",
    );
  });

  it("fails closed instead of using a disabled/not_connected/error whatsapp_accounts row -- the status filter returns no row, never a stale credential", async () => {
    const accountChain = chain({ data: null, error: null });
    const { from } = buildFrom(connectedPhoneChain(), { accountChain });
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    await expect(repo.loadConversationContext("conversation-1")).rejects.toThrow(
      "WhatsApp account account-1 is not connected for company company-1",
    );
    expect(accountChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("propagates a genuine Supabase error from the account lookup rather than swallowing it", async () => {
    const accountChain = chain({ data: null, error: { message: "connection reset" } });
    const { from } = buildFrom(connectedPhoneChain(), { accountChain });
    const repo = new SupabaseMessageConsumerRepository({ from } as never);

    await expect(repo.loadConversationContext("conversation-1")).rejects.toMatchObject({
      message: "connection reset",
    });
  });
});
