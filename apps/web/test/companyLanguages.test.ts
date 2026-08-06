import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { loadCompanyEnabledLanguages } from "../lib/repositories/companyLanguages.js";

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  maybeSingle: (...args: unknown[]) => FakeChain;
  then: (resolve: (value: QueryResult) => unknown) => unknown;
}

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
    maybeSingle: record("maybeSingle"),
    then: (resolve) => resolve(result),
  };
  return chain;
}

function fakeSupabaseClient(chain: FakeChain): SupabaseClient {
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

const COMPANY_ID = "company-1";

describe("loadCompanyEnabledLanguages", () => {
  it("returns only the Chat-Agent-supported languages from company_settings.enabled_languages", async () => {
    const chain = fakeChain({
      data: { enabled_languages: ["en", "ml", "fr", "zh"] },
      error: null,
    });
    const client = fakeSupabaseClient(chain);

    const result = await loadCompanyEnabledLanguages(client, COMPANY_ID);

    expect(result).toEqual(["en", "ml"]);
  });

  it("preserves the four supported languages when all are enabled", async () => {
    const chain = fakeChain({
      data: { enabled_languages: ["en", "ml", "hi", "ar"] },
      error: null,
    });
    const client = fakeSupabaseClient(chain);

    const result = await loadCompanyEnabledLanguages(client, COMPANY_ID);

    expect(result).toEqual(["en", "ml", "hi", "ar"]);
  });

  it("scopes the query to the caller's own companyId", async () => {
    const chain = fakeChain({ data: { enabled_languages: ["en"] }, error: null });
    const client = fakeSupabaseClient(chain);

    await loadCompanyEnabledLanguages(client, COMPANY_ID);

    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", COMPANY_ID] });
  });

  it("defaults to English alone when no company_settings row exists", async () => {
    const chain = fakeChain({ data: null, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await loadCompanyEnabledLanguages(client, COMPANY_ID);

    expect(result).toEqual(["en"]);
  });

  it("defaults to English alone when enabled_languages has no Chat-Agent-supported entries", async () => {
    const chain = fakeChain({ data: { enabled_languages: ["fr", "zh"] }, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await loadCompanyEnabledLanguages(client, COMPANY_ID);

    expect(result).toEqual(["en"]);
  });

  it("only ever reads -- never inserts, updates, or deletes anything", async () => {
    const chain = fakeChain({ data: { enabled_languages: ["en"] }, error: null });
    const client = fakeSupabaseClient(chain);

    await loadCompanyEnabledLanguages(client, COMPANY_ID);

    const methods = chain.calls.map((c) => c.method);
    expect(methods).not.toContain("insert");
    expect(methods).not.toContain("update");
    expect(methods).not.toContain("delete");
    expect(methods).not.toContain("upsert");
  });
});
