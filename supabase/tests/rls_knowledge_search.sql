-- P1 stabilization: DB-level regression coverage for search_knowledge_chunks
-- (migrations 10/11), which had no direct SQL/RPC test before this. Covers
-- the retrieval path used by message-consumer's KnowledgeRetriever
-- (packages/knowledge) at the real database level.
--
-- search_knowledge_chunks is `language sql stable` -- NOT `security definer`
-- (see migration 10's comment on the function) -- so it runs as SECURITY
-- INVOKER; RLS therefore still applies whenever a role other than
-- service_role somehow reaches it. But as of migration 34 (P2 knowledge
-- ingestion), EXECUTE itself is revoked from public/anon/authenticated and
-- granted only to service_role -- the only real caller (message-consumer/
-- voice-consumer). This file locks in BOTH layers: the grant-level denial
-- for anon/authenticated (section 2/3 below), and service_role's own
-- `kc.company_id = p_company_id` filter plus the ingestion_status/is_enabled
-- filters as the sole remaining isolation/quality guarantees for the one
-- role that can still call it (sections 1 and 4).

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

-- ingestion_status is explicit (not left to the column default) throughout
-- this fixture -- migration 34 changed that default to 'pending', so a real
-- retrieval-focused test must state the status it actually intends per row
-- rather than relying on whatever a future default happens to be.
insert into knowledge_sources (id, company_id, source_type, title, is_enabled, ingestion_status) values
  ('84000001-0000-0000-0000-000000000001', '82000001-0000-0000-0000-000000000001', 'pricing', 'Co A Pricing', true, 'ready'),
  ('84000001-0000-0000-0000-000000000002', '82000001-0000-0000-0000-000000000001', 'faq', 'Co A Disabled FAQ', false, 'ready'),
  ('84000002-0000-0000-0000-000000000001', '82000002-0000-0000-0000-000000000001', 'pricing', 'Co B Pricing', true, 'ready');

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
-- 2. authenticated: migration 34 revokes EXECUTE entirely -- even a real,
--    legitimately-authenticated Company A member (who genuinely has
--    knowledge.view and would previously have been let through by RLS) now
--    gets a permission error at the grant layer, before RLS is ever
--    evaluated. This is a hardening/attack-surface reduction (Phase 19 of
--    the P2 audit): the only real caller is service_role.
-- ---------------------------------------------------------------------------

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '81000001-0000-0000-0000-000000000001', true);

  begin
    perform count(*) from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
    raise exception 'ASSERTION FAILED: authenticated should be denied execute on search_knowledge_chunks, but the call succeeded';
  exception
    when insufficient_privilege then
      raise notice 'OK: authenticated (Company A owner, real knowledge.view) is denied EXECUTE on search_knowledge_chunks -- grant-level denial, not just RLS';
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. anon: same grant-level denial as authenticated above.
-- ---------------------------------------------------------------------------

do $$
begin
  -- test_clear_current_user() is required here, not just `set local role
  -- anon` -- request.jwt.claim.sub was set (non-locally) to the Company A
  -- owner's id in section 2 above and does not reset on its own, so without
  -- this call auth.uid() would still resolve to that real user even under
  -- the anon role, silently testing the wrong scenario.
  perform test_clear_current_user();
  set local role anon;

  begin
    perform count(*) from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
    raise exception 'ASSERTION FAILED: anon should be denied execute on search_knowledge_chunks, but the call succeeded';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on search_knowledge_chunks';
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. service_role retains EXECUTE, and ingestion_status = 'ready' (added by
--    migration 34, alongside the pre-existing is_enabled = true filter) is
--    genuinely enforced: an enabled source sitting at pending/processing/
--    failed must never be retrievable, only a genuinely ready one.
-- ---------------------------------------------------------------------------

insert into knowledge_sources (id, company_id, source_type, title, is_enabled, ingestion_status) values
  ('84000001-0000-0000-0000-000000000003', '82000001-0000-0000-0000-000000000001', 'faq', 'Co A Pending FAQ', true, 'pending'),
  ('84000001-0000-0000-0000-000000000004', '82000001-0000-0000-0000-000000000001', 'faq', 'Co A Processing FAQ', true, 'processing'),
  ('84000001-0000-0000-0000-000000000005', '82000001-0000-0000-0000-000000000001', 'faq', 'Co A Failed FAQ', true, 'failed');

insert into knowledge_chunks (id, company_id, knowledge_source_id, content, chunk_index) values
  ('85000001-0000-0000-0000-000000000003', '82000001-0000-0000-0000-000000000001', '84000001-0000-0000-0000-000000000003', 'Pending source website pricing info', 0),
  ('85000001-0000-0000-0000-000000000004', '82000001-0000-0000-0000-000000000001', '84000001-0000-0000-0000-000000000004', 'Processing source website pricing info', 0),
  ('85000001-0000-0000-0000-000000000005', '82000001-0000-0000-0000-000000000001', '84000001-0000-0000-0000-000000000005', 'Failed source website pricing info', 0);

do $$
declare
  v_count integer;
  v_title text;
begin
  set local role service_role;

  select count(*) into v_count
    from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert(
    'service_role: only the ready+enabled source is ever returned -- pending/processing/failed enabled sources are excluded',
    v_count = 1
  );

  select title into v_title
    from search_knowledge_chunks('82000001-0000-0000-0000-000000000001', 'website package pricing', 10);
  perform test_assert('service_role: the one returned chunk is genuinely the ready source''s', v_title = 'Co A Pricing');
end;
$$;

reset role;

rollback;
