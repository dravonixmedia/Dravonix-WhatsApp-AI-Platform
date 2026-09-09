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

/**
 * Correctness fix: a real staging inbound message from a contact who had
 * previously messaged a DIFFERENT, now-superseded WhatsApp number (a
 * disabled manual_admin connection under migration 39's one-active-WABA-
 * per-company policy) got silently reattached to that old conversation --
 * which still pointed at the disabled phone -- instead of a conversation
 * bound to the number that actually received the new message. Root cause:
 * the existing-conversation lookup filtered only on company_id + contact_id
 * + state != closed, never on whatsapp_phone_number_id. Fixed by resolving
 * the inbound event's own phone row up front and requiring an exact match
 * on it in the lookup, only falling back to creating a new conversation
 * (bound to the correct phone) when no match exists for that phone.
 */
function chainMulti(results: Array<{ data: unknown; error: unknown }>) {
  const builder: Record<string, unknown> = {};
  let call = 0;
  for (const method of ["select", "eq", "neq", "is", "insert", "upsert", "update"]) {
    builder[method] = vi.fn(() => builder);
  }
  const resolve = () => results[Math.min(call, results.length - 1)]!;
  builder.single = vi.fn(async () => {
    const r = resolve();
    call += 1;
    return r;
  });
  builder.maybeSingle = vi.fn(async () => {
    const r = resolve();
    call += 1;
    return r;
  });
  // Some call sites (recordInboundMessage's conversations.update(...).eq(...))
  // await the builder directly rather than terminating with
  // single()/maybeSingle() -- make the builder itself thenable so that works.
  (builder as { then: unknown }).then = (
    onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
  ) => {
    const r = resolve();
    call += 1;
    return Promise.resolve(r).then(onFulfilled);
  };
  return builder;
}

function makeFrom(tables: Record<string, ReturnType<typeof chainMulti>>) {
  return vi.fn((table: string) => {
    const entry = tables[table];
    if (!entry) throw new Error(`Unexpected table: ${table}`);
    return entry;
  });
}

const NEW_PHONE_ROW_ID = "1b566519-cd2e-4a66-94de-114cf43a7ca1"; // Meta phone_number_id 1327624763758546
const OLD_PHONE_ROW_ID = "a226ea35-6976-41a1-92a2-4b88a4019c18"; // Meta phone_number_id 1295050510350858 (disabled)
const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

describe("SupabaseWhatsAppIngestRepository.upsertContactAndConversation", () => {
  it("item 1: same company + same contact + same phone + non-closed conversation -> reuses the existing conversation", async () => {
    const conversations = chainMulti([{ data: { id: "conv-existing" }, error: null }]);
    const from = makeFrom({
      contacts: chainMulti([{ data: { id: "contact-1" }, error: null }]),
      whatsapp_phone_numbers: chainMulti([{ data: { id: NEW_PHONE_ROW_ID }, error: null }]),
      conversations,
    });
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const result = await repo.upsertContactAndConversation({
      companyId: COMPANY_ID,
      waId: "918086552536",
      profileName: "Test User",
      phoneNumberId: "1327624763758546",
    });

    expect(result).toEqual({ contactId: "contact-1", conversationId: "conv-existing" });
    expect(conversations.eq).toHaveBeenCalledWith("whatsapp_phone_number_id", NEW_PHONE_ROW_ID);
    expect(conversations.insert).not.toHaveBeenCalled();
  });

  it("item 2 & 3: same company + same contact but a DIFFERENT (or disabled, now-superseded) phone -> does NOT reuse the old conversation, creates a new one bound to the inbound phone", async () => {
    // The lookup, scoped to the NEW phone, matches nothing -- the only
    // existing conversation for this contact belongs to the OLD phone.
    const conversations = chainMulti([
      { data: null, error: null }, // existing-conversation lookup: no match for NEW_PHONE_ROW_ID
      { data: { id: "conv-new-phone" }, error: null }, // insert result
    ]);
    const from = makeFrom({
      contacts: chainMulti([{ data: { id: "contact-1" }, error: null }]),
      whatsapp_phone_numbers: chainMulti([{ data: { id: NEW_PHONE_ROW_ID }, error: null }]),
      conversations,
    });
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const result = await repo.upsertContactAndConversation({
      companyId: COMPANY_ID,
      waId: "918086552536",
      profileName: "Test User",
      phoneNumberId: "1327624763758546",
    });

    expect(result).toEqual({ contactId: "contact-1", conversationId: "conv-new-phone" });
    expect(conversations.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: COMPANY_ID,
        contact_id: "contact-1",
        whatsapp_phone_number_id: NEW_PHONE_ROW_ID,
      }),
    );
    // Never silently reused/rewrote the old conversation bound to the old phone.
    expect(conversations.eq).not.toHaveBeenCalledWith("whatsapp_phone_number_id", OLD_PHONE_ROW_ID);
  });

  it("item 4: same phone, but the only existing conversation is closed -> creates a new conversation", async () => {
    // A closed conversation is already excluded by .neq("state","closed"),
    // so the lookup finds nothing regardless of phone.
    const conversations = chainMulti([
      { data: null, error: null },
      { data: { id: "conv-fresh" }, error: null },
    ]);
    const from = makeFrom({
      contacts: chainMulti([{ data: { id: "contact-1" }, error: null }]),
      whatsapp_phone_numbers: chainMulti([{ data: { id: NEW_PHONE_ROW_ID }, error: null }]),
      conversations,
    });
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const result = await repo.upsertContactAndConversation({
      companyId: COMPANY_ID,
      waId: "918086552536",
      profileName: "Test User",
      phoneNumberId: "1327624763758546",
    });

    expect(result.conversationId).toBe("conv-fresh");
    expect(conversations.neq).toHaveBeenCalledWith("state", "closed");
    expect(conversations.insert).toHaveBeenCalled();
  });

  it("item 5: tenant isolation unchanged -- the existing-conversation lookup is still scoped to the caller's own company_id", async () => {
    const conversations = chainMulti([{ data: { id: "conv-existing" }, error: null }]);
    const from = makeFrom({
      contacts: chainMulti([{ data: { id: "contact-1" }, error: null }]),
      whatsapp_phone_numbers: chainMulti([{ data: { id: NEW_PHONE_ROW_ID }, error: null }]),
      conversations,
    });
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    await repo.upsertContactAndConversation({
      companyId: COMPANY_ID,
      waId: "918086552536",
      profileName: "Test User",
      phoneNumberId: "1327624763758546",
    });

    expect(conversations.eq).toHaveBeenCalledWith("company_id", COMPANY_ID);
  });

  it("falls back to .is(whatsapp_phone_number_id, null) when the inbound phone_number_id has no matching phone row (defensive; should not occur once routing has already succeeded)", async () => {
    const conversations = chainMulti([
      { data: null, error: null },
      { data: { id: "conv-no-phone-row" }, error: null },
    ]);
    const from = makeFrom({
      contacts: chainMulti([{ data: { id: "contact-1" }, error: null }]),
      whatsapp_phone_numbers: chainMulti([{ data: null, error: null }]),
      conversations,
    });
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const result = await repo.upsertContactAndConversation({
      companyId: COMPANY_ID,
      waId: "918086552536",
      profileName: "Test User",
      phoneNumberId: "unknown-phone-number-id",
    });

    expect(result.conversationId).toBe("conv-no-phone-row");
    expect(conversations.is).toHaveBeenCalledWith("whatsapp_phone_number_id", null);
  });
});

describe("SupabaseWhatsAppIngestRepository.recordInboundMessage", () => {
  it("item 7: bumps conversations.last_message_at so the conversation list's sort order and unread indicator reflect this inbound message", async () => {
    const conversations = chainMulti([{ data: null, error: null }]);
    const from = makeFrom({
      messages: chainMulti([{ data: { id: "message-1" }, error: null }]),
      conversations,
    });
    const repo = new SupabaseWhatsAppIngestRepository({ from } as never);

    const result = await repo.recordInboundMessage({
      companyId: COMPANY_ID,
      conversationId: "conv-1",
      providerMessageId: "wamid.TEST",
      body: "hi",
      channelType: "text",
    });

    expect(result).toEqual({ messageId: "message-1" });
    expect(conversations.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_message_at: expect.any(String) }),
    );
    expect(conversations.eq).toHaveBeenCalledWith("id", "conv-1");
  });
});
