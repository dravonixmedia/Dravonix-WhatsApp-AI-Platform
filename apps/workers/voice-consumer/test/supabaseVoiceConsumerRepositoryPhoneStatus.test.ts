import { describe, expect, it, vi } from "vitest";
import { SupabaseVoiceConsumerRepository } from "../src/repositories/supabaseVoiceConsumerRepository.js";

/**
 * Meta/WhatsApp Batch 1 (migration 35) regression: loadConversationContext's
 * phone-number lookup must require status = "connected" in both the
 * by-conversation-id and the by-company-fallback branch, so a disabled/
 * not_connected/error mapping can never be used to send an outbound voice
 * reply. Scoped narrowly to that one behavior -- mirrors
 * supabaseMessageConsumerRepositoryPhoneStatus.test.ts.
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

function buildFrom(
  phoneNumberChain: ReturnType<typeof chain>,
  conversation: Record<string, unknown> = BASE_CONVERSATION,
) {
  const conversationChain = chain({ data: conversation, error: null });
  const companyChain = chain({ data: { name: "Co", timezone: "Asia/Kolkata" }, error: null });
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
  const voiceSettingsChain = chain({ data: { is_enabled: true }, error: null });
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

  return from;
}

describe("SupabaseVoiceConsumerRepository.loadConversationContext phone-number status filtering", () => {
  it("resolves the phone_number_id when the mapped phone number is connected, filtering by status in the query", async () => {
    const phoneNumberChain = chain({ data: { phone_number_id: "meta-phone-1" }, error: null });
    const from = buildFrom(phoneNumberChain);
    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    const context = await repo.loadConversationContext("conversation-1");

    expect(context.phoneNumberId).toBe("meta-phone-1");
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("throws a safe error instead of using a disabled phone mapping -- the status filter returns no row, never a stale phone_number_id", async () => {
    const phoneNumberChain = chain({ data: null, error: null });
    const from = buildFrom(phoneNumberChain);
    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    await expect(repo.loadConversationContext("conversation-1")).rejects.toThrow(
      "No WhatsApp phone number configured for company company-1",
    );
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("status", "connected");
  });

  it("also filters by status in the by-company fallback branch (no whatsapp_phone_number_id on the conversation)", async () => {
    const phoneNumberChain = chain({ data: { phone_number_id: "meta-phone-2" }, error: null });
    const conversationWithoutPhone = { ...BASE_CONVERSATION, whatsapp_phone_number_id: null };
    const from = buildFrom(phoneNumberChain, conversationWithoutPhone);
    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    const context = await repo.loadConversationContext("conversation-1");

    expect(context.phoneNumberId).toBe("meta-phone-2");
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("company_id", "company-1");
    expect(phoneNumberChain.eq).toHaveBeenCalledWith("status", "connected");
  });
});
