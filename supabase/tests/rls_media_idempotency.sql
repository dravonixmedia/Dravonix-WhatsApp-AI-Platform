-- Voice pipeline reliability -- media_files/transcriptions idempotency
-- constraint tests (migration 16). Run after rls_currency.sql (via
-- supabase/tests/run.sh), against the same throwaway local Postgres
-- database -- never a hosted Supabase project. Every check either passes
-- silently or RAISE EXCEPTIONs.
--
-- This file tests the CONSTRAINTS added by migration 16 against a database
-- that already has them (fresh migrate-from-empty flow). The separate
-- legacy-duplicate CONSOLIDATION behavior (pre-existing duplicate rows,
-- safe vs. unsafe divergent-transcript groups) is tested in its own
-- dedicated scratch-database flow in run.sh, mirroring the legacy-upgrade
-- pattern used for migration 12.

begin;

-- ---------------------------------------------------------------------------
-- Assertion helpers (each test file defines/rolls back its own copy).
-- ---------------------------------------------------------------------------

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

create or replace function test_assert_raises(description text, sql_text text, expected_sqlstate text) returns void
  language plpgsql
  as $$
  declare
    caught_sqlstate text;
    did_raise boolean := false;
  begin
    begin
      execute sql_text;
    exception
      when others then
        get stacked diagnostics caught_sqlstate = returned_sqlstate;
        did_raise := true;
    end;

    if not did_raise then
      raise exception 'ASSERTION FAILED: % -- expected a SQLSTATE % exception but none was raised', description, expected_sqlstate;
    end if;
    if caught_sqlstate <> expected_sqlstate then
      raise exception 'ASSERTION FAILED: % -- expected SQLSTATE % but got %', description, expected_sqlstate, caught_sqlstate;
    end if;
    raise notice 'OK: %', description;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Fixtures: two companies, each with a contact/conversation/message, so
-- cross-company non-collision (CASE C) uses a genuinely valid relational
-- fixture rather than an impossible FK state.
-- ---------------------------------------------------------------------------

insert into companies (id, name, slug, status, is_demo) values
  ('9a000001-0000-0000-0000-000000000001', 'Media Idempotency Co A', 'media-idem-co-a', 'active', true),
  ('9a000002-0000-0000-0000-000000000002', 'Media Idempotency Co B', 'media-idem-co-b', 'active', true);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('9c000001-0000-0000-0000-000000000001', '9a000001-0000-0000-0000-000000000001', '919700000001', 'Contact A'),
  ('9c000002-0000-0000-0000-000000000002', '9a000002-0000-0000-0000-000000000002', '919700000002', 'Contact B');

insert into conversations (id, company_id, contact_id) values
  ('9d000001-0000-0000-0000-000000000001', '9a000001-0000-0000-0000-000000000001', '9c000001-0000-0000-0000-000000000001'),
  ('9d000002-0000-0000-0000-000000000002', '9a000002-0000-0000-0000-000000000002', '9c000002-0000-0000-0000-000000000002');

insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body) values
  ('9e000001-0000-0000-0000-000000000001', '9a000001-0000-0000-0000-000000000001', '9d000001-0000-0000-0000-000000000001', 'inbound', 'audio', 'customer', null),
  ('9e000002-0000-0000-0000-000000000002', '9a000002-0000-0000-0000-000000000002', '9d000002-0000-0000-0000-000000000002', 'inbound', 'audio', 'customer', null);

-- ---------------------------------------------------------------------------
-- CASE A: first inbound_audio insert for a message succeeds.
-- ---------------------------------------------------------------------------

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('9f000001-0000-0000-0000-000000000001', '9a000001-0000-0000-0000-000000000001', 'inbound_audio', '9e000001-0000-0000-0000-000000000001', 'companies/9a000001-0000-0000-0000-000000000001/audio/inbound/9e000001-0000-0000-0000-000000000001', 'audio/ogg');

select test_assert(
  'CASE A: first inbound_audio media_files insert for a message succeeds',
  exists (select 1 from media_files where id = '9f000001-0000-0000-0000-000000000001')
);

-- ---------------------------------------------------------------------------
-- CASE B: a second inbound_audio row for the SAME company_id/message_id/kind
-- is rejected at the database level (23505 unique_violation).
-- ---------------------------------------------------------------------------

select test_assert_raises(
  'CASE B: a duplicate inbound_audio insert for the same company_id+message_id+kind is rejected by the database',
  $$ insert into media_files (id, company_id, kind, message_id, storage_key, mime_type)
     values ('9f000001-0000-0000-0000-000000000099', '9a000001-0000-0000-0000-000000000001', 'inbound_audio', '9e000001-0000-0000-0000-000000000001', 'companies/9a000001-0000-0000-0000-000000000001/audio/inbound/9e000001-0000-0000-0000-000000000001', 'audio/ogg') $$,
  '23505'
);

-- ---------------------------------------------------------------------------
-- CASE C: two different companies, each with their own message and their
-- own media_files row -- a valid relational fixture, not an impossible FK
-- state (message_id is a UUID FK-bound to exactly one company already, so
-- two companies can never literally share a message_id). Both inserts
-- succeed independently -- there is no cross-company collision.
-- ---------------------------------------------------------------------------

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('9f000002-0000-0000-0000-000000000002', '9a000002-0000-0000-0000-000000000002', 'inbound_audio', '9e000002-0000-0000-0000-000000000002', 'companies/9a000002-0000-0000-0000-000000000002/audio/inbound/9e000002-0000-0000-0000-000000000002', 'audio/ogg');

select test_assert(
  'CASE C: a second company''s own inbound_audio row for its own message never collides with company A''s row',
  exists (select 1 from media_files where id = '9f000002-0000-0000-0000-000000000002')
);

-- ---------------------------------------------------------------------------
-- CASE D: a different kind for the SAME message_id remains permitted -- the
-- constraint is genuinely 3-column (company_id, message_id, kind), not
-- effectively 2-column.
-- ---------------------------------------------------------------------------

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('9f000001-0000-0000-0000-000000000002', '9a000001-0000-0000-0000-000000000001', 'outbound_audio', '9e000001-0000-0000-0000-000000000001', 'companies/9a000001-0000-0000-0000-000000000001/audio/outbound/generated-1', 'audio/ogg');

select test_assert(
  'CASE D: a different kind (outbound_audio) for the same message_id is permitted alongside the existing inbound_audio row',
  exists (select 1 from media_files where id = '9f000001-0000-0000-0000-000000000002' and kind = 'outbound_audio')
);

-- ---------------------------------------------------------------------------
-- CASE E: multiple knowledge_document rows with message_id null remain
-- permitted -- standard SQL NULL-distinctness, not NULLS NOT DISTINCT.
-- ---------------------------------------------------------------------------

insert into media_files (id, company_id, kind, message_id, storage_key, mime_type) values
  ('9f000003-0000-0000-0000-000000000003', '9a000001-0000-0000-0000-000000000001', 'knowledge_document', null, 'companies/9a000001-0000-0000-0000-000000000001/knowledge/doc-a.pdf', 'application/pdf'),
  ('9f000004-0000-0000-0000-000000000004', '9a000001-0000-0000-0000-000000000001', 'knowledge_document', null, 'companies/9a000001-0000-0000-0000-000000000001/knowledge/doc-b.pdf', 'application/pdf');

select test_assert(
  'CASE E: two knowledge_document rows with message_id null both persist without conflict',
  (select count(*) from media_files where kind = 'knowledge_document' and company_id = '9a000001-0000-0000-0000-000000000001') = 2
);

-- ---------------------------------------------------------------------------
-- CASE F/G: first transcription for a media file succeeds; a second for the
-- SAME media_file_id is rejected at the database level.
-- ---------------------------------------------------------------------------

insert into transcriptions (id, company_id, media_file_id, message_id, provider, raw_text) values
  ('9a1e0001-0000-0000-0000-000000000001', '9a000001-0000-0000-0000-000000000001', '9f000001-0000-0000-0000-000000000001', '9e000001-0000-0000-0000-000000000001', 'elevenlabs', 'First transcript');

select test_assert(
  'CASE F: first transcription for a media file succeeds',
  exists (select 1 from transcriptions where id = '9a1e0001-0000-0000-0000-000000000001')
);

select test_assert_raises(
  'CASE G: a second transcription for the same media_file_id is rejected by the database',
  $$ insert into transcriptions (id, company_id, media_file_id, message_id, provider, raw_text)
     values ('9a1e0001-0000-0000-0000-000000000099', '9a000001-0000-0000-0000-000000000001', '9f000001-0000-0000-0000-000000000001', '9e000001-0000-0000-0000-000000000001', 'elevenlabs', 'Second transcript attempt') $$,
  '23505'
);

-- ---------------------------------------------------------------------------
-- CASE H: the existing corrected_text UPDATE workflow on the SAME row still
-- succeeds -- migration 16 must not disturb in-place corrections.
-- ---------------------------------------------------------------------------

update transcriptions
set corrected_text = 'Corrected transcript', corrected_at = now()
where id = '9a1e0001-0000-0000-0000-000000000001';

select test_assert(
  'CASE H: correcting the existing transcription row (not inserting a new one) still succeeds',
  (select corrected_text from transcriptions where id = '9a1e0001-0000-0000-0000-000000000001') = 'Corrected transcript'
);

-- ---------------------------------------------------------------------------
-- CASE L: existing outbound idempotency (migration 12) is unaffected by
-- migration 16 -- a second reservation attempt for the same
-- (source_message_id, channel_type) still reports claimed = false rather
-- than creating a second reservation.
-- ---------------------------------------------------------------------------

select test_assert(
  'CASE L: outbound reservation for a source message claims successfully the first time',
  (select claimed from reserve_ai_outbound_message('9e000001-0000-0000-0000-000000000001', 'text')) = true
);

select test_assert(
  'CASE L: a second outbound reservation attempt for the same source message/channel reports claimed = false (unaffected by migration 16)',
  (select claimed from reserve_ai_outbound_message('9e000001-0000-0000-0000-000000000001', 'text')) = false
);

rollback;
