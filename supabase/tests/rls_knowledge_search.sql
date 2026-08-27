-- P1 stabilization: DB-level regression coverage for search_knowledge_chunks
-- (migrations 10/11), which had no direct SQL/RPC test before this. Covers
-- the retrieval path used by message-consumer's KnowledgeRetriever
-- (packages/knowledge) at the real database level.
--
-- search_knowledge_chunks is `language sql stable` -- NOT `security definer`
-- (see migration 10's comment on the function) -- so it runs as SECURITY
-- INVOKER. This means two independent isolation layers exist depending on
-- who calls it:
--   1. service_role (the real production caller, via message-consumer's
--      Supabase client): RLS is bypassed entirely for this role, so the
--      function's own `kc.company_id = p_company_id` filter is the SOLE
--      isolation guarantee for this call path.
--   2. authenticated/anon (if ever called directly, e.g. from a future
--      client-side integration): RLS (knowledge_chunks_select_member /
--      knowledge_sources_select_member, migration 6) remains fully
--      authoritative regardless of what p_company_id is passed, since RLS
--      filters by has_company_permission(<row's own company_id>, ...)
--      evaluated per row, independent of the function's own parameter.
--
-- This file tests both layers explicitly rather than assuming either one
-- alone is sufficient.

begin;

create or replace function test_assert(description text, condition boolean) returns void
  language plpgsql
  as $$
  begin
    if not condition then
      raise exception 'ASSERTION FAILED: %', description;
    else
      raise notice 'OK: %', description;
    end if;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Fixtures: two companies, each with an enabled pricing source and one
-- disabled source, all sharing similar content so a query genuinely could
-- match either company's data if isolation were broken.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('81000001-0000-0000-0000-000000000001', 'owner-know-a@example.test'),
  ('81000002-0000-0000-0000-000000000001', 'owner-know-b@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('82000001-0000-0000-0000-000000000001', 'Knowledge Co A', 'knowledge-co-a', 'active', true),
  ('82000002-0000-0000-0000-000000000001', 'Knowledge Co B', 'knowledge-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('83000001-0000-0000-0000-000000000001', '82000001-0000-0000-0000-000000000001', '81000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('83000002-0000-0000-0000-000000000001', '82000002-0000-0000-0000-000000000001', '81000002-0000-0000-0000-000000000001', 'company_owner', true);

insert into knowledge_sources (id, company_id, source_type, title, is_enabled) values
  ('84000001-0000-0000-0000-000000000001', '82000001-0000-0000-0000-000000000001', 'pricing', 'Co A Pricing', true),
  ('84000001-0000-0000-0000-000000000002', '82000001-0000-0000-0000-000000000001', 'faq', 'Co A Disabled FAQ', false),
  ('84000002-0000-0000-0000-000000000001', '82000002-0000-0000-0000-000000000001', 'pricing', 'Co B Pricing', true);

insert into knowledge_chunks (id, company_id, knowledge_source_id, content, chunk_index) values
  ('85000001-0000-0000-0000-000000000001', '82000001-0000-0000-0000-000000000001', '84000001-0000-0000-0000-000000000001', 'Our website package costs fifty thousand rupees', 0),
  ('85000001-0000-0000-0000-000000000002', '82000001-0000-0000-0000-000000000001', '84000001-0000-0000-0000-000000000002', 'Disabled source website pricing info', 0),
  ('85000002-0000-0000-0000-000000000001', '82000002-0000-0000-0000-000000000001', '84000002-0000-0000-0000-000000000001', 'Company B website package pricing details', 0);

-- ---------------------------------------------------------------------------
-- 1. service_role (real production call path): same-company retrieval works,
--    the disabled source is excluded, and the OTHER company's data never
--    appears for a query that would genuinely match it too.
-- ---------------------------------------------------------------------------

do $$
declare
  v_count integer;
  v_source_id uuid;
  v_title text;
begin
  set local role service_role;

  select count(*) into v_count
    from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('service_role: same-company retrieval returns exactly one chunk (the enabled source''s)', v_count = 1);

  select source_id, title into v_source_id, v_title
    from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('service_role: the returned chunk belongs to the enabled source', v_source_id = '84000001-0000-0000-0000-000000000001');
  perform test_assert('service_role: the disabled FAQ source''s chunk is never returned even though its content matches', v_title = 'Co A Pricing');

  select count(*) into v_count
    from search_knowledge_chunks('82000002-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('service_role: Company B''s own query returns only Company B''s chunk, never mixed with Company A''s', v_count = 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. authenticated (defense-in-depth layer): RLS remains fully authoritative
--    regardless of what p_company_id is passed -- a caller belonging to
--    Company A can retrieve their own company's chunks, but passing
--    Company B's id gets zero rows (RLS-filtered), never Company B's real
--    data and never a permission error.
-- ---------------------------------------------------------------------------

do $$
declare
  v_count integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '81000001-0000-0000-0000-000000000001', true);

  select count(*) into v_count
    from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('authenticated (Company A owner): own-company retrieval works under RLS', v_count = 1);

  select count(*) into v_count
    from search_knowledge_chunks('82000002-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('authenticated (Company A owner): passing Company B''s id returns zero rows, never Company B''s data', v_count = 0);
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. anon: EXECUTE on this function (and table-level SELECT on
--    knowledge_chunks/knowledge_sources) is still the Postgres default
--    PUBLIC grant -- unlike the more recently hardened
--    search_company_leads/search_company_conversations (migration 25),
--    which explicitly revoke EXECUTE from anon. This is a real grant-model
--    inconsistency worth tightening in a future pass, but RLS independently
--    guarantees anon can never retrieve real company data through it today
--    -- has_company_permission() resolves to false with no auth.uid(), for
--    every row, regardless of which company_id is requested. This assertion
--    locks in that safety property so a future RLS regression here would be
--    caught even before the grant itself is ever tightened.
-- ---------------------------------------------------------------------------

do $$
declare v_count integer; begin
  -- test_clear_current_user() is required here, not just `set local role
  -- anon` -- request.jwt.claim.sub was set (non-locally) to the Company A
  -- owner's id in section 2 above and does not reset on its own, so without
  -- this call auth.uid() would still resolve to that real user even under
  -- the anon role, silently testing the wrong scenario.
  perform test_clear_current_user();
  set local role anon;
  select count(*) into v_count
    from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('anon: RLS returns zero rows regardless of company_id, even though EXECUTE is still PUBLIC-granted', v_count = 0);
end; $$;

reset role;

rollback;
