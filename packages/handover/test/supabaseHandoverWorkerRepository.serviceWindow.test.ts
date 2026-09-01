import { describe, expect, it, vi } from "vitest";
import { SupabaseHandoverWorkerRepository } from "../src/repositories/supabaseHandoverWorkerRepository.js";

/**
 * Meta/WhatsApp Batch 2: getServiceWindowState resolves through four
 * sequential, explicit queries (messages -> conversations -> messages ->
 * whatsapp_phone_numbers -> whatsapp_accounts -> whatsapp_templates) rather
 * than one PostgREST embedded-resource select, since whatsapp_templates has
 * two distinct FK relationships to whatsapp_accounts that an embed cannot
 * disambiguate. This test drives every branch: a resolved, approved
 * fallback template; a configured-but-no-longer-approved template (must be
 * treated as absent); and no phone number mapped to the conversation at all
 * (must short-circuit without querying whatsapp_accounts/whatsapp_templates).
 */

function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => result);
  builder.maybeSingle = vi.fn(async () => result);
  return builder;
}

describe("SupabaseHandoverWorkerRepository.getServiceWindowState", () => {
  it("resolves the last inbound customer message and an approved fallback template", async () => {
    const fromMock = vi
      .fn()
      // messages: resolve conversation_id from the source message
      .mockReturnValueOnce(chain({ data: { conversation_id: "conv-1" }, error: null }))
      // conversations: resolve whatsapp_phone_number_id
      .mockReturnValueOnce(
        chain({ data: { whatsapp_phone_number_id: "phone-row-1" }, error: null }),
      )
      // messages: most recent qualifying inbound customer message
      .mockReturnValueOnce(chain({ data: { created_at: "2026-09-01T10:00:00.000Z" }, error: null }))
      // whatsapp_phone_numbers: resolve whatsapp_account_id
      .mockReturnValueOnce(chain({ data: { whatsapp_account_id: "account-1" }, error: null }))
      // whatsapp_accounts: resolve service_window_fallback_template_id
      .mockReturnValueOnce(
        chain({ data: { service_window_fallback_template_id: "tpl-1" }, error: null }),
      )
      // whatsapp_templates: resolve the template itself, status approved
      .mockReturnValueOnce(
        chain({
          data: { id: "tpl-1", name: "reengagement_v1", language: "en", status: "approved" },
          error: null,
        }),
      );

    const repo = new SupabaseHandoverWorkerRepository({ from: fromMock } as never);
    const state = await repo.getServiceWindowState("src-1");

    expect(state.lastCustomerMessageAt).toBe("2026-09-01T10:00:00.000Z");
    expect(state.fallbackTemplate).toEqual({
      id: "tpl-1",
      name: "reengagement_v1",
      language: "en",
    });
  });

  it("treats a configured but no-longer-approved template as no fallback at all", async () => {
    const fromMock = vi
      .fn()
      .mockReturnValueOnce(chain({ data: { conversation_id: "conv-1" }, error: null }))
      .mockReturnValueOnce(
        chain({ data: { whatsapp_phone_number_id: "phone-row-1" }, error: null }),
      )
      .mockReturnValueOnce(chain({ data: null, error: null }))
      .mockReturnValueOnce(chain({ data: { whatsapp_account_id: "account-1" }, error: null }))
      .mockReturnValueOnce(
        chain({ data: { service_window_fallback_template_id: "tpl-1" }, error: null }),
      )
      .mockReturnValueOnce(
        chain({
          data: { id: "tpl-1", name: "reengagement_v1", language: "en", status: "disabled" },
          error: null,
        }),
      );

    const repo = new SupabaseHandoverWorkerRepository({ from: fromMock } as never);
    const state = await repo.getServiceWindowState("src-1");

    expect(state.lastCustomerMessageAt).toBeNull();
    expect(state.fallbackTemplate).toBeNull();
  });

  it("short-circuits without querying accounts/templates when the conversation has no phone number mapped", async () => {
    const fromMock = vi
      .fn()
      .mockReturnValueOnce(chain({ data: { conversation_id: "conv-1" }, error: null }))
      .mockReturnValueOnce(chain({ data: { whatsapp_phone_number_id: null }, error: null }))
      .mockReturnValueOnce(
        chain({ data: { created_at: "2026-09-01T10:00:00.000Z" }, error: null }),
      );

    const repo = new SupabaseHandoverWorkerRepository({ from: fromMock } as never);
    const state = await repo.getServiceWindowState("src-1");

    expect(state.fallbackTemplate).toBeNull();
    expect(fromMock).toHaveBeenCalledTimes(3);
  });
});
