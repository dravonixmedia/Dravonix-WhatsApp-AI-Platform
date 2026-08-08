-- Post-migration-16 assertions for the legacy-duplicate consolidation
-- regression (run.sh's dedicated scratch database, seeded via
-- support/media_duplicate_safe_seed.sql BEFORE migration 16 is applied).
-- Every check either passes silently or RAISE EXCEPTIONs.

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

-- CASE K: no duplicate logical media groups remain anywhere after
-- migration 16's consolidation.
select test_assert(
  'CASE K: zero duplicate (company_id, message_id, kind) media_files groups remain after migration 16',
  not exists (
    select 1 from media_files
    where message_id is not null
    group by company_id, message_id, kind
    having count(*) > 1
  )
);

select test_assert(
  'CASE K: zero duplicate media_file_id transcription groups remain after migration 16',
  not exists (
    select 1 from transcriptions
    group by media_file_id
    having count(*) > 1
  )
);

-- CASE I: the divergent-transcript group (message C) kept the row whose
-- transcript matches the message's live body -- the LATER row, not the
-- earliest one (mirrors the real staging finding this migration is
-- designed around).
select test_assert(
  'CASE I: message C''s surviving media_files row is the LATER duplicate (8f0000c1...002), matching the live message body',
  (
    select mf.id from media_files mf
    where mf.message_id = '8e0000c1-0000-0000-0000-000000000001'
  ) = '8f0000c1-0000-0000-0000-000000000002'
);

select test_assert(
  'CASE I: the surviving row''s own transcript still equals the live message body',
  (
    select t.raw_text = m.body
    from media_files mf
    join transcriptions t on t.media_file_id = mf.id
    join messages m on m.id = mf.message_id
    where mf.message_id = '8e0000c1-0000-0000-0000-000000000001'
  )
);

-- Message A (no-transcript duplicates) consolidated to exactly one row.
select test_assert(
  'no-transcript duplicate group (message A) consolidated to exactly one media_files row',
  (select count(*) from media_files where message_id = '8e0000a1-0000-0000-0000-000000000001') = 1
);

-- Message B (identical-transcript duplicates) consolidated to exactly one row.
select test_assert(
  'identical-transcript duplicate group (message B) consolidated to exactly one media_files row',
  (select count(*) from media_files where message_id = '8e0000b1-0000-0000-0000-000000000001') = 1
);

-- Message D (never duplicated) is untouched.
select test_assert(
  'the non-duplicated message D row is untouched by consolidation',
  (select id from media_files where message_id = '8e0000d1-0000-0000-0000-000000000001')
    = '8f0000d1-0000-0000-0000-000000000001'
);

-- Both constraints exist after a successful consolidation.
select test_assert(
  'media_files_company_message_kind_key constraint exists after migration 16',
  exists (select 1 from pg_constraint where conname = 'media_files_company_message_kind_key')
);
select test_assert(
  'transcriptions_media_file_id_key constraint exists after migration 16',
  exists (select 1 from pg_constraint where conname = 'transcriptions_media_file_id_key')
);

rollback;
