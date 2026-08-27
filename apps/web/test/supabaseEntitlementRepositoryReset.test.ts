import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseEntitlementRepository } from "../lib/repositories/supabaseEntitlementRepository.js";

/**
 * Phase 7B correction pass: the entitlement-reset SQL tests
 * (supabase/tests/rls_super_admin_subscription_controls.sql) only prove
 * admin_reset_company_entitlement deletes the company_entitlements override
 * row -- SQL tests structurally cannot reach application-layer TS code, so
 * they never prove "effective inheritance" through the real merge. This
 * test drives the actual production repository class (the same one
 * apps/web/lib/actions/handover.ts and the dashboard billing page use) end
 * to end: plan default -> company override -> effective value resolves to
 * the override -> override removed (exactly what admin_reset_company_
 * entitlement's DELETE produces) -> effective value resolves back to the
 * plan default, with no precedence change and no repository edit.
 */

type QueryResult = { data?: unknown; error?: unknown; count?: number };

function makeQueryBuilder(result: QueryResult) {
  const builder: PromiseLike<QueryResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    single: async () => result,
    maybeSingle: async () => result,
    then: (onFulfilled: (value: QueryResult) => unknown) =>
      Promise.resolve(result).then(onFulfilled),
  } as never;
  return builder;
}

function makeStubClient(tables: Record<string, QueryResult>): SupabaseClient {
  return {
    from: (table: string) => makeQueryBuilder(tables[table] ?? { data: null, error: null }),
  } as unknown as SupabaseClient;
}

const COMPANY_ID = "60000001-0000-0000-0000-000000000001";
const PLAN_VERSION_ID = "70000001-0000-0000-0000-000000000001";
const FEATURE_KEY = "voice_enabled";

const PLAN_DEFAULT = { feature_key: FEATURE_KEY, is_enabled: false, numeric_limit: null };
const COMPANY_OVERRIDE = { feature_key: FEATURE_KEY, is_enabled: true, numeric_limit: 500 };

function baseTables(companyEntitlementRows: unknown[]): Record<string, QueryResult> {
  return {
    companies: { data: { status: "active" }, error: null },
    subscriptions: {
      data: {
        state: "active",
        plan_version_id: PLAN_VERSION_ID,
        current_period_start: "2026-08-01T00:00:00.000Z",
      },
      error: null,
    },
    plan_entitlements: { data: [PLAN_DEFAULT], error: null },
    company_entitlements: { data: companyEntitlementRows, error: null },
    messages: { count: 0, error: null },
  };
}

describe("SupabaseEntitlementRepository: effective inheritance after admin_reset_company_entitlement", () => {
  it("resolves the plan default when no company override exists", async () => {
    const repo = new SupabaseEntitlementRepository(makeStubClient(baseTables([])));

    const snapshot = await repo.getSnapshot(COMPANY_ID);

    expect(snapshot.features[FEATURE_KEY]).toEqual({ isEnabled: false, numericLimit: null });
  });

  it("resolves the company override, not the plan default, while the override row exists", async () => {
    const repo = new SupabaseEntitlementRepository(makeStubClient(baseTables([COMPANY_OVERRIDE])));

    const snapshot = await repo.getSnapshot(COMPANY_ID);

    expect(snapshot.features[FEATURE_KEY]).toEqual({ isEnabled: true, numericLimit: 500 });
  });

  it("falls back to the plan default again once the override row is deleted -- exactly admin_reset_company_entitlement's effect", async () => {
    const withOverride = new SupabaseEntitlementRepository(
      makeStubClient(baseTables([COMPANY_OVERRIDE])),
    );
    const beforeReset = await withOverride.getSnapshot(COMPANY_ID);
    expect(beforeReset.features[FEATURE_KEY]).toEqual({ isEnabled: true, numericLimit: 500 });

    // admin_reset_company_entitlement is a plain DELETE of the
    // company_entitlements row -- simulated here by the repository simply
    // seeing no matching row any more, exactly as it would after that RPC
    // runs. plan_entitlements is never touched by the reset, so it is
    // identical to the pre-reset snapshot's tables.
    const afterReset = new SupabaseEntitlementRepository(makeStubClient(baseTables([])));
    const snapshot = await afterReset.getSnapshot(COMPANY_ID);

    expect(snapshot.features[FEATURE_KEY]).toEqual({ isEnabled: false, numericLimit: null });
  });
});
