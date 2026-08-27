import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { recordUsageEvents } from "../src/usageEvents.js";
import type { UsageEventInsert } from "../src/types.js";

function fakeClient(upsertResult: { error: unknown }) {
  const upsert = vi.fn().mockResolvedValue(upsertResult);
  const from = vi.fn().mockReturnValue({ upsert });
  return { client: { from } as unknown as SupabaseClient, from, upsert };
}

describe("recordUsageEvents", () => {
  it("is a no-op for an empty array -- no request is made", async () => {
    const { client, from } = fakeClient({ error: null });
    await recordUsageEvents(client, []);
    expect(from).not.toHaveBeenCalled();
  });

  it("upserts against usage_events with idempotency_key as the conflict target and ignoreDuplicates set", async () => {
    const { client, from, upsert } = fakeClient({ error: null });
    const events: UsageEventInsert[] = [
      {
        companyId: "company-1",
        metric: "claude_requests",
        quantity: 1,
        idempotencyKey: "message-1:claude_requests",
      },
    ];
    await recordUsageEvents(client, events);

    expect(from).toHaveBeenCalledWith("usage_events");
    expect(upsert).toHaveBeenCalledWith(
      [
        {
          company_id: "company-1",
          metric: "claude_requests",
          quantity: 1,
          idempotency_key: "message-1:claude_requests",
          conversation_id: null,
          is_billable: true,
          provider_request_id: null,
        },
      ],
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
  });

  it("maps optional fields through when provided", async () => {
    const { client, upsert } = fakeClient({ error: null });
    await recordUsageEvents(client, [
      {
        companyId: "company-1",
        metric: "claude_input_tokens",
        quantity: 120,
        idempotencyKey: "message-1:claude_input_tokens",
        conversationId: "conversation-1",
        isBillable: false,
        providerRequestId: "req-abc",
      },
    ]);
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          conversation_id: "conversation-1",
          is_billable: false,
          provider_request_id: "req-abc",
        }),
      ],
      expect.anything(),
    );
  });

  it("batches multiple events into a single upsert call", async () => {
    const { client, upsert } = fakeClient({ error: null });
    await recordUsageEvents(client, [
      {
        companyId: "company-1",
        metric: "claude_input_tokens",
        quantity: 10,
        idempotencyKey: "message-1:claude_input_tokens",
      },
      {
        companyId: "company-1",
        metric: "claude_output_tokens",
        quantity: 5,
        idempotencyKey: "message-1:claude_output_tokens",
      },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toHaveLength(2);
  });

  it("throws when the underlying upsert reports a real error", async () => {
    const { client } = fakeClient({ error: { message: "connection reset" } });
    await expect(
      recordUsageEvents(client, [
        {
          companyId: "company-1",
          metric: "claude_requests",
          quantity: 1,
          idempotencyKey: "message-1:claude_requests",
        },
      ]),
    ).rejects.toEqual({ message: "connection reset" });
  });
});
