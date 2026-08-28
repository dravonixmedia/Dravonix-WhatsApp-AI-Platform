-- Dravonix WhatsApp AI Platform
-- P2 Knowledge Base ingestion: a real, transactional chunk-writing pipeline
-- replacing the single-raw-chunk bypass in admin_add_knowledge_source, plus
-- the ingestion_status/search hardening the P2 architecture audit found
-- missing. See the audit's own report (this session) for the full
-- evidence trail; this migration implements exactly its approved scope.
--
-- BEFORE this migration (confirmed against both this repo's code and the
-- live hosted project immediately before writing this file):
--   - knowledge_sources.ingestion_status defaulted to 'ready', and no code
--     path anywhere ever wrote any other value -- every real source was
--     'ready' regardless of whether it had any chunks at all.
--   - admin_add_knowledge_source was the only writer to knowledge_chunks,
--     inserting the caller's entire p_content as one raw chunk with no
--     cleaning, chunking, or validation.
--   - search_knowledge_chunks filtered only on knowledge_sources.is_enabled,
--     never on ingestion_status.
--   - search_knowledge_chunks had EXECUTE granted to anon/authenticated (the
--     Postgres default-to-PUBLIC grant, never revoked) even though its only
--     real caller is message-consumer/voice-consumer via service_role.
--   - knowledge_chunks had no unique constraint at all -- reconfirmed zero
--     duplicate (company_id, knowledge_source_id, chunk_index) rows exist on
--     hosted staging and in every local seed/test fixture before adding one.
--
-- AFTER this migration:
--   - New sources start 'pending', never 'ready', until a real chunk commit
--     succeeds. Existing 'ready' rows are NOT rewritten.
--   - ingest_knowledge_source is the only writer to knowledge_chunks (besides
--     seeds/test fixtures), transactional, Super-Admin-gated, and preserves
--     an existing source's last-known-good chunks untouched if a replacement
--     attempt's content is invalid.
--   - admin_add_knowledge_source no longer accepts or writes raw chunk
--     content -- it only ever creates the knowledge_sources metadata row.
--   - search_knowledge_chunks also requires ingestion_status = 'ready'.
--   - search_knowledge_chunks's EXECUTE is revoked from public/anon/
--     authenticated and explicitly granted to service_role only.
--
-- NOT in scope (per the audit): no file upload/storage, no PDF/DOCX, no
-- embeddings, no new worker/queue, no change to is_enabled's role as the
-- enable/disable control (knowledge_ingestion_status.'disabled' remains
-- declared-but-unused, exactly as before -- not removed, not newly wired).

-- ---------------------------------------------------------------------------
-- 1. New sources start 'pending', never 'ready', until ingestion succeeds.
--    Existing rows are untouched -- this only changes the default applied to
--    future inserts.
-- ---------------------------------------------------------------------------

alter table knowledge_sources
  alter column ingestion_status set default 'pending';

-- ---------------------------------------------------------------------------
-- 2. Uniqueness on the chunk position within a source, so a retried or
--    duplicated ingestion can never leave overlapping/duplicate chunks.
--    Confirmed zero conflicting rows exist (hosted staging queried directly;
--    every local seed/test fixture inspected) before adding this constraint.
-- ---------------------------------------------------------------------------

alter table knowledge_chunks
  add constraint knowledge_chunks_company_source_index_key
  unique (company_id, knowledge_source_id, chunk_index);

-- ---------------------------------------------------------------------------
-- 3. ingest_knowledge_source: the one real, transactional chunk writer.
--
-- Receives already-cleaned/chunked strings from the caller (packages/
-- knowledge's prepareKnowledgeChunks) and re-validates them itself -- this
-- function, not the TypeScript layer, is the actual safety boundary, so it
-- never trusts that the caller already did the right thing.
--
-- Critical invariant (last-known-good preservation): if the resulting chunk
-- set is empty after this function's own trim/filter, knowledge_chunks is
-- NEVER touched -- an existing 'ready' source's prior chunks remain exactly
-- as they were, fully searchable, and the source is marked 'failed' with a
-- safe error instead. Only once a non-empty chunk set is confirmed does this
-- function delete the source's previous chunks and insert the new set; both
-- happen inside this same function invocation, so a genuine failure during
-- that step (e.g. an unexpected constraint violation) raises an exception
-- that aborts and rolls back the entire call -- the delete is undone along
-- with everything else, and the source's previous 'ready' state and chunks
-- remain visible exactly as before the call, never a partially-replaced set.
-- ---------------------------------------------------------------------------

create or replace function ingest_knowledge_source(
  p_company_id uuid,
  p_source_id uuid,
  p_chunks text[],
  p_empty_error text default 'Content was empty after cleaning.'
)
returns table (id uuid, ingestion_status knowledge_ingestion_status, ingestion_error text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.knowledge_sources%rowtype;
  v_clean_chunks text[];
  v_count integer;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  select * into v_source
    from public.knowledge_sources
    where public.knowledge_sources.id = p_source_id
      and public.knowledge_sources.company_id = p_company_id;
  if not found then raise exception 'knowledge_source_not_found'; end if;

  -- Defense-in-depth re-validation: never trust that the caller already
  -- cleaned/filtered these, even though prepareKnowledgeChunks (the
  -- intended, only real caller) already does.
  --
  -- Postgres's own trim(text) (no explicit character argument) strips ONLY
  -- the plain space character -- it does NOT recognize tab/newline/CR as
  -- whitespace (confirmed directly: trim(E'\t') = E'\t', not ''). A chunk
  -- consisting entirely of tabs/newlines/CRs would therefore have passed
  -- this check as "non-empty" and silently replaced an existing source's
  -- last-known-good chunks with content-free garbage. btrim(text, text)
  -- with an explicit character set has no such gap -- verified directly
  -- against exactly this set (space, tab, newline, CR, vertical tab, form
  -- feed; CRLF is just CR immediately followed by LF, both already in the
  -- set) and confirmed to strip only leading/trailing occurrences, never
  -- anything internal, so "hello   world" keeps its internal spacing and
  -- non-Latin content (e.g. Malayalam, Arabic) surrounded by whitespace is
  -- preserved exactly, boundaries only.
  v_clean_chunks := array(
    select btrim(c, E' \t\n\r\v\f')
    from unnest(coalesce(p_chunks, '{}'::text[])) as c
    where btrim(c, E' \t\n\r\v\f') <> ''
  );

  if array_length(v_clean_chunks, 1) is null then
    -- Zero usable chunks -- knowledge_chunks is NEVER touched on this path,
    -- so a previously-'ready' source's last-known-good chunks remain fully
    -- intact and searchable regardless of what happens to ingestion_status
    -- below. The status itself is only downgraded to 'failed' when the
    -- source has never successfully ingested before (status was already
    -- something other than 'ready') -- a source that WAS genuinely ready
    -- stays 'ready' through a failed edit attempt, exactly as it was before
    -- the call, with only ingestion_error updated so the failure is still
    -- visible. A brand-new source (never 'ready') correctly ends up
    -- 'failed' with zero chunks, matching a genuine first-ingestion failure.
    update public.knowledge_sources
      set ingestion_status = case
            when public.knowledge_sources.ingestion_status = 'ready' then 'ready'::public.knowledge_ingestion_status
            else 'failed'::public.knowledge_ingestion_status
          end,
          ingestion_error = coalesce(nullif(btrim(p_empty_error, E' \t\n\r\v\f'), ''), 'Content was empty after cleaning.')
      where public.knowledge_sources.id = p_source_id
      returning * into v_source;
    return query select v_source.id, v_source.ingestion_status, v_source.ingestion_error;
    return;
  end if;

  delete from public.knowledge_chunks
    where public.knowledge_chunks.company_id = p_company_id
      and public.knowledge_chunks.knowledge_source_id = p_source_id;

  v_count := array_length(v_clean_chunks, 1);
  for i in 1..v_count loop
    insert into public.knowledge_chunks (company_id, knowledge_source_id, content, chunk_index)
      values (p_company_id, p_source_id, v_clean_chunks[i], i - 1);
  end loop;

  update public.knowledge_sources
    set ingestion_status = 'ready',
        ingestion_error = null
    where public.knowledge_sources.id = p_source_id
    returning * into v_source;

  return query select v_source.id, v_source.ingestion_status, v_source.ingestion_error;
end;
$$;

revoke all on function ingest_knowledge_source(uuid, uuid, text[], text) from public, anon;
grant execute on function ingest_knowledge_source(uuid, uuid, text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. admin_add_knowledge_source no longer accepts or writes raw chunk
--    content -- it only ever creates the knowledge_sources metadata row
--    (now starting 'pending' by default, per change 1 above). The
--    application layer is responsible for calling ingest_knowledge_source
--    separately once content has been prepared -- this keeps
--    ingest_knowledge_source as the ONLY writer to knowledge_chunks, so
--    p_content can never again be an alternate raw-chunk bypass.
--
-- The parameter list changes (p_content is removed), so the prior 4-arg
-- overload is dropped explicitly rather than left behind alongside a new
-- 3-arg one -- there is exactly one caller in the whole codebase
-- (apps/web/lib/actions/adminCompanyConfig.ts), updated in this same batch.
-- ---------------------------------------------------------------------------

drop function if exists admin_add_knowledge_source(uuid, knowledge_source_type, text, text);

create or replace function admin_add_knowledge_source(
  p_company_id uuid,
  p_source_type knowledge_source_type,
  p_title text
)
returns table (id uuid, title text, source_type knowledge_source_type)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.knowledge_sources%rowtype;
  -- Same whitespace-detection fix as ingest_knowledge_source above: plain
  -- trim() would accept a tab/newline/CR-only title as "meaningful".
  v_title text := nullif(btrim(coalesce(p_title, ''), E' \t\n\r\v\f'), '');
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;
  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if v_title is null then raise exception 'invalid_title'; end if;

  insert into public.knowledge_sources (company_id, source_type, title)
    values (p_company_id, p_source_type, v_title)
    returning * into v_source;

  return query select v_source.id, v_source.title, v_source.source_type;
end;
$$;

revoke all on function admin_add_knowledge_source(uuid, knowledge_source_type, text) from public, anon;
grant execute on function admin_add_knowledge_source(uuid, knowledge_source_type, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. search_knowledge_chunks: require ingestion_status = 'ready' in addition
--    to the existing is_enabled = true filter, so failed/processing/pending
--    content can never reach AI context. Same OR-matched full-text query as
--    migration 11 -- only the WHERE clause's status filter changes.
-- ---------------------------------------------------------------------------

create or replace function search_knowledge_chunks(
  p_company_id uuid,
  p_query text,
  p_limit integer
)
returns table (
  source_id uuid,
  title text,
  content text,
  rank real
)
language sql
stable
as $$
  with words as (
    select distinct lower(regexp_replace(w, '[^a-zA-Z0-9]', '', 'g')) as w
    from regexp_split_to_table(p_query, '\s+') as w
  ),
  filtered as (
    select w from words where length(w) > 0
  ),
  query as (
    select to_tsquery('simple', string_agg(w, ' | ')) as tsq
    from filtered
  )
  select
    kc.knowledge_source_id as source_id,
    ks.title,
    kc.content,
    ts_rank(kc.content_tsv, query.tsq) as rank
  from knowledge_chunks kc
  join knowledge_sources ks on ks.id = kc.knowledge_source_id
  cross join query
  where kc.company_id = p_company_id
    and ks.is_enabled = true
    and ks.ingestion_status = 'ready'
    and query.tsq is not null
    and kc.content_tsv @@ query.tsq
  order by rank desc
  limit p_limit;
$$;

comment on function search_knowledge_chunks(uuid, text, integer) is
  'Ranked full-text search over one company''s enabled, ready knowledge chunks. Only ever called with the service-role client (which already bypasses RLS), so the p_company_id filter is the sole isolation guarantee here -- callers must never pass a company_id the caller does not control.';

-- EXECUTE on this function was still the Postgres default-to-PUBLIC grant
-- (never explicitly revoked since migration 10) even though its only real
-- caller is message-consumer/voice-consumer via service_role -- confirmed
-- live against the hosted project before writing this migration. RLS
-- already prevented any actual cross-tenant disclosure for anon/authenticated
-- (has_company_permission() resolves false for both with no real company
-- membership), so this is a hardening/attack-surface reduction, not a fix
-- for a live leak. service_role needs an EXPLICIT grant here -- it is not a
-- member of any role this migration grants to, and (unlike RLS) Postgres
-- object-level GRANT/REVOKE privileges are never bypassed by service_role's
-- bypassrls attribute.
revoke all on function search_knowledge_chunks(uuid, text, integer) from public, anon, authenticated;
grant execute on function search_knowledge_chunks(uuid, text, integer) to service_role;
