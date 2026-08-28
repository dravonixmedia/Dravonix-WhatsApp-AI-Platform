-- P2 Knowledge Base ingestion (migration 34): DB-level regression coverage
-- for ingest_knowledge_source, the one real transactional chunk writer.
-- Covers success, atomic replacement, the last-known-good preservation
-- invariant on a failed re-ingestion, first-ingestion failure + retry, and
-- authorization (including cross-company rejection).

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

create or replace function test_assert_raises(description text, sql_text text, expected_message text) returns void
  language plpgsql
  as $$
  declare
    caught text;
    did_raise boolean := false;
  begin
    begin
      execute sql_text;
    exception
      when others then
        caught := sqlerrm;
        did_raise := true;
    end;

    if not did_raise then
      raise exception 'ASSERTION FAILED: % -- expected exception "%" but none was raised', description, expected_message;
    end if;
    if caught <> expected_message then
      raise exception 'ASSERTION FAILED: % -- expected exception "%" but got "%"', description, expected_message, caught;
    end if;
    raise notice 'OK: %', description;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Fixtures: one super_admin, one Company A with an owner/admin/plain member,
-- one Company B with its own owner (for the cross-company case). Company A
-- starts with one already-'ready' source carrying two real chunks (for the
-- atomic-replacement and failed-re-ingestion tests) and one freshly created
-- 'pending' source with zero chunks (for the first-ingestion tests).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('91100001-0000-0000-0000-000000000001', 'super-admin-ki@example.test'),
  ('91100002-0000-0000-0000-000000000001', 'owner-ki-a@example.test'),
  ('91100003-0000-0000-0000-000000000001', 'admin-ki-a@example.test'),
  ('91100004-0000-0000-0000-000000000001', 'agent-ki-a@example.test'),
  ('91100005-0000-0000-0000-000000000001', 'owner-ki-b@example.test');

insert into platform_members (user_id, role, is_active) values
  ('91100001-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('92100001-0000-0000-0000-000000000001', 'Ingestion Co A', 'ingestion-co-a', 'active', true),
  ('92100002-0000-0000-0000-000000000001', 'Ingestion Co B', 'ingestion-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('93100001-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', '91100002-0000-0000-0000-000000000001', 'company_owner', true),
  ('93100001-0000-0000-0000-000000000002', '92100001-0000-0000-0000-000000000001', '91100003-0000-0000-0000-000000000001', 'company_admin', true),
  ('93100001-0000-0000-0000-000000000003', '92100001-0000-0000-0000-000000000001', '91100004-0000-0000-0000-000000000001', 'agent', true),
  ('93100002-0000-0000-0000-000000000001', '92100002-0000-0000-0000-000000000001', '91100005-0000-0000-0000-000000000001', 'company_owner', true);

insert into knowledge_sources (id, company_id, source_type, title, is_enabled, ingestion_status) values
  ('94100001-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Ready Source', true, 'ready'),
  ('94100001-0000-0000-0000-000000000002', '92100001-0000-0000-0000-000000000001', 'faq', 'New Source', true, 'pending'),
  ('94100001-0000-0000-0000-000000000003', '92100001-0000-0000-0000-000000000001', 'faq', 'Retry Source', true, 'pending'),
  ('94100001-0000-0000-0000-000000000004', '92100001-0000-0000-0000-000000000001', 'faq', 'Oversized Source', true, 'pending'),
  ('94100002-0000-0000-0000-000000000001', '92100002-0000-0000-0000-000000000001', 'faq', 'Company B Source', true, 'pending'),
  -- Fixtures for the whitespace-classification blocker correction: one
  -- 'pending' source per whitespace-only first-ingestion case, plus one per
  -- valid-boundary-whitespace-content case.
  ('94100001-0000-0000-0000-000000000005', '92100001-0000-0000-0000-000000000001', 'faq', 'WS Space Source', true, 'pending'),
  ('94100001-0000-0000-0000-000000000006', '92100001-0000-0000-0000-000000000001', 'faq', 'WS Tab Source', true, 'pending'),
  ('94100001-0000-0000-0000-000000000007', '92100001-0000-0000-0000-000000000001', 'faq', 'WS Newline Source', true, 'pending'),
  ('94100001-0000-0000-0000-000000000008', '92100001-0000-0000-0000-000000000001', 'faq', 'WS CR Source', true, 'pending'),
  ('94100001-0000-0000-0000-000000000009', '92100001-0000-0000-0000-000000000001', 'faq', 'WS CRLF Source', true, 'pending'),
  ('9410000a-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'WS Mixed Source', true, 'pending'),
  ('9410000b-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'WS NullPlusWhitespace Source', true, 'pending'),
  ('9410000c-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Valid Hello Source', true, 'pending'),
  ('9410000d-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Valid TabHelloNewline Source', true, 'pending'),
  ('9410000e-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Valid CrlfFaq Source', true, 'pending'),
  ('9410000f-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Valid HelloWorld Source', true, 'pending'),
  ('94100010-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Valid Malayalam Source', true, 'pending'),
  ('94100011-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', 'faq', 'Valid Arabic Source', true, 'pending');

insert into knowledge_chunks (id, company_id, knowledge_source_id, content, chunk_index) values
  ('95100001-0000-0000-0000-000000000001', '92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', 'Old chunk zero', 0),
  ('95100001-0000-0000-0000-000000000002', '92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', 'Old chunk one', 1);

set local role authenticated;
select test_set_current_user('91100001-0000-0000-0000-000000000001'); -- super_admin

-- ---------------------------------------------------------------------------
-- 1. First-ingestion success: the brand-new 'pending' source gets its exact
--    chunk set, deterministic 0-based chunk_index, 'ready', no error.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_error text;
begin
  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000002',
      array['New source chunk zero', 'New source chunk one']
    );
  perform test_assert('first ingestion: status is ready', v_status = 'ready');
  perform test_assert('first ingestion: error is cleared', v_error is null);
  perform test_assert(
    'first ingestion: exactly the two chunks exist, in order',
    (select array_agg(content order by chunk_index)
       from knowledge_chunks
       where knowledge_source_id = '94100001-0000-0000-0000-000000000002')
      = array['New source chunk zero', 'New source chunk one']
  );
  perform test_assert(
    'first ingestion: chunk_index is deterministic (0, 1)',
    (select array_agg(chunk_index order by chunk_index)
       from knowledge_chunks
       where knowledge_source_id = '94100001-0000-0000-0000-000000000002')
      = array[0, 1]
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Atomic replacement: the already-'ready' source's two old chunks are
--    fully replaced by three new ones -- no old rows survive, no duplicates,
--    still 'ready', error still null.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
begin
  select ingestion_status into v_status
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000001',
      array['Replacement chunk A', 'Replacement chunk B', 'Replacement chunk C']
    );
  perform test_assert('atomic replacement: status is ready', v_status = 'ready');
  perform test_assert(
    'atomic replacement: exactly the three new chunks exist, in order, no old rows, no duplicates',
    (select array_agg(content order by chunk_index)
       from knowledge_chunks
       where knowledge_source_id = '94100001-0000-0000-0000-000000000001')
      = array['Replacement chunk A', 'Replacement chunk B', 'Replacement chunk C']
  );
  perform test_assert(
    'atomic replacement: neither old chunk survives',
    not exists (
      select 1 from knowledge_chunks
      where knowledge_source_id = '94100001-0000-0000-0000-000000000001'
        and content in ('Old chunk zero', 'Old chunk one')
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. CRITICAL -- failed re-ingestion preserves last-known-good: the source
--    is already 'ready' (holding the three replacement chunks from step 2).
--    An invalid (whitespace-only) replacement attempt must NOT touch those
--    chunks, must NOT change the status away from 'ready', and must leave no
--    partial/duplicate rows -- only ingestion_error changes.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_error text;
  v_chunk_count integer;
begin
  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000001',
      array['   ', '']
    );
  perform test_assert(
    'failed re-ingestion of an already-ready source: status REMAINS ready, never downgraded',
    v_status = 'ready'
  );
  perform test_assert('failed re-ingestion: a safe error is recorded so the failure is still visible', v_error is not null);

  select count(*) into v_chunk_count
    from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000001';
  perform test_assert('failed re-ingestion: exactly the prior three chunks remain -- no partial/duplicate rows', v_chunk_count = 3);
  perform test_assert(
    'failed re-ingestion: the prior chunks are unchanged and still searchable content',
    (select array_agg(content order by chunk_index)
       from knowledge_chunks
       where knowledge_source_id = '94100001-0000-0000-0000-000000000001')
      = array['Replacement chunk A', 'Replacement chunk B', 'Replacement chunk C']
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. First-ingestion failure + retry: a fresh source (never ready) gets an
--    invalid attempt first -- zero chunks, 'failed', safe error -- then a
--    valid retry succeeds cleanly, exact chunks, 'ready', error cleared.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_error text;
  v_chunk_count integer;
begin
  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000003',
      array['', '   ']
    );
  perform test_assert('first-ingestion failure: a source that has never succeeded is marked failed', v_status = 'failed');
  perform test_assert('first-ingestion failure: a safe error is recorded', v_error is not null);

  select count(*) into v_chunk_count
    from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000003';
  perform test_assert('first-ingestion failure: zero chunks were written', v_chunk_count = 0);

  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000003',
      array['Retry chunk zero']
    );
  perform test_assert('retry after first-ingestion failure: status becomes ready', v_status = 'ready');
  perform test_assert('retry after first-ingestion failure: error is cleared', v_error is null);
  perform test_assert(
    'retry after first-ingestion failure: exactly the retried chunk exists',
    (select array_agg(content order by chunk_index)
       from knowledge_chunks
       where knowledge_source_id = '94100001-0000-0000-0000-000000000003')
      = array['Retry chunk zero']
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. The caller-supplied error-message override (used by the Server Action
--     to distinguish "oversized" from "empty after cleaning" without any
--     TypeScript-side write to knowledge_sources -- see
--     packages/knowledge/src/ingestion.ts's prepareKnowledgeChunks and
--     adminCompanyConfig.ts) is honored, and still respects the same
--     last-known-good status rule.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_error text;
begin
  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000004',
      array[]::text[],
      'Content exceeds the allowed size.'
    );
  perform test_assert('oversized-content override: a never-ready source is marked failed', v_status = 'failed');
  perform test_assert('oversized-content override: the caller-supplied message is stored verbatim', v_error = 'Content exceeds the allowed size.');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4c. CRITICAL -- the actual reported defect: Postgres's trim(text) with no
--     explicit character argument strips ONLY the plain space character, not
--     tab/newline/CR (confirmed directly: trim(E'\t') = E'\t', not ''). A
--     replacement attempt made entirely of tab/newline/CR/mixed-whitespace
--     content must be classified exactly like the plain-space case in
--     section 3 above: invalid, so the already-'ready' source's chunks
--     (still the three from section 2) are left completely untouched. This
--     also verifies the mandatory searchability check -- the old chunks
--     must remain findable through the real production path
--     (search_knowledge_chunks via service_role), not merely present in the
--     table.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_error text;
  v_chunk_count integer;
  v_chunks text[];
  v_indexes integer[];
begin
  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source(
      '92100001-0000-0000-0000-000000000001',
      '94100001-0000-0000-0000-000000000001',
      array[E'\t', E'\n', E'\r', E'\r\n', E' \t\n\r ', null]::text[]
    );
  perform test_assert(
    'CRITICAL: tab/newline/CR/CRLF/mixed-whitespace replacement is classified invalid, not a valid non-empty chunk set',
    v_status = 'ready'
  );
  perform test_assert('CRITICAL: a safe error is recorded so the failure is still visible', v_error is not null);

  select count(*) into v_chunk_count
    from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000001';
  perform test_assert('CRITICAL: exactly the prior three chunks remain -- no partial/duplicate/garbage rows', v_chunk_count = 3);

  select array_agg(content order by chunk_index), array_agg(chunk_index order by chunk_index)
    into v_chunks, v_indexes
    from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000001';
  perform test_assert(
    'CRITICAL: chunk content is byte-for-byte unchanged from section 2''s replacement set',
    v_chunks = array['Replacement chunk A', 'Replacement chunk B', 'Replacement chunk C']
  );
  perform test_assert('CRITICAL: chunk_index values unchanged (0, 1, 2)', v_indexes = array[0, 1, 2]);
  perform test_assert(
    'CRITICAL: no whitespace-only garbage chunk exists anywhere for this source',
    not exists (
      select 1 from knowledge_chunks
      where knowledge_source_id = '94100001-0000-0000-0000-000000000001'
        and content !~ '\S'
    )
  );
end;
$$;

-- Mandatory: the last-known-good chunks must still be actually searchable
-- through the real production call path, not merely present in the table --
-- this is the check that catches the defect at its real user-facing impact
-- (message-consumer/voice-consumer would otherwise silently retrieve zero
-- knowledge for this source after a "failed" edit attempt).
do $$
declare
  v_count integer;
begin
  set local role service_role;
  select count(*) into v_count
    from search_knowledge_chunks('92100001-0000-0000-0000-000000000001', 'Replacement', 10);
  perform test_assert(
    'last-known-good chunks remain searchable after the failed tab/newline/CR/mixed-whitespace re-ingestion attempt',
    v_count = 3
  );
  set local role authenticated;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4d. First-ingestion whitespace rejection matrix: a brand-new source (never
--     'ready') must end up 'failed' with zero chunks for EVERY whitespace
--     type individually, not just plain spaces -- space, tab, newline, CR,
--     CRLF, mixed whitespace, and NULL-mixed-with-whitespace.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_error text;
  v_chunk_count integer;
begin
  select ingestion_status, ingestion_error into v_status, v_error
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000005', array['   ']);
  perform test_assert('first-ingestion, space-only: failed, never ready', v_status = 'failed');
  perform test_assert('first-ingestion, space-only: a safe error is recorded', v_error is not null);
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000005';
  perform test_assert('first-ingestion, space-only: zero chunks written', v_chunk_count = 0);

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000006', array[E'\t\t\t']);
  perform test_assert('first-ingestion, tab-only: failed, never ready', v_status = 'failed');
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000006';
  perform test_assert('first-ingestion, tab-only: zero chunks written', v_chunk_count = 0);

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000007', array[E'\n\n']);
  perform test_assert('first-ingestion, newline-only: failed, never ready', v_status = 'failed');
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000007';
  perform test_assert('first-ingestion, newline-only: zero chunks written', v_chunk_count = 0);

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000008', array[E'\r\r']);
  perform test_assert('first-ingestion, CR-only: failed, never ready', v_status = 'failed');
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000008';
  perform test_assert('first-ingestion, CR-only: zero chunks written', v_chunk_count = 0);

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000009', array[E'\r\n\r\n']);
  perform test_assert('first-ingestion, CRLF-only: failed, never ready', v_status = 'failed');
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '94100001-0000-0000-0000-000000000009';
  perform test_assert('first-ingestion, CRLF-only: zero chunks written', v_chunk_count = 0);

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '9410000a-0000-0000-0000-000000000001', array[E' \t\n\r ']);
  perform test_assert('first-ingestion, mixed whitespace: failed, never ready', v_status = 'failed');
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '9410000a-0000-0000-0000-000000000001';
  perform test_assert('first-ingestion, mixed whitespace: zero chunks written', v_chunk_count = 0);

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '9410000b-0000-0000-0000-000000000001', array[null, E'\t', '']::text[]);
  perform test_assert('first-ingestion, NULL mixed with whitespace: failed, never ready', v_status = 'failed');
  select count(*) into v_chunk_count from knowledge_chunks where knowledge_source_id = '9410000b-0000-0000-0000-000000000001';
  perform test_assert('first-ingestion, NULL mixed with whitespace: zero chunks written', v_chunk_count = 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4e. Valid content regression: meaningful content surrounded by tab/
--     newline/CR whitespace must still ingest successfully, with only the
--     leading/trailing whitespace normalized away -- internal whitespace
--     between words, and non-Latin content, must be preserved exactly.
-- ---------------------------------------------------------------------------

do $$
declare
  v_status knowledge_ingestion_status;
  v_content text;
begin
  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '9410000c-0000-0000-0000-000000000001', array['hello']);
  select content into v_content from knowledge_chunks where knowledge_source_id = '9410000c-0000-0000-0000-000000000001';
  perform test_assert('valid content "hello": ready', v_status = 'ready');
  perform test_assert('valid content "hello": stored exactly', v_content = 'hello');

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '9410000d-0000-0000-0000-000000000001', array[E'\thello\n']);
  select content into v_content from knowledge_chunks where knowledge_source_id = '9410000d-0000-0000-0000-000000000001';
  perform test_assert('valid content "\thello\n": ready', v_status = 'ready');
  perform test_assert('valid content "\thello\n": boundary tab/newline stripped, content preserved', v_content = 'hello');

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '9410000e-0000-0000-0000-000000000001', array[E'\r\nFAQ answer\r\n']);
  select content into v_content from knowledge_chunks where knowledge_source_id = '9410000e-0000-0000-0000-000000000001';
  perform test_assert('valid content "\r\nFAQ answer\r\n": ready', v_status = 'ready');
  perform test_assert('valid content "\r\nFAQ answer\r\n": boundary CRLF stripped, internal space preserved', v_content = 'FAQ answer');

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '9410000f-0000-0000-0000-000000000001', array[E'hello\nworld']);
  select content into v_content from knowledge_chunks where knowledge_source_id = '9410000f-0000-0000-0000-000000000001';
  perform test_assert('valid content "hello\nworld": ready', v_status = 'ready');
  perform test_assert('valid content "hello\nworld": internal newline is NOT a boundary -- preserved exactly', v_content = E'hello\nworld');

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100010-0000-0000-0000-000000000001', array[E'  \t' || 'സ്വാഗതം' || E'\n  ']);
  select content into v_content from knowledge_chunks where knowledge_source_id = '94100010-0000-0000-0000-000000000001';
  perform test_assert('valid Malayalam content surrounded by whitespace: ready', v_status = 'ready');
  perform test_assert('valid Malayalam content: boundary whitespace stripped, script preserved exactly', v_content = 'സ്വാഗതം');

  select ingestion_status into v_status
    from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100011-0000-0000-0000-000000000001', array[E'  \t' || 'مرحبا' || E'\n  ']);
  select content into v_content from knowledge_chunks where knowledge_source_id = '94100011-0000-0000-0000-000000000001';
  perform test_assert('valid Arabic content surrounded by whitespace: ready', v_status = 'ready');
  perform test_assert('valid Arabic content: boundary whitespace stripped, script preserved exactly', v_content = 'مرحبا');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4f. Title validation has the identical whitespace-classification defect
--     (admin_add_knowledge_source's v_title used plain trim()) -- a
--     whitespace-only title must be rejected, and a meaningful title
--     surrounded by whitespace must be accepted with only the boundaries
--     normalized away.
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'a title made entirely of tab/newline/space is rejected as invalid, not accepted as "meaningful"',
  $sql$ select id from admin_add_knowledge_source('92100001-0000-0000-0000-000000000001', 'faq', E'  \t\n  ') $sql$,
  'invalid_title'
);

do $$
declare
  v_title text;
begin
  select title into v_title
    from admin_add_knowledge_source('92100001-0000-0000-0000-000000000001', 'faq', E'  \tPricing Info\n  ');
  perform test_assert('a meaningful title surrounded by whitespace is accepted, boundary-normalized', v_title = 'Pricing Info');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Wrong company/source pairing is rejected -- a real source id paired
--    with the WRONG company_id must never resolve, never write anything.
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'a real source_id paired with the wrong company_id is rejected, not silently reassigned',
  $sql$ select id from ingest_knowledge_source('92100002-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', array['x']) $sql$,
  'knowledge_source_not_found'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6. Authorization: anon, an ordinary authenticated user with no platform
--    role, and every real Company A role (owner/admin/agent) are all denied
--    -- ingestion is Super Admin only, exactly like the other admin_*
--    knowledge functions. Only super_admin (already proven above) succeeds.
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_clear_current_user();
  set local role anon;
  begin
    perform id from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', array['x']);
    raise exception 'ASSERTION FAILED: anon should be denied EXECUTE on ingest_knowledge_source, but the call succeeded';
  exception
    when insufficient_privilege then
      raise notice 'OK: anon is denied EXECUTE on ingest_knowledge_source';
  end;
end;
$$;

reset role;

set local role authenticated;

select test_set_current_user('91100002-0000-0000-0000-000000000001'); -- Company A owner
select test_assert_raises(
  'a company owner (real Company A member, no platform role) cannot ingest knowledge -- Super Admin only',
  $sql$ select id from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', array['x']) $sql$,
  'permission_denied'
);

select test_set_current_user('91100003-0000-0000-0000-000000000001'); -- Company A admin
select test_assert_raises(
  'a company admin cannot ingest knowledge -- Super Admin only',
  $sql$ select id from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', array['x']) $sql$,
  'permission_denied'
);

select test_set_current_user('91100004-0000-0000-0000-000000000001'); -- Company A agent
select test_assert_raises(
  'an ordinary company member cannot ingest knowledge -- Super Admin only',
  $sql$ select id from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', array['x']) $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 7. Cross-company chunk write is impossible: Company B's own owner cannot
--    use their own real membership to write chunks onto Company A's source,
--    even by passing Company A's own ids explicitly.
-- ---------------------------------------------------------------------------

select test_set_current_user('91100005-0000-0000-0000-000000000001'); -- Company B owner
select test_assert_raises(
  'Company B''s owner cannot ingest into Company A''s source under any pairing -- Super Admin only, not merely cross-tenant',
  $sql$ select id from ingest_knowledge_source('92100001-0000-0000-0000-000000000001', '94100001-0000-0000-0000-000000000001', array['x']) $sql$,
  'permission_denied'
);

reset role;

-- Final sanity: none of the denied attempts above wrote or changed anything.
do $$
begin
  perform test_assert(
    'no denied authorization attempt above wrote a cross-company/unauthorized chunk',
    (select array_agg(content order by chunk_index)
       from knowledge_chunks
       where knowledge_source_id = '94100001-0000-0000-0000-000000000001')
      = array['Replacement chunk A', 'Replacement chunk B', 'Replacement chunk C']
  );
end;
$$;

rollback;
