-- Dravonix WhatsApp AI Platform
-- Phase 3A.2: close the direct-authenticated raw phone bypass.
--
-- Migration 25 built the secure phone read layer (permission, masking
-- helper, phone_is_full_for_caller authorization core, and the
-- SECURITY DEFINER display/search RPCs) and switched every client-facing
-- read path onto it, but deliberately left the underlying direct-table
-- bypass open pending review. This migration closes it.
--
-- THE PRIVILEGE CORRECTION THIS MIGRATION MAKES:
--
-- A prior draft of this migration proposed a column-level REVOKE alone:
--   revoke select (whatsapp_wa_id) on public.contacts from authenticated;
-- That is NOT sufficient. Supabase's own bootstrap grants ALL PRIVILEGES on
-- every public-schema table to anon/authenticated/service_role by default
-- and relies on RLS row policies alone for protection -- verified on hosted
-- staging (project lshfkxirfbjwlklqwqnf):
--   has_table_privilege('authenticated','public.contacts','SELECT') = true
--   has_table_privilege('authenticated','public.leads','SELECT')    = true
-- Postgres privilege checking treats table-level and column-level SELECT as
-- additive (a column is selectable if EITHER grants it) -- a column-level
-- REVOKE can never carve an exception out of a table-level GRANT that still
-- stands. With that table-level grant in place, contacts.whatsapp_wa_id and
-- leads.phone_number would have remained fully readable by any authenticated
-- company member with conversations.view/leads.view (every active role
-- except company_accounts -- confirmed via role_permissions), completely
-- unaffected by a column-level revoke, via a bare Supabase-JS/PostgREST
-- query. RLS on these tables scopes ROWS by company_id, never COLUMNS, so it
-- was never a defense against this at all -- e.g. a Sales Person, who is
-- only supposed to see a customer's full number for their own assigned
-- conversation (phone_is_full_for_caller), could already read every
-- customer's raw number in their company directly, bypassing that
-- assignment check entirely, since conversations.view is a company-wide
-- grant with no assignment condition in RLS.
--
-- The correct closure: revoke the table-level SELECT grant entirely, then
-- re-grant SELECT on an explicit safe-column allowlist -- built from an
-- exhaustive sweep of every remaining authenticated client-facing
-- contacts/leads query in the repository (see the Phase 3A security-review
-- report for the full sweep). whatsapp_wa_id and phone_number are excluded
-- from both allowlists; every other read path already switched to
-- get_conversation_phone_displays/get_lead_phone_displays/
-- search_company_conversations/search_company_leads (migration 25), all
-- SECURITY DEFINER and owned by this migration's applying role, so they are
-- completely unaffected by an authenticated-role grant change -- a SECURITY
-- DEFINER function runs with its owner's privileges, never the caller's (verified
-- empirically: a role with no table-level or column-level SELECT on a
-- column can still read it through a SECURITY DEFINER function that
-- references it directly).
--
-- Also confirmed empirically before writing this migration: an RLS policy's
-- own USING/WITH CHECK expression referencing a column does NOT require the
-- querying role to hold privilege on that column -- only a column the
-- caller's own query text references (SELECT list, WHERE, ORDER BY) does.
-- Every existing RLS policy on contacts/leads references only company_id
-- (via has_company_permission), so this REVOKE does not affect row-security
-- evaluation at all.
--
-- service_role is untouched by any of this -- REVOKE ... FROM authenticated
-- only ever affects the authenticated role, and service_role already
-- bypasses RLS and holds its own unrelated table-level grants (unaffected
-- by design, verified on hosted staging). Every trusted backend path
-- (webhook ingest, message-consumer, voice-consumer, and
-- sendHumanReplyAction's server-only outbound-routing lookup via
-- apps/web/lib/supabase/serviceRole.ts) runs as service_role and keeps
-- reading whatsapp_wa_id directly, unaffected.
--
-- No RLS policy changes, no function alterations, and no new indexes are
-- required by this migration -- it is exactly the privilege GRANT/REVOKE
-- closure described above, nothing else.

-- ---------------------------------------------------------------------------
-- contacts: safe direct-column allowlist for authenticated, built from the
-- Phase 3A security-review sweep of every remaining authenticated
-- contacts-embedding query (conversationsRepository.ts, notificationsRepository.ts,
-- loadContactSummary.ts, chatAgentContext.ts, supabaseHandoverRepository.ts,
-- leadsRepository.ts, globalSearchRepository.ts). whatsapp_wa_id, is_blocked,
-- and updated_at are deliberately excluded -- none of them is referenced by
-- any remaining authenticated client query's select list, WHERE/eq filter,
-- or order-by. company_id IS included, even though no current TypeScript
-- read path filters an embedded contacts sub-select on it directly (the app
-- always filters the outer conversations/leads row instead) -- it is not
-- sensitive (no more revealing than the row's own existence, which RLS
-- already permits inferring), and this repo's own
-- rls_tenant_isolation.sql test legitimately filters `contacts` directly by
-- company_id in exactly this shape, proving it a real, non-hypothetical
-- need this REVOKE must not break. Add any other column here only when a
-- real query is found that needs it.
-- ---------------------------------------------------------------------------

revoke select on public.contacts from authenticated;
grant select (id, company_id, display_name, profile_name, last_detected_language, timezone, created_at)
  on public.contacts to authenticated;

-- No authenticated-facing read path selects from contacts at all as `anon`
-- (every RLS policy on this table requires auth.uid() via
-- has_company_permission/is_platform_staff, so anon already got zero rows) --
-- revoked outright rather than re-granted, closing the same
-- grant-everything-by-default gap for completeness.
revoke select on public.contacts from anon;

-- ---------------------------------------------------------------------------
-- leads: safe direct-column allowlist for authenticated, built from
-- leadsRepository.ts's LEAD_SELECT_COLUMNS, chatAgentContext.ts,
-- globalSearchRepository.ts, and lib/actions/leads.ts's update/.eq() filter
-- columns (id and company_id are both directly referenced in those queries'
-- own WHERE clauses). phone_number is the one column deliberately excluded.
-- ---------------------------------------------------------------------------

revoke select on public.leads from authenticated;
grant select (
    id, company_id, customer_name, company_name, service_interest, product_interest,
    budget, preferred_timeline, email, location, branch, notes, source, score, stage,
    assigned_member_id, conversation_id, created_at, updated_at
  )
  on public.leads to authenticated;

revoke select on public.leads from anon;
