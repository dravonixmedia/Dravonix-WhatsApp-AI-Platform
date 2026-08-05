"use server";

import {
  GLOBAL_SEARCH_MIN_LENGTH,
  searchConversations,
  searchLeads,
  type GlobalSearchResults,
} from "../repositories/globalSearchRepository.js";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

const EMPTY_RESULTS: GlobalSearchResults = { conversations: [], leads: [] };

function escapeIlikeTerm(term: string): string {
  // PostgREST's .or() filter string is comma-separated; a raw comma or
  // parenthesis in the search term would otherwise break the filter's own
  // syntax (not a SQL-injection vector -- supabase-js parameterizes the
  // value itself -- but an unescaped structural character here still
  // corrupts the filter expression and can throw or silently misfilter).
  return term.replace(/[,()]/g, "");
}

/**
 * Tenant-scoped global search across the two modules with real, indexed
 * backend support: conversations (matched via the linked contact's identity
 * -- the same technique lib/repositories/conversationsRepository.ts already
 * uses) and leads (matched via listLeads's existing searchable columns).
 * Uses the caller's own RLS-scoped Supabase client and
 * getDashboardSession()'s server-derived activeCompanyId -- a company id is
 * never accepted from the browser, and RLS enforces the same scoping
 * regardless. The actual queries live in
 * lib/repositories/globalSearchRepository.ts so they're directly
 * unit-testable with a fake Supabase client; this file only adds the
 * session/length gating a Server Action needs (and every export here must
 * stay an async function -- see GLOBAL_SEARCH_MIN_LENGTH's own comment for
 * why the constant lives in the repository module instead).
 */
export async function globalSearchAction(rawQuery: string): Promise<GlobalSearchResults> {
  const term = rawQuery.trim();
  if (term.length < GLOBAL_SEARCH_MIN_LENGTH) return EMPTY_RESULTS;

  const session = await getDashboardSession();
  if (!session) return EMPTY_RESULTS;

  const safeTerm = escapeIlikeTerm(term);
  if (!safeTerm) return EMPTY_RESULTS;

  const supabase = await createServerSupabaseClient();
  const companyId = session.activeCompanyId;

  const [conversations, leads] = await Promise.all([
    searchConversations(supabase, companyId, safeTerm),
    searchLeads(supabase, companyId, safeTerm),
  ]);

  return { conversations, leads };
}
