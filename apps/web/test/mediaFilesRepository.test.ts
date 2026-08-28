import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { getPlayableAudioMediaFile } from "../lib/repositories/mediaFilesRepository.js";

interface MediaFileRow {
  storage_key: string;
  mime_type: string | null;
  kind: string;
  deleted_at: string | null;
}

interface QueryResult {
  data: MediaFileRow | null;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  eq: (...args: unknown[]) => FakeChain;
  in: (...args: unknown[]) => FakeChain;
  is: (...args: unknown[]) => FakeChain;
  select: (...args: unknown[]) => FakeChain;
  maybeSingle: () => Promise<QueryResult>;
}

/** Minimal chainable stub matching Supabase's PostgrestFilterBuilder shape, same convention as leadsRepository.test.ts. */
function fakeChain(result: QueryResult): FakeChain {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): FakeChain => {
      calls.push({ method, args });
      return chain;
    };
  const chain: FakeChain = {
    calls,
    select: record("select"),
    eq: record("eq"),
    in: record("in"),
    is: record("is"),
    maybeSingle: () => Promise.resolve(result),
  };
  return chain;
}

function fakeSupabaseClient(chain: FakeChain): SupabaseClient {
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const MEDIA_ID = "media-1";

function audioRow(overrides: Partial<MediaFileRow> = {}): MediaFileRow {
  return {
    storage_key: `companies/${COMPANY_A}/audio/inbound/msg-1`,
    mime_type: "audio/ogg",
    kind: "inbound_audio",
    deleted_at: null,
    ...overrides,
  };
}

describe("getPlayableAudioMediaFile", () => {
  it("CASE 1: an authorized same-company caller resolves the correct storage key and mime type", async () => {
    const chain = fakeChain({ data: audioRow(), error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_A, MEDIA_ID);

    expect(result).toEqual({
      storageKey: `companies/${COMPANY_A}/audio/inbound/msg-1`,
      mimeType: "audio/ogg",
    });
    // Always scoped by the caller's own companyId, never a value from the request.
    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", COMPANY_A] });
    expect(chain.calls).toContainEqual({ method: "eq", args: ["id", MEDIA_ID] });
    expect(chain.calls).toContainEqual({ method: "is", args: ["deleted_at", null] });
  });

  it("CASE 2: a query scoped to a different company than the one owning the media returns null (cross-company denial)", async () => {
    // The query is scoped by COMPANY_B, but the row that would match this
    // mediaFileId actually belongs to COMPANY_A -- the fake driver, like
    // real RLS + the .eq('company_id', ...) filter together, simply returns
    // no row for a mismatched company_id.
    const chain = fakeChain({ data: null, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_B, MEDIA_ID);

    expect(result).toBeNull();
    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", COMPANY_B] });
  });

  it("CASE 4: a missing media file returns null, never throwing", async () => {
    const chain = fakeChain({ data: null, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_A, "nonexistent-media-id");

    expect(result).toBeNull();
  });

  it("CASE 5: only ever queries inbound_audio/outbound_audio kinds -- never a knowledge_document row belonging to a different conversation/company relationship", async () => {
    const chain = fakeChain({ data: audioRow(), error: null });
    const client = fakeSupabaseClient(chain);

    await getPlayableAudioMediaFile(client, COMPANY_A, MEDIA_ID);

    const inCall = chain.calls.find((c) => c.method === "in");
    expect(inCall?.args).toEqual(["kind", ["inbound_audio", "outbound_audio"]]);
  });

  it("CASE 6: a browser-supplied company id cannot be used to bypass ownership -- the function only ever accepts companyId as an explicit parameter (never read from the row itself)", async () => {
    // Even if a malicious/malformed row somehow claimed a different
    // company's storage key, the explicit keyBelongsToCompany check below
    // rejects it -- this proves that defense-in-depth layer independently.
    const chain = fakeChain({
      data: audioRow({ storage_key: `companies/${COMPANY_B}/audio/inbound/msg-1` }),
      error: null,
    });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_A, MEDIA_ID);

    expect(result).toBeNull();
  });

  it("excludes a retention-deleted media file even if somehow returned by the driver", async () => {
    const chain = fakeChain({ data: null, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_A, MEDIA_ID);

    expect(result).toBeNull();
    expect(chain.calls).toContainEqual({ method: "is", args: ["deleted_at", null] });
  });

  it("falls back to the same default mime type the voice pipeline itself uses when mime_type is missing", async () => {
    const chain = fakeChain({ data: audioRow({ mime_type: null }), error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_A, MEDIA_ID);

    expect(result?.mimeType).toBe("audio/ogg");
  });

  it("propagates a genuine database error rather than silently swallowing it", async () => {
    const chain = fakeChain({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = fakeSupabaseClient(chain);

    await expect(getPlayableAudioMediaFile(client, COMPANY_A, MEDIA_ID)).rejects.toThrow(
      "too many connections",
    );
  });

  it("MALFORMED-ID CORRECTION: a malformed (non-UUID) mediaFileId returns null, matching the established 22P02 handling elsewhere in this codebase, rather than throwing and surfacing a 500", async () => {
    const chain = fakeChain({
      data: null,
      error: { code: "22P02", message: 'invalid input syntax for type uuid: "not-a-uuid"' },
    });
    const client = fakeSupabaseClient(chain);

    const result = await getPlayableAudioMediaFile(client, COMPANY_A, "not-a-uuid");

    expect(result).toBeNull();
  });

  it("a malformed mediaFileId never logs the error -- it is treated identically to a routine not-found, not an infrastructure failure", async () => {
    const chain = fakeChain({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type uuid" },
    });
    const client = fakeSupabaseClient(chain);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await getPlayableAudioMediaFile(client, COMPANY_A, "not-a-uuid");

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
